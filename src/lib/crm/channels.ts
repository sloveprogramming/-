/**
 * The channels a CRM conversation, message or draft runs on, and the
 * per-channel facts the CRM needs in more than one place. Pure and
 * client-safe; schema.ts re-exports the type. Every switch here is
 * exhaustive, so adding a channel fails the build until each one says what
 * the new channel does.
 *
 * 改造：渠道从「邮件 / 领英 / WhatsApp」换成国内实际在用的「邮件 / 企业微信 /
 * 短信 / 电话」。原来那三个的英文 key 会留在历史数据里（crm_conversations.channel
 * 是 text），读取时按未知渠道兜底即可，不需要改数据。
 *
 * 为什么是这四个：
 * - 邮件：报价单、检测报告、合同这类正式文件，国内仍然用，但不再作为首触。
 * - 企业微信：加了好友之后的承接与日常沟通，也是国内 B2B 的主渠道。
 * - 短信：没有好友关系时的第一次触达，以及预约提醒。
 * - 电话：转化率最高的一环，记录"打过了、结果如何、下次什么时候"。
 */
export const CRM_CHANNELS = ["email", "wecom", "sms", "call"] as const;
export type CrmChannel = (typeof CRM_CHANNELS)[number];

export function isCrmChannel(value: unknown): value is CrmChannel {
  return typeof value === "string" && (CRM_CHANNELS as readonly string[]).includes(value);
}

/** 历史数据里可能还有已下线渠道的 key，标签层要能原样兜底显示。 */
const LEGACY_CHANNEL_LABELS: Readonly<Record<string, string>> = {
  linkedin: "领英（已停用）",
  whatsapp: "WhatsApp（已停用）",
};

/**
 * The channel's Chinese name, for every surface that shows it (record pages,
 * queues, settings). The stored values stay English; only the display label
 * changes, so no data migration is needed.
 */
export function crmChannelLabel(channel: CrmChannel | string): string {
  switch (channel) {
    case "email":
      return "邮件";
    case "wecom":
      return "企业微信";
    case "sms":
      return "短信";
    case "call":
      return "电话";
    default:
      return LEGACY_CHANNEL_LABELS[channel] ?? channel;
  }
}

/**
 * Who delivers a CRM draft on this channel (crm_send_attempts.provider).
 * 邮件目前仍走 Gmail API，等企业邮箱 SMTP 接进来之后这里换成 "smtp"。
 */
export function crmChannelSendProvider(
  channel: CrmChannel,
): "gmail" | "smtp" | "wecom" | "sms" | "call" {
  switch (channel) {
    case "email":
      return "gmail";
    case "wecom":
      return "wecom";
    case "sms":
      return "sms";
    case "call":
      return "call";
  }
}

/** Whether a message on this channel carries a subject line. */
export function crmChannelHasSubject(channel: CrmChannel): boolean {
  switch (channel) {
    case "email":
      return true;
    case "wecom":
    case "sms":
    case "call":
      return false;
  }
}
