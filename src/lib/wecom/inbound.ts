import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { ingestInboundReply } from "@/lib/crm/conversations";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { listOrganizationsWithPlatform, getPlatformCredentials } from "@/lib/platform/credentials";

/**
 * 企业微信入站：把客户发来的消息灌进 CRM。
 *
 * 走的是和邮件完全同一条管线（ingestInboundReply → 分类 → 起草），所以客户从
 * 企微回、从邮件回，在 CRM 里是同一种东西。差别只在"怎么把消息捞出来"。
 *
 * 关键的身份问题：企微消息只带 external_userid（形如 wmXXXX），不是手机号也不是
 * 邮箱。所以要把 external_userid 映射到 people 上的某个人：
 *
 *   1. 优先查 people.custom 里的「企微ID / wecomExternalId」——销售录入时填过；
 *   2. 没有就新建一个人（来源标 wecom），名字用企微昵称。
 *
 * 为什么不硬猜：猜错会把两个客户的消息混进同一条记录，比"先建个新的人"糟得多。
 */

export type WecomInboundMessage = {
  /** 企业 ID：用来定位是哪个组织的。 */
  corpId: string;
  externalUserId: string;
  /** 对方在企业微信里的昵称。 */
  fromName: string | null;
  text: string;
  msgId: string;
  /** 企微给的消息创建时间（秒）。 */
  createdAt: number;
  /** 接收消息的成员 userid。 */
  toUserId: string | null;
};

export type WecomInboundResult = { orgId: string | null; personId: string | null; duplicate: boolean; skipped: boolean };

/** 按 corpId 找到对应的组织，并解决 external_userid → person 的映射。 */
export async function findPersonForExternalContact(
  externalUserId: string,
  fromName: string | null,
): Promise<{ personId: string; created: boolean }> {
  // 先按自定义字段找：销售录入过企微 ID 的，直接对上。
  const [existing] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(
      inOrg(people),
      sql`(${people.custom}->>'企微ID' = ${externalUserId} OR ${people.custom}->>'wecomExternalId' = ${externalUserId})`,
    ))
    .limit(1);
  if (existing) return { personId: existing.id, created: false };

  // 没找到就新建。邮件/领英字段都留空——企微客户常常没有邮箱，
  // 硬填一个假地址会污染去重逻辑（people 的 email 有唯一索引）。
  const [created] = await db
    .insert(people)
    .values({
      organizationId: currentOrganizationId(),
      fullName: fromName ?? `企微客户 ${externalUserId.slice(-6)}`,
      custom: { 企微ID: externalUserId, 来源渠道: "企业微信" },
      raw: {},
      source: "crm:wecom-inbound",
    })
    .returning({ id: people.id });
  return { personId: created.id, created: true };
}

/**
 * 处理一条企微入站消息：定位组织 → 映射到人 → 进 CRM。
 *
 * 用 runInOrganization 是因为 ingestInboundReply 依赖组织作用域（fail-closed），
 * 而 webhook 是匿名的——必须先通过 corpId 反查出是哪个组织。
 */
export async function ingestWecomMessage(message: WecomInboundMessage): Promise<WecomInboundResult> {
  const orgIds = await listOrganizationsWithPlatform("wecom");
  if (!orgIds.length) return { orgId: null, personId: null, duplicate: false, skipped: true };

  // 逐个组织比对 corpId：同一套系统可能部署给多家公司，corpId 是唯一可靠的判别。
  let matchedOrg: string | null = null;
  for (const orgId of orgIds) {
    const credentials = await runInOrganization(orgId, () => getPlatformCredentials("wecom"));
    if (credentials?.corpId === message.corpId) {
      matchedOrg = orgId;
      break;
    }
  }
  if (!matchedOrg) return { orgId: null, personId: null, duplicate: false, skipped: true };

  return runInOrganization(matchedOrg, async () => {
    const { personId } = await findPersonForExternalContact(message.externalUserId, message.fromName);

    // 幂等键用 msgId：企微可能重复推送同一条消息（回调没及时 ack 时会重试）。
    const result = await ingestInboundReply({
      personId,
      channel: "wecom",
      // accountRef 存 corpId：一个企业在系统里可能有多个企微，corpId 能区分。
      accountRef: message.corpId,
      // providerThreadId 存 external_userid：这是"和谁的会话"，也是发消息时的收件人。
      providerThreadId: message.externalUserId,
      providerContactId: message.externalUserId,
      idempotencyKey: `wecom:${message.msgId}`,
      providerMessageId: message.msgId,
      subject: null,
      bodyText: message.text,
      raw: message as unknown as Record<string, unknown>,
      sentAt: new Date(message.createdAt * 1000),
      actorRef: "wecom",
    });

    return {
      orgId: matchedOrg,
      personId,
      duplicate: Boolean(result.duplicate),
      skipped: false,
    };
  });
}
