import { describe, expect, test } from "bun:test";
import {
  buildSearchTerms,
  fallbackIntent,
  matchDictionary,
  parseAiIntent,
} from "./productIntent";
import { ICP_SEGMENTS, type IcpSegmentKey } from "./segments";

/**
 * 产品意图解析的纯逻辑。
 *
 * 这里最容易出两类问题，都必须钉住：
 * 1. 词典把模糊词硬塞进某个品类（"面包丝"可能是地方叫法，不该拍板成铁事实）
 * 2. AI 返回的 JSON 形状不对（多字段、少字段、类型错）直接崩
 */

const SEGMENTS = ICP_SEGMENTS.map((segment) => segment.key) as IcpSegmentKey[];

describe("本地词典", () => {
  test("面包丝/面包糠归到烘焙原料，买家是食品加工与餐饮供应链", () => {
    const intent = matchDictionary("面包丝");
    expect(intent).not.toBeNull();
    expect(intent!.category).toContain("烘焙");
    expect(intent!.buyerDescription).toContain("食品");
    expect(intent!.source).toBe("dictionary");
    expect(intent!.confidence).toBe(1);
  });

  test("坚果类归到休闲食品渠道", () => {
    const intent = matchDictionary("山核桃仁");
    expect(intent!.category).toBe("坚果炒货");
    expect(intent!.segment).toBe("distributor");
  });

  test("礼盒归到企业团购", () => {
    expect(matchDictionary("年货礼盒")!.segment).toBe("corporate_gifting");
  });

  test("最长匹配优先：每日坚果不会被别的短词截胡", () => {
    const intent = matchDictionary("每日坚果");
    expect(intent!.category).toBe("坚果炒货");
  });

  test("词典没收的品类返回 null，交给 AI", () => {
    expect(matchDictionary("某种冷门工业原料")).toBeNull();
    expect(matchDictionary("")).toBeNull();
  });
});

describe("搜索词构造", () => {
  test("产品词与买家行业词都要搜", () => {
    const terms = buildSearchTerms(["烘焙食品", "食品加工"], "面包丝");
    expect(terms).toContain("面包丝");
    expect(terms).toContain("烘焙食品");
    expect(terms).toContain("食品加工");
  });

  test("去重且不超过 8 个（企查查批量搜索的实际上限）", () => {
    const terms = buildSearchTerms(["a", "a", "b", "c", "d", "e", "f", "g", "h", "i"], "x");
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms.length).toBeLessThanOrEqual(8);
  });
});

describe("AI 结果解析", () => {
  const valid = {
    category: "烘焙原料",
    segment: "distributor",
    buyerDescription: "烘焙厂与餐饮供应链",
    searchTerms: ["烘焙食品", "食品加工"],
    excludeTerms: ["种植"],
    confidence: 0.8,
    uncertainties: ["可能是地方性叫法"],
  };

  test("合法 JSON 能解析", () => {
    const intent = parseAiIntent(valid, "面包丝", SEGMENTS);
    expect(intent).not.toBeNull();
    expect(intent!.source).toBe("ai");
    expect(intent!.confidence).toBe(0.8);
    expect(intent!.uncertainties).toHaveLength(1);
  });

  test("缺关键字段返回 null（不让空数据流到下游）", () => {
    expect(parseAiIntent({ ...valid, category: "" }, "x", SEGMENTS)).toBeNull();
    expect(parseAiIntent({ ...valid, buyerDescription: undefined }, "x", SEGMENTS)).toBeNull();
    expect(parseAiIntent({ ...valid, searchTerms: [] }, "x", SEGMENTS)).toBeNull();
    expect(parseAiIntent("not an object", "x", SEGMENTS)).toBeNull();
  });

  test("非法 segment 归为 null，而不是硬套一个", () => {
    const intent = parseAiIntent({ ...valid, segment: "not_a_segment" }, "x", SEGMENTS);
    expect(intent!.segment).toBeNull();
  });

  test("置信度被夹到 0-1", () => {
    expect(parseAiIntent({ ...valid, confidence: 5 }, "x", SEGMENTS)!.confidence).toBe(1);
    expect(parseAiIntent({ ...valid, confidence: -3 }, "x", SEGMENTS)!.confidence).toBe(0);
    expect(parseAiIntent({ ...valid, confidence: "high" }, "x", SEGMENTS)!.confidence).toBe(0.5);
  });

  test("搜索词超过 8 个会截断", () => {
    const many = Array.from({ length: 20 }, (_, i) => `term${i}`);
    expect(parseAiIntent({ ...valid, searchTerms: many }, "x", SEGMENTS)!.searchTerms).toHaveLength(8);
  });
});

describe("兜底", () => {
  test("没识别出买家画像时，至少给一个能搜的词，并明说不确定", () => {
    const intent = fallbackIntent("面包丝");
    expect(intent.searchTerms).toEqual(["面包丝"]);
    expect(intent.confidence).toBe(0);
    expect(intent.uncertainties.length).toBeGreaterThan(0);
  });
});
