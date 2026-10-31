import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { agentEvents, agentRuns, costOf, type AgentEventType, type AgentRunKind, type AgentRunStatus } from "./schema";
import type { AgentStepEvent } from "./events";

/**
 * Agent 运行的落库。
 *
 * 为什么先做这个再做改造：一次回复从"一次模型调用"变成"3-5 次 + 若干工具"，
 * 成本和延迟都会变。没有这份记录，就无法回答"改造后是不是更好了"。
 *
 * 落库是**尽力而为**的：观测失败不能让业务失败。所以每个写库操作都吞掉异常
 * 并打日志——一个 Agent 因为没法记日志而失败，是本末倒置。
 */

export type AgentRunRecorder = {
  runId: string;
  /** 记录一个循环事件（llm_call / tool_call / tool_result / error / finish）。 */
  record: (event: AgentStepEvent) => void;
  /** 收尾：写最终状态、token、成本、耗时。 */
  finish: (result: {
    stopReason: string;
    steps: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    durationMs: number;
    error?: string | null;
  }) => Promise<void>;
};

export async function startAgentRun(input: {
  kind: AgentRunKind;
  model: string | null;
  subjectType: string | null;
  subjectId: string | null;
  context?: Record<string, unknown>;
  /**
   * 同一次业务动作的追踪 id。多角色协作时，所有角色的 run 共享同一个 trace，
   * 这样"一次找客户"在库里是一棵树，而不是一堆孤立的执行记录。
   *
   * 不传时为 null：单次调用的场景（比如分类）不需要 trace 概念。
   */
  traceId?: string | null;
  /** 调起本次执行的上级 run；根节点为 null。 */
  parentRunId?: string | null;
  /** 执行角色（planner / qualifier / researcher …）。历史调用不传即为 null。 */
  role?: string | null;
}): Promise<AgentRunRecorder> {
  const organizationId = currentOrganizationId();
  let runId = "";
  try {
    const [row] = await db
      .insert(agentRuns)
      .values({
        organizationId,
        kind: input.kind,
        status: "running",
        model: input.model,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        traceId: input.traceId ?? null,
        parentRunId: input.parentRunId ?? null,
        role: input.role ?? null,
        context: input.context ?? {},
      })
      .returning({ id: agentRuns.id });
    runId = row?.id ?? "";
  } catch (error) {
    console.error("[agent/observe] 创建运行记录失败：", error);
  }

  let seq = 0;
  const pending: Array<Promise<unknown>> = [];

  return {
    runId,
    record(event) {
      if (!runId) return;
      const row = toEventRow(organizationId, runId, (seq += 1), event);
      if (!row) return;
      // 不 await：观测不该拖慢每一次工具调用。收尾时统一等它们。
      pending.push(
        db.insert(agentEvents).values(row).catch((error) => {
          console.error("[agent/observe] 写入事件失败：", error);
        }),
      );
    },
    async finish(result) {
      await Promise.allSettled(pending);
      if (!runId) return;
      const cost = costOf(input.model, result.inputTokens, result.outputTokens);
      const status: AgentRunStatus = result.error
        ? "failed"
        : result.stopReason === "aborted"
          ? "aborted"
          : "completed";
      try {
        await db
          .update(agentRuns)
          .set({
            status,
            steps: result.steps,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            // 价格未知时记 0 且不误判——上下文里已经留了模型名，事后可回算。
            costUsd: (cost ?? 0).toFixed(6),
            toolCalls: result.toolCalls,
            durationMs: result.durationMs,
            error: result.error ?? null,
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, runId));
      } catch (error) {
        console.error("[agent/observe] 收尾失败：", error);
      }
    },
  };
}


function toEventRow(
  organizationId: string,
  runId: string,
  seq: number,
  event: AgentStepEvent,
): typeof agentEvents.$inferInsert | null {
  switch (event.type) {
    case "llm_call":
      return {
        organizationId,
        runId,
        seq,
        type: "llm_call" satisfies AgentEventType,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        durationMs: event.durationMs,
      };
    case "tool_call":
      return {
        organizationId,
        runId,
        seq,
        type: "tool_call" satisfies AgentEventType,
        tool: event.tool,
        payload: { input: event.input, risk: event.risk },
        durationMs: event.durationMs,
        ok: event.ok,
      };
    case "tool_result":
      return {
        organizationId,
        runId,
        seq,
        type: "tool_result" satisfies AgentEventType,
        tool: event.tool,
        payload: { output: event.output },
        ok: event.ok,
      };
    case "error":
      return {
        organizationId,
        runId,
        seq,
        type: "error" satisfies AgentEventType,
        payload: { message: event.message },
        ok: false,
      };
    case "finish":
      return {
        organizationId,
        runId,
        seq,
        type: "finish" satisfies AgentEventType,
        payload: { reason: event.reason },
        ok: event.reason === "final_answer",
      };
    default:
      return null;
  }
}
