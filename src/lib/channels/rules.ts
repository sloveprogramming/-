/**
 * Sending rules: the numbers that used to be hardcoded in the sending
 * engines, now set per organization in 设置 → <渠道> → 发送规则.
 *
 * Every rule is declared once here — label, help, default, unit and the
 * bounds it may take — and the settings page is generated from it, the API
 * validates against it, and the engines read resolved values through
 * `channelRules()` (rules.server.ts). An organization that never opens the
 * page behaves exactly as the defaults say.
 *
 * Two bounds per rule:
 *  - min / max: hard limits. A value outside them is refused, so a typo
 *    cannot, say, blast 3,000 text messages in a day.
 *  - safe: the edge of what the platforms tolerate. Beyond it the page
 *    shows the rule's `warning` but still saves.
 *
 * Some rules can be overridden per connected account (a mailbox's daily
 * limit, a WeCom account's daily adds); `override` says where. Resolution:
 * account override → organization rule → default.
 *
 * 改造：渠道从 LinkedIn / WhatsApp 换成国内实际在用的「邮件 / 企业微信 / 短信 /
 * 电话」，规则、默认值、时段和提示语都按国内场景重写（默认时区 Asia/Shanghai、
 * 默认电话国家 CN）。原来的 LinkedIn 邀请数、WhatsApp 新聊天数等规则整段删除。
 *
 * Client-safe: no database or server imports.
 */

import { resolveTimeZone } from "@/lib/timeZone";

export const CHANNELS = ["email", "wecom", "sms", "call", "general"] as const;
export type Channel = (typeof CHANNELS)[number];

export type WeeklyHours = {
  /** IANA time zone, e.g. Asia/Shanghai. */
  timezone: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** "HH:mm", 24-hour. */
  start: string;
  end: string;
};

type Common = {
  key: string;
  label: string;
  help: string;
  /** Where an account can override it, shown under the rule. */
  override?: string;
};

export type NumberRule = Common & {
  kind: "number";
  unit: string;
  default: number;
  min: number;
  max: number;
  /** Values beyond this (in the risky direction) show the warning. */
  safe?: { above?: number; below?: number };
  warning?: string;
};

export type RangeRule = Common & {
  kind: "range";
  unit: string;
  default: [number, number];
  min: number;
  max: number;
  safe?: { above?: number; below?: number };
  warning?: string;
};

export type HoursRule = Common & {
  kind: "hours";
  default: WeeklyHours | null;
  /** May be null, meaning "any time". */
  optional?: boolean;
};

export type CountryRule = Common & { kind: "country"; default: string };

/** An IANA time zone, stored under its current name (src/lib/timeZone.ts). */
export type TimeZoneRule = Common & { kind: "timezone"; default: string };

/** A time of day, "HH:mm", 24-hour. */
export type ClockRule = Common & { kind: "time"; default: string };

export type Rule = NumberRule | RangeRule | HoursRule | CountryRule | TimeZoneRule | ClockRule;

/** 国内工作日：周一到周五。周六常见于门店/批发渠道，企业微信单独放开了周六。 */
const WEEKDAYS = [1, 2, 3, 4, 5];
const WORKDAYS_PLUS_SATURDAY = [1, 2, 3, 4, 5, 6];

