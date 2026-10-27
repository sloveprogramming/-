import "server-only";

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { appendCrmEvent } from "@/lib/crm/events";
import { CrmConflictError, CrmNotFoundError, type CrmTransaction, withCrmTransaction } from "@/lib/crm/repository";
import { lockCrmRecord } from "@/lib/crm/records";
import { crmEvents, crmPipelines, crmSubcategories } from "@/lib/crm/schema";
import { inOrg } from "@/lib/tenancy/scope";
import {
  VISIT_ALLOWED_NEXT,
  VISIT_STATUS_LABEL,
  visitEventToStatus,
  type Visit,
  type VisitEventType,
  type VisitOutcome,
  type VisitStatus,
} from "./visitTypes";

/**
 * 拜访管理（服务端）。
 *
 * 改造新增：上一版完全没有这块——销售见完客户只能手动把阶段改成「已见面」，
 * 再补一条备注。那不是拜访管理，是改个字段。
 *
 * 这里的拜访是一个有结构的过程：
 *
 *   计划 → 到场 → 结束（纪要 + 下一步 + 结果）
 *            ↘ 取消（原因）
 *
 * 为什么不新开一张表：`crm_events` 已经是「这个客户发生过什么」的通用记录，
 * 拜访只是其中一种事件。新表要处理跨表一致性、改时间线渲染、写迁移，收益只是
 * 字段更整齐。用事件表 + 约定好的 payload 形状，记录页的时间线天然就能显示。
 *
 * 状态从事件里推出来，不存冗余字段——避免"状态字段说已结束，但事件里还没结束"
 * 这种自相矛盾的数据。
 *
 * 类型与文案在 ./visitTypes（客户端安全），这里重导出，服务端调用方不用改 import。
 */
export { VISIT_EVENTS, VISIT_STATUS_LABEL, VISIT_OUTCOME_LABEL, VISIT_ALLOWED_NEXT, visitEventToStatus } from "./visitTypes";
export type { Visit, VisitEventType, VisitStatus, VisitOutcome } from "./visitTypes";

/** 安排一次拜访。 */
export async function planVisit(input: {
  recordId: string;
  scheduledAt: string;
  location?: string | null;
  purpose?: string | null;
}): Promise<{ visitId: string }> {
  const scheduledAt = input.scheduledAt?.trim();
  if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) {
    throw new CrmConflictError("拜访时间格式不对");
  }
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    if (record.workflowState === "closed") throw new CrmConflictError("记录已关闭，不能再安排拜访");

    const event = await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "visit.planned",
      actorType: "authenticated_operator",
      toData: {
        scheduledAt,
        location: input.location?.trim() || null,
        purpose: input.purpose?.trim() || null,
      },
      contextVersion: record.contextVersion,
    });
    return { visitId: event.id };
  });
}

/** 到场签到。 */
export async function checkInVisit(visitId: string, at: string = new Date().toISOString()): Promise<void> {
  await transitionVisit(visitId, "visit.checked_in", { checkedInAt: at });
}

/** 结束拜访。纪要必填——没有纪要的拜访等于没发生。 */
export async function completeVisit(input: {
  visitId: string;
  notes: string;
  nextStep?: string | null;
  outcome: VisitOutcome;
  completedAt?: string;
}): Promise<void> {
  const notes = input.notes.trim();
  if (!notes) throw new CrmConflictError("见面纪要不能为空");
  await transitionVisit(input.visitId, "visit.completed", {
    completedAt: input.completedAt ?? new Date().toISOString(),
    notes,
    nextStep: input.nextStep?.trim() || null,
    outcome: input.outcome,
  });
}

/** 取消拜访。原因必填。 */
export async function cancelVisit(visitId: string, reason: string): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new CrmConflictError("取消要写原因");
  await transitionVisit(visitId, "visit.cancelled", { cancelledReason: trimmed });
}

/** 从事件表推出一个拜访的当前状态。 */
async function currentVisitStatus(tx: CrmTransaction, visitId: string): Promise<VisitStatus> {
  const [latest] = await tx
    .select({ eventType: crmEvents.eventType })
    .from(crmEvents)
    .where(and(
      inOrg(crmEvents),
      inArray(crmEvents.eventType, ["visit.checked_in", "visit.completed", "visit.cancelled"]),
      sql`${crmEvents.toData}->>'visitId' = ${visitId}`,
    ))
    .orderBy(desc(crmEvents.createdAt))
    .limit(1);
  return latest ? visitEventToStatus(latest.eventType as VisitEventType) : "planned";
}

/**
 * 推进拜访状态。
 *
 * 校验状态机是必须的：没有它，时间线上会出现"先结束再签到"这种脏数据，
 * 而这类数据会让后面的统计（平均停留时长、到场率）全部失真。
 */
