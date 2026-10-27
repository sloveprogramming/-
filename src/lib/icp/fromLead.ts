/**
 * 从一条线索（人 + 公司 + 自定义字段）推出评分信号。
 *
 * 评分模型要的是"这家公司像不像客户"，而线索表里现在有的只是：姓名、职位、
 * 邮箱、手机号，加上导入时带的**自定义字段**（CSV 的中文表头会变成 custom 的 key）。
 * 所以这里做两件事：
 *
 *   1. 能从现有数据直接判断的（有没有手机号、是不是决策人）直接判断；
 *   2. 其余从 custom 里按**别名**找——导入的表格千奇百怪，「门店数」「门店数量」
 *      「storeCount」都得认。
 *
 * 找不到就留 null，不猜。null 在评分里是 0 分并触发"还缺什么"，这比瞎猜有用。
 */

import type { LeadSignals, Scale } from "./score";

export type LeadLike = {
  person: {
    fullName?: string | null;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
    custom?: Record<string, unknown> | null;
  };
  company?: { name?: string | null; domain?: string | null } | null;
};

/** 在 custom 里按别名找第一个有值的键；键名大小写与空格不敏感。 */
export function pickCustom(custom: Record<string, unknown> | null | undefined, aliases: readonly string[]): unknown {
  if (!custom) return undefined;
  const normalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(custom)) {
    normalized.set(key.toLowerCase().replace(/[\s_\-]/g, ""), value);
  }
  for (const alias of aliases) {
    const hit = normalized.get(alias.toLowerCase().replace(/[\s_\-]/g, ""));
    if (hit !== undefined && hit !== null && String(hit).trim() !== "") return hit;
  }
  return undefined;
}

/** 把「是/否/有/没有/true/1/yes/Y」这类写法统一成布尔；认不出返回 null。 */
export function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (["是", "有", "true", "1", "yes", "y", "在卖", "有卖"].includes(text)) return true;
  if (["否", "没有", "无", "false", "0", "no", "n", "不卖"].includes(text)) return false;
  return null;
}

/** 数字字段：容忍 "80 家"、"80家门店"、"1,200" 这类写法。 */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

const SCALE_ALIASES: Record<string, Scale> = {
  "微型": "micro", "10人以下": "micro", "micro": "micro",
  "小型": "small", "10-50人": "small", "small": "small",
  "中型": "mid", "50-300人": "mid", "mid": "mid", "medium": "mid",
  "大型": "large", "300人以上": "large", "large": "large",
};

export function toScale(value: unknown): Scale | null {
  if (typeof value !== "string") return null;
  return SCALE_ALIASES[value.trim().toLowerCase()] ?? null;
}

/** 职位里出现这些词，就认为找对了人（决策人 / 采购 / 渠道负责人）。 */
const DECISION_TITLE = /(总经理|老板|董事长|创始人|合伙人|采购|渠道|销售总监|商务|负责人|CEO|创始人|总监|经理)/;

/** 公司名/域名/行业字段里出现这些词，认为行业对得上。 */
const INDUSTRY_HINT = /(坚果|炒货|零食|休闲食品|食品|干果|蜜饯|食品批发|食品经营|供应链)/;

export function leadSignalsFromRow(row: LeadLike): LeadSignals {
  const custom = row.person.custom ?? {};
  const companyName = row.company?.name ?? "";
  const industryField = pickCustom(custom, ["行业", "所属行业", "主营行业", "industry", "行业分类"]);
  const industryText = `${typeof industryField === "string" ? industryField : ""} ${companyName}`.trim();

  return {
    // 行业：有专门的行业字段就用它，否则看公司名里有没有食品/坚果这类词。
    industryMatch: industryText ? INDUSTRY_HINT.test(industryText) : null,
    foodLicense: toBoolean(pickCustom(custom, ["食品经营许可证", "食品许可证", "食品流通许可证", "foodLicense"])),
    registeredYears: toNumber(pickCustom(custom, ["成立年限", "成立年数", "经营年限", "注册年限", "registeredYears"])),
    scale: toScale(pickCustom(custom, ["规模", "公司规模", "参保人数区间", "scale", "员工规模"])),

    storeCount: toNumber(pickCustom(custom, ["门店数", "门店数量", "门店家数", "店铺数", "storeCount"])),
    hasOnlineStore: toBoolean(pickCustom(custom, ["有电商店", "电商店铺", "网店", "淘宝店", "抖音小店", "hasOnlineStore"])),
    distributesSnacks: toBoolean(pickCustom(custom, ["在卖坚果", "是否卖坚果", "经销品类", "distributesSnacks"])),
    distributionNetwork: toBoolean(pickCustom(custom, ["分销网络", "配送能力", "有配送", "distributionNetwork"])),

    hiringChannelRole: toBoolean(pickCustom(custom, ["招渠道岗", "在招渠道", "招聘渠道", "hiringChannelRole"])),
    recentTender: toBoolean(pickCustom(custom, ["近期招标", "有招标", "中标公告", "recentTender"])),
    newSnackCategory: toBoolean(pickCustom(custom, ["新增坚果品类", "上新坚果", "扩品类", "newSnackCategory"])),
    attendedTradeShow: toBoolean(pickCustom(custom, ["参展", "参加过展会", "糖酒会", "attendedTradeShow"])),

    hasMobile: Boolean(row.person.phone?.trim()),
    hasWecom: toBoolean(pickCustom(custom, ["企业微信", "已加企微", "微信", "wecom", "hasWecom"])),
    decisionMakerIdentified: row.person.title ? DECISION_TITLE.test(row.person.title) : null,
  };
}
