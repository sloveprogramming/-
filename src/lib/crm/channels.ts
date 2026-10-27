/**
 * The channels a CRM conversation, message or draft runs on, and the
 * per-channel facts the CRM needs in more than one place. Pure and
 * client-safe; schema.ts re-exports the type. Every switch here is
 * exhaustive, so adding a channel fails the build until each one says what
 * the new channel does.
 *
 * "whatsapp" is WhatsApp messaging through Unipile
 * (src/lib/whatsapp/crmBridge.ts); on a record it is also where call
 * follow-ups from WhatsApp Calling are worked (src/lib/calls/crmFollowUp.ts).
 */
export const CRM_CHANNELS = ["email", "linkedin", "whatsapp"] as const;
export type CrmChannel = (typeof CRM_CHANNELS)[number];

export function isCrmChannel(value: unknown): value is CrmChannel {
  return typeof value === "string" && (CRM_CHANNELS as readonly string[]).includes(value);
}

/**
 * The channel's Chinese name, for every surface that shows it (record pages,
 * queues, settings). 改造：中文化。The stored values stay English; only the
 * display label changes, so no data migration is needed.
 */
export function crmChannelLabel(channel: CrmChannel): string {
  switch (channel) {
    case "email":
      return "邮件";
    case "linkedin":
      return "领英";
    case "whatsapp":
      return "WhatsApp";
  }
}

/** Who delivers a CRM draft on this channel (crm_send_attempts.provider). */
export function crmChannelSendProvider(channel: CrmChannel): "gmail" | "unipile" {
  switch (channel) {
    case "email":
      return "gmail";
    case "linkedin":
    case "whatsapp":
      return "unipile";
  }
}

/** Whether a message on this channel carries a subject line. */
export function crmChannelHasSubject(channel: CrmChannel): boolean {
  switch (channel) {
    case "email":
      return true;
    case "linkedin":
    case "whatsapp":
      return false;
  }
}
