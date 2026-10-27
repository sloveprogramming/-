import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes } from "./schema";
import { testMailboxConnection } from "./gmail";
import { encryptSmtpSecret, testSmtpConnection } from "./smtp";
import { decryptCredentialText } from "@/lib/integrations/credential-crypto";
import { channelRules } from "@/lib/channels/rules.server";
import { mailboxHoursFromWeekly } from "./workingHours";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

export async function listMailboxes() {
  return db.select().from(mailboxes).where(inOrg(mailboxes)).orderBy(mailboxes.createdAt);
}

export async function getMailbox(id: string) {
  const [row] = await db.select().from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, id))).limit(1);
  return row ?? null;
}

export type ConnectMailboxResult =
  | { ok: true; mailboxId: string; status: "connected" }
  | { ok: false; error: string };

/**
 * Adds (or re-tests) a mailbox: stores the row, calls Gmail to verify our
 * service account can actually impersonate this address, then records the
 * outcome. This is the entire "connect" flow — no OAuth screen, no password.
 */
export async function connectMailbox(input: {
  emailAddress: string;
  displayName?: string | null;
  /** Undefined leaves any existing signature untouched (e.g. on a retest); pass "" to explicitly clear it. */
  signatureHtml?: string | null;
}): Promise<ConnectMailboxResult> {
  const emailAddress = input.emailAddress.trim().toLowerCase();
  if (!emailAddress || !emailAddress.includes("@")) {
    return { ok: false, error: `invalid email: "${input.emailAddress}"` };
  }

  const [existing] = await db
    .select()
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, emailAddress)))
    .limit(1);
  if (!existing) {
    // A Gmail mailbox belongs to exactly one organization (email_address is
    // globally unique), so one already connected elsewhere cannot be added.
    const [elsewhere] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.emailAddress, emailAddress))
      .limit(1);
    if (elsewhere) return { ok: false, error: `${emailAddress} is already connected to another organization` };
  }

  // A new mailbox starts from the organization's sending rules; after that its
  // own limit and hours are edited per mailbox.
  const rules = existing ? null : await channelRules("email");
  const mailboxId =
    existing?.id ??
    (
      await db
        .insert(mailboxes)
        .values({
          organizationId: currentOrganizationId(),
          emailAddress,
          displayName: input.displayName?.trim() || null,
          signatureHtml: input.signatureHtml?.trim() || null,
          status: "connecting",
          dailySendLimit: rules!.dailySendLimit,
          workingHours: mailboxHoursFromWeekly(rules!.sendingHours),
        })
        .returning({ id: mailboxes.id })
    )[0].id;

  const test = await testMailboxConnection(emailAddress);

  if (test.ok) {
    await db
      .update(mailboxes)
      .set({
        status: "connected",
        lastError: null,
        lastTestedAt: new Date(),
        lastHistoryId: test.historyId,
        displayName: input.displayName?.trim() || existing?.displayName || null,
        ...(input.signatureHtml !== undefined ? { signatureHtml: input.signatureHtml?.trim() || null } : {}),
        updatedAt: new Date(),
      })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
    return { ok: true, mailboxId, status: "connected" };
  }

  await db
    .update(mailboxes)
    .set({ status: "failed", lastError: test.error, lastTestedAt: new Date(), updatedAt: new Date() })
    .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
  return { ok: false, error: test.error };
}

/** Re-runs the connection test for an already-added mailbox. Leaves its signature untouched. */
export async function retestMailbox(id: string): Promise<ConnectMailboxResult> {
  const mailbox = await getMailbox(id);
  if (!mailbox) return { ok: false, error: "mailbox not found" };
  // 改造：SMTP 邮箱重测走 SMTP 验证，不再去问 Gmail 的服务账号。
  if (mailbox.provider === "smtp") {
    const config = await smtpConfigForMailbox(mailbox);
    if (!config) return { ok: false, error: "这个邮箱的 SMTP 配置不完整，请重新填写主机、端口、账号和密码。" };
    const test = await testSmtpConnection(config);
    await db
      .update(mailboxes)
      .set({
        status: test.ok ? "connected" : "failed",
        lastError: test.ok ? null : test.error,
        lastTestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));
    return test.ok ? { ok: true, mailboxId: mailbox.id, status: "connected" } : { ok: false, error: test.error };
  }
  return connectMailbox({ emailAddress: mailbox.emailAddress, displayName: mailbox.displayName });
}

