import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { agentArtifacts } from "../schema";
import type { ToolRegistry } from "../tools";

/**
 * 搜索结果的历史记忆：查一个词以前命中过几家。
 *
 * ## 为什么值得做
 *
 * 重规划时模型最容易犯的错是**重复试死词**。用「面包丝」搜 0 家，下次换个产品
 * 它可能又给出「面包丝」；或者反复给出「坚果批发」这种在这家企业库里根本没
 * 数据支撑的词。它每次都从零开始想，因为没人告诉它"这个词上周试过，0 家"。
 *
 * 数据其实已经在库里了：每次找客户都会写一份 `sourcing` 产物，里面就有
 * 「词 → 命中数」。这里只是把它读出来聚合一遍。
 *
 * ## 为什么不建专门的表
 *
 * 一个词的命中率是**派生的统计**，不是事实来源。为它建表就要处理更新、失效、
 * 一致性问题；而 artifact 已经是事实来源，聚合 50 条记录的成本可以忽略。
 * 数据量真的大到扛不住时再优化，现在不预先设计。
 *
 * ## 口径说明
 *
 * 「命中数」在不同数据源下不可直接比：本地库可能几十家，企查查全国是几万家。
 * 所以统计里带上 `sources`，让调用方能看出这个结论是哪个口径下的。
 */

/** 最多回溯多少条历史产物。50 条 ≈ 最近几十次找客户，够看出规律。 */
const HISTORY_LIMIT = 50;

/** 最多回多少个词的统计，防止一次返回几百个词把上下文撑满。 */
const MAX_TERMS = 15;

export type SearchTermStat = {
  term: string;
  /** 这个词出现在几次搜索里。 */
  runs: number;
  /** 其中命中 > 0 的次数——这就是"有效词"的比例。 */
  hitRuns: number;
  /** 累计命中家数。 */
  totalHits: number;
  /** 见过的数据源（local / qcc）。口径不同，命中数不可直接比。 */
  sources: string[];
};

/**
 * 把若干份 sourcing 产物聚合成词级统计。
 *
 * 抽成纯函数是为了能测：DB 查询是薄的，聚合逻辑才是容易写错的地方
 * （比如把 replan 补搜的词漏掉、或者把 error 的词算成命中）。
 */
export function aggregateSearchTerms(
  payloads: readonly unknown[],
  options: { filterTerms?: readonly string[]; limit?: number } = {},
): { stats: SearchTermStat[]; scanned: number } {
  const map = new Map<string, SearchTermStat>();
  const filter = options.filterTerms?.length
    ? new Set(options.filterTerms.map((term) => term.trim().toLowerCase()))
    : null;

  let scanned = 0;
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    const record = payload as { terms?: unknown; replan?: unknown };
    if (!Array.isArray(record.terms)) continue;
    scanned += 1;

    // 补搜的词也算历史：它们同样回答"这个词行不行"。
    const replanTerms = (() => {
      const replan = record.replan as { newTerms?: unknown } | undefined;
      if (!replan || !Array.isArray(replan.newTerms)) return [] as string[];
      return replan.newTerms.filter((item): item is string => typeof item === "string");
    })();

    for (const entry of record.terms) {
      if (!entry || typeof entry !== "object") continue;
      const { term, hits, error } = entry as { term?: unknown; hits?: unknown; error?: unknown };
      if (typeof term !== "string" || !term.trim()) continue;
      const key = term.trim();
      const lowered = key.toLowerCase();
      if (filter && !filter.has(lowered)) continue;

      const count = Number(hits);
      const hitCount = Number.isFinite(count) && count > 0 ? count : 0;
      const current = map.get(key) ?? { term: key, runs: 0, hitRuns: 0, totalHits: 0, sources: [] };
      current.runs += 1;
      if (hitCount > 0) current.hitRuns += 1;
      current.totalHits += hitCount;
      // 出错记为"这个口径下没结果"，但不算命中——避免把限流当成"这词不行"。
      if (typeof error === "string" && !current.sources.includes("error")) current.sources.push("error");
      map.set(key, current);
    }

    // 补搜词只增加"被用过"的计数，没有独立命中数（它们的结果已并入 terms）。
    for (const term of replanTerms) {
      const key = term.trim();
      if (!key) continue;
      if (filter && !filter.has(key.toLowerCase())) continue;
      if (!map.has(key)) map.set(key, { term: key, runs: 0, hitRuns: 0, totalHits: 0, sources: [] });
    }
  }

  const stats = [...map.values()]
    // 命中多的排前面：模型最需要知道"哪些词真的能搜到东西"。
    .sort((left, right) => right.totalHits - left.totalHits || right.runs - left.runs)
    .slice(0, options.limit ?? MAX_TERMS);

  return { stats, scanned };
}

export function registerHistoryTools(registry: ToolRegistry): ToolRegistry {
  return registry.register({
    name: "search_history",
    description:
      "查过去搜索关键词的命中情况（哪些词真的能搜到公司、哪些词一直是 0 家）。重规划前先用它，避免重复试已经证明搜不到的词。",
    risk: "read",
    schema: z.object({
      terms: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("只看这几个词的统计；不传则返回命中最好的若干词"),
    }),
    execute: async ({ terms }) => {
      try {
        const rows = await db
          .select({ payload: agentArtifacts.payload })
          .from(agentArtifacts)
          .where(and(inOrg(agentArtifacts), eq(agentArtifacts.kind, "sourcing")))
          .orderBy(desc(agentArtifacts.createdAt))
          .limit(HISTORY_LIMIT);
        const { stats, scanned } = aggregateSearchTerms(
          rows.map((row) => row.payload),
          { filterTerms: terms },
        );
        return {
          扫描历史条数: scanned,
          词统计: stats.length,
          /** 0 家 = 这个词过去从没搜到过，基本可以放弃。 */
          从没搜到过的词: stats.filter((item) => item.totalHits === 0).map((item) => item.term),
          词: stats,
        };
      } catch (error) {
        // 查历史失败不该挡住重规划——它只是参考信息。
        return { error: error instanceof Error ? error.message : String(error), 词: [] };
      }
    },
  });
}