export const CHANNEL_RULES = {
  email: [
    {
      key: "dailySendLimit",
      kind: "number",
      label: "每个邮箱每天发信上限",
      help: "新接入的邮箱每天发多少封。老邮箱可以多一些；新邮箱建议从低处起步，逐步加量。",
      unit: "封 / 天",
      default: 30,
      min: 1,
      max: 200,
      safe: { above: 50 },
      warning: "单个企业邮箱一天超过约 50 封，送达率通常开始下降，邮箱服务商也可能限流。",
      override: "每个邮箱可以在「设置 → 邮件 → 发信邮箱」里单独设上限。",
    },
    {
      key: "sendGapMinutes",
      kind: "range",
      label: "同一邮箱两封信之间的间隔",
      help: "每发一封，邮箱在这个区间内随机等一段时间再发下一封，看起来像人在发。",
      unit: "分钟",
      default: [18, 24],
      min: 1,
      max: 240,
      safe: { below: 10 },
      warning: "同一个邮箱间隔不到 10 分钟连发，容易被判为机器群发。",
    },
    {
      key: "sendingHours",
      kind: "hours",
      label: "新邮箱的发送时段",
      help: "新接入的邮箱在什么时间可以发信。每个邮箱可以在「发信邮箱」里改自己的时段。",
      override: "每个邮箱可以在「设置 → 邮件 → 发信邮箱」里单独设时段。",
      default: { timezone: "Asia/Shanghai", days: WEEKDAYS, start: "09:00", end: "18:00" },
    },
    {
      // Read by the CRM's automatic follow-up sender (src/lib/crm/autoFollowUps.ts).
      key: "crmFollowUpGapMinutes",
      kind: "number",
      label: "同一邮箱两封自动跟进之间的间隔",
      help: "打开了「自动发送跟进」的序列，每个邮箱在这段时间内最多发一封，按到期先后排队，所以同时到期的跟进会摊到一天里。",
      unit: "分钟",
      default: 30,
      min: 5,
      max: 720,
      safe: { below: 15 },
      warning: "同一邮箱两封跟进间隔不到 15 分钟，看起来像自动群发。",
    },
  ],
  wecom: [
    {
      key: "dailyAddLimit",
      kind: "number",
      label: "每个企微账号每天加好友上限",
      help: "企微对主动添加外部联系人有频率限制，加得太快会被限制加人甚至封号。宁可按周慢慢加，也不要一天加满。",
      unit: "人 / 天",
      default: 20,
      min: 1,
      max: 60,
      safe: { above: 30 },
      warning: "一天加超过 30 人，触发企微风控的概率明显上升。",
      override: "每个账号可以在「设置 → 企业微信 → 账号」里单独设上限。",
    },
    {
      key: "messageGapMinutes",
      kind: "range",
      label: "同一账号两条消息之间的间隔",
      help: "每条消息发出后在这个区间内随机等待，避免整点批量发出。",
      unit: "分钟",
      default: [1, 3],
      min: 1,
      max: 60,
      safe: { below: 1 },
      warning: "间隔不到 1 分钟的连续消息很容易被识别为群发工具。",
    },
    {
      key: "sendingHours",
      kind: "hours",
      label: "企微发送时段",
      help: "什么时间可以发消息。不要在深夜和清晨发，客户会直接拉黑。",
      default: { timezone: "Asia/Shanghai", days: WORKDAYS_PLUS_SATURDAY, start: "09:00", end: "19:00" },
    },
    {
      key: "crmFollowUpGapMinutes",
      kind: "number",
      label: "同一账号两封自动跟进之间的间隔",
      help: "企微里的自动跟进，每个账号在这段时间内最多发一条。",
      unit: "分钟",
      default: 30,
      min: 5,
      max: 720,
      safe: { below: 15 },
      warning: "间隔太短，客户会感到被连续打扰。",
    },
  ],
  sms: [
    {
      key: "dailySendLimit",
      kind: "number",
      label: "每个号码每天短信上限",
      help: "一个发送号码一天最多发多少条。短信按条计费，也是投诉和封号的主要来源，宁少勿多。",
      unit: "条 / 天",
      default: 200,
      min: 1,
      max: 2000,
      safe: { above: 500 },
      warning: "单号码一天超过 500 条，运营商侧被拦截和投诉的概率会明显上升。",
      override: "每个号码可以在「设置 → 短信 → 号码」里单独设上限。",
    },
    {
      key: "sendGapMinutes",
      kind: "range",
      label: "同一号码两条短信之间的间隔",
      help: "短信网关通常有自己的限速，这里控制的是我们主动放慢的节奏。",
      unit: "分钟",
      default: [1, 3],
      min: 1,
      max: 60,
      safe: { below: 1 },
      warning: "间隔太短会被网关限流，反而拖慢整体发送。",
    },
    {
      key: "sendingHours",
      kind: "hours",
      label: "短信发送时段",
      help: "营销短信有明确的时段要求：早 8 点前、晚 9 点后发送属于违规，会被投诉。",
      default: { timezone: "Asia/Shanghai", days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "20:00" },
    },
  ],
  call: [
    {
      key: "dailyCallLimit",
      kind: "number",
      label: "每个坐席每天外呼上限",
      help: "一个销售一天最多拨打多少通。定得过高，接通率和记录质量都会掉。",
      unit: "通 / 天",
      default: 80,
      min: 1,
      max: 300,
      safe: { above: 150 },
      warning: "一天超过 150 通，多数团队的通话质量和 CRM 记录质量都会明显下降。",
    },
    {
      key: "callGapMinutes",
      kind: "range",
      label: "两通电话之间的间隔",
      help: "每通电话结束后等待一段时间再拨下一通，留出记录结果的时间。",
      unit: "分钟",
      default: [2, 5],
      min: 1,
      max: 60,
      safe: { below: 1 },
      warning: "间隔太短，销售来不及记录，线索会积压。",
    },
    {
      key: "callHours",
      kind: "hours",
      label: "外呼时段",
      help: "什么时间可以打电话。午休和晚上 8 点以后打，基本只会挨骂。",
      default: { timezone: "Asia/Shanghai", days: WORKDAYS_PLUS_SATURDAY, start: "09:00", end: "18:00" },
    },
  ],
  general: [
    {
      // Read by the daily rollover (src/lib/scheduler/dailyRollover.ts).
      key: "timeZone",
      kind: "timezone",
      label: "时区",
      help: "组织所在时区。下面「新的一天从几点开始」按这个时区计算。",
      default: "Asia/Shanghai",
    },
    {
      key: "dayStartsAt",
      kind: "time",
      label: "新的一天从几点开始",
      help: "每日限额在这个时间重置，当天的发信队列也在这时生成。",
      default: "00:00",
    },
    {
      key: "defaultPhoneCountry",
      kind: "country",
      label: "默认电话国家",
      help: "不带 + 和国家码的号码按这个国家解析。国内用 CN；保留海外业务时再改。",
      default: "CN",
    },
  ],
} as const satisfies Record<Channel, readonly Rule[]>;

