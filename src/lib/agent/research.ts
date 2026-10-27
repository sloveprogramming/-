import "server-only";

import { z } from "zod";
import { getOpenRouterRuntime } from "@/lib/ai/server/runtime";
import { runAgentLoop, type AgentLoopResult, type ChatRequest, type ChatResponse } from "./runtime";
import { startAgentRun } from "./observe";
import { ToolRegistry } from "./tools";
import { registerCustomerTools } from "./tools/customer";

/**
 * 「先查后写」的起草 Agent。
 *
 * 这是这次改造的核心产物。改造前后对比：
 *
 *   改造前：调用方把上下文攒成一坨塞给模型 → 模型直接写
 *   改造后：给模型四个只读工具 → 它自己决定先查什么 → 查够了再写
 *
 * 为什么要这么做：起草一封回复，真正决定质量的是**它知道多少**。原来的上下
 * 文是调用方猜"模型可能需要什么"攒出来的——猜漏了（比如三周前报过价、客户
 * 上次说过在换供应商），写出来就是外行话。现在模型可以自己伸手去拿。
 *
 * 安全保障：
 * - 工具全是 read 风险，不改数据。
 * - 轮数上限 3：查两轮还不够，说明信息不在库里，继续查是烧钱。
 * - 观测落库：每次运行记录查了什么、花多少 token。
 * - **最终输出仍然走原来的结构化校验**：Agent 只负责"材料准备"，写出来的
 *   东西还是要过 validateDraftOutput，不会因为引入 Agent 而放宽约束。
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
  /** 测试注入。 */
  complete?: (request: ChatRequest) => Promise<ChatResponse>;
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

  let client: unknown = null;
  let model = "unknown";
  let provider: unknown = undefined;

  if (!input.complete) {
    const runtime = await getOpenRouterRuntime(input.requestedModel, 45_000);
    client = runtime.client;
    model = runtime.selection.modelId;
    provider = runtime.provider;
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

  let result: AgentLoopResult;
  try {
    result = await runAgentLoop({
      client: client as never,
      model,
      provider,
      temperature: 0.2,
      maxOutputTokens: 1_500,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      tools,
      context: {
        organizationId: input.organizationId,
        subject: { type: "person", id: input.personId },
        signal: input.signal,
      },
      maxSteps: 3,
      timeoutMs: 45_000,
      signal: input.signal,
      onEvent: (event) => recorder.record(event),
      ...(input.complete ? { complete: input.complete } : {}),
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
    // 撞上限时用 partialText 兜底：总比没有材料强。
    findings: result.text || result.partialText || "",
    lookups: result.toolCalls.map((call) => ({ tool: call.name, ok: call.ok })),
    steps: result.steps,
    stopReason: result.stopReason,
    usage: result.usage,
  };
}
