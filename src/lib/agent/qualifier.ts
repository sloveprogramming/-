import "server-only";

import { runPiAgent } from "./pi/session";
import { startAgentRun } from "./observe";
import { ToolRegistry } from "./tools";
import { registerQccSignalTools } from "./tools/qccSignal";

/**
 * 资格员：分数落在灰色带时，去查真实经营信号，给出"要不要打这个电话"的判断。
 *
 * ## 为什么只对灰色带跑
 *
 * 分数 80 分以上的公司，公式已经足够回答"像不像客户"，再花一次模型调用 + 几次
 * 企查查查询是浪费。分数 40 以下的同理——不值得为它花钱。
 *
 * 真正需要判断的是 **45–65 这一段**：工商信息看着像，但看不出他现在到底做不做
 * 这门生意。也就是"资料齐全但看不出活不活"的那种公司。这一段恰恰最值得打
 * 电话，也最容易被销售跳过。
 *
 * ## 为什么结论不改分数
 *
 * 分数是公式算的，销售问"为什么 87 分"能逐项答出来。如果模型能改分数，这个
 * 可解释性就没了。所以这里的结论是**附加信号**：`pursue` / `hold` / `drop`
 * 加一句理由，跟分数并列呈现，而不是替换它。
 *
 * ## 成本边界
 *
 * - 只对灰色带、且最多 2 家（一家一次模型调用 + 最多 4 次企查查查询）
 * - 默认关闭（`AGENT_QUALIFY_GRAY_ZONE=1` 开启）
 * - 失败、超时、没配 token、解析不出来 —— 一律返回 null，pipeline 用原分档
 */

/** 灰色带区间：低于下限没价值，高于上限不需要判断。 */
export const GRAY_ZONE = { min: 45, max: 65 } as const;

/** 一次 pipeline 最多深查几家。再多就是拿钱换一点点排序优化。 */
export const MAX_DEEP_CHECK = 2;

const MAX_TOOL_CALLS = 5;

export function qualifierEnabled(): boolean {
  const value = process.env.AGENT_QUALIFY_GRAY_ZONE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export type QualifierVerdict = "pursue" | "hold" | "drop";

export type QualifierInput = {
  companyName: string;
  /** 公式算出来的分与分档，给 Agent 一个参照。 */
  score: number;
  tier: string;
  /** 系统判定的买家描述（比如"烘焙厂、速冻食品厂"），用来判断行业是否对口。 */
  buyerDescription: string;
  /** 触发它的产品，便于它理解上下文。 */
  product: string;
  organizationId: string;
  signal?: AbortSignal;
};

export type QualifierResult = {
  verdict: QualifierVerdict;
  reasoning: string;
  /** 它查了哪些工具、成没成功（审计用）。 */
  lookups: Array<{ tool: string; ok: boolean }>;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
};

const SYSTEM_PROMPT = [
  "你是新农哥的客户资格审核员。销售要打电话给一家公司，但系统给的分数落在中间段（看不出好坏）。",
  "你的任务：查几个真实信号，判断这家公司值不值得打这个电话。",
  "",
  "你有四个只读工具（都只收完整企业登记名）：",
  "- lookup_company_profile：行业四级分类、企业规模、主营产品",
  "- lookup_recruitment：在招什么岗位（在招采购/渠道/销售 = 正在扩张渠道）",
  "- lookup_bidding：招投标与中标记录（有中标 = 业务在真实运转）",
  "- lookup_qualifications：资质与许可（食品经营许可是做食品分销的前提）",
  "- lookup_food_safety：食品安全抽检与处罚（坚果行业硬风险）",
  "",
  "判断标准：",
  "1. **行业对口最重要**：他的行业/主营产品跟买家描述（{buyerDescription}）对得上吗？",
  "2. **需求信号**：在招渠道岗、有中标记录，说明他现在有钱有动作，值得打。",
  "3. **渠道能力**：有食品相关资质，说明他真能铺货。",
  "4. **风险**：有食品安全处罚记录的，标 drop 或 hold，让销售知道这个坑。",
  "",
  "规则：",
  "- 最多调 4 次工具。查到能下判断就停，不要为了查而查。",
  "- **只陈述查到的**。没查到的写「未查到」，绝不推测。",
  "- 不要报价、不要承诺政策、不要评价对方信誉好坏——只说数据事实和你的建议。",
  "- 最后只输出 JSON，不要任何其他文字：",
  '  {"verdict":"pursue|hold|drop","reasoning":"不超过 80 字，说清最关键的一条依据"}',
  "",
  "verdict 含义：pursue = 值得优先打；hold = 可以打但优先级一般；drop = 别打（行业不符或有硬风险）。",
].join("\n");

export async function qualifyCompany(input: QualifierInput): Promise<QualifierResult | null> {
  const tools = registerQccSignalTools(new ToolRegistry());
  const recorder = await startAgentRun({
    kind: "qualify",
    role: "qualifier",
    model: null,
    subjectType: "company",
    subjectId: null,
    context: {
      company: input.companyName,
      score: input.score,
      tier: input.tier,
      product: input.product,
    },
  });

  const userPrompt = [
    `公司：${input.companyName}`,
    `产品：${input.product}`,
    `这家公司应该是什么买家：${input.buyerDescription}`,
    `系统给的分数：${input.score}（分档 ${input.tier}）——分数在中间段，需要你判断`,
    "",
    "请按需调用工具，然后给出 verdict 与一句理由。",
  ].join("\n");

  let result;
  try {
    result = await runPiAgent({
      organizationId: input.organizationId,
      subject: { type: "company", id: null },
      systemPrompt: SYSTEM_PROMPT.replace("{buyerDescription}", input.buyerDescription),
      userPrompt,
      tools,
      maxToolCalls: MAX_TOOL_CALLS,
      timeoutMs: 60_000,
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
    // 深查失败不是业务失败：调用方用原分档继续。
    return null;
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

  const parsed = parseQualifierOutput(result.text);
  if (!parsed) return null;

  return {
    ...parsed,
    lookups: result.toolCalls.map((call) => ({ tool: call.name, ok: call.ok })),
    usage: result.usage,
    stopReason: result.stopReason,
  };
}

/**
 * 解析模型输出。
 *
 * 宽容策略与重规划一致：模型经常带 ```json 围栏或先说一句"我查了一下"。
 * 解析不出来就返回 null（调用方当作"深查没结论"），绝不猜测 verdict。
 */
export function parseQualifierOutput(text: string): { verdict: QualifierVerdict; reasoning: string } | null {
  const raw = text?.trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== "pursue" && verdict !== "hold" && verdict !== "drop") return null;

  const reasoning = typeof record.reasoning === "string"
    ? record.reasoning.trim().slice(0, 200)
    : "";
  return { verdict, reasoning };
}

/** 这个分数该不该深查。抽成函数是为了让"触发条件"能被单独测试。 */
export function inGrayZone(score: number): boolean {
  return score >= GRAY_ZONE.min && score <= GRAY_ZONE.max;
}