/** The resolved, typed values of one channel's rules. */
type ValueOf<R> = R extends { kind: "number" } ? number
  : R extends { kind: "range" } ? [number, number]
  : R extends { kind: "hours"; optional: true } ? WeeklyHours | null
  : R extends { kind: "hours" } ? WeeklyHours
  : R extends { kind: "country" } ? string
  : R extends { kind: "timezone" } ? string
  : R extends { kind: "time" } ? string
  : never;
export type ChannelRuleValues<C extends Channel> = {
  [R in (typeof CHANNEL_RULES)[C][number] as R["key"]]: ValueOf<R>;
};

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

export function rulesOf(channel: Channel): readonly Rule[] {
  return CHANNEL_RULES[channel] as readonly Rule[];
}

/** A number rule by key — what a per-account override is validated against. */
export function numberRule(channel: Channel, key: string): NumberRule {
  const rule = rulesOf(channel).find((r) => r.key === key);
  if (rule?.kind !== "number") throw new Error(`No number rule ${channel}.${key}`);
  return rule;
}

export function defaultValues<C extends Channel>(channel: C): ChannelRuleValues<C> {
  return Object.fromEntries(rulesOf(channel).map((rule) => [rule.key, rule.default])) as ChannelRuleValues<C>;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const COUNTRY = /^[A-Z]{2}$/;

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Why `value` is not acceptable for `rule`, or null when it is. */
export function ruleError(rule: Rule, value: unknown): string | null {
  switch (rule.kind) {
    case "number": {
      if (typeof value !== "number" || !Number.isInteger(value)) return `${rule.label}必须是一个整数`;
      if (value < rule.min || value > rule.max) return `${rule.label}要在 ${rule.min} 到 ${rule.max} 之间`;
      return null;
    }
    case "range": {
      if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isInteger(n))) {
        return `${rule.label}需要一个最小值和最大值（都是整数）`;
      }
      const [lo, hi] = value as [number, number];
      if (lo < rule.min || hi > rule.max) return `${rule.label}要落在 ${rule.min} 到 ${rule.max} 之间`;
      if (lo > hi) return `${rule.label}：最小值不能大于最大值`;
      return null;
    }
    case "hours": {
      if (value === null && rule.optional) return null;
      const h = value as Partial<WeeklyHours> | null;
      if (!h || typeof h !== "object") return `${rule.label}格式不对`;
      if (typeof h.timezone !== "string" || !isTimeZone(h.timezone)) return `${rule.label}：时区不认识`;
      if (!Array.isArray(h.days) || !h.days.length || !h.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        return `${rule.label}：至少选一天`;
      }
      if (typeof h.start !== "string" || !HHMM.test(h.start) || typeof h.end !== "string" || !HHMM.test(h.end)) {
        return `${rule.label}：时间要写成 09:00 这种格式`;
      }
      if (h.start >= h.end) return `${rule.label}：结束时间要晚于开始时间`;
      return null;
    }
    case "country": {
      if (value === "") return null;
      if (typeof value !== "string" || !COUNTRY.test(value)) return `${rule.label}必须是两位国家码，比如 CN`;
      return null;
    }
    case "timezone":
      return typeof value === "string" && value !== "" && isTimeZone(value) ? null : `${rule.label}：时区不认识`;
    case "time":
      return typeof value === "string" && HHMM.test(value) ? null : `${rule.label}：时间要写成 09:00 这种格式`;
  }
}

