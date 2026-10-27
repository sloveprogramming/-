import { and, eq } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import { db } from "@/lib/db";
import { decryptCredentialText, encryptCredentialText } from "@/lib/integrations/credential-crypto";
import { inOrg } from "@/lib/tenancy/scope";
import { mailboxes } from "./schema";
import type { SendEmailParams, SendEmailResult } from "./gmail";

/**
 * 企业邮箱 SMTP 发信。
 *
 * 原来整套外发只认 Gmail API（Google Workspace 域委派），国内没有这条路，
 * 一封邮件都发不出去。这里给第二种接法：腾讯企业邮 / 阿里云邮箱 / 网易企业邮
 * 这类标准 SMTP，账号密码按邮箱存，密码加密入库。
 *
 * 为什么用 nodemailer 而不是自己拼 MIME：附件、编码、TLS、退信地址这些细节它
 * 都处理过了，而且项目本来就依赖它（Gmail 那条路也用它的 MailComposer）。
 *
 * 纯服务端模块：读库、解密、建立 TCP 连接。
 */

export type SmtpConfig = {
  host: string;
  port: number;
  /** true = 465 直连 TLS；false = 587 STARTTLS。 */
  secure: boolean;
  user: string;
  secret: string;
};

export type SmtpTestResult = { ok: true } | { ok: false; error: string };

/** 国内常见服务商的默认主机，设置页用它做占位提示。 */
export const SMTP_PRESETS: ReadonlyArray<{ label: string; host: string; port: number; secure: boolean; note: string }> = [
  { label: "腾讯企业邮", host: "smtp.exmail.qq.com", port: 465, secure: true, note: "在「邮箱设置 → 客户端设置」里开启 SMTP 服务，用邮箱密码或专用密码" },
  { label: "阿里云邮箱", host: "smtp.qiye.aliyun.com", port: 465, secure: true, note: "企业邮箱控制台 → 域名解析完成后即可用" },
  { label: "网易企业邮", host: "smtphz.qiye.163.com", port: 465, secure: true, note: "管理后台 → 账号 → 客户端授权密码" },
  { label: "其他（587 STARTTLS）", host: "", port: 587, secure: false, note: "多数自建邮件网关用这个组合" },
];

function transportFor(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.secret },
    // 企业邮箱的证书链偶尔不完整；不跳过校验，但要有个明确的超时，
    // 否则连不上时发信队列会一直挂着。
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

/** 校验 SMTP 配置能不能登上去。设置页「测试连接」和新增邮箱都走这里。 */
export async function testSmtpConnection(config: SmtpConfig): Promise<SmtpTestResult> {
  const transport = transportFor(config);
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeSmtpError(error) };
  } finally {
    transport.close();
  }
}

/** 把 nodemailer 的报错翻成销售/管理员能看懂的一句话。 */
export function describeSmtpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/EAUTH|Invalid login|535|authentication/i.test(message)) {
    return "账号或密码不对。国内企业邮箱多数要在后台单独开启 SMTP 服务，并用「客户端专用密码」而不是登录密码。";
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return "连不上这个 SMTP 服务器。检查主机名和端口（465 是 SSL，587 是 STARTTLS），以及服务器有没有开放外发。";
  }
  if (/self signed certificate|CERT_/i.test(message)) {
    return "SMTP 服务器的证书有问题。换 465 端口，或让 IT 换一份完整证书链。";
  }
  return message;
}

/**
 * 用 SMTP 发一封信，返回和 Gmail 分支相同形状的结果。
 *
 * threadId 恒为 null：SMTP 没有 Gmail 那种会话 ID，邮件线程靠 In-Reply-To /
 * References 头维持，调用方已经把这两个头传进来了。
 */
export async function sendEmailViaSmtp(params: SendEmailParams, config: SmtpConfig): Promise<SendEmailResult> {
  const transport = transportFor(config);
  try {
    const info = await transport.sendMail({
      from: params.fromName ? `"${params.fromName.replace(/["\\]/g, "\\$&")}" <${params.from}>` : params.from,
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      text: params.text,
      html: params.html ?? params.text,
      inReplyTo: params.inReplyTo,
      references: params.references,
      headers: {
        ...(params.unsubscribeUrl
          ? {
              "List-Unsubscribe": `<${params.unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
          : {}),
      },
    });
    return {
      id: info.messageId ?? null,
      messageId: info.messageId ?? null,
      threadId: null,
    };
  } catch (error) {
    throw new Error(describeSmtpError(error));
  } finally {
    transport.close();
  }
}

/** 这个地址对应的 SMTP 配置；不是 SMTP 邮箱、或配置不全时返回 null。 */
export async function smtpConfigForAddress(emailAddress: string): Promise<SmtpConfig | null> {
  const [row] = await db
    .select()
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, emailAddress.trim().toLowerCase())))
    .limit(1);
  if (!row || row.provider !== "smtp") return null;
  if (!row.smtpHost || !row.smtpPort || !row.smtpUser || !row.smtpSecretEncrypted) return null;
  return {
    host: row.smtpHost,
    port: row.smtpPort,
    secure: row.smtpSecure,
    user: row.smtpUser,
    secret: decryptCredentialText(row.smtpSecretEncrypted),
  };
}

/** 保存 SMTP 密码前加密。设置页与新增邮箱共用，保证库里只有密文。 */
export function encryptSmtpSecret(secret: string): string {
  return encryptCredentialText(secret);
}
