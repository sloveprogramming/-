/**
 * Agent 运行观测：一次 Agent 执行、它调过的每个工具、以及 token 与成本。
 *
 * 为什么要先建这张表再做 Agent：改造后一次回复可能触达 3-5 次模型调用，
 * 没有观测就不知道"变好了还是变贵了"。先有尺子再改东西。
 *
 * 设计取舍：
 * - `agent_runs` 一次执行一行，`agent_events` 一次动作一行（llm_call / tool_call / error）。
 *   两个粒度分开，是因为"这次跑了多久、花了多少"和"它到底干了什么"是两类问题。
 * - 工具参数与结果都存，但对超长输出做截断（同简历里说的"超长 Tool 输出裁剪"）。
 * - 成本用表里的单价快照计算，不依赖运行时配置，历史数据不会因为改价而失真。
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
  boolean,
} from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * 一次执行属于哪类工作。
 *
 * `replan` 是拓客场景的重规划（搜到的公司太少时换词重搜）。单独列出来而不是
 * 混进 `research`：否则"调研花了多少钱"的统计会把两类开销算在一起，分不清
 * 是哪条链在烧钱。
 */
export type AgentRunKind = "classify" | "draft" | "research" | "replan" | "qualify";
export type AgentRunStatus = "running" | "completed" | "failed" | "aborted";

/** 一次 Agent 执行。 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().$type<AgentRunKind>(),
    /**
     * 一次业务动作的追踪 id：同一次"找客户"里所有角色的执行共享一个 trace。
     *
     * 不用外键，因为 trace 的发起方可能不是 Agent（比如确定性流水线），
     * 它只是给一组 run 打的标签。
     */
    traceId: uuid("trace_id"),
    /** 谁调起了这次执行。为空表示是根节点（用户直接触发）。 */
    parentRunId: uuid("parent_run_id"),
    /** 执行角色，与 artifacts.ts 的 AgentRole 对应（历史数据为空）。 */
    role: text("role"),
    status: text("status").notNull().default("running").$type<AgentRunStatus>(),
    /** 关联的业务对象：crm_record / crm_conversation 等。 */
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    model: text("model"),
    /** 模型调用轮数（工具循环跑了几圈）。 */
    steps: integer("steps").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    /** 工具调用总次数，便于"平均几轮工具才够用"这类分析。 */
    toolCalls: integer("tool_calls").notNull().default(0),
    durationMs: integer("duration_ms"),
    error: text("error"),
    /** 本次执行的关键输入摘要，便于复现（不含敏感内容）。 */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_runs_org_started_idx").on(t.organizationId, t.startedAt),
    index("agent_runs_subject_idx").on(t.subjectType, t.subjectId),
    index("agent_runs_trace_idx").on(t.traceId),
    index("agent_runs_parent_idx").on(t.parentRunId),
  ],
);

/**
 * 角色之间传递的结构化产物。
 *
 * 为什么不复用 `agent_runs.context`：那是"本次执行的输入摘要"，一次执行一行；
 * 而 artifact 是"交给下游的东西"，一次 trace 会有多条，且要按顺序回放。
 * 混在一起会让"这次到底产出了什么"变得难查。
 *
 * 为什么不给它外键指向 agent_runs：产物可能是确定性代码写的（比如打分），
 * 那时根本没有对应的 Agent 执行记录。用 `trace_id` 聚合就够，且不会因为
 * 某条 run 被清理而丢掉产物。
 */
export const agentArtifacts = pgTable(
  "agent_artifacts",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    /** 同一次业务动作的追踪 id。 */
    traceId: uuid("trace_id").notNull(),
    /** 产出角色（planner / qualifier / …）。 */
    role: text("role").notNull(),
    /** 产物种类（plan / sourcing / qualification / …）。 */
    kind: text("kind").notNull(),
    /** 同 trace 内的顺序，便于按流程回放。 */
    seq: integer("seq").notNull(),
    /** 已通过 zod 校验的 payload。 */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_artifacts_trace_idx").on(t.organizationId, t.traceId, t.seq),
    index("agent_artifacts_kind_idx").on(t.kind),
  ],
);

export type AgentEventType = "llm_call" | "tool_call" | "tool_result" | "error" | "finish";

/** 一次执行里的一个动作。 */
export const agentEvents = pgTable(
  "agent_events",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull().$type<AgentEventType>(),
    /** 工具名；非工具事件为 null。 */
    tool: text("tool"),
    /** 事件负载：模型响应摘要、工具入参、工具输出（已截断）。 */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    /** 工具调用是否成功；非工具事件为 null。 */
    ok: boolean("ok"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_events_run_seq_idx").on(t.runId, t.seq)],
);

/** 模型单价快照（美元 / 1K tokens），用于把 usage 折算成成本。 */
export type ModelPrice = { inputPer1k: number; outputPer1k: number };

/**
 * 已知模型的单价。命中不了时按 0 算，并在事件里标 `priced: false`，
 * 免得把未知价格当成"免费"而误判优化效果。
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "deepseek/deepseek-chat": { inputPer1k: 0.00014, outputPer1k: 0.00028 },
  "deepseek/deepseek-v3": { inputPer1k: 0.00014, outputPer1k: 0.00028 },
  "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "qwen/qwen-plus": { inputPer1k: 0.0004, outputPer1k: 0.0012 },
};

/** 按模型名找单价，忽略 provider 前缀差异。 */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  if (MODEL_PRICES[normalized]) return MODEL_PRICES[normalized];
  const tail = normalized.split("/").pop() ?? normalized;
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (key.toLowerCase().endsWith(`/${tail}`) || key.toLowerCase() === tail) return price;
  }
  return null;
}

/** tokens → 美元。价格未知时返回 null（区别于 0）。 */
export function costOf(model: string | null | undefined, inputTokens: number, outputTokens: number): number | null {
  const price = priceFor(model);
  if (!price) return null;
  return (inputTokens / 1000) * price.inputPer1k + (outputTokens / 1000) * price.outputPer1k;
}
