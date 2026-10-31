import "server-only";

import { searchKnowledge } from "@/lib/crm/knowledge";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import type { CrmExecutor } from "@/lib/crm/repository";
import { fuseRrf, type FusedItem } from "../rrf";
import { chunkCount, searchChunks, type VectorHit } from "./index";
import { embeddingEnabled } from "../embedding";
import { milvusEnabled } from "./client";

/**
 * 混合检索：全文检索（PostgreSQL） + 向量检索（Milvus），RRF 融合。
 *
 * 为什么要两路——这两类检索的盲区刚好互补：
 *
 * | 场景 | 全文检索 | 向量检索 |
 * |---|---|---|
 * | 查「山核桃仁」这种专有名词 | ✅ 精确命中 | 🟡 可能被同义词稀释 |
 * | 查「有没有便宜的坚果」 | ❌ 没有「便宜」这个词 | ✅ 语义命中 |
 * | 查数字/型号（「200箱」） | ✅ 精确 | ❌ 数字在向量里没有意义 |
 * | 口语化提问 | ❌ 词不匹配 | ✅ 能懂 |
 *
 * 融合用 RRF（见 rrf.ts）：只看排名，不调权重。
 *
 * **降级策略**：向量检索不可用时（Milvus 挂了 / 没有 embedding / collection 空）
 * 自动退回纯全文检索，并标记 `degraded: true`。这一点很重要——知识库是起草的
 * 依据，检索挂了不能让起草整个失败，但必须让调用方知道"这次没有语义能力"。
 */

export type HybridKnowledgeHit = {
  documentId: string;
  versionId: string;
  chunkIndex: number;
  title: string;
  kind: string;
  tags: string[];
  text: string;
  /** 融合分数。 */
  score: number;
  /** 出现在哪几路结果里：["bm25"] / ["vector"] / ["bm25","vector"]。 */
  sources: string[];
  ranks: Record<string, number>;
};

export type HybridSearchResult = {
  hits: HybridKnowledgeHit[];
  /** 纯全文检索时为 true —— 说明这次没有语义能力。 */
  degraded: boolean;
  /** 降级原因，便于日志与设置页展示。 */
  degradedReason: string | null;
};

/**
 * 混合检索。
 *
 * @param query 用户问题原文
 * @param options.limit 返回几条（默认 5）
 * @param options.perRoute 每路先召回多少条（默认 15，融合前要留余量）
 */