export type ConnectSmtpInput = {
  emailAddress: string;
  displayName?: string | null;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** 明文密码，只在这里出现；入库前加密。 */
  secret: string;
  signatureHtml?: string | null;
};

/**
 * 连接一个企业邮箱（SMTP）。
 *
 * 改造新增：Gmail 那条路只需要一个地址，国内的企业邮箱要主机、端口、账号和
 * 密码。密码用 INTEGRATION_CREDENTIALS_KEY 加密后存库；这里先用它真的登一次
 * SMTP，登不上就不算连上，避免"配置存进去了但发不出去"。
 */
export async function connectSmtpMailbox(input: ConnectSmtpInput): Promise<ConnectMailboxResult> {
  const emailAddress = input.emailAddress.trim().toLowerCase();
  if (!emailAddress || !emailAddress.includes("@")) {
    return { ok: false, error: `邮箱地址不对：「${input.emailAddress}」` };
  }
  const host = input.host.trim();
  if (!host) return { ok: false, error: "SMTP 服务器地址不能为空" };
  if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65535) {
    return { ok: false, error: "端口要是一个 1-65535 的整数（465 是 SSL，587 是 STARTTLS）" };
  }
  const user = input.user.trim() || emailAddress;
  if (!input.secret) return { ok: false, error: "密码不能为空。国内企业邮箱多数要用「客户端专用密码」" };

  const config = { host, port: input.port, secure: input.secure, user, secret: input.secret };
  const test = await testSmtpConnection(config);

  const [existing] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, emailAddress)))
    .limit(1);
  if (!existing) {
    const [elsewhere] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.emailAddress, emailAddress))
      .limit(1);
    if (elsewhere) return { ok: false, error: `${emailAddress} 已经被另一个组织连接了` };
  }

  const rules = existing ? null : await channelRules("email");
  const shared = {
    provider: "smtp" as const,
    smtpHost: host,
    smtpPort: input.port,
    smtpSecure: input.secure,
    smtpUser: user,
    smtpSecretEncrypted: encryptSmtpSecret(input.secret),
    status: test.ok ? ("connected" as const) : ("failed" as const),
    lastError: test.ok ? null : test.error,
    lastTestedAt: new Date(),
    updatedAt: new Date(),
  };

  const [row] = existing
    ? await db
        .update(mailboxes)
        .set({
          ...shared,
          ...(input.displayName !== undefined ? { displayName: input.displayName?.trim() || null } : {}),
          ...(input.signatureHtml !== undefined ? { signatureHtml: input.signatureHtml?.trim() || null } : {}),
        })
        .where(and(inOrg(mailboxes), eq(mailboxes.id, existing.id)))
        .returning({ id: mailboxes.id })
    : await db
        .insert(mailboxes)
        .values({
          organizationId: currentOrganizationId(),
          emailAddress,
          displayName: input.displayName?.trim() || null,
          signatureHtml: input.signatureHtml?.trim() || null,
          dailySendLimit: rules!.dailySendLimit,
          workingHours: mailboxHoursFromWeekly(rules!.sendingHours),
          ...shared,
        })
        .returning({ id: mailboxes.id });

  if (!row) return { ok: false, error: "邮箱保存失败" };
  return test.ok ? { ok: true, mailboxId: row.id, status: "connected" } : { ok: false, error: test.error };
}

/** 从库里那一行组装 SMTP 配置（解密密码）。配置不全返回 null。 */
async function smtpConfigForMailbox(row: typeof mailboxes.$inferSelect) {
  if (!row.smtpHost || !row.smtpPort || !row.smtpUser || !row.smtpSecretEncrypted) return null;
  return {
    host: row.smtpHost,
    port: row.smtpPort,
    secure: row.smtpSecure,
    user: row.smtpUser,
    secret: decryptCredentialText(row.smtpSecretEncrypted),
  };
}

export async function deleteMailbox(id: string) {
  await db.delete(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, id)));
}
