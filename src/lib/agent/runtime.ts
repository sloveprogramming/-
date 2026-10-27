import "server-only";

import type OpenAI from "openai";
import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolRegistry, ToolRisk } from "./tools";

/**
 * Agent 主循环：模型 → 调工具 → 把结果喂回去 → 再问模型，直到它给出最终答案。
 *
 * 这就是"从一次问答升级成会自己查资料"的核心。循环本身要守住四条边界，
 * 否则它会变成一个烧钱且不可预测的东西：
 *
 * 1. **轮数上限**（默认 4）。查两轮还不够，说明这个任务的信息根本不在工具里，
 *    继续查只是烧钱。
 * 2. **工具白名单**。只有 registry 里登记过的工具能被调用，模型编造一个
 *    不存在的名字会得到明确的"工具不存在"回执，而不是崩溃。
 * 3. **风险分级**。destructive 工具在循环里直接拒绝，回执告诉模型"这需要人工
 *    审批"，让它换个方式表达，而不是真去删东西。
 * 4. **单工具超时 + 失败不中断**。一个工具挂了不该让整次执行失败——把错误
 *    作为工具结果回灌给模型，它往往能换个查法。
 *
 * 参数校验用 zod：模型给错参就回一条"参数不对，正确形状是…"，它通常第二次就对。
 */

export type AgentLoopMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type AgentToolCall = { id: string; name: string; arguments: string };

export type AgentStepEvent =
  | { type: "llm_call"; step: number; inputTokens: number | null; outputTokens: number | null; durationMs: number }
  | { type: "tool_call"; step: number; tool: string; input: unknown; durationMs: number; ok: boolean; risk: ToolRisk }
  | { type: "tool_result"; step: number; tool: string; ok: boolean; output: unknown }
  | { type: "error"; step: number; message: string }
  | { type: "finish"; step: number; reason: AgentStopReason };

export type AgentStopReason =
  /** 模型给出了不含工具调用的答案。 */
  | "final_answer"
  /** 撞到轮数上限。 */
  | "max_steps"
  /** 模型想调一个不允许的工具，且没有别的动作。 */
  | "tool_refused"
  /** 模型调用失败且不可重试。 */
  | "model_error"
  /** 外部取消。 */
  | "aborted";

export type AgentLoopInput = {
  /** 已建好的 OpenAI 兼容客户端（复用现有 OpenRouter 那套）。 */
  client: OpenAI;
  model: string;
  provider?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  systemPrompt: string;
  /** 首轮用户消息。工具结果会追加在它后面。 */
  userPrompt: string;
  tools: ToolRegistry;
  context: ToolExecutionContext;
  maxSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 每个事件都会回调一次，供观测层落库。 */
  onEvent?: (event: AgentStepEvent) => void;
  /** 测试注入：替换 client.chat.completions.create。 */
  complete?: (request: ChatRequest) => Promise<ChatResponse>;
};

export type ChatRequest = {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  tool_choice: "auto";
  temperature?: number;
  max_tokens?: number;
  provider?: unknown;
};

export type ChatResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export type AgentLoopResult = {
  /** 模型最后的文本答案；撞上限或拒绝时可能为空。 */
  text: string;
  /** 循环过程中所有的工具调用记录，便于审计"它查了什么"。 */
  toolCalls: Array<{ name: string; input: unknown; ok: boolean; output: unknown }>;
  steps: number;
  stopReason: AgentStopReason;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  /** 达到上限但还没给出答案时，带上最后一次的文本，便于上层兜底。 */
  partialText: string | null;
};

