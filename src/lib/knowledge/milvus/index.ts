import "server-only";

import { ConsistencyLevelEnum } from "@zilliz/milvus2-sdk-node";
import { COLLECTION, ensureCollection, ensureLoaded, milvusClient } from "./client";
import { chunkVectorId, embedInBatches, embedText, embeddingEnabled } from "../embedding";

/**
 * Milvus 上的知识块索引：写入、删除、向量检索。
 *
 * 数据流：
 *
 *   文档版本 → chunker 切块 → embedding 编码 → 写 Milvus
 *
 * 一致性策略：**Milvus 是 PostgreSQL 的从属索引**。
 * 数据库是唯一事实来源；Milvus 里存的只是「可以被快速找到的副本」。
 * 所以：
 *   - 写失败不回滚数据库（数据库那步已经提交了）
 *   - 检索失败可以退回全文检索（见 hybrid.ts）
 *   - 删旧块用 document_id 过滤整篇删，不用逐块对账
 */

export type KnowledgeChunkRecord = {
  id: string;
  documentId: string;
  versionId: string;
  chunkIndex: number;
  title: string;
  kind: string;
  tags: string[];
  text: string;
};

export type VectorHit = {
  id: string;
  documentId: string;
  versionId: string;
  chunkIndex: number;
  title: string;
  kind: string;
  tags: string[];
  text: string;
  /** 余弦相似度，0~1。 */
  score: number;
};

/** 写入一批块。同一版本重复写入会因主键相同而覆盖（幂等）。 */
export async function upsertChunks(
  chunks: ReadonlyArray<Omit<KnowledgeChunkRecord, "id">>,
): Promise<{ written: number }> {
  if (!chunks.length) return { written: 0 };
  if (!embeddingEnabled()) throw new Error("向量化未启用，无法写入 Milvus");

  // 注意：这里**不调用 ensureLoaded**。
  //
  // 踩过的坑：每批写入前都 loadCollection，会让刚 upsert 但尚未 flush 的
  // 数据被"重新加载"覆盖掉——表现为「报告写入 23 块，实际只剩 8 块」。
  // load 只在 collection 创建时做一次（见 ensureCollection / ensureLoaded），
  // 写入路径不应该碰它。
  await ensureCollection();

  const vectors = await embedInBatches(chunks.map((chunk) => chunk.text));
  if (vectors.length !== chunks.length) {
    throw new Error(`向量条数不符：${vectors.length} vs ${chunks.length}`);
  }

  const client = milvusClient();
  await client.upsert({
    collection_name: COLLECTION,
    data: chunks.map((chunk, index) => ({
      id: chunkVectorId(chunk.versionId, chunk.chunkIndex),
      document_id: chunk.documentId,
      version_id: chunk.versionId,
      chunk_index: chunk.chunkIndex,
      title: chunk.title.slice(0, 512),
      kind: chunk.kind.slice(0, 64),
      tags: chunk.tags.map((tag) => tag.slice(0, 128)),
      // Milvus VarChar 上限 8192，chunker 每块不超过 500 字，这里截断只是兜底。
      text: chunk.text.slice(0, 8192),
      vector: vectors[index],
    })),
  });
  return { written: chunks.length };
}

/**
 * 删除一篇文档的所有块。
 *
 * 为什么按 document_id 整篇删而不是按 version_id：文档改版后旧版本也要清掉，
 * 只删当前 version_id 会留下孤儿块——它们在检索里仍会命中，但内容已经过时。
 */
export async function deleteDocumentChunks(documentId: string): Promise<void> {
  const client = milvusClient();
  await client.delete({
    collection_name: COLLECTION,
    filter: `document_id == "${escapeMilvusString(documentId)}"`,
  });
}

/** 删除单个版本（改版后清理旧版本用）。 */
export async function deleteVersionChunks(versionId: string): Promise<void> {
  const client = milvusClient();
  await client.delete({
    collection_name: COLLECTION,
    filter: `version_id == "${escapeMilvusString(versionId)}"`,
  });
}

/** 向量检索。 */
export async function searchChunks(input: {
  query: string;
  limit?: number;
  /** 只在某些类型的文档里找。 */
  kind?: string | null;
  /** 只在某些文档里找。 */
  documentIds?: readonly string[] | null;
  /** HNSW 的 ef 参数：越大召回越全越慢，默认 64。 */
  ef?: number;
}): Promise<VectorHit[]> {
  const query = input.query.trim();
  if (!query) return [];
  if (!embeddingEnabled()) return [];
  await ensureCollection();
  await ensureLoaded();

  const vector = await embedText(query);
  const filters: string[] = [];
  if (input.kind) filters.push(`kind == "${escapeMilvusString(input.kind)}"`);
  if (input.documentIds?.length) {
    const ids = input.documentIds.map((id) => `"${escapeMilvusString(id)}"`).join(", ");
    filters.push(`document_id in [${ids}]`);
  }

  const result = await milvusClient().search({
    collection_name: COLLECTION,
    data: [vector],
    anns_field: "vector",
    limit: input.limit ?? 10,
    metric_type: "COSINE",
    params: { ef: input.ef ?? 64 },
    ...(filters.length ? { filter: filters.join(" and ") } : {}),
    output_fields: ["document_id", "version_id", "chunk_index", "title", "kind", "tags", "text"],
    // Strong：写入后立即可查。默认 Bounded 级别读不到刚写入（还在 growing
    // segment）的数据——实测刚 upsert 23 条后 Bounded 查返回 0 条。
    // 知识库是"写完马上就要能检索"的场景，必须用强一致。
    consistency_level: ConsistencyLevelEnum.Strong,
  });

  const rows = result?.results ?? [];
  return rows.map((row) => {
    // Milvus 2.4 的 SDK 把 output_fields 平铺在结果对象上（不是嵌在 entity 里），
    // 这里同时兼容两种形状，避免版本差异导致"检索有结果但字段全空"。
    const flat = row as unknown as Record<string, unknown>;
    const entity = (flat.entity ?? flat) as Record<string, unknown>;
    return {
      id: String(flat.id ?? entity.id ?? ""),
      documentId: String(entity.document_id ?? ""),
      versionId: String(entity.version_id ?? ""),
      chunkIndex: Number(entity.chunk_index ?? 0),
      title: String(entity.title ?? ""),
      kind: String(entity.kind ?? ""),
      tags: Array.isArray(entity.tags) ? entity.tags.map(String) : [],
      text: String(entity.text ?? ""),
      // COSINE 返回的是距离（0~2），相似度 = 1 - 距离。
      score: 1 - Number(flat.score ?? 0),
    };
  });
}

/**
 * collection 里有多少块（用于自检与设置页展示）。
 *
 * 不能用 `getCollectionStatistics().row_count`：Milvus 2.4 的这个统计是
 * **异步更新**的，刚写完数据它仍报 0（已实测）。用 query 数实际行数才准。
 */
export async function chunkCount(): Promise<number> {
  try {
    const client = milvusClient();
    const result = await client.query({
      collection_name: COLLECTION,
      filter: 'id != ""',
      output_fields: ["id"],
      limit: 10_000,
      consistency_level: ConsistencyLevelEnum.Strong,
    });
    return (result?.data ?? []).length;
  } catch {
    // 查询失败（collection 不存在 / 未 load）当成 0，调用方据此跳过向量路。
    return 0;
  }
}

/**
 * Milvus 的过滤表达式是字符串拼接，引号必须转义。
 * 文档 id / kind 都是 UUID 或固定枚举，实际不会有引号；这层转义是防御性的。
 */
function escapeMilvusString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
