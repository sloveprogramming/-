import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes } from "./schema";
import { inboundEvents } from "@/lib/inbox/schema";
import { createStepLogger } from "@/lib/debugLog";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { describeImapError, fetchNewImapMessages, imapConfigForMailbox } from "./imap";
import { ingestGmailReply } from "./replyBridge";

/**
 * 企业邮箱的入站同步（IMAP 轮询）。
 *
 * 和 Gmail 那条路的分工：
 *   Gmail    → Pub/Sub 推送触发 gmailSync → replyBridge
 *   企业邮箱 → 定时任务每几分钟扫一次 imapSync → 同一个 replyBridge
 *
 * 也就是说客户从哪个邮箱回复，都进同一条分类/建记录/起草的管线；差别只在
 * "怎么知道有新邮件"。
 */

export type ImapSyncResult = { synced: number; error?: string };

/** 同步一个邮箱。调用方负责已经打开该邮箱所属组织的作用域。 */
export async function syncMailboxInboxImap(mailboxId: string): Promise<ImapSyncResult> {
  const [mailbox] = await db.select().from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId))).limit(1);
  if (!mailbox || mailbox.provider !== "smtp" || mailbox.status !== "connected") return { synced: 0 };

  const config = imapConfigForMailbox(mailbox);
  if (!config) return { synced: 0, error: "imap_not_configured" };

  let batch;
  try {
    batch = await fetchNewImapMessages(config, mailbox.lastImapUid);
  } catch (error) {
    const message = describeImapError(error);
    await db
      .update(mailboxes)
      .set({ lastError: `收信失败：${message}`, updatedAt: new Date() })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
    return { synced: 0, error: message };
  }

  let synced = 0;
  for (const msg of batch.messages) {
    const log = createStepLogger();
    log.info(`IMAP 收到邮件 ${msg.gmailMessageId}（来自 ${msg.fromEmail ?? "未知"}），开始处理`);
    try {
      const result = await ingestGmailReply(mailbox.emailAddress, msg, log);
      log.finish(result.skipped ? "skipped" : "ok");
      await db.insert(inboundEvents).values({
        organizationId: currentOrganizationId(),
        source: "imap",
        eventType: "inbound_message",
        title: msg.fromName || msg.fromEmail || null,
        status: log.status,
        steps: log.steps,
        payload: msg as unknown as object,
        processed: true,
      });
      if (!result.skipped) synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(message);
      log.finish("error");
      await db.insert(inboundEvents).values({
        organizationId: currentOrganizationId(),
        source: "imap",
        eventType: "inbound_message",
        title: msg.fromName || msg.fromEmail || null,
        status: log.status,
        steps: log.steps,
        payload: msg as unknown as object,
        processed: false,
        error: message,
      });
    }
  }

  // 游标只在整批处理完之后推进：中途失败的话下一轮还会重试同一批，
  // 而 replyBridge 本身是幂等的（同一 Message-ID 不会建两条回复）。
  if (batch.newUid !== null && batch.newUid !== mailbox.lastImapUid) {
    await db
      .update(mailboxes)
      .set({ lastImapUid: batch.newUid, lastError: null, updatedAt: new Date() })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
  }

  return { synced };
}

export type ImapInboxSyncRun = { organizations: number; mailboxes: number; synced: number; failed: number };

/**
 * 全平台的收信扫描，给定时任务用：每个组织各自开作用域，互不影响。
 * 一个邮箱失败不拖累其它邮箱。
 */
export async function runImapInboxSync(): Promise<ImapInboxSyncRun> {
  const total: ImapInboxSyncRun = { organizations: 0, mailboxes: 0, synced: 0, failed: 0 };
  const rows = await db
    .selectDistinct({ organizationId: mailboxes.organizationId, id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.provider, "smtp"), eq(mailboxes.status, "connected")));

  const byOrg = new Map<string, string[]>();
  for (const row of rows) {
    byOrg.set(row.organizationId, [...(byOrg.get(row.organizationId) ?? []), row.id]);
  }
  total.organizations = byOrg.size;
  total.mailboxes = rows.length;

  for (const [organizationId, ids] of byOrg) {
    try {
      const part = await runInOrganization(organizationId, async () => {
        let synced = 0;
        let failed = 0;
        for (const id of ids) {
          const result = await syncMailboxInboxImap(id);
          synced += result.synced;
          if (result.error) failed += 1;
        }
        return { synced, failed };
      });
      total.synced += part.synced;
      total.failed += part.failed;
    } catch (error) {
      console.error(`[outreach/imapSync] 组织 ${organizationId} 收信失败：`, error);
      total.failed += ids.length;
    }
  }
  return total;
}