const DEFAULT_MAX_STEPS = 4;
const DEFAULT_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 10_000;
/** 工具输出回灌给模型前截断：一次 SQL 查询的完整结果可能有几十 KB。 */
const MAX_TOOL_OUTPUT_CHARS = 4_000;

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const maxSteps = Math.max(1, input.maxSteps ?? DEFAULT_MAX_STEPS);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const deadline = started + timeoutMs;

  const messages: AgentLoopMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.userPrompt },
  ];
  const specs = input.tools.specs();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: AgentLoopResult["toolCalls"] = [];
  let partialText: string | null = null;
  let step = 0;

  const complete = input.complete ?? ((request: ChatRequest) => defaultComplete(input.client, request, input.signal));

  for (step = 1; step <= maxSteps; step += 1) {
    if (input.signal?.aborted) {
      emit(input, { type: "finish", step: step - 1, reason: "aborted" });
      return finish("aborted", "");
    }
    if (Date.now() > deadline) {
      emit(input, { type: "error", step, message: "Agent 超过了总超时" });
      return finish("model_error", partialText ?? "");
    }

    const llmStarted = Date.now();
    let response: ChatResponse;
    try {
      response = await withTimeout(
        complete({
          model: input.model,
          messages: toWireMessages(messages),
          tools: specs as unknown as Array<Record<string, unknown>>,
          tool_choice: "auto",
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.maxOutputTokens !== undefined ? { max_tokens: input.maxOutputTokens } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
        }),
        Math.max(1_000, deadline - Date.now()),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(input, { type: "error", step, message });
      return finish("model_error", partialText ?? "");
    }

    const turnUsage = {
      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
    };
    usage.inputTokens += turnUsage.inputTokens ?? 0;
    usage.outputTokens += turnUsage.outputTokens ?? 0;
    emit(input, { type: "llm_call", step, ...turnUsage, durationMs: Date.now() - llmStarted });

    const message = response.choices?.[0]?.message;
    const text = (message?.content ?? "").trim();
    if (text) partialText = text;
    const calls = (message?.tool_calls ?? []).flatMap((call) => {
      const name = call.function?.name;
      if (!name) return [];
      return [{ id: call.id ?? `call_${step}_${name}`, name, arguments: call.function?.arguments ?? "{}" }];
    });

    if (!calls.length) {
      emit(input, { type: "finish", step, reason: "final_answer" });
      return finish("final_answer", text);
    }

    messages.push({ role: "assistant", content: text || null, toolCalls: calls });

    let executedAny = false;
    for (const call of calls) {
      const tool = input.tools.get(call.name);
      if (!tool) {
        // 模型编了一个不存在的工具：明确回执，别让它继续猜。
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: `工具不存在：${call.name}。可用工具：${input.tools.specs().map((s) => s.function.name).join("、") || "（无）"}`,
        });
        emit(input, { type: "error", step, message: `模型调用了未登记的工具：${call.name}` });
        continue;
      }
      executedAny = true;
      const result = await executeTool(tool, call, input.context, step, input);
      toolCalls.push({ name: call.name, input: result.input, ok: result.ok, output: result.output });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.content });
    }

    if (!executedAny && step === maxSteps) {
      emit(input, { type: "finish", step, reason: "tool_refused" });
      return finish("tool_refused", partialText ?? "");
    }
  }

  // 循环正常结束意味着步数用满了：for 循环退出时 step 会多 1，这里拉回来，
  // 否则观测表里记的"模型调用轮数"会比实际多一轮。
  step = maxSteps;
  emit(input, { type: "finish", step: maxSteps, reason: "max_steps" });
  return finish("max_steps", partialText ?? "");

  function finish(stopReason: AgentStopReason, text: string): AgentLoopResult {
    return {
      text,
      toolCalls,
      steps: step,
      stopReason,
      usage,
      durationMs: Date.now() - started,
      partialText: stopReason === "final_answer" ? null : partialText,
    };
  }
}

async function executeTool(
  tool: ToolDefinition,
  call: AgentToolCall,
  context: ToolExecutionContext,
  step: number,
  input: AgentLoopInput,
): Promise<{ ok: boolean; input: unknown; output: unknown; content: string }> {
  const started = Date.now();
  let parsedInput: unknown = null;

  // 风险分级：destructive 在循环里一律拒绝，要求走人工审批。
  if (tool.risk === "destructive") {
    const output = { refused: true, reason: "这个操作需要人工审批，Agent 不能直接执行。" };
    emit(input, { type: "tool_call", step, tool: tool.name, input: null, durationMs: 0, ok: false, risk: tool.risk });
    emit(input, { type: "tool_result", step, tool: tool.name, ok: false, output });
    return { ok: false, input: null, output, content: JSON.stringify(output) };
  }

  let args: unknown;
  try {
    args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    const output = { error: "参数不是合法 JSON。请只输出 JSON 对象，不要加注释或多余文本。" };
    emit(input, { type: "tool_call", step, tool: tool.name, input: null, durationMs: 0, ok: false, risk: tool.risk });
    emit(input, { type: "tool_result", step, tool: tool.name, ok: false, output });
    return { ok: false, input: null, output, content: JSON.stringify(output) };
  }

  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    parsedInput = args;
    const output = {
      error: "参数不符合工具定义。",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
    emit(input, { type: "tool_call", step, tool: tool.name, input: parsedInput, durationMs: 0, ok: false, risk: tool.risk });
    emit(input, { type: "tool_result", step, tool: tool.name, ok: false, output });
    return { ok: false, input: parsedInput, output, content: truncate(JSON.stringify(output)) };
  }

  parsedInput = parsed.data;
  try {
    const output = await withTimeout(
      tool.execute(parsed.data, context),
      tool.timeoutMs ?? TOOL_TIMEOUT_MS,
    );
    const durationMs = Date.now() - started;
    emit(input, { type: "tool_call", step, tool: tool.name, input: parsedInput, durationMs, ok: true, risk: tool.risk });
    emit(input, { type: "tool_result", step, tool: tool.name, ok: true, output: summarize(output) });
    return { ok: true, input: parsedInput, output: summarize(output), content: truncate(JSON.stringify(output ?? null)) };
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const output = { error: message };
    emit(input, { type: "tool_call", step, tool: tool.name, input: parsedInput, durationMs, ok: false, risk: tool.risk });
    emit(input, { type: "tool_result", step, tool: tool.name, ok: false, output });
    // 工具失败也回灌给模型，它通常能换个查法。
    return { ok: false, input: parsedInput, output, content: truncate(JSON.stringify(output)) };
  }
}

function toWireMessages(messages: AgentLoopMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
      return {
        role: "assistant",
        content: message.content ?? "",
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

function emit(input: AgentLoopInput, event: AgentStepEvent): void {
  input.onEvent?.(event);
}

/** 只保留工具输出的摘要给事件层，落库不至于爆炸。 */
function summarize(output: unknown): unknown {
  const text = JSON.stringify(output ?? null);
  if (text.length <= 1_000) return output;
  return { truncated: true, preview: text.slice(0, 1_000), length: text.length };
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…（输出过长，已截断，共 ${text.length} 字符）`;
}

async function defaultComplete(client: OpenAI, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  return client.chat.completions.create(request as never, signal ? { signal } : {}) as unknown as ChatResponse;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时（${ms}ms）`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
