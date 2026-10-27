import { describe, expect, test } from "bun:test";
import { isChineseMobile, nationalDigits, normalizePhone } from "./index";

describe("normalizePhone", () => {
  test("默认按中国大陆解析不带 + 的手机号", () => {
    expect(normalizePhone("13800138000")).toBe("+8613800138000");
    expect(normalizePhone("138 0013 8000")).toBe("+8613800138000");
    expect(normalizePhone("+86 138-0013-8000")).toBe("+8613800138000");
  });

  test("显式带国家码的海外号码仍然能解析", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("+1-415-555-2671")).toBe("+14155552671");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  test("00 开头的国际前缀按默认国家的 IDD 解析", () => {
    expect(normalizePhone("008613800138000")).toBe("+8613800138000");
  });

  test("可以显式指定默认国家", () => {
    expect(normalizePhone("98765 43210", "IN")).toBe("+919876543210");
  });

  test("解释不了的输入返回 null，不猜", () => {
    expect(normalizePhone("98765 43210")).toBeNull();
    // 美国号码不能被当成中国座机：0415 是丹东区号，曾经静默解析成 +864155552671。
    expect(normalizePhone("(415) 555-2671")).toBeNull();
    expect(normalizePhone("not a phone number")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("+91 123")).toBeNull();
  });

  test("带区号的中国座机能解析", () => {
    expect(normalizePhone("0571-88887777")).toBe("+8657188887777");
    expect(normalizePhone("0571 8888 7777")).toBe("+8657188887777");
  });
});

describe("nationalDigits", () => {
  test("去掉 + 和所有非数字字符", () => {
    expect(nationalDigits("+8613800138000")).toBe("8613800138000");
    expect(nationalDigits("+1 (415) 555-2671")).toBe("14155552671");
  });
});

describe("isChineseMobile", () => {
  test("认中国大陆手机号", () => {
    expect(isChineseMobile("+8613800138000")).toBe(true);
    expect(isChineseMobile("8613800138000")).toBe(true);
  });

  test("座机和海外号码都不算", () => {
    expect(isChineseMobile("+862188887777")).toBe(false);
    expect(isChineseMobile("+919876543210")).toBe(false);
  });
});
