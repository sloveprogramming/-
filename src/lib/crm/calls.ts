import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmEvents, crmRecords } from "@/lib/crm/schema";
import { appendCrmEvent } from "@/lib/crm/events";
import { CrmConflictError, CrmNotFoundError, withCrmTransaction } from "@/lib/crm/repository";
import { lockCrmRecord } from "@/lib/crm/records";
import { inOrg } from "@/lib/tenancy/scope";

/**
 * 通话记录：打完电话，把结果写进 CRM。
 *
 * 这是"名单"和"跟踪"之间最后一段。没有它，销售打完电话的结果只留在一个
 * 页面文本框里，第二条电话打完就忘了第一条说了什么。
 *
 * 事件模型（存在 crm_events，不新开表）：
 *
 *   call.logged        一次通话的结果（接通/未接通、要点、下一步、意向）
 *
 * 为什么不复用 `stage.moved` 推阶段：那个操作要求记录有入站消息（见
 * operations.ts 的 moveRecordStageInTransaction）。纯电话接触的记录没有会话，
 * 硬推会撞上那条约束。所以这里只记事件，**推进阶段由销售在记录页手动决定**——
 * 这也更符合现实：意向是人的判断，不该被一个下拉框自动改写。
 */

export type CallOutcome =
  /** 接通了 */
  | "connected"
  /** 没人接 / 空号 */
  | "unreachable"
  /** 转给了别人 */
  | "transferred"
  /** 前台挡下 */
  | "gatekeeper"
  /** 明确拒绝 */
  | "rejected";

export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  connected: "接通",
  unreachable: "未接通",
  transferred: "已转对接人",
  gatekeeper: "前台挡下",
  rejected: "明确拒绝",
};

/** 通话后对合作意向的判断。只有真接了电话才谈得上有意向。 */
export type CallIntent = "interested" | "needs_follow_up" | "not_interested" | "unknown";

export const CALL_INTENT_LABEL: Record<CallIntent, string> = {
  interested: "有意向",
  needs_follow_up: "需要再跟",
  not_interested: "无意向",
  unknown: "说不清",
};

export type CallLog = {
  id: string;
  recordId: string;
  outcome: CallOutcome;
  intent: CallIntent;
  /** 通话要点，销售自己写。 */
  notes: string | null;
  /** 约定好的下一步。 */
  nextStep: string | null;
  /** 通话时长（秒），可空。 */
  durationSeconds: number | null;
  /** 对方自称的称呼，用来替换"前台"。 */
  contactName: string | null;
  at: string;
};

export type LogCallInput = {
  recordId: string;
  outcome: CallOutcome;
  intent: CallIntent;
  notes?: string | null;
  nextStep?: string | null;
  durationSeconds?: number | null;
  /** 对方说了自己叫什么，顺手改正联系人称呼。 */
  contactName?: string | null;
};

const MAX_NOTES = 2_000;

/**
 * 记一次通话。
 *
 * 校验几件现实里必须成立的事：
 * - 没接通就别标"有意向"（说不通，而且会污染后续跟进优先级）
 * - 明确拒绝必须是"无意向"
 * - 要点有长度上限（一段通话纪要写两千字已经不是纪要了）
 */
export async function logCall(input: LogCallInput): Promise<CallLog> {
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > MAX_NOTES) {
    throw new CrmConflictError(`通话要点最多 ${MAX_NOTES} 字`);
  }
  if (input.outcome === "unreachable" && input.intent !== "unknown") {
    throw new CrmConflictError("电话没接通，不能判断意向");
  }
  if (input.outcome === "rejected" && input.intent !== "not_interested") {
    throw new CrmConflictError("明确拒绝的记录，意向应当是「无意向」");
  }
  const duration = input.durationSeconds;
  if (duration != null && (!Number.isFinite(duration) || duration < 0 || duration > 24 * 3600)) {
    throw new CrmConflictError("通话时长看起来不对");
  }

  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    if (!("workflowState" in record) || record.workflowState === "closed") {
      throw new CrmConflictError("记录已关闭，不能再记通话");
    }

    const event = await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "call.logged",
      actorType: "authenticated_operator",
      toData: {
        outcome: input.outcome,
        intent: input.intent,
        notes,
        nextStep: input.nextStep?.trim() || null,
        durationSeconds: duration ?? null,
        contactName: input.contactName?.trim() || null,
      },
      contextVersion: record.contextVersion,
    });

    return {
      id: event.id,
      recordId: record.id,
      outcome: input.outcome,
      intent: input.intent,
      notes,
      nextStep: input.nextStep?.trim() || null,
      durationSeconds: duration ?? null,
      contactName: input.contactName?.trim() || null,
      at: event.createdAt.toISOString(),
    };
  });
}

