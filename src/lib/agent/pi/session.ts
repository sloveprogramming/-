import "server-only";

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolRegistry } from "../tools";
import { toPiTools } from "./tools";
import { createPiRuntime } from "./runtime";
import { createAgentResourceLoader } from "./resourceLoader";
import { createToolBudgetExtension } from "./toolBudget";
import type { AgentStepEvent, AgentStopReason } from "../events";

/**
 * Pi session 封装：替代原来的 `runAgentLoop`。
 *
 * ## 为什么不用 Pi 的持久化 SessionManager
 *
 * Pi 的 `SessionManager` 默认把会话写成 JSONL 文件（`~/.pi/...`）。这个项目：
 *
 * - 多租户：所有人共用一个进程，文件式存储会串组织
 * - 容器化：没有持久卷，重启就丢
 * - 已有事实来源：`crm_conversation_messages` 已经在存对话
 *
 * 所以用 `SessionManager.inMemory()`，**每次调用新建一个空会话**，
 * 历史由调用方通过 `systemPrompt` / 首条消息注入。这保持了「PostgreSQL 是
 * 唯一事实来源」的设计，也让 Pi 不写任何会话文件到磁盘。
 *
 * ## 安全边界（四条，全部是代码而不是提示词）
 *
 * 1. **`noTools: "builtin"`** —— 关掉 Pi 内置的 `bash` / `edit` / `write` / `read`。
 *    注意不能写 `"all"`：那会把我们自己的 customTools 也关掉（实测后果是
 *    模型发现自己没工具，转而试图调用 bash）。
 * 2. **只注册 read 类工具** —— 通过 `customTools` 只给 4 个查询工具。
 * 3. **destructive 在执行层拒绝** —— 见 tools.ts 的 toPiTool。
 * 4. **工具调用次数硬上限** —— Pi 本身没有步数限制（实测传 maxSteps 无效），
 *    所以用 `tool_call` hook 记账，超限的调用直接 block + terminate。
 *    这是唯一能真正控制成本的机制。
 *
 * ## 观测
 *
 * Pi 的事件流（`session.subscribe`）映射到项目已有的 `AgentStepEvent`，
 * 这样 `observe.ts` 完全不用改就能继续写 `agent_runs` / `agent_events`。
 */

export type PiAgentRunInput = {
  organizationId: string;
  subject: { type: string | null; id: string | null };
  systemPrompt: string;
  userPrompt: string;
  tools: ToolRegistry;
  /**
   * 最多允许几次工具调用。
   *
   * 语义与自研 runtime 的 `maxSteps` 对齐（那是"模型调用轮数"），但实现不同：
   * Pi 没有原生步数限制，这里通过拦截 `tool_call` 实现——超过上限的工具调用
   * 会被 block 并终止本轮。模型调用本身仍可能多一两次（它要消化"被拒绝"这个
   * 结果），但查询次数被硬限制了，成本不会失控。
   */
  maxToolCalls?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentStepEvent) => void;
};

export type PiAgentRunResult = {
  text: string;
  steps: number;
  stopReason: AgentStopReason;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  toolCalls: Array<{ name: string; ok: boolean }>;
  /** 是否因为超过工具调用上限被截断。 */
  truncated: boolean;
};

const DEFAULT_TIMEOUT_MS = 45_000;
/** 默认最多 6 次工具调用：调研场景 4 个工具，查两轮够了。 */
const DEFAULT_MAX_TOOL_CALLS = 6;

/**
 * 跑一次 Pi Agent。
 *
 * 返回结构与原来的 `AgentLoopResult` 对齐，这样 `research.ts` 只需改调用处。
 */
