import "server-only";

import { researchBeforeDraft } from "../research";
import { buildCallScript, renderCallScriptText } from "@/lib/icp/callScript";
import { matchDictionary, fallbackIntent } from "@/lib/icp/productIntent";
import { channelConstraintsForDraft } from "./channel";
import type { AgentStateType } from "./state";

/**
 * 子 Agent：每个负责一件事，只读状态、返回增量。
 *
 * ## 设计原则
 *
 * 1. **子 Agent 不互相调用**。它们只通过 state 通信——这是多 Agent 架构
 *    与"函数调用链"的区别。好处是可观测（每次传递都看得见）和可中断。
 *
 * 2. **每个 Agent 只做一件事**。research 只查资料，draft 只写话术。
 *    混在一起的后果是出错时不知道是哪部分的问题。
 *
 * 3. **返回的是"增量"**，不是完整状态。LangGraph 会用 reducer 合并。
 *    这样并发分支时不会互相覆盖。
 */

/** ① 调研：查客户档案、历史、知识库、时间线。 */
export async function researchAgent(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const result = await researchBeforeDraft({
    personId: state.personId,
    organizationId: state.organizationId,
    channel: state.channel,
    stepLabel: stepLabelFor(state.goal),
    brief: state.findings
      ? `已有材料：${state.findings}`
      : "尚无上下文，需要自己查。",
    channelConstraints: channelConstraintsForDraft(state.channel),
  });

  return {
    findings: result.findings || "（调研未获得有效材料）",
    trail: [`research: ${result.lookups.length} 次工具调用，${result.steps} 步`],
    ...(result.stopReason === "model_error" ? { error: "调研 Agent 运行失败" } : {}),
  };
}

/** ② 意向评估：判断这个客户值不值得跟进。 */
export async function assessIntentAgent(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // 这里用规则判断，而不是调模型——因为意图分类本身已经由 CRM 的分类管线做过
  // （客户回复进来时 AI 就分类了）。子 Agent 的职责是**读那个结果**，不是重复判断。
  //
  // 如果状态里没有意图信息（比如还没收到客户回复），就看材料里有无线索。
  const findings = (state.findings ?? "").toLowerCase();

  // 从材料里识别负面信号。这是启发式，不是模型判断——便宜且可测。
  const negativeSignals = ["已有供应商", "不需要", "不感兴趣", "拒绝", "勿扰"];
  const positiveSignals = ["感兴趣", "要资料", "要报价", "想见面", "可以谈", "留个联系方式"];

  const negativeHit = negativeSignals.find((signal) => findings.includes(signal));
  const positiveHit = positiveSignals.find((signal) => findings.includes(signal));

  const category = negativeHit
    ? "not_interested"
    : positiveHit
      ? "interested"
      : "other";

  return {
    intent: {
      category,
      confidence: negativeHit || positiveHit ? 0.7 : 0.3,
      // 明确写清这是启发式判断，避免被误认为是模型结论。
      reasoning: negativeHit
        ? `材料中出现负面信号「${negativeHit}」`
        : positiveHit
          ? `材料中出现正面信号「${positiveHit}」`
          : "材料中未见明确态度信号，按中性处理",
    },
    trail: [`assess_intent: ${category}`],
  };
}

/** ③ 起草：写话术。复用已有的话术生成能力。 */
export async function draftAgent(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // 这里不直接调 generateCrmDraft（那个需要数据库事务和草稿记录），
  // 而是用 callScript 这类"纯生成"能力——因为子 Agent 不该关心持久化，
  // 持久化是图跑完之后调用方的事。
  //
  // 这是有意的解耦：Agent 产出内容，调用方决定存不存、怎么存。
  const intent = matchDictionary(state.product ?? "") ?? fallbackIntent(state.product ?? "");
  const script = buildCallScript({
    product: intent,
    companyName: state.companyName ?? "贵司",
    contactName: null,
  });

  const isCall = state.channel === "call";
  const text = isCall
    ? renderCallScriptText(script)
    : renderTextForChannel(script, state.channel);

  return {
    draftText: text,
    draftSubject: state.channel === "email" ? `${state.companyName ?? "贵司"} · 沟通跟进` : null,
    trail: [`draft: 产出 ${text.length} 字（${state.channel}）`],
  };
}

/** ④ 关闭：客户明确不需要，不再跟进。 */
export async function closeAgent(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  return {
    draftText: null,
    trail: [`close: 客户意向为「${state.intent?.category ?? "未知"}」，停止跟进`],
  };
}

/** ⑤ 收尾：汇总本次协同做了什么。 */
export async function finishAgent(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  return {
    trail: [`finish: ${state.draftText ? "已产出草稿" : "无草稿"}，共 ${state.trail.length} 步`],
  };
}

// ---------------------------------------------------------------- helpers

function stepLabelFor(goal: AgentStateType["goal"]): string {
  switch (goal) {
    case "first_touch":
      return "首次触达";
    case "draft_reply":
      return "回复客户";
    case "follow_up":
      return "跟进";
    default:
      return "调研";
  }
}

/**
 * 把电话话术渲染成其他渠道的文本。
 *
 * 电话话术是四段结构（开场/探询/价值/收尾），直接发到微信太长。
 * 所以只取「开场」和「收尾」，并按渠道长度限制裁剪。
 */
function renderTextForChannel(
  script: ReturnType<typeof buildCallScript>,
  channel: AgentStateType["channel"],
): string {
  const opening = script.segments.find((segment) => segment.key === "opening")?.text ?? "";
  const closing = script.segments.find((segment) => segment.key === "closing")?.text ?? "";

  // 占位符要按语义替换。
  //
  // 踩过的坑：{name} 后面紧跟「您好」（模板是「{name}您好」），填「您好」会
  // 变成「您好您好」；填空会留下一个逗号；{rep} 填「我」会变成「新农哥的我」。
  //
  // 正确做法：
  //   {name} → 有称呼填称呼，没有就整体删掉「{name}您好」这个问候语
  //   {rep}  → 没有销售名时用「销售」而不是「我」（「新农哥的销售」是通的）
  const cleaned = (text: string) => {
    let out = text.replaceAll("{company}", script.companyName);
    if (script.contactName) {
      out = out.replaceAll("{name}", script.contactName);
    } else {
      // 没有称呼：整个「{name}您好，」段去掉，避免留下标点碎片。
      out = out.replace(/\{name\}您好[，,]?\s*/g, "");
    }
    out = out.replaceAll("{rep}", "销售");
    return out
      .replace(/^[，,、]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const sentences = cleaned(opening);

  if (channel === "wecom") {
    // 微信：一到四句，去掉"收尾"里的多选项（那是给销售看的提示，不是要发的）
    const first = sentences.split(/[。！？]/)[0] ?? sentences;
    return `${first}。`;
  }
  if (channel === "sms") {
    // 短信按 70 字计费
    const limit = 70;
    return sentences.length <= limit ? sentences : `${sentences.slice(0, limit - 1)}…`;
  }
  // 邮件：开场 + 收尾
  return `${sentences}\n\n${cleaned(closing)}`;
}