/** A valid value in its stored form: time zones under their current IANA name. */
function normalize(rule: Rule, value: unknown): unknown {
  if (rule.kind === "timezone") return resolveTimeZone(value as string);
  if (rule.kind === "hours" && value !== null) {
    const h = value as WeeklyHours;
    return { ...h, days: [...new Set(h.days)].sort((a, b) => a - b) };
  }
  return value;
}

/** The warning to show for `value`, or null when it is within the safe range. */
export function ruleWarning(rule: Rule, value: unknown): string | null {
  if ((rule.kind !== "number" && rule.kind !== "range") || !rule.safe || !rule.warning) return null;
  const [lo, hi] = rule.kind === "number" ? [value as number, value as number] : (value as [number, number]);
  if (rule.safe.above !== undefined && hi > rule.safe.above) return rule.warning;
  if (rule.safe.below !== undefined && lo < rule.safe.below) return rule.warning;
  return null;
}

/**
 * Stored values merged over the defaults. Anything stored that is unknown,
 * or no longer valid (a bound tightened since), falls back to the default,
 * so the engines only ever see valid numbers.
 */
export function resolveValues<C extends Channel>(channel: C, stored: Record<string, unknown> | null | undefined): ChannelRuleValues<C> {
  const values: Record<string, unknown> = {};
  for (const rule of rulesOf(channel)) {
    const candidate = stored?.[rule.key];
    values[rule.key] = candidate !== undefined && ruleError(rule, candidate) === null ? normalize(rule, candidate) : rule.default;
  }
  return values as ChannelRuleValues<C>;
}

/** Validate a submitted set of values for one channel. Only known keys; returns the clean values or the first error. */
export function validateValues(channel: Channel, input: Record<string, unknown>): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const known = new Map(rulesOf(channel).map((rule) => [rule.key, rule]));
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = known.get(key);
    if (!rule) return { ok: false, error: `未知的设置项：${key}` };
    const error = ruleError(rule, value);
    if (error) return { ok: false, error };
    values[key] = normalize(rule, value);
  }
  return { ok: true, values };
}

/** A random whole number in an inclusive range. */
export function pickInRange([lo, hi]: [number, number]): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
