import "server-only";

import { runPiAgent } from "./pi/session";
import { startAgentRun } from "./observe";
import { ToolRegistry } from "./tools";
import { registerProspectingTools } from "./tools/prospecting";
import { registerHistoryTools } from "./tools/history";

/**
 * 重规划搜索词：搜到的公司太少时，让 Agent 自己换词再搜一轮。
 *
 * ## 这一步解决了什么
 *
 * 用「面包丝」搜企查查，命中 **0 家**——因为买面包丝的是烘焙厂、速冻食品厂，
 * 公司名里不会写"面包丝"。系统靠词典扩展出行业词能救一部分，但词典只覆盖
 * 食品品类，新品类、地方性叫法、组合产品它都不认识。
 *
 * 所以给 Agent 一个探测工具，让它自己试：**先试再答，而不是凭语感编词**。
 *
 * ## 为什么它是"真 Agent"而不是又一次单次调用
 *
 * 关键差别在于**决策依赖观察结果**：它先 probe 一个词，看到命中数，再决定
 * 下一个词试什么。单次调用做不到这件事——不试就不知道哪些词在这家企业库里
 * 是死的。
 *
 * ## 成本边界
 *
 * - 只在「搜到的公司 < 5 家」时触发，不是每次都跑
 * - 最多 4 次工具调用（4 次企业库搜索）、最多 1 轮重规划
 * - 默认关闭，env 开关 `AGENT_REPLAN_SEARCH=1`
 * - 任何失败（模型挂了、超时、解析失败、没有 key）都退回原结果，绝不影响主链路
 */

/** 低于这个数量才值得重规划。5 家已是"够打一天电话"的量。 */
export const MIN_COMPANIES_BEFORE_REPLAN = 5;

/** 一轮最多试几个词——每次 probe 都是一次企业库调用，要计费。 */
const MAX_PROBE_TERMS = 4;

/** 开关：默认关闭，与 `AGENT_RESEARCH_BEFORE_DRAFT` 同一套约定。 */
export function replanEnabled(): boolean {
  const value = process.env.AGENT_REPLAN_SEARCH?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export type ReplanInput = {
  /** 销售原话，比如「面包丝」。 */
  product: string;
  /** 系统判定的买家描述，给它一个方向。 */
  buyerDescription: string;
  /** 已经搜过、没搜到东西的词及命中数。 */
  triedTerms: ReadonlyArray<{ term: string; hits: number }>;
  organizationId: string;
  signal?: AbortSignal;
};

export type ReplanResult = {
  /** 建议再搜的词；已过滤掉试过的。 */
  newTerms: string[];
  /** 为什么换这些词（给人看的，不参与逻辑）。 */
  reasoning: string;
  /** 它实际探测了哪些词、成没成功（审计用）。 */
  probes: Array<{ tool: string; ok: boolean }>;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
};

const SYSTEM_PROMPT = [
  "你是新农哥的拓客助手。销售给了一个产品，系统按若干关键词去企业库搜公司，但搜到的太少。",
  "你的任务：换几个更可能搜到公司的关键词。",
  "",
  "你有两个工具：",
  "- search_history：查过去这些词的命中情况（哪些词一直是 0 家）。**先用它**，别重复试死词。",
  "- probe_search(term)：搜一次企业库，只返回命中数量。",
  "",
  "规则：",
  "1. 关键认知：**公司名里不会写产品名**。卖「面包丝」要找的是「烘焙食品」「速冻食品」这类买家行业词。",
  "2. 先查历史，再试新词。历史里命中 0 的词直接放弃，不要浪费 probe 次数。",
  "3. 先试再答。不要凭感觉给词——用 probe_search 试，看到命中数再决定下一个。最多试 4 个。",
  "4. 不要重复已经试过的词。",
  "5. 命中 0 的词说明这个说法在企业库里是死的，换同义或更上位的行业词。",
  "6. 最后只输出 JSON，不要任何其他文字：",
  '   {"newTerms": ["词1", "词2"], "reasoning": "一句话说明为什么换这几个词"}',
  "7. newTerms 给 1-3 个，每个 2-10 个字，是买家行业词而不是产品词。",
].join("\n");

export async function replanSearch(input: ReplanInput): Promise<ReplanResult> {
  // 历史记忆 + 探测：先看哪些词已经证明搜不到，再试新词。
  const tools = registerHistoryTools(registerProspectingTools(new ToolRegistry()));
  const recorder = await startAgentRun({
    // 用独立的 kind 而不是混进 research：否则"调研花了多少钱"的统计会把
    // 重规划算进去，两类开销混在一起就分不清了。
    kind: "replan",
    role: "planner",
    model: null,
    subjectType: "prospect",
    subjectId: null,
    context: {
      product: input.product,
      tried: input.triedTerms.map((item) => `${item.term}:${item.hits}`),
    },
  });

  const userPrompt = [
    `产品：${input.product}`,
    `系统判断的买家：${input.buyerDescription}`,
    "",
    "已经搜过、结果不理想的词（词 → 命中数）：",
    ...input.triedTerms.map((item) => `- ${item.term} → ${item.hits}`),
    "",
    "请先 probe 几个候选词，再给出建议。",
  ].join("\n");

  let result;
  try {
    result = await runPiAgent({
      organizationId: input.organizationId,
      subject: { type: "prospect", id: null },
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      tools,
      // 4 次探测 + 1 次查历史：查历史几乎零成本，但能给探测省掉一整轮浪费。
      maxToolCalls: MAX_PROBE_TERMS + 1,
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

  const parsed = parseReplanOutput(result.text);
  const tried = new Set(input.triedTerms.map((item) => item.term.trim().toLowerCase()));
  return {
    // 双重保险：模型可能仍然给出试过的词，这里再滤一遍。
    newTerms: (parsed?.newTerms ?? []).filter((term) => !tried.has(term.toLowerCase())),
    reasoning: parsed?.reasoning ?? "模型没有给出可用关键词",
    probes: result.toolCalls.map((call) => ({ tool: call.name, ok: call.ok })),
    usage: result.usage,
    stopReason: result.stopReason,
  };
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 为什么要这么宽容：即使提示词说了"只输出 JSON"，模型仍会加上 ```json 围栏、
 * 或先来一句"我试了三个词："。解析失败就整条降级，所以这里尽量捞——
 * 捞不到再返回 null，让调用方保持原结果。
 */
export function parseReplanOutput(text: string): { newTerms: string[]; reasoning: string } | null {
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
  const candidates = Array.isArray(record.newTerms) ? record.newTerms : [];
  // 长度上限按"搜索词"而不是"句子"来定：企业库的搜索词基本是 2-6 个字，
  // 放到 20 字会让模型把一句解释当成词混进来（实测踩过：19 字的长句通过了）。
  const newTerms = [...new Set(
    candidates
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && item.length <= 10),
  )].slice(0, 3);
  if (!newTerms.length) return null;

  const reasoning = typeof record.reasoning === "string"
    ? record.reasoning.trim().slice(0, 200)
    : "";
  return { newTerms, reasoning };
}
