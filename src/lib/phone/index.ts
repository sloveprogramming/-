import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * 手机号/电话规范化。
 *
 * 从 `src/lib/calls/phone.ts` 抽出来的：原来的实现活在 WhatsApp 拨号模块里，
 * 但号码解析是国内拓客的基本功（导入、去重、外呼前校验都要用），不该跟着那个
 * 模块一起删。改造后默认国家从"跟环境变量"变成"默认中国大陆"——销售录入
 * 13800138000 这种不带 + 的号码，应该直接当国内号解析，而不是解析失败。
 *
 * 纯函数，客户端也能用。
 */
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

function asCountryCode(value: string | undefined): CountryCode | undefined {
  return value && COUNTRY_CODE_PATTERN.test(value) ? (value as CountryCode) : undefined;
}

/** 中国大陆。可以用 DEFAULT_PHONE_COUNTRY 覆盖（比如保留一点海外业务时）。 */
export const DEFAULT_PHONE_COUNTRY = "CN";

/**
 * 把脏数据规范成 E.164（"+8613800138000"），people.phone 只存这个形状。
 *
 * 不带 "+" 的输入只能用 `defaultCountry` 的拨号规则解析：libphonenumber 没有别的
 * 办法知道一个裸的本地号码属于哪个国家。
 *
 * 但"默认中国大陆"有个陷阱，是实测出来的：(415) 555-2671 这种美国号码，10 位数字
 * 恰好能拼成中国的一个合法座机（0415 是丹东的区号），于是被静默解析成
 * "+864155552671"——导入一份混合名单时这是数据事故，而且错得很隐蔽。所以裸号只
 * 认三种明确的中国形状：11 位手机号、带 +86/0086 的、带区号的座机（0571-88887777）。
 * 其它裸号返回 null，宁可让销售补一个 +，也不要猜。
 *
 * 显式传了别的默认国家（比如 "IN"、"US"）时不做这层限制——那是调用方明确知道
 * 自己在处理哪个国家的数据。
 */
const CN_MOBILE = /^1[3-9]\d{9}$/;
const CN_PREFIXED = /^(?:\+?86|0086)/;
/** 0 + 2-3 位区号 + 7-8 位号码，去掉分隔符后是 10-12 位且以 0 开头。 */
const CN_LANDLINE = /^0\d{9,11}$/;

function looksLikeChineseNumber(trimmed: string): boolean {
  const digits = trimmed.replace(/\D/g, "");
  return CN_MOBILE.test(digits) || CN_PREFIXED.test(digits) || CN_LANDLINE.test(digits);
}

export function normalizePhone(
  input: string,
  defaultCountry: string | undefined = process.env.DEFAULT_PHONE_COUNTRY ?? DEFAULT_PHONE_COUNTRY,
): string | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  const country = asCountryCode(defaultCountry);
  const bare = !trimmed.startsWith("+") && !/^00/.test(trimmed.replace(/\D/g, "").slice(0, 2));
  if (bare && country === "CN" && !looksLikeChineseNumber(trimmed)) return null;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, country);
    return parsed?.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

/** 只留数字，去掉 "+"——短信网关、外呼平台、Excel 比对都用这个形状。 */
export function nationalDigits(e164: string): string {
  return e164.replace(/\D/g, "");
}

/** 中国大陆手机号：11 位、1 开头。用于导入时的快速校验与提示。 */
export function isChineseMobile(e164: string): boolean {
  const digits = nationalDigits(e164);
  return /^86?1[3-9]\d{9}$/.test(digits);
}