export async function runPiAgent(input: PiAgentRunInput): Promise<PiAgentRunResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxToolCalls = Math.max(1, input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS);
  const { modelRuntime, model } = await createPiRuntime();

  const toolCalls: Array<{ name: string; ok: boolean }> = [];
  let text = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: AgentStopReason = "final_answer";
  let steps = 0;
  let truncated = false;

  const customTools = toPiTools(input.tools, {
    organizationId: input.organizationId,
    subject: input.subject,
  });

  // ---- 工具调用上限：通过内联扩展的 tool_call hook 实现 ----
  //
  // 必须在 createAgentSession 之前建好，因为扩展要在构造时传入。
  // 见 toolBudget.ts 的说明：Pi 没有原生步数限制，这是唯一能控制成本的地方。
  const toolBudget = createToolBudgetExtension(maxToolCalls, () => {
    truncated = true;
    if (stopReason === "final_answer") stopReason = "max_steps";
  });
  const { session } = await createAgentSession({
    // 关掉 Pi 内置的 bash/edit/write/read —— 拓客场景不需要，而且是风险源。
    // 必须用 "builtin" 而不是 "all"：
    //   "all"     = 内置 + 自定义工具全部关掉 → 我们的 4 个工具也失效了（实测）
    //   "builtin" = 只关 Pi 内置的 bash/edit/write/read，保留 customTools
    noTools: "builtin",
    // 只给我们自己的只读工具。
    customTools,
    // 内存会话：不写磁盘，历史由调用方注入。
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    model,
    // systemPrompt 不在 CreateAgentSessionOptions 里，要通过 ResourceLoader 提供。
    // loader 还顺带关掉了所有磁盘发现，避免 AGENTS.md / skills 影响行为。
    resourceLoader: await createAgentResourceLoader(input.systemPrompt, [toolBudget.extension]),
  });


  // Pi 的事件映射到项目已有的 AgentStepEvent（observe.ts 直接能用）。
  const unsubscribe = session.subscribe((event: unknown) => {
    const typed = event as {
      type?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
      message?: { role?: string; usage?: { input?: number; output?: number } };
    };
    switch (typed.type) {
      case "message_update":
        // 累积文本增量；最后仍以 getLastAssistantText 为准。
        if (typed.assistantMessageEvent?.type === "text_delta" && typed.assistantMessageEvent.delta) {
          text += typed.assistantMessageEvent.delta;
        }
        break;
      case "message_end": {
        const messageUsage = typed.message?.usage;
        if (messageUsage) {
          usage.inputTokens += Number(messageUsage.input ?? 0);
          usage.outputTokens += Number(messageUsage.output ?? 0);
        }
        steps += 1;
        input.onEvent?.({
          type: "llm_call",
          step: steps,
          inputTokens: Number(messageUsage?.input ?? 0) || null,
          outputTokens: Number(messageUsage?.output ?? 0) || null,
          durationMs: Date.now() - started,
        });
        break;
      }
      case "tool_execution_start":
        if (typed.toolName) {
          input.onEvent?.({
            type: "tool_call",
            step: Math.max(1, steps),
            tool: typed.toolName,
            input: null,
            durationMs: 0,
            ok: true,
            risk: "read",
          });
        }
        break;
      case "tool_execution_end":
        if (typed.toolName) {
          toolCalls.push({ name: typed.toolName, ok: typed.isError !== true });
          input.onEvent?.({
            type: "tool_result",
            step: Math.max(1, steps),
            tool: typed.toolName,
            ok: typed.isError !== true,
            output: null,
          });
        }
        break;
      default:
        break;
    }
  });

  try {
    // 超时保护：Pi 的 prompt 不一定会自己停，用 abort 兜。
    const timer = setTimeout(() => {
      if (stopReason === "final_answer") stopReason = "model_error";
      void session.abort().catch(() => undefined);
    }, timeoutMs);

    try {
      await session.prompt(input.userPrompt);
    } finally {
      clearTimeout(timer);
    }

    // 用 Pi 记录的最后一条助手消息作为权威结果（比累积 delta 更可靠）。
    const last = session.getLastAssistantText?.();
    if (typeof last === "string" && last.trim()) text = last.trim();
  } catch (error) {
    console.error("[agent/pi] 运行失败：", error instanceof Error ? error.message : error);
    stopReason = input.signal?.aborted ? "aborted" : "model_error";
    throw error;
  } finally {
    unsubscribe?.();
    session.dispose?.();
    input.onEvent?.({ type: "finish", step: Math.max(1, steps), reason: stopReason });
  }

  return {
    text,
    steps: Math.max(1, steps),
    stopReason,
    usage,
    durationMs: Date.now() - started,
    toolCalls,
    truncated,
  };
}
