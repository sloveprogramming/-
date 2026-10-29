import "server-only";

import { getOpenRouterRuntime } from "@/lib/ai/server/runtime";
import { runPiAgent, type PiAgentRunResult } from "./pi/session";
import { startAgentRun } from "./observe";
import { ToolRegistry } from "./tools";
import { registerCustomerTools } from "./tools/customer";

/**
 * 「先查后写」的起草调研 Agent（基于 Pi SDK）。
 *
 * 改造前后的分工变化：
 *
 *   自研 runtime：调用方攒上下文 → 手写工具循环 → 模型调用
 *   Pi SDK：createAgentSession → session.prompt() → Pi 管上下文与工具循环
 *
 * 这次改造的核心是**职责切分**：
 *
 *   **Pi 负责**：会话生命周期、上下文组装与压缩、工具循环、模型调用
 *   **我们负责**：工具本身（4 个只读查询）、风险闸门、观测落库、失败兜底
 *
 * 「上下文管理」这类通用能力交给成熟实现，「业务工具 + 安全边界」留在自己
 * 手里——两边都不重复造轮子。
 *
 * 安全保障（全部是代码，不是提示词）：
 * - `noTools: "builtin"` 关掉 Pi 内置的 bash/edit/write/read
 * - 只注册 4 个 `read` 风险的工具
 * - destructive 工具在执行层直接拒绝
 * - 最终输出仍走原来的结构化校验（Agent 只准备材料，不负责写作）
 */

export type ResearchInput = {
  personId: string;
  channel: "email" | "wecom" | "sms" | "call";
  /** 已有的上下文摘要（历史对话、当前阶段），作为初始材料。 */
  brief: string;
  /** 要写的是哪一步：是回复，还是第几次跟进。 */
  stepLabel: string;
  /** AI 起草的渠道约束（短信 70 字内等），由 draftChannelConstraints 生成。 */
  channelConstraints: readonly string[];
  organizationId: string;
  requestedModel?: { provider: string; modelId: string };
  signal?: AbortSignal;
};

export type ResearchResult = {
  /** Agent 调研后整理的「写作材料」，交给起草提示使用。 */
  findings: string;
  /** 它实际查了什么，便于审计。 */
  lookups: Array<{ tool: string; ok: boolean }>;
  steps: number;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
};

const SYSTEM_PROMPT = [
  "你是新农哥的销售助手。你的任务不是写回复，而是**先把材料查清楚**，然后交给写作者。",
  "",
  "你有四个只读工具：",
  "- lookup_customer：这个客户是谁、什么行业、什么规模",
  "- lookup_history：我们和他聊过什么（换了几个渠道、上次说到哪）",
  "- search_knowledge：知识库里的产品信息、合作政策、价格规则、常见异议",
  "- lookup_timeline：这个客户的结构化事件（阶段变化、成交、退订）",
  "",
  "规则：",
  "1. 先判断缺什么，再决定查哪个。**不要为了查而查**——如果上下文已经足够，直接给结论。",
  "2. 一次最多查三个工具。查两轮还不够，说明信息库里没有，就基于现有材料给结论并注明「这一点没查到」。",
  "3. 只陈述查到的事实。没查到的写「未知」，绝不推测具体价格、政策、日期。",
  "4. 最后用中文输出一段给写作者的材料摘要，不超过 300 字，包含：对方是谁、聊到哪一步、这次要解决什么、有哪些不能碰的红线（比如价格必须走正式报价）。",
  "5. 不要写回复正文，那是下一步的事。",
].join("\n");

export async function researchBeforeDraft(input: ResearchInput): Promise<ResearchResult> {
  const tools = registerCustomerTools(new ToolRegistry());
  const recorder = await startAgentRun({
    kind: "research",
    model: input.requestedModel ? `${input.requestedModel.provider}/${input.requestedModel.modelId}` : null,
    subjectType: "person",
    subjectId: input.personId,
    context: { channel: input.channel, step: input.stepLabel },
  });

  // 数据库里没配 OpenRouter 不算错误：Pi 会走 DEEPSEEK_API_KEY / OPENROUTER_API_KEY
  // 环境变量。这里只是提前探一下，出问题也继续——由 createPiRuntime 给出准确的报错。
  if (!input.requestedModel) {
    try {
      await getOpenRouterRuntime(undefined, 45_000);
    } catch {
      // 忽略：Pi 会用环境变量兜底。
    }
  }

  const userPrompt = [
    `联系人 ID：${input.personId}`,
    `渠道：${input.channel}`,
    `这一步要写：${input.stepLabel}`,
    "",
    "当前已有材料：",
    input.brief,
    "",
    "渠道限制（写作者会遵守，你只要知道边界）：",
    ...input.channelConstraints.map((line) => `- ${line}`),
    "",
    "请判断还缺什么，按需调用工具查询，最后给一段材料摘要。",
  ].join("\n");

  let result: PiAgentRunResult;
  try {
    result = await runPiAgent({
      organizationId: input.organizationId,
      subject: { type: "person", id: input.personId },
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      tools,
      maxToolCalls: 6,
      timeoutMs: 45_000,
      signal: input.signal,
      onEvent: (event) => recorder.record(event),
    });
  } catch (error) {
    await recorder.finish({
      stopReason: "model_error",
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  await recorder.finish({
    stopReason: result.stopReason,
    steps: result.steps,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    toolCalls: result.toolCalls.length,
    durationMs: result.durationMs,
    error: result.stopReason === "model_error" ? "model_error" : null,
  });

  return {
    findings: result.text,
    lookups: result.toolCalls.map((call) => ({ tool: call.name, ok: call.ok })),
    steps: result.steps,
    stopReason: result.stopReason,
    usage: result.usage,
  };
}
