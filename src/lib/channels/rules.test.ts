import { describe, expect, test } from "bun:test";
import { CHANNEL_RULES, CHANNELS, defaultValues, pickInRange, resolveValues, ruleError, ruleWarning, rulesOf, validateValues } from "./rules";

/**
 * 改造：断言跟着国内四渠道重写。原来的 LinkedIn 邀请数、WhatsApp 新聊天数这些
 * 规则随频道删除，对应的用例一并去掉；新增企业微信加好友上限、短信条数、外呼通数
 * 的边界与告警用例。
 */
describe("registry", () => {
  test("every default is valid and inside its own bounds", () => {
    for (const channel of CHANNELS) {
      for (const rule of rulesOf(channel)) {
        expect(ruleError(rule, rule.default)).toBeNull();
        expect(ruleWarning(rule, rule.default)).toBeNull();
      }
    }
  });
  test("keys are unique within a channel", () => {
    for (const channel of CHANNELS) {
      const keys = rulesOf(channel).map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
  test("defaults reflect the domestic channels", () => {
    expect(defaultValues("email")).toMatchObject({ dailySendLimit: 30, sendGapMinutes: [18, 24] });
    expect(defaultValues("wecom")).toMatchObject({ dailyAddLimit: 20, messageGapMinutes: [1, 3], crmFollowUpGapMinutes: 30 });
    expect(defaultValues("sms").dailySendLimit).toBe(200);
    expect(defaultValues("call")).toMatchObject({ dailyCallLimit: 80, callGapMinutes: [2, 5] });
    // 默认时区与默认电话国家都改成国内。
    expect(defaultValues("general")).toEqual({ timeZone: "Asia/Shanghai", dayStartsAt: "00:00", defaultPhoneCountry: "CN" });
  });
});

describe("validation", () => {
  const addLimit = CHANNEL_RULES.wecom.find((r) => r.key === "dailyAddLimit")!;
  const gap = CHANNEL_RULES.email.find((r) => r.key === "sendGapMinutes")!;
  const hours = CHANNEL_RULES.email.find((r) => r.key === "sendingHours")!;
  const country = CHANNEL_RULES.general.find((rule) => rule.key === "defaultPhoneCountry")!;

  test("hard ceilings refuse a typo", () => {
    expect(ruleError(addLimit, 3000)).toContain("要在 1 到 60 之间");
    expect(ruleError(addLimit, 0)).not.toBeNull();
    expect(ruleError(addLimit, 12.5)).toContain("整数");
    expect(ruleError(addLimit, "30")).not.toBeNull();
  });
  test("ranges must be ordered and bounded", () => {
    expect(ruleError(gap, [10, 20])).toBeNull();
    expect(ruleError(gap, [30, 20])).toContain("最小值不能大于最大值");
    expect(ruleError(gap, [0, 20])).not.toBeNull();
    expect(ruleError(gap, [5])).not.toBeNull();
  });
  test("warnings appear beyond the safe edge but values still save", () => {
    expect(ruleWarning(addLimit, 20)).toBeNull();
    expect(ruleWarning(addLimit, 45)).toContain("风控");
    expect(ruleError(addLimit, 45)).toBeNull();
    expect(ruleWarning(gap, [5, 8])).toContain("10 分钟");
  });
  test("hours: time zone, days and times", () => {
    expect(ruleError(hours, { timezone: "Europe/London", days: [1], start: "08:30", end: "17:00" })).toBeNull();
    expect(ruleError(hours, { timezone: "Mars/Base", days: [1], start: "08:30", end: "17:00" })).toContain("时区");
    expect(ruleError(hours, { timezone: "UTC", days: [], start: "08:30", end: "17:00" })).toContain("至少选一天");
    expect(ruleError(hours, { timezone: "UTC", days: [1], start: "9", end: "17:00" })).toContain("09:00");
    expect(ruleError(hours, { timezone: "UTC", days: [1], start: "18:00", end: "09:00" })).toContain("结束时间");
  });
  test("country: empty or two capital letters", () => {
    expect(ruleError(country, "")).toBeNull();
    expect(ruleError(country, "CN")).toBeNull();
    expect(ruleError(country, "cn")).not.toBeNull();
    expect(ruleError(country, "CHN")).not.toBeNull();
  });
  test("validateValues refuses unknown keys and returns clean values", () => {
    expect(validateValues("email", { nope: 1 })).toEqual({ ok: false, error: "未知的设置项：nope" });
    expect(validateValues("email", { dailySendLimit: 500 }).ok).toBe(false);
    const ok = validateValues("email", { sendingHours: { timezone: "UTC", days: [5, 1, 1, 3], start: "09:00", end: "17:00" } });
    expect(ok).toEqual({ ok: true, values: { sendingHours: { timezone: "UTC", days: [1, 3, 5], start: "09:00", end: "17:00" } } });
  });
});

describe("resolveValues", () => {
  test("stored values override defaults; invalid or unknown ones fall back", () => {
    const resolved = resolveValues("wecom", { dailyAddLimit: 40, legacy: true });
    expect(resolved).toMatchObject({ dailyAddLimit: 40, messageGapMinutes: [1, 3] });
    // 超出硬上限的值回退到默认，而不是照用。
    expect(resolveValues("wecom", { dailyAddLimit: 999 }).dailyAddLimit).toBe(20);
  });
  test("nothing stored means the defaults", () => {
    expect(resolveValues("email", null)).toEqual(defaultValues("email"));
  });
});

test("pickInRange stays inside the range", () => {
  for (let i = 0; i < 200; i++) {
    const n = pickInRange([3, 6]);
    expect(n >= 3 && n <= 6 && Number.isInteger(n)).toBe(true);
  }
  expect(pickInRange([5, 5])).toBe(5);
});

describe("organization day (general.timeZone, general.dayStartsAt)", () => {
  test("defaults to Shanghai midnight", () => {
    expect(defaultValues("general")).toEqual({ timeZone: "Asia/Shanghai", dayStartsAt: "00:00", defaultPhoneCountry: "CN" });
  });

  test("validates the zone and the time", () => {
    expect(validateValues("general", { timeZone: "Asia/Shanghai", dayStartsAt: "05:30" })).toEqual({ ok: true, values: { timeZone: "Asia/Shanghai", dayStartsAt: "05:30" } });
    expect(validateValues("general", { timeZone: "Mars/Olympus" }).ok).toBe(false);
    expect(validateValues("general", { timeZone: "" }).ok).toBe(false);
    expect(validateValues("general", { dayStartsAt: "24:00" }).ok).toBe(false);
    expect(validateValues("general", { dayStartsAt: "7:00" }).ok).toBe(false);
  });

  test("stores and reads legacy zone names under their current IANA name", () => {
    expect(validateValues("general", { timeZone: "Asia/Calcutta" })).toEqual({ ok: true, values: { timeZone: "Asia/Kolkata" } });
    expect(resolveValues("general", { timeZone: "Europe/Kiev" }).timeZone).toBe("Europe/Kyiv");
    expect(resolveValues("general", { timeZone: "Nowhere/Land", dayStartsAt: "nope" })).toMatchObject({ timeZone: "Asia/Shanghai", dayStartsAt: "00:00" });
  });
});
