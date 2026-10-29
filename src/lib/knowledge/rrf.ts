/**
 * RRF（Reciprocal Rank Fusion）：把两路召回的结果合成一个排序。
 *
 * 为什么用 RRF 而不是「分数加权平均」：
 * 两路检索的分数**不可比**——`ts_rank_cd` 是 PostgreSQL 的相关度分数（量级
 * 可能是 0.01~0.5），余弦相似度是 -1~1。直接加权平均会被量级大的那一路
 * 完全主导，权重调到天荒地老也不对。
 *
 * RRF 只看**排名**不看分数：
 *
 *   score(doc) = Σ 1 / (k + rank_i)
 *
 * k 取 60 是业界惯例（来自 Cormack 等人 2009 年的论文）。k 的作用是压低
 * 头部排名的绝对优势——k 越小，第 1 名越强势；k 越大，各路结果越平均。
 *
 * 这个公式的好处是：一路检索完全没召回到的文档，另一路仍然能把它带上来，
 * 而且**不需要调权重**。
 */

export type RankedItem<T> = {
  item: T;
  /** 这一路里的名次，从 1 开始。 */
  rank: number;
};

export type FusedItem<T> = {
  item: T;
  /** 融合后的分数，越高越靠前。 */
  score: number;
  /** 出现在哪几路里，便于观察「两路都命中」的文档。 */
  sources: string[];
  /** 各路的名次，用于排查。 */
  ranks: Record<string, number>;
};

export const DEFAULT_RRF_K = 60;

/**
 * 融合多路召回结果。
 *
 * @param lists 每个元素是一路结果（已按相关度降序），带来源名（如 "bm25" / "vector"）
 * @param options.k RRF 的平滑常数，默认 60
 * @param options.key 从 item 里取出稳定的去重键（同一文档在两路里要能认出是同一个）
 * @param options.limit 返回多少个
 */
export function fuseRrf<T>(
  lists: ReadonlyArray<{ source: string; items: readonly T[] }>,
  options: {
    key: (item: T) => string;
    k?: number;
    limit?: number;
  },
): FusedItem<T>[] {
  const k = options.k ?? DEFAULT_RRF_K;
  const limit = options.limit ?? 20;
  const byKey = new Map<string, FusedItem<T>>();

  for (const { source, items } of lists) {
    items.forEach((item, index) => {
      const rank = index + 1;
      const key = options.key(item);
      if (!key) return;
      const contribution = 1 / (k + rank);
      const existing = byKey.get(key);
      if (existing) {
        existing.score += contribution;
        existing.sources.push(source);
        existing.ranks[source] = rank;
        return;
      }
      byKey.set(key, { item, score: contribution, sources: [source], ranks: { [source]: rank } });
    });
  }

  return [...byKey.values()]
    // 分数相同的时候，两路都命中的优先（说明证据更强）。
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.sources.length - left.sources.length;
    })
    .slice(0, limit);
}
