/**
 * Agent 的事件与状态类型。
 *
 * 这些类型原本定义在自研的 `runtime.ts` 里；迁移到 Pi SDK 之后，循环本身
 * 交给 Pi，但**观测层仍然需要同一套事件形状**（`observe.ts` 把事件写进
 * `agent_runs` / `agent_events`）。所以类型抽出来单独放，成为两边共用的契约。
 *
 * 这也是把 Agent 运行时换成 Pi 之后唯一保留的"自研部分"——事件模型是业务
 * 概念（我们要按 run 归因成本和工具调用），不是框架该决定的。
 */

/** Pi 的一次步骤事件，映射成这个项目的事件模型。 */
export type AgentStepEvent =
  | { type: "llm_call"; step: number; inputTokens: number | null; outputTokens: number | null; durationMs: number }
  | { type: "tool_call"; step: number; tool: string; input: unknown; durationMs: number; ok: boolean; risk: AgentToolRisk }
  | { type: "tool_result"; step: number; tool: string; ok: boolean; output: unknown }
  | { type: "error"; step: number; message: string }
  | { type: "finish"; step: number; reason: AgentStopReason };

/** 工具风险等级（与 tools.ts 的 ToolRisk 对应，这里避免循环依赖）。 */
export type AgentToolRisk = "read" | "write" | "destructive";

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
