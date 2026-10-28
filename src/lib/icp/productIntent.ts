/**
 * 产品意图：从一个产品名，推出"谁会买它"以及"该用什么词去搜"。
 *
 * 这是"说一个产品就自动拓客"的第一步。销售拿到一个新产品（比如「面包丝」），
 * 脑子里三个问题：这东西归哪一类、谁需要它、去哪儿找这些人。这个模块把
 * 三个回答变成结构化数据，后面接企查查搜索和话术生成。
 *
 * 为什么要两段式（本地词典 + AI 兜底）：
 *
 * 1. **本地词典优先**：常见的食品原料/品类命中词典就是零成本、毫秒级、结果稳定。
 *    每次都调模型既慢又贵，而大部分问题其实词典能答。
 * 2. **AI 只处理词典没收录的**：新品类、行业术语、组合产品。这时候才值得花钱。
 *
 * 还有一个刻意的设计：**输出必须包含"不确定"的表达**。模型说"面包丝属于烘焙原料"
 * 时，我们要能标出这是推断而不是事实——因为它可能是某种地方性叫法。下游用它
 * 生成话术时，不确定的品类应该问客户而不是直接断言。
 */

import type { IcpSegmentKey } from "./segments";

export type ProductIntentSource = "dictionary" | "ai";

/** 一个可执行的搜索策略：关键词 + 目标客户 + 排除项。 */
export type ProductIntent = {
  /** 用户输入的原话。 */
  query: string;
  /** 归到哪个品类；不确定时为 null。 */
  category: string | null;
  /** 这个品类通常卖给谁。 */
  segment: IcpSegmentKey | null;
  /** 一句话说明"谁需要它"。 */
  buyerDescription: string;
  /** 直接拿去搜企查查的关键词，已按"行业词 × 渠道词"组合好。 */
  searchTerms: string[];
  /** 要排除的干扰项。 */
  excludeTerms: string[];
  /** 判断依据来自词典还是 AI。 */
  source: ProductIntentSource;
  /** AI 给出的推断置信度；词典命中恒为 1。 */
  confidence: number;
  /** 需要人确认的地方（比如"面包丝"可能有多种叫法）。 */
  uncertainties: string[];
};

/**
 * 本地词典：食品/农产品领域常见品类的"谁买它"映射。
 *
 * 只收录**我们确实知道**的品类。词典越宽，越容易瞎猜——宁可让 AI 兜底，
 * 也不要把一个模糊词硬塞进某个品类。
 */
type DictEntry = {
  /** 命中这些词就归入本品类。 */
  aliases: readonly string[];
  category: string;
  segment: IcpSegmentKey;
  buyerDescription: string;
  /** 买家侧的行业词（用于搜公司名/经营范围）。 */
  buyerTerms: readonly string[];
};

const DICTIONARY: readonly DictEntry[] = [
  {
    aliases: ["面包丝", "面包糠", "面包屑", "panko", "裹粉"],
    category: "烘焙原料 / 裹粉类",
    segment: "distributor",
    buyerDescription: "烘焙食品厂、油炸食品加工厂、餐饮供应链、汉堡炸鸡连锁的采购",
    buyerTerms: ["烘焙食品", "食品加工", "速冻食品", "餐饮供应链", "裹粉", "油炸食品", "西式快餐"],
  },
  {
    aliases: ["山核桃", "碧根果", "夏威夷果", "腰果", "开心果", "板栗", "每日坚果", "坚果", "炒货"],
    category: "坚果炒货",
    segment: "distributor",
    buyerDescription: "休闲食品经销商、商超采购、零食连锁、电商分销商",
    buyerTerms: ["休闲食品", "食品批发", "预包装食品", "商超配送", "零食连锁", "食品供应链"],
  },
  {
    aliases: ["果干", "蜜饯", "芒果干", "葡萄干", "蔓越莓干", "红枣"],
    category: "果干蜜饯",
    segment: "distributor",
    buyerDescription: "休闲食品经销商、零食连锁、电商分销商",
    buyerTerms: ["休闲食品", "食品批发", "蜜饯", "果干", "食品供应链"],
  },
  {
    aliases: ["调味料", "复合调味", "酱料", "火锅底料", "香辛料"],
    category: "调味品",
    segment: "distributor",
    buyerDescription: "调味品经销商、餐饮供应链、火锅连锁、食品加工厂",
    buyerTerms: ["调味品", "食品配料", "餐饮供应链", "调味料", "食品加工"],
  },
  {
    aliases: ["预制菜", "速冻食品", "冷冻食品", "半成品菜"],
    category: "预制菜 / 速冻食品",
    segment: "retail_chain",
    buyerDescription: "商超冷冻区采购、餐饮连锁、社区团购、电商生鲜",
    buyerTerms: ["速冻食品", "预制菜", "食品供应链", "生鲜电商", "餐饮连锁"],
  },
  {
    aliases: ["礼盒", "年货", "伴手礼", "节日礼品"],
    category: "礼盒 / 礼品",
    segment: "corporate_gifting",
    buyerDescription: "企业工会与行政采购、礼品公司、福利平台",
    buyerTerms: ["礼品", "企业福利", "团购", "商贸", "文化礼品"],
  },
];