/** 读一条记录的通话历史，最新在前。 */
export async function listRecordCalls(recordId: string, limit = 20): Promise<CallLog[]> {
  const rows = await db
    .select({ id: crmEvents.id, crmRecordId: crmEvents.crmRecordId, toData: crmEvents.toData, createdAt: crmEvents.createdAt })
    .from(crmEvents)
    .where(and(inOrg(crmEvents), eq(crmEvents.crmRecordId, recordId), eq(crmEvents.eventType, "call.logged")))
    .orderBy(desc(crmEvents.createdAt))
    .limit(limit);

  return rows.map((row) => {
    const data = (row.toData ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      recordId: row.crmRecordId ?? recordId,
      outcome: (data.outcome as CallOutcome) ?? "connected",
      intent: (data.intent as CallIntent) ?? "unknown",
      notes: (data.notes as string) ?? null,
      nextStep: (data.nextStep as string) ?? null,
      durationSeconds: typeof data.durationSeconds === "number" ? data.durationSeconds : null,
      contactName: (data.contactName as string) ?? null,
      at: row.createdAt.toISOString(),
    };
  });
}

/** 这个人的最近一次通话结论——记录页顶部提示"上次打过了没打通"。 */
export async function lastCallForPerson(personId: string): Promise<CallLog | null> {
  const [latest] = await db
    .select({ id: crmEvents.id, toData: crmEvents.toData, createdAt: crmEvents.createdAt, crmRecordId: crmEvents.crmRecordId })
    .from(crmEvents)
    .where(and(inOrg(crmEvents), eq(crmEvents.personId, personId), eq(crmEvents.eventType, "call.logged")))
    .orderBy(desc(crmEvents.createdAt))
    .limit(1);
  if (!latest) return null;
  const data = (latest.toData ?? {}) as Record<string, unknown>;
  return {
    id: latest.id,
    recordId: latest.crmRecordId ?? "",
    outcome: (data.outcome as CallOutcome) ?? "connected",
    intent: (data.intent as CallIntent) ?? "unknown",
    notes: (data.notes as string) ?? null,
    nextStep: (data.nextStep as string) ?? null,
    durationSeconds: typeof data.durationSeconds === "number" ? data.durationSeconds : null,
    contactName: (data.contactName as string) ?? null,
    at: latest.createdAt.toISOString(),
  };
}

/**
 * 有通话意向的记录清单——销售每天开工先看这个。
 *
 * 只按事件存在与否筛，不猜"意向是否还有效"：意向会过时，但那是销售判断的
 * 事，代码不该替他决定。
 */
export async function recordsWithCallIntent(limit = 50): Promise<Array<{
  recordId: string;
  personId: string;
  intent: CallIntent;
  at: string;
}>> {
  const rows = await db
    .select({ crmRecordId: crmEvents.crmRecordId, personId: crmEvents.personId, toData: crmEvents.toData, createdAt: crmEvents.createdAt })
    .from(crmEvents)
    .where(and(
      inOrg(crmEvents),
      eq(crmEvents.eventType, "call.logged"),
      sql`${crmEvents.toData}->>'intent' IN ('interested', 'needs_follow_up')`,
    ))
    .orderBy(desc(crmEvents.createdAt))
    .limit(limit);

  const seen = new Set<string>();
  const out: Array<{ recordId: string; personId: string; intent: CallIntent; at: string }> = [];
  for (const row of rows) {
    if (!row.crmRecordId || seen.has(row.crmRecordId)) continue;
    seen.add(row.crmRecordId);
    const data = (row.toData ?? {}) as Record<string, unknown>;
    out.push({
      recordId: row.crmRecordId,
      personId: row.personId,
      intent: (data.intent as CallIntent) ?? "unknown",
      at: row.createdAt.toISOString(),
    });
  }
  return out;
}
