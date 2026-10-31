import "server-only";

import { z } from "zod";
import { getOpenRouterRuntime } from "@/lib/ai/server/runtime";
import { completeStructuredWithOpenRouter } from "@/lib/ai/server/structuredCompletion";
import { ICP_SEGMENTS, type IcpSegmentKey } from "./segments";
import { buildIntentPrompt, fallbackIntent, matchDictionary, parseAiIntent, type ProductIntent } from "./productIntent";

/**
 * 产品意图解析的服务端入口：词典优先，AI 兜底。
 *
 * 分成两段是因为两个原因都很实际：
 *
 * 1. **成本**：词典命中时零模型调用。销售每天问几十个产品，全走 AI 是一笔持续开销。
 * 2. **稳定**：词典的结果永远一样，面试/演示时不会因为模型抽风而给出奇怪答案。
 *
 * AI 只处理词典没收录的品类。它失败（超时、接口坏、输出不合 schema）时退回
 * 兜底结果——**保证用户总能拿到能搜的东西**，而不是报错。
 */

const SEGMENT_KEYS = ICP_SEGMENTS.map((segment) => segment.key) as IcpSegmentKey[];

/** 用结构化输出约束模型：只给 JSON schema 里有的字段。 */
const INTENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["category", "segment", "buyerDescription", "searchTerms", "excludeTerms", "confidence", "uncertainties"],
  properties: {
    category: { type: "string", minLength: 1, maxLength: 60 },
    segment: { anyOf: [{ type: "string", enum: [...SEGMENT_KEYS] }, { type: "null" }] },
    buyerDescription: { type: "string", minLength: 1, maxLength: 300 },
    searchTerms: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1 } },
    excludeTerms: { type: "array", maxItems: 10, items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    uncertainties: { type: "array", maxItems: 10, items: { type: "string" } },
  },
};

export async function interpretProduct(input: {
  query: string;
  /** 关掉 AI，只走词典（测试用）。 */
  allowAi?: boolean;
}): Promise<ProductIntent> {
  const query = input.query.trim();
  if (!query) return fallbackIntent("");

  // 1. 词典命中直接用：零成本、结果确定。
  const dictionaryHit = matchDictionary(query);
  if (dictionaryHit) return dictionaryHit;

  // 2. 词典没收录才问模型。
  if (input.allowAi === false) return fallbackIntent(query);
  try {
    const prompt = buildIntentPrompt(query, SEGMENT_KEYS);
    await getOpenRouterRuntime(undefined, 20_000);
    const result = await completeStructuredWithOpenRouter({
      timeoutMs: 20_000,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens: 800,
      jsonSchema: INTENT_SCHEMA,
      schemaName: "product_intent",
      schemaDescription: "提交产品意图解析结果。只调一次。",
    });
    const parsed = parseAiIntent(JSON.parse(result.text), query, SEGMENT_KEYS);
    if (!parsed) return fallbackIntent(query);
    // AI 给的关键词如果为空，至少把原始产品词放进去，否则后面搜不了。
    if (!parsed.searchTerms.length) parsed.searchTerms = [query];
    return parsed;
  } catch (error) {
    console.error("[icp] 产品意图解析失败，退回兜底：", error);
    return fallbackIntent(query);
  }
}

export { z };