/** 词典命中：返回 null 表示该交给 AI。 */
export function matchDictionary(query: string): ProductIntent | null {
  const text = query.trim().toLowerCase();
  if (!text) return null;
  // 最长匹配优先："每日坚果"应该命中坚果条目而不是被"坚果"截断成别的。
  const hits = DICTIONARY.flatMap((entry) =>
    entry.aliases
      .filter((alias) => text.includes(alias.toLowerCase()))
      .map((alias) => ({ entry, alias })),
  ).sort((a, b) => b.alias.length - a.alias.length);
  if (!hits.length) return null;

  const { entry } = hits[0];
  return {
    query: query.trim(),
    category: entry.category,
    segment: entry.segment,
    buyerDescription: entry.buyerDescription,
    searchTerms: buildSearchTerms(entry.buyerTerms, text),
    excludeTerms: ["种植合作社", "机械设备", "餐饮堂食"],
    source: "dictionary",
    confidence: 1,
    uncertainties: [],
  };
}

/**
 * 把"买家行业词"和"产品词"组合成可搜索的关键词。
 *
 * 企查查是按公司名/经营范围搜的——直接搜"面包丝"只能找到名字里带这三个字的公司，
 * 而买它的是"烘焙食品厂"。所以要**两个都搜**：产品词找同行/供应商，行业词找买家。
 */
export function buildSearchTerms(buyerTerms: readonly string[], product: string): string[] {
  const terms = new Set<string>();
  // 产品词本身：能找到同品类公司（往往是潜在客户或竞争对手，都值得看）
  terms.add(product);
  // 买家行业词：这是主要目标
  for (const term of buyerTerms) terms.add(term);
  return [...terms].filter(Boolean).slice(0, 8);
}

/** AI 返回的解析结果 → ProductIntent。做严格的形状校验：模型经常多给字段或给错类型。 */
export function parseAiIntent(
  raw: unknown,
  query: string,
  allowedSegments: readonly IcpSegmentKey[],
): ProductIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const str = (input: unknown): string | null =>
    typeof input === "string" && input.trim() ? input.trim() : null;
  const list = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];

  const category = str(value.category);
  const buyerDescription = str(value.buyerDescription);
  const terms = list(value.searchTerms);
  if (!category || !buyerDescription || !terms.length) return null;

  const segmentRaw = str(value.segment);
  const segment = segmentRaw && (allowedSegments as readonly string[]).includes(segmentRaw)
    ? (segmentRaw as IcpSegmentKey)
    : null;

  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.min(1, Math.max(0, value.confidence))
    : 0.5;

  return {
    query: query.trim(),
    category,
    segment,
    buyerDescription,
    searchTerms: terms.slice(0, 8),
    excludeTerms: list(value.excludeTerms),
    source: "ai",
    confidence,
    uncertainties: list(value.uncertainties),
  };
}

/** 生成给模型的提示。要求它返回严格 JSON，并明确"不确定就说不知道"。 */
export function buildIntentPrompt(query: string, allowedSegments: readonly string[]): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: [
      "你帮一个食品公司的销售判断：一个产品该卖给谁，以及该用什么关键词去找这些公司。",
      "只输出 JSON，不要任何解释文字。",
      "字段：category（品类）、segment（最匹配的客户类型，只能从给定列表选）、",
      "buyerDescription（谁需要它，一句话）、searchTerms（搜公司用的关键词数组，3-8 个）、",
      "excludeTerms（要排除的干扰项数组）、confidence（0-1，你对这个判断的把握）、",
      "uncertainties（数组：你不确定的地方，比如「这个词可能是地方性叫法」）。",
      "",
      "重要：宁可说不知道，也不要编。如果这个词有多种含义或你不认识，",
      "confidence 给低分，并在 uncertainties 里写清楚。",
      `客户类型只能从这些选：${allowedSegments.join("、")}`,
    ].join("\n"),
    userPrompt: `产品：「${query}」\n它该卖给谁？用哪些关键词去找这些公司？`,
  };
}

/** 词典没命中、AI 也不可用时的兜底：至少给用户一个能立刻搜的结果。 */
export function fallbackIntent(query: string): ProductIntent {
  const trimmed = query.trim();
  return {
    query: trimmed,
    category: null,
    segment: null,
    buyerDescription: "暂未识别出买家画像，建议按产品词直接搜",
    searchTerms: [trimmed],
    excludeTerms: [],
    source: "dictionary",
    confidence: 0,
    uncertainties: ["没有识别出这个产品的买家类型，结果可能不精准"],
  };
}
