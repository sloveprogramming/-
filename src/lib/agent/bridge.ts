import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmConversations, crmRecords } from "@/lib/crm/schema";
import { draftChannelConstraints } from "@/lib/crm/ai/draft";
import type { CrmChannel } from "@/lib/crm/schema";
import { researchBeforeDraft } from "./research";

/**
 * 起草前的调研开关与薄封装。
 *
 * 为什么要有开关：Agent 调研是**额外的一次模型调用**（可能 3 轮）。它让草稿更
 * 准，但也更贵更慢。上线初期必须能一键退回老行为，否则出问题只能改代码重发。
 *
 * 开关读环境变量 AGENT_RESEARCH_BEFORE_DRAFT：
 *   - 未设置 / "0" / "false" → 关闭（默认关闭，稳妥）
 *   - "1" / "true" → 开启
 *
 * 为什么默认关闭：现有部署没有 agent_runs 表时不会崩，但如果模型供应商慢，
 * 每次起草多花几秒会让人以为系统卡了。先让运营在设置里确认再开。
 */
export function researchEnabled(): boolean {
  const value = process.env.AGENT_RESEARCH_BEFORE_DRAFT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export type DraftBrief = {
  /** 现有上下文摘要，喂给调研 Agent。 */
  brief: string;
  channel: CrmChannel;
  stepLabel: string;
};

/**
 * 为一次起草做前置调研，返回给写作者的材料。失败时返回空字符串——
 * 调研失败绝不能阻止起草，退回改造前行为即可。
 */
export async function findDraftMaterials(input: {
  personId: string;
  organizationId: string;
  channel: CrmChannel;
  stepLabel: string;
  brief: string;
  requestedModel?: { provider: string; modelId: string };
  signal?: AbortSignal;
}): Promise<string> {
  if (!researchEnabled()) return "";
  try {
    const result = await researchBeforeDraft({
      personId: input.personId,
      organizationId: input.organizationId,
      channel: input.channel,
      stepLabel: input.stepLabel,
      brief: input.brief,
      channelConstraints: draftChannelConstraints(input.channel),
      requestedModel: input.requestedModel,
      signal: input.signal,
    });
    return result.findings;
  } catch (error) {
    console.error("[crm/drafts] 起草前调研失败，退回原有上下文：", error);
    return "";
  }
}

/** 从一条草稿反查它属于哪个联系人和组织，供调研用。 */
export async function draftSubjectOf(
  recordId: string,
): Promise<{ personId: string; organizationId: string; channel: CrmChannel } | null> {
  const [row] = await db
    .select({
      personId: crmRecords.personId,
      organizationId: crmRecords.organizationId,
      channel: crmConversations.channel,
    })
    .from(crmRecords)
    .innerJoin(crmConversations, eq(crmConversations.crmRecordId, crmRecords.id))
    .where(eq(crmRecords.id, recordId))
    .limit(1);
  if (!row) return null;
  return { personId: row.personId, organizationId: row.organizationId, channel: row.channel };
}
