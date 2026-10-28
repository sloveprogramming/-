import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { searchCompanies } from "@/lib/qcc/provider";
import { interpretProduct } from "@/lib/icp/productIntent.server";
import type { CompanyHit, SearchResult } from "@/lib/qcc/types";
import type { ProductIntent } from "@/lib/icp/productIntent";

/**
 * 找客户搜索，两种模式：
 *
 *   GET ?q=坚果              → 直接按关键词搜（原有行为）
 *   GET ?product=面包丝      → 先解析产品意图，再按推导出的多个关键词搜
 *
 * 产品模式的价值：销售只知道"我要卖面包丝"，不知道"该搜烘焙食品厂"。
 * 意图解析把这一步补上，并把推导出的买家画像一起返回，让人能判断搜得对不对。
 *
 * 多关键词合并规则：按公司名去重，保留第一次出现的那条。同时记录每个关键词
 * 命中多少家——某个词一条都没搜到，说明这个词选得不好，界面该提示换。
 */

export type ProductSearchResponse = SearchResult & {
  intent: ProductIntent;
  /** 每个关键词命中多少家，便于判断搜得准不准。 */
  perTerm: Array<{ term: string; hits: number; error?: string }>;
};

export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const params = request.nextUrl.searchParams;
      const product = params.get("product")?.trim();
      const sourceParam = params.get("source");
      const source = sourceParam === "local" || sourceParam === "qcc" ? sourceParam : "auto";

      // ---- 产品模式：先解析意图，再按推导出的词搜 ----
      if (product) {
        const intent = await interpretProduct({ query: product });
        const perTerm: ProductSearchResponse["perTerm"] = [];
        const byName = new Map<string, CompanyHit>();
        let notice: string | null = null;
        // searchCompanies 收的是 auto/local/qcc，但结果里的 source 只会是 local 或 qcc
        // （auto 会被它自己解析掉）。所以从真实结果里取，而不是照抄入参。
        let resolvedSource: SearchResult["source"] = "local";

        for (const term of intent.searchTerms) {
          try {
            const result = await searchCompanies(term, { source, limit: 20 });
            resolvedSource = result.source;
            perTerm.push({ term, hits: result.total });
            if (result.notice && !notice) notice = result.notice;
            for (const hit of result.hits) {
              // 同名公司只留第一次出现的那条：多关键词很容易重复命中同一家。
              if (!byName.has(hit.name)) byName.set(hit.name, hit);
            }
          } catch (error) {
            perTerm.push({ term, hits: 0, error: error instanceof Error ? error.message : String(error) });
          }
        }

        const body: ProductSearchResponse = {
          source: resolvedSource,
          total: byName.size,
          hits: [...byName.values()].slice(0, 60),
          notice,
          intent,
          perTerm,
        };
        return NextResponse.json(body);
      }

      // ---- 关键词模式：原有行为 ----
      const q = params.get("q") ?? "";
      const result = await searchCompanies(q, { source });
      return NextResponse.json(result);
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
