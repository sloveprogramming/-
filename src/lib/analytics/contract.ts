/**
 * The shapes of GET /api/analytics/[view], shared by the route, the queries
 * (src/lib/analytics/*.server.ts) and the dashboard (src/components/analytics).
 * Client-safe: types and pure helpers only, no runtime imports.
 *
 * Counting conventions, so the views agree with each other:
 * - Every count is for events inside the range, bucketed in the viewer's
 *   time zone. A "funnel" is therefore period counts, not one cohort
 *   followed through; the UI says so.
 * - "People" counts are distinct person ids; "messages"/"emails"/"calls" are rows.
 * - Rates are 0..1, or null when the denominator is 0.
 * - "now" snapshots (queues, capacity, pipeline) ignore the range.
 */

// 改造：LinkedIn / WhatsApp 两个视图随频道删除，只保留总览与邮件。
export const ANALYTICS_VIEWS = ["overview", "email"] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

export const ANALYTICS_CHANNELS = ["email"] as const;
export type AnalyticsChannel = (typeof ANALYTICS_CHANNELS)[number];

/** The longest range the endpoint answers, in days. Past 62 days points are weekly. */
export const MAX_ANALYTICS_RANGE_DAYS = 180;
export const WEEKLY_BUCKET_AFTER_DAYS = 62;

export type AnalyticsRange = {
  /** Inclusive, YYYY-MM-DD in `tz`. */
  from: string;
  /** Inclusive, YYYY-MM-DD in `tz`. */
  to: string;
  /** IANA zone the buckets are cut in. */
  tz: string;
  bucket: "day" | "week";
};

/** A number for the range, and the same number for the equally long range just before it. */
export type Metric = {
  value: number;
  /** null when the previous period can't be computed (e.g. a "now" snapshot). */
  previous: number | null;
};

/** One point per bucket, zero-filled; `date` is the bucket's first day, YYYY-MM-DD. */
export type TimeSeries<K extends string> = {
  keys: readonly K[];
  points: Array<{ date: string } & Record<K, number>>;
};

export type BreakdownRow<K extends string = string> = { key: K; label: string; value: number };

// ---------------------------------------------------------------- overview

export type FunnelStageKey = "reached" | "replied" | "positive" | "meeting" | "customer";

/**
 * The Overview is CRM-first: `crm` (conversations, pipeline, AI) leads, and
 * the outreach funnel and channel table show where those conversations came from.
 */
export type OverviewAnalytics = {
  view: "overview";
  range: AnalyticsRange;
  kpis: {
    /** Distinct people with any outbound touch: email sent, LinkedIn invite/message, WhatsApp call or outbound message. */
    reached: Metric;
    /** Distinct people with an inbound reply on any channel (crm_conversation_messages, inbound). */
    replied: Metric;
    /** Distinct CRM records moved into Interested or Customer. */
    positive: Metric;
    /** Distinct CRM records moved into a meeting subcategory (see MEETING_SUBCATEGORY_KEYS). */
    meetings: Metric;
    /** Distinct CRM records moved into Customer. */
    customers: Metric;
  };
  funnel: Array<{ key: FunnelStageKey; label: string; value: number }>;
  channels: Array<{
    channel: AnalyticsChannel;
    reached: number;
    replied: number;
    /** replied / reached. */
    replyRate: number | null;
    positive: number;
  }>;
  /** Now, regardless of range. */
  attention: {
    actionRequired: number;
    overdue: number;
    draftsAwaitingReview: number;
    mailboxesFailing: number;
    linkedinDisconnected: number;
    whatsappDisconnected: number;
  };
  crm: CrmSummary;
};

/**
 * Subcategory keys that mean a meeting or demo was requested or held. The
 * taxonomy is operator-editable, so this is a convention, not a schema fact;
 * "meeting_no_show" is deliberately excluded.
 */
export const MEETING_SUBCATEGORY_KEYS = [
  "meeting_requested",
  "meeting_done",
  "demo_request",
  "demo_requested",
] as const;

// ---------------------------------------------------------------- email

