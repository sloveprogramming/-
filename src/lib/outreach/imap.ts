import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { InboundMessage } from "./gmail";
import { decryptCredentialText } from "@/lib/integrations/credential-crypto";
import type { mailboxes } from "./schema";

/**
 * 企业邮箱收信（IMAP）。
 *
 * Gmail 那条路是 Pub/Sub 推送 + historyId 游标；企业邮箱没有推送，只能轮询，
 * 游标是递增的 UID。这里把新邮件拉下来、解析成和 Gmail 分支同形状的
 * `InboundMessage`，后面接的是同一条 replyBridge（分类、建 CRM 记录、起草）。
 *
 * 服务端模块：读库、解密、建立 TCP 连接。
 */

export type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  secret: string;
};

export type ImapFetchResult = {
  messages: InboundMessage[];
  /** 这一批处理完之后的游标；没拉到新邮件时等于入参。 */
  newUid: number | null;
};

/**
 * 从发信主机推导收信主机。
 *
 * 国内三家的规律是一致的：
 *   smtp.exmail.qq.com  → imap.exmail.qq.com
 *   smtp.qiye.aliyun.com → imap.qiye.aliyun.com
 *   smtphz.qiye.163.com → imaphz.qiye.163.com
 * 所以默认不要求单独填 IMAP；自建网关可以在库里覆盖 imap_host。
 */
export function deriveImapHost(smtpHost: string): string {
  return smtpHost.replace(/^smtp/i, "imap");
}

type MailboxRow = typeof mailboxes.$inferSelect;

/** 这个邮箱的 IMAP 配置；配不全返回 null（发信可能仍然可用）。 */
export function imapConfigForMailbox(row: MailboxRow): ImapConfig | null {
  if (row.provider !== "smtp") return null;
  const secret = row.imapSecretEncrypted ?? row.smtpSecretEncrypted;
  const user = row.imapUser ?? row.smtpUser ?? row.emailAddress;
  if (!user || !secret) return null;
  const host = row.imapHost ?? (row.smtpHost ? deriveImapHost(row.smtpHost) : null);
  if (!host) return null;
  return {
    host,
    port: row.imapPort ?? 993,
    secure: row.imapSecure,
    user,
    secret: decryptCredentialText(secret),
  };
}

function addresses(list: unknown): Array<{ name: string | null; address: string }> {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const value = entry as { name?: string; address?: string };
    if (!value?.address) return [];
    return [{ name: value.name?.trim() || null, address: value.address.trim() }];
  });
}

/**
 * 拉取 UID 大于 `sinceUid` 的邮件。
 *
 * 首次同步（sinceUid 为 null）只取最近 20 封：一个用了两年的邮箱有几千封历史，
 * 全量拉下来既慢又没意义——CRM 只关心"从今天开始的回复"。
 */
export async function fetchNewImapMessages(
  config: ImapConfig,
  sinceUid: number | null,
  options: { limit?: number } = {},
): Promise<ImapFetchResult> {
  const limit = options.limit ?? 50;
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.secret },
    logger: false,
    // 企业邮箱的反垃圾网关有时比标准的慢一拍，给足超时。
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uidNext = Number(client.mailbox && typeof client.mailbox === "object" ? client.mailbox.uidNext : 0) || null;

      // 首次同步：取最近 N 封，把游标落到当前 uidNext-1，之后只拿新的。
      const range = sinceUid === null ? `${Math.max(1, (uidNext ?? limit + 1) - limit)}:*` : `${sinceUid + 1}:*`;

      const messages: InboundMessage[] = [];
      let highest = sinceUid;
      for await (const raw of client.fetch(range, { uid: true, source: true, internalDate: true }, { uid: true })) {
        const uid = Number(raw.uid);
        if (Number.isFinite(uid) && (highest === null || uid > highest)) highest = uid;
        if (!raw.source) continue;
        // 自己发出去的邮件不进 CRM——那会把每条外发都当成"客户回复"。
        const parsed = await simpleParser(raw.source);
        const from = addresses(parsed.from?.value)[0] ?? null;
        if (!from) continue;
        if (from.address.toLowerCase() === config.user.toLowerCase()) continue;

        const to = addresses(parsed.to).map((entry) => ({ email: entry.address, name: entry.name }));
        const cc = addresses(parsed.cc).map((entry) => ({ email: entry.address, name: entry.name }));
        messages.push({
          gmailMessageId: `imap:${uid}`,
          threadId: null,
          fromEmail: from.address,
          fromName: from.name,
          toEmail: to[0]?.email ?? null,
          to,
          cc,
          replyTo: addresses(parsed.replyTo).map((entry) => ({ email: entry.address, name: entry.name })),
          ccEmails: cc.map((entry) => entry.email),
          subject: parsed.subject ?? null,
          bodyText: parsed.text ?? null,
          messageId: parsed.messageId ?? null,
          inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : (parsed.inReplyTo?.[0] ?? null),
          internalDate: parsed.date ?? (raw.internalDate instanceof Date ? raw.internalDate : null),
        });
        if (messages.length >= limit) break;
      }

      // 首次同步且信箱是空的：把游标定在 uidNext-1，避免下一轮把历史再拉一遍。
      if (highest === null && sinceUid === null && uidNext) highest = Math.max(0, uidNext - 1);
      return { messages, newUid: highest };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** 把 IMAP/认证错误翻成管理员能看懂的一句话。 */
export function describeImapError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(message)) {
    return "收信账号或密码不对。企业邮箱通常要在后台单独开启 IMAP 服务，并用客户端专用密码。";
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return "连不上 IMAP 服务器。检查主机名和端口（993 是 SSL），以及服务器是否开放了 IMAP。";
  }
  return message;
}
