/**
 * Backfills the CRM conversation with the outreach that was actually sent,
 * before any inbound reply is recorded. Without this, the classifier and
 * drafter see a first reply with no idea what was pitched.
 *
 * Outreach history is read from the channel's own store, never written by
 * it: `outreach_emails` (src/lib/outreach/schema.ts) for email. Each row is
 * inserted into `crm_conversation_messages` as an outbound message through
 * the same `insertConversationMessageInTransaction` idempotent upsert the
 * inbound and CRM-send paths already use, so re-running this is always safe.
 *
 * 改造：LinkedIn 与 WhatsApp 两个来源随频道删除。国内渠道的记录（企微消息、
 * 短信发送记录、外呼通话）接入时，各自加一个只读的 loadXxxOutreachRows + 转换函数。
 */
import { and, eq, inArray } from "drizzle-orm";
import { outreachCampaigns, outreachEmails, outreachLeads } from "@/lib/outreach/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { htmlToPlainText, looksLikeHtml } from "@/lib/email/htmlToText";
import {
  insertConversationMessageInTransaction,
  type InsertConversationMessageInput,
} from "./conversations";
import { CrmConflictError, type CrmTransaction } from "./repository";
import type { CrmChannel } from "./schema";

export type BackfillOutreachHistoryInput = {
  conversationId: string;
  personId: string;
  channel: CrmChannel;
  accountRef: string;
};

export type BackfillOutreachHistoryResult = { inserted: number };

/** What every row, from either channel, resolves to before the shared context fields are attached. */
type PendingOutboundMessage = Omit<
  InsertConversationMessageInput,
  "conversationId" | "personId" | "channel" | "accountRef"
>;

export type EmailOutreachRow = {
  id: string;
  subject: string | null;
  body: string | null;
  messageId: string | null;
  sentAt: Date | null;
  stepNumber: number;
  campaignId: string | null;
};

/** Converts one sent `outreach_emails` row into an outbound message, or null to skip it. */
export function emailOutreachRowToMessageInput(row: EmailOutreachRow): PendingOutboundMessage | null {
  if (!row.sentAt) return null;
  const rawBody = row.body ?? "";
  const isHtml = looksLikeHtml(rawBody);
  const bodyText = (isHtml ? htmlToPlainText(rawBody) : rawBody).trim();
  if (!bodyText) return null;
  return {
    direction: "outbound",
    idempotencyKey: `outreach-email:${row.id}`,
    providerMessageId: row.messageId,
    subject: row.subject,
    bodyText,
    bodyHtml: isHtml ? rawBody : null,
    raw: {
      source: "outreach_emails",
      id: row.id,
      step: row.stepNumber,
      campaignId: row.campaignId,
    },
    sentAt: row.sentAt,
  };
}

async function loadEmailOutreachRows(tx: CrmTransaction, personId: string): Promise<EmailOutreachRow[]> {
  return tx
    .select({
      id: outreachEmails.id,
      subject: outreachEmails.subject,
      body: outreachEmails.body,
      messageId: outreachEmails.messageId,
      sentAt: outreachEmails.sentAt,
      stepNumber: outreachEmails.stepNumber,
      campaignId: outreachLeads.campaignId,
    })
    .from(outreachEmails)
    .innerJoin(outreachLeads, eq(outreachLeads.id, outreachEmails.leadId))
    .where(and(
      inArray(
        outreachLeads.campaignId,
        tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(inOrg(outreachCampaigns)),
      ),
      eq(outreachLeads.personId, personId),
      eq(outreachEmails.status, "sent"),
    ));
}

async function loadPendingOutreach(
  tx: CrmTransaction,
  input: BackfillOutreachHistoryInput,
): Promise<(PendingOutboundMessage | null)[]> {
  // 改造：只回填邮件。企业微信、短信、外呼各自的发送记录接入后，在这里加 case，
  // 各自的 loadXxxOutreachRows 只读、不写。
  switch (input.channel) {
    case "email":
      return (await loadEmailOutreachRows(tx, input.personId)).map(emailOutreachRowToMessageInput);
    case "wecom":
    case "sms":
    case "call":
      return [];
  }
}

/**
 * Inserts every one of the Person's sent outreach messages for `channel`
 * into the given conversation as outbound `crm_conversation_messages` rows.
 * Idempotent: safe to call again for a conversation that already has some
 * or all of this history recorded.
 *
 * A per-row `CrmConflictError` (the same idempotency/provider id already
 * exists under another conversation or direction — e.g. a CRM-sent LinkedIn
 * message that also landed in "Message" as CUSTOM_SENT with the same
 * linkedinMessageId) is swallowed and the row is skipped rather than
 * failing the whole backfill. Any other error propagates.
 */
export async function backfillOutreachHistoryInTransaction(
  tx: CrmTransaction,
  input: BackfillOutreachHistoryInput,
): Promise<BackfillOutreachHistoryResult> {
  const pending = await loadPendingOutreach(tx, input);

  let inserted = 0;
  for (const message of pending) {
    if (!message) continue;
    try {
      const { created } = await insertConversationMessageInTransaction(tx, {
        conversationId: input.conversationId,
        personId: input.personId,
        channel: input.channel,
        accountRef: input.accountRef,
        ...message,
      });
      if (created) inserted += 1;
    } catch (err) {
      if (err instanceof CrmConflictError) continue;
      throw err;
    }
  }
  return { inserted };
}
