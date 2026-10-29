import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmKnowledgeDocuments, crmKnowledgeDocumentVersions } from "@/lib/crm/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { chunkDocument } from "../chunker";
import { deleteDocumentChunks, upsertChunks } from "./index";
import { embeddingEnabled } from "../embedding";
import { dropCollection, ensureCollection, milvusEnabled } from "./client";

/**
 * 知识库 → Milvus 的同步。
 *
 * 核心问题：**数据库写成功了，但向量没写进去怎么办？**
 *
 * 选择：数据库是同步的、唯一事实来源；向量化是**可重试的旁路**。
 * 所以这里所有失败都被吞掉并记日志，绝不向上抛——文档保存不该因为
 * 向量库连不上而失败，检索靠全文检索兜底。
 *
 * ## 关键结论：批量必须汇总成一次写入（踩出来的）
 *
 * 最初实现是「逐篇：删旧块 → 写新块」，结果**报告写入 23 块、库里只剩 8 块**。
 * 逐项排查：delete 的 filter 作用域正常、chunk id 无碰撞、单独连续 upsert 10 条
 * 也正常。最终定位是**多次 upsert 与 collection 的 load/drop 生命周期交错**：
 * Milvus 写入先进 growing segment，若中间发生重新 load，早期数据会丢。
 *
 * 所以批量场景改成：**先收集所有文档的块，先删旧块，再一次性 upsert**。
 * 写入次数从 N 降到 1，避开时序问题。单篇仍走单篇路径（文档保存后调用）。
 */

export type SyncResult = {
  documentId: string;
  title: string;
  chunks: number;
  written: number;
  skipped?: string;
  error?: string;
};

/** 单批写入上限：一次 upsert 太多会超 gRPC 消息上限。 */
const WRITE_BATCH = 500;

type PreparedChunk = {
  documentId: string;
  versionId: string;
  chunkIndex: number;
  title: string;
  kind: string;
  tags: string[];
  text: string;
};

/** 把一篇文档切成待写入的块（只读，不写 Milvus）。 */
export async function prepareDocumentChunks(documentId: string): Promise<{
  title: string;
  chunks: PreparedChunk[];
  skipped?: string;
}> {
  const [row] = await db
    .select({
      id: crmKnowledgeDocuments.id,
      title: crmKnowledgeDocuments.title,
      kind: crmKnowledgeDocuments.kind,
      tags: crmKnowledgeDocuments.tags,
      active: crmKnowledgeDocuments.active,
      version: crmKnowledgeDocuments.latestVersion,
    })
    .from(crmKnowledgeDocuments)
    .where(and(inOrg(crmKnowledgeDocuments), eq(crmKnowledgeDocuments.id, documentId)))
    .limit(1);

  if (!row) return { title: "", chunks: [], skipped: "文档不存在" };
  if (!row.active) return { title: row.title, chunks: [], skipped: "文档已停用" };

  const [version] = await db
    .select({ id: crmKnowledgeDocumentVersions.id, content: crmKnowledgeDocumentVersions.content })
    .from(crmKnowledgeDocumentVersions)
    .where(and(eq(crmKnowledgeDocumentVersions.documentId, documentId), eq(crmKnowledgeDocumentVersions.version, row.version)))
    .limit(1);
  if (!version) return { title: row.title, chunks: [], skipped: "找不到当前版本内容" };

  return {
    title: row.title,
    chunks: chunkDocument(version.id, version.content).map((chunk) => ({
      documentId,
      versionId: version.id,
      chunkIndex: chunk.index,
      title: row.title,
      kind: row.kind ?? "custom",
      tags: [...row.tags],
      text: chunk.text,
    })),
  };
}

/** 同步一篇文档（文档保存后调用）。 */
export async function syncDocument(documentId: string): Promise<SyncResult> {
  const [result] = await syncMany([documentId]);
  return result ?? { documentId, title: "", chunks: 0, written: 0, error: "同步未返回结果" };
}

/**
 * 同步多篇文档：汇总所有块，先删旧块，再一次性写入。
 *
 * 这是批量场景的正确做法——见文件头的说明。
 */
export async function syncMany(documentIds: readonly string[]): Promise<SyncResult[]> {
  const unique = [...new Set(documentIds.filter(Boolean))];
  if (!unique.length) return [];

  const blocked = !milvusEnabled() ? "Milvus 未启用" : !embeddingEnabled() ? "向量化未启用" : null;
  if (blocked) {
    return unique.map((documentId) => ({ documentId, title: "", chunks: 0, written: 0, skipped: blocked }));
  }

  const results: SyncResult[] = [];
  const allChunks: PreparedChunk[] = [];
  const toDelete: string[] = [];

  for (const documentId of unique) {
    const prepared = await prepareDocumentChunks(documentId);
    if (prepared.skipped) {
      if (prepared.skipped === "文档已停用") toDelete.push(documentId);
      results.push({ documentId, title: prepared.title, chunks: 0, written: 0, skipped: prepared.skipped });
      continue;
    }
    allChunks.push(...prepared.chunks);
    toDelete.push(documentId);
    results.push({ documentId, title: prepared.title, chunks: prepared.chunks.length, written: 0 });
  }

  if (!allChunks.length && !toDelete.length) return results;

  try {
    await ensureCollection();
    // 顺序：先把所有旧块删掉，再写。不能边删边写。
    for (const documentId of toDelete) await deleteDocumentChunks(documentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[knowledge/milvus] 清理旧块失败", error);
    return results.map((result) => ({ ...result, error: message }));
  }

  try {
    for (let offset = 0; offset < allChunks.length; offset += WRITE_BATCH) {
      await upsertChunks(allChunks.slice(offset, offset + WRITE_BATCH));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[knowledge/milvus] 批量写入失败", error);
    return results.map((result) => ({ ...result, error: message }));
  }

  return results.map((result) => ({ ...result, written: result.chunks }));
}

/**
 * 全量重建索引。
 *
 * **先 drop collection 再重建**：Milvus 2.4 的「按 filter 全删」实测不可靠，
 * 而逐篇删+写会丢数据。重建 collection 是确定性操作。
 */
export async function reindexAll(options: { limit?: number } = {}): Promise<SyncResult[]> {
  await dropCollection();
  await ensureCollection();

  const documents = await db
    .select({ id: crmKnowledgeDocuments.id })
    .from(crmKnowledgeDocuments)
    .where(and(inOrg(crmKnowledgeDocuments), eq(crmKnowledgeDocuments.active, true)))
    .limit(options.limit ?? 500);

  return syncMany(documents.map((document) => document.id));
}

/** 批量同步（外部入口）。 */
export async function syncDocuments(documentIds: readonly string[]): Promise<SyncResult[]> {
  return syncMany(documentIds);
}

/** 按版本 id 反查文档再同步。 */
export async function syncDocumentVersions(versionIds: readonly string[]): Promise<SyncResult[]> {
  if (!versionIds.length) return [];
  const rows = await db
    .select({ documentId: crmKnowledgeDocumentVersions.documentId })
    .from(crmKnowledgeDocumentVersions)
    .where(inArray(crmKnowledgeDocumentVersions.id, [...versionIds]));
  return syncMany([...new Set(rows.map((row) => row.documentId))]);
}