async function transitionVisit(
  visitId: string,
  eventType: VisitEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  return withCrmTransaction(async (tx) => {
    const [plan] = await tx
      .select({ event: crmEvents })
      .from(crmEvents)
      .where(and(inOrg(crmEvents), eq(crmEvents.id, visitId), eq(crmEvents.eventType, "visit.planned")))
      .limit(1)
      .for("update");
    if (!plan) throw new CrmNotFoundError("拜访", visitId);

    const status = await currentVisitStatus(tx, visitId);
    if (!VISIT_ALLOWED_NEXT[status].includes(eventType)) {
      throw new CrmConflictError(
        `这个拜访现在是「${VISIT_STATUS_LABEL[status]}」，不能再改成「${VISIT_STATUS_LABEL[visitEventToStatus(eventType)]}」`,
      );
    }

    await appendCrmEvent(tx, {
      personId: plan.event.personId,
      crmRecordId: plan.event.crmRecordId,
      pipelineId: plan.event.pipelineId,
      eventType,
      actorType: "authenticated_operator",
      fromData: { status },
      toData: { visitId, ...payload },
      contextVersion: plan.event.contextVersion,
    });
  });
}

type VisitUpdate = { eventType: VisitEventType; toData: Record<string, unknown> | null; createdAt: Date };

/** 把一批拜访的计划事件与它们的后续事件拼成 Visit。 */
function assembleVisits(
  plans: Array<{ event: typeof crmEvents.$inferSelect; personName: string | null; companyName: string | null }>,
  updates: VisitUpdate[],
): Visit[] {
  const byVisit = new Map<string, VisitUpdate[]>();
  for (const update of updates) {
    const visitId = String(update.toData?.visitId ?? "");
    if (!visitId) continue;
    byVisit.set(visitId, [...(byVisit.get(visitId) ?? []), update]);
  }

  return plans.map(({ event, personName, companyName }) => {
    const plan = (event.toData ?? {}) as Record<string, unknown>;
    const history = byVisit.get(event.id) ?? [];
    // 降序：第一条就是最新状态。
    const latest = history[0];
    const status: VisitStatus = latest ? visitEventToStatus(latest.eventType) : "planned";
    const findData = (type: VisitEventType): Record<string, unknown> => {
      const hit = history.find((entry) => entry.eventType === type);
      return (hit?.toData ?? {}) as Record<string, unknown>;
    };
    const checkedIn = findData("visit.checked_in");
    const completed = findData("visit.completed");
    const cancelled = findData("visit.cancelled");
    return {
      id: event.id,
      recordId: event.crmRecordId ?? "",
      personId: event.personId,
      personName,
      companyName,
      status,
      scheduledAt: (plan.scheduledAt as string) ?? null,
      checkedInAt: (checkedIn.checkedInAt as string) ?? null,
      completedAt: (completed.completedAt as string) ?? null,
      location: (plan.location as string) ?? null,
      purpose: (plan.purpose as string) ?? null,
      notes: (completed.notes as string) ?? null,
      nextStep: (completed.nextStep as string) ?? null,
      outcome: (completed.outcome as VisitOutcome) ?? null,
      cancelledReason: (cancelled.cancelledReason as string) ?? null,
      updatedAt: (latest?.createdAt ?? event.createdAt).toISOString(),
    };
  });
}

/** 列出拜访，按约定时间倒序。 */
export async function listVisits(input: { from?: string; to?: string; limit?: number } = {}): Promise<Visit[]> {
  const plans = await db
    .select({ event: crmEvents, personName: people.fullName, companyName: companies.name })
    .from(crmEvents)
    .innerJoin(people, eq(people.id, crmEvents.personId))
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(and(
      inOrg(crmEvents),
      eq(crmEvents.eventType, "visit.planned"),
      input.from ? gte(crmEvents.createdAt, new Date(input.from)) : undefined,
      input.to ? lte(crmEvents.createdAt, new Date(input.to)) : undefined,
    ))
    .orderBy(desc(crmEvents.createdAt))
    .limit(input.limit ?? 100);

  if (!plans.length) return [];

  // 只取这些拜访的后续事件。用 jsonb 的 ->'visitId' 过滤，避免全表扫。
  const ids = plans.map((row) => row.event.id);
  const updates = await db
    .select({ eventType: crmEvents.eventType, toData: crmEvents.toData, createdAt: crmEvents.createdAt })
    .from(crmEvents)
    .where(and(
      inOrg(crmEvents),
      inArray(crmEvents.eventType, ["visit.checked_in", "visit.completed", "visit.cancelled"]),
      sql`${crmEvents.toData}->>'visitId' IN ${ids}`,
    ))
    .orderBy(desc(crmEvents.createdAt));

  return assembleVisits(plans, updates as VisitUpdate[]);
}

/** 某条记录的拜访（记录页用）。 */
export async function listRecordVisits(recordId: string): Promise<Visit[]> {
  const all = await listVisits({ limit: 300 });
  return all.filter((visit) => visit.recordId === recordId);
}

/**
 * 「已见面」这个阶段。拜访结束时销售最容易忘的就是推进记录——
 * 提示他直接点一下，比让他自己去漏斗里找省一步。
 *
 * crm_subcategories 挂在 pipeline 下、自己没有 organizationId，所以作用域要
 * 通过 pipeline 关联来限定（这是这个库里"继承式作用域"的常规做法）。
 */
export async function meetingDoneStage(): Promise<{ id: string; key: string } | null> {
  const [row] = await db
    .select({ id: crmSubcategories.id, key: crmSubcategories.key })
    .from(crmSubcategories)
    .innerJoin(crmPipelines, eq(crmPipelines.id, crmSubcategories.pipelineId))
    .where(and(
      inOrg(crmPipelines),
      eq(crmSubcategories.key, "meeting_done"),
      eq(crmSubcategories.active, true),
    ))
    .limit(1);
  return row ?? null;
}
