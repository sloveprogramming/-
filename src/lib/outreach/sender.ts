import "server-only";

import { sendEmail as sendViaGmail, type SendEmailParams, type SendEmailResult } from "./gmail";
import { sendEmailViaSmtp, smtpConfigForAddress } from "./smtp";

/**
 * 发信的唯一入口，按邮箱的 provider 分派。
 *
 * 改造：原来所有调用点直接 import `gmail.ts` 的 sendEmail，等于把"发信"和
 * "Gmail"绑死。现在调用方只认 `from` 地址，由这里查这个邮箱接的是 Gmail 还是
 * 企业邮箱 SMTP：
 *
 *   - provider = "smtp"  → nodemailer 走企业邮箱（国内唯一可用的发信方式）
 *   - 其它（含没登记的地址）→ Gmail API，保持原有行为
 *
 * 没登记成 SMTP 的地址回落到 Gmail，是为了不破坏已经在用 Google Workspace 的
 * 部署；新农哥这边所有邮箱都会登记成 smtp。
 */
export type { SendEmailParams, SendEmailResult };

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const smtp = await smtpConfigForAddress(params.from);
  if (smtp) return sendEmailViaSmtp(params, smtp);
  return sendViaGmail(params);
}