export async function hybridSearch(
  query: string,
  options: {
    limit?: number;
    perRoute?: number;
    executor?: CrmExecutor;
    kind?: string | null;
  } = {},
): Promise<HybridSearchResult> {
  const text = query.trim();
  if (!text) return { hits: [], degraded: false, degradedReason: null };

  const limit = options.limit ?? 5;
  const perRoute = options.perRoute ?? 15;

  // ---- 第一路：PostgreSQL 全文检索 ----
  //
  // 复用现有 searchKnowledge：它内部做 ts_rank_cd 排序 + tag 匹配 + token 预算。
  // 这里只要它返回的候选块，不要它的"选段"逻辑（那套是给起草拼上下文用的）。
  const textRoute: Array<{ key: string; entry: HybridKnowledgeHit }> = [];
  try {
    const selection = await searchKnowledge(options.executor ?? (await defaultExecutor()), {
      query: text,
      maxTokens: 20_000, // 只要候选，放宽预算避免被截断
    });
    // 关键判断：`rank === 0` 意味着这一路**没有真正匹配**，只是按固定顺序
    // 返回了文档。中文在 PostgreSQL 的 'simple' 配置下不分词（整句算一个
    // token），所以中文查询几乎必然 rank=0。把这种「零分结果」混进 RRF
    // 会污染融合排序（每篇都拿到同样的底分），必须剔除。
    const scored = selection.entries.filter((entry) => {
      const rank = typeof entry.rank === "number" ? entry.rank : Number(entry.rank ?? 0);
      return Number.isFinite(rank) && rank > 0;
    });
    for (const entry of scored) {
      // 全文检索返回的是「整篇文档的摘录」，不是 chunk。用它作为一路召回，
      // 与向量路按 documentId 对齐——这样两路都能认出是同一篇文档。
      const key = entry.documentId;
      if (textRoute.some((item) => item.key === key)) continue;
      textRoute.push({
        key,
        entry: {
          documentId: entry.documentId,
          versionId: entry.documentVersionId,
          chunkIndex: 0,
          title: entry.title,
          kind: String(entry.kind ?? ""),
          tags: [...entry.tags],
          text: entry.excerpt,
          score: typeof entry.rank === "number" ? entry.rank : Number(entry.rank ?? 0),
          sources: [],
          ranks: {},
        },
      });
      if (textRoute.length >= perRoute) break;
    }
  } catch {
    // 全文检索是尽力而为：失败时仍可只靠向量路返回结果。
  }

  // ---- 第二路：Milvus 向量检索 ----
  //
  // 注意粒度和第一路不同：全文检索给的是「整篇文档的摘录」，向量检索给的是
  // 「具体某个 chunk」。所以融合键不同（文档 id vs 块 id），融合之后两路会
  // 同时出现在结果里——这是有意的：一篇文档既被关键词命中又被语义命中，
  // 说明证据更强。
  const vectorRoute: Array<{ key: string; entry: HybridKnowledgeHit }> = [];
  let vectorError: string | null = null;
  let vectorAvailable = milvusEnabled() && embeddingEnabled();

  if (vectorAvailable) {
    try {
      const count = await chunkCount();
      if (count === 0) {
        vectorAvailable = false;
        vectorError = "索引为空，尚未同步";
      } else {
        const hits = await searchChunks({ query: text, limit: perRoute, kind: options.kind });
        for (const hit of hits) {
          // 块级 key：同一文档的不同块是不同的结果，不能按文档去重。
          const key = `${hit.documentId}#${hit.chunkIndex}`;
          vectorRoute.push({
            key,
            entry: {
              documentId: hit.documentId,
              versionId: hit.versionId,
              chunkIndex: hit.chunkIndex,
              title: hit.title,
              kind: hit.kind,
              tags: hit.tags,
              text: hit.text,
              score: hit.score,
              sources: [],
              ranks: {},
            },
          });
        }
      }
    } catch (error) {
      vectorAvailable = false;
      vectorError = error instanceof Error ? error.message : String(error);
    }
  } else {
    vectorError = milvusEnabled() ? "向量化未启用" : "Milvus 未启用";
  }

  // ---- 融合 ----
  //
  // 两路粒度不同，但融合键都用「文档 id」：销售最终要看的是「哪篇知识有用」，
  // 不是「哪一块」。同一文档在向量路命中多个块时，只取排名最高的那一块作为
  // 代表——否则一篇文档会占满整个结果列表。
  const textList = textRoute.map((item) => ({ ...item.entry, routeKey: `doc:${item.key}` }));
  const vectorList = bestChunkPerDocument(vectorRoute).map((item) => ({ ...item.entry, routeKey: `doc:${item.entry.documentId}` }));

  const lists = [
    { source: "bm25", items: textList },
    { source: "vector", items: vectorList },
  ];
  const fused: FusedItem<HybridKnowledgeHit>[] = fuseRrf(lists, {
    key: (item) => item.documentId,
    limit,
  });

  return {
    hits: fused.map((item) => ({
      ...item.item,
      score: Number(item.score.toFixed(6)),
      sources: item.sources,
      ranks: item.ranks,
    })),
    degraded: !vectorAvailable,
    degradedReason: vectorAvailable ? null : vectorError,
  };
}

/** 默认执行器：直接用 db（服务端调用时组织作用域已建立）。 */
async function defaultExecutor(): Promise<CrmExecutor> {
  // searchKnowledge 要求 CrmExecutor；db 满足这个约束。
  const { db } = await import("@/lib/db");
  void currentOrganizationId();
  return db as unknown as CrmExecutor;
}

/**
 * 混合检索的诊断信息，给设置页展示"语义检索是否生效"。
 */
export async function hybridDiagnostics(): Promise<{
  milvus: boolean;
  embedding: boolean;
  vectors: number;
  note: string;
}> {
  const milvus = milvusEnabled();
  const embedding = embeddingEnabled();
  const vectors = milvus && embedding ? await chunkCount() : 0;
  const note = !milvus
    ? "Milvus 未启用，检索只用全文"
    : !embedding
      ? "向量化服务不可用，检索只用全文"
      : vectors === 0
        ? "索引为空，去设置页点「重建索引」"
        : `已索引 ${vectors} 个知识块`;
  return { milvus, embedding, vectors, note };
}

export type { VectorHit };
/**
 * 同一文档命中多个 chunk 时，只保留相似度最高的那一个。
 *
 * 为什么必须做这一步：一篇长文档切了 5 块，向量检索很可能 5 块全进候选。
 * 不去重的话，融合后这篇文档会以 5 个不同 rank 反复加分，把其他文档挤出去。
 */
function bestChunkPerDocument<T extends { entry: HybridKnowledgeHit }>(items: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const key = item.entry.documentId;
    const current = best.get(key);
    if (!current || item.entry.score > current.entry.score) best.set(key, item);
  }
  return [...best.values()];
}
