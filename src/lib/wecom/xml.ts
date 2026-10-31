import "server-only";

/**
 * 极简 XML 解析：只处理企业微信回调那种形状。
 *
 * ```xml
 * <xml><ToUserName><![CDATA[corp]]></ToUserName><Content>你好</Content></xml>
 * ```
 *
 * 为什么不引入 fast-xml-parser：企微回调是固定的扁平结构（没有属性、没有嵌套、
 * 文本要么 CDATA 要么纯文本），为它加一个通用 XML 库不划算——通用库会接受更复杂
 * 的结构，反而扩大攻击面。这个解析器只认白名单的标签，拿到别的东西直接返回 null。
 *
 * 实现上有个坑：如果直接用 `/<tag>(.*?)<\/tag>/` 全局匹配，第一个匹配会把整个
 * `<xml>` 包裹层当成标签名，把内部所有内容吞成它的文本值，于是什么都取不到。
 * 所以先剥掉外层 `<xml>...</xml>`，再把 CDATA 段换成占位符（CDATA 里可以有
 * `<` 和 `>`，直接扫标签会切碎），解析完再还原。
 */

/** CDATA 占位符：用不会出现在企微字段里的字符组合。 */
const CDATA_OPEN = "\u0000CDATA";
const CDATA_MARKER = /\u0000CDATA(\d+)\u0000/g;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 只取一层扁平标签的值；同名标签只保留第一个。 */
export function parseFlatXml(xml: string, allowedTags?: readonly string[]): Record<string, string> | null {
  const trimmed = xml.trim();
  const outer = /^<xml>([\s\S]*)<\/xml>$/.exec(trimmed);
  if (!outer) return null;

  // 1. 先把 CDATA 段抽出来，换成占位符——里面可能有 < >，直接扫会被切碎。
  const cdata: string[] = [];
  const inner = outer[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, value: string) => {
    cdata.push(value);
    return `${CDATA_OPEN}${cdata.length - 1}\u0000`;
  });

  // 2. 扫剩下的普通标签。
  const allowed = allowedTags ? new Set(allowedTags) : null;
  const fields: Record<string, string> = {};
  for (const match of inner.matchAll(/<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g)) {
    const [, tag, value] = match;
    if (allowed && !allowed.has(tag)) continue;
    if (tag in fields) continue;
    fields[tag] = decodeEntities(value.trim());
  }

  // 3. 把 CDATA 占位符还原成原文（不做实体解码：CDATA 里就是字面值）。
  for (const [tag, value] of Object.entries(fields)) {
    fields[tag] = value.replace(CDATA_MARKER, (_, index: string) => cdata[Number(index)] ?? "");
  }

  return Object.keys(fields).length ? fields : null;
}

/** 企业微信文本消息的字段白名单。 */
export const WECOM_TEXT_TAGS = [
  "ToUserName",
  "FromUserName",
  "CreateTime",
  "MsgType",
  "Content",
  "MsgId",
  "AgentID",
  "Encrypt",
] as const;