export type EmailAnalytics = {
  view: "email";
  range: AnalyticsRange;
  kpis: {
    /** outreach_emails with status 'sent', by sent_at. */
    sent: Metric;
    /** Distinct leads sent step 1 in the range. */
    contacted: Metric;
    /** Distinct people in an email campaign with an inbound email reply in the range. */
    replied: Metric;
    /** replied / contacted for the same range; previous likewise. */
    replyRate: { value: number | null; previous: number | null };
    /** Suppression rows with reason 'bounced'. */
    bounced: Metric;
    /** Suppression rows with reason 'unsubscribed'. */
    unsubscribed: Metric;
  };
  sends: TimeSeries<"firstTouch" | "followUp">;
  replies: TimeSeries<"replies">;
  /** outreach_emails with status 'failed' in the range (by created_at). */
  failedSends: number;
  campaigns: Array<{
    id: string;
    name: string;
    status: string;
    leads: number;
    /** Leads past 'pending'. */
    contacted: number;
    /** Emails sent in the range. */
    sentInRange: number;
    /** Leads with sequence_status 'reply_received' (all time). */
    replied: number;
    /** replied / contacted. */
    replyRate: number | null;
    bounced: number;
    /** Sends per bucket in the range, for a row sparkline. */
    trend: number[];
  }>;
  /** Now. */
  mailboxes: {
    total: number;
    connected: number;
    failing: number;
    sentToday: number;
    capacityToday: number;
    rows: Array<{ id: string; email: string; status: string; sentToday: number; dailyLimit: number }>;
  };
};

// ---------------------------------------------------------------- crm (part of the overview)

export type CrmCategory = "customer" | "interested" | "not_interested" | "other" | "unclassified";

/** The CRM half of the Overview. */
export type CrmSummary = {
  kpis: {
    /** Inbound crm_conversation_messages. */
    replies: Metric;
    /** crm_classifications created, excluding failed and stale. */
    classified: Metric;
    /** crm_drafts that reached 'sent' (by the message.sent event time). */
    draftsSent: Metric;
    /** Median minutes from an inbound message to the next outbound in its conversation. */
    medianFirstResponseMinutes: { value: number | null; previous: number | null };
    /** overridden / (accepted + overridden + auto_applied) classifications. */
    overrideRate: { value: number | null; previous: number | null };
  };
  /** Inbound replies per bucket by the category they were classified into. */
  repliesByCategory: TimeSeries<CrmCategory>;
  /** Now: open records per subcategory, funnel stages first by stage_rank. */
  pipeline: Array<{
    subcategoryId: string | null;
    name: string;
    categoryKey: CrmCategory;
    stageRank: number | null;
    count: number;
  }>;
  /** Stage moves into each subcategory during the range. */
  stageEntries: Array<{ subcategoryId: string; name: string; categoryKey: CrmCategory; entered: number }>;
  drafts: {
    generated: number;
    sentAsIs: number;
    sentEdited: number;
    discarded: number;
    /** Now. */
    awaitingReview: number;
  };
  /** Now. */
  workflow: Array<BreakdownRow>;
  /** Now. */
  attention: { actionRequired: number; overdue: number };
};

// 改造：LinkedIn / WhatsApp 两个视图随频道删除。
export type AnalyticsResponse = OverviewAnalytics | EmailAnalytics;

export type AnalyticsResponseFor<V extends AnalyticsView> = Extract<AnalyticsResponse, { view: V }>;

// ---------------------------------------------------------------- helpers (pure)

/** part / whole, or null when whole is 0. */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Signed change from previous to value as a fraction, or null when there's no base. */
export function change(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return (value - previous) / previous;
}

/** Adds `days` to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The equally long range that ends the day before `from`. */
export function previousRange(range: Pick<AnalyticsRange, "from" | "to">): { from: string; to: string } {
  const days = dayCount(range.from, range.to);
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** Bucket start dates for a range, oldest first. Weeks start on the range's first day. */
export function bucketStarts(range: Pick<AnalyticsRange, "from" | "to" | "bucket">): string[] {
  const step = range.bucket === "week" ? 7 : 1;
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, step)) out.push(d);
  return out;
}

/** The bucket a YYYY-MM-DD day falls in. */
export function bucketFor(day: string, range: Pick<AnalyticsRange, "from" | "bucket">): string {
  if (range.bucket === "day") return day;
  const offset = Math.floor(dayCount(range.from, day) - 1);
  return addDays(range.from, offset - (offset % 7));
}

/** Zero-filled series from day-level rows (`date` YYYY-MM-DD in tz). */
export function toSeries<K extends string>(
  keys: readonly K[],
  range: Pick<AnalyticsRange, "from" | "to" | "bucket">,
  rows: Array<{ date: string } & Partial<Record<K, number>>>,
): TimeSeries<K> {
  const byBucket = new Map<string, Record<K, number>>();
  for (const start of bucketStarts(range)) {
    byBucket.set(start, Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>);
  }
  for (const row of rows) {
    if (row.date < range.from || row.date > range.to) continue;
    const target = byBucket.get(bucketFor(row.date, range));
    if (!target) continue;
    for (const k of keys) target[k] += Number(row[k] ?? 0);
  }
  return { keys, points: [...byBucket].map(([date, values]) => ({ date, ...values })) };
}
