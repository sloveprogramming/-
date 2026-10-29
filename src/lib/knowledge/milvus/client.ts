import "server-only";

import { MilvusClient, DataType } from "@zilliz/milvus2-sdk-node";
import { EMBEDDING_DIM } from "../embedding";

/**
 * Milvus 客户端与 collection 管理。
 *
 * 部署现状：Milvus 跑在一台 VMware 虚拟机里（192.168.100.128:19530），
 * 宿主机通过 NAT 访问。地址走环境变量，因为不同机器上端口/主机名不同。
 *
 * 为什么用 SDK 而不是 REST：Milvus 的 HTTP 端口（9091）在不同版本上路径
 * 不一致（v2.4 的 /v2/vectordb/* 在某些发行版上不挂），而 gRPC SDK 是
 * 官方主推、行为稳定。
 */

export const COLLECTION = "knowledge_chunks";

export type MilvusConfig = {
  address: string;
  token?: string;
  database?: string;
};

export function milvusConfig(): MilvusConfig {
  const address = process.env.MILVUS_ADDRESS?.trim() || "192.168.100.128:19530";
  const token = process.env.MILVUS_TOKEN?.trim() || undefined;
  const database = process.env.MILVUS_DATABASE?.trim() || undefined;
  return { address, ...(token ? { token } : {}), ...(database ? { database } : {}) };
}

export function milvusEnabled(): boolean {
  // 显式关掉用 MILVUS_DISABLED=1：本地没有虚拟机时仍能跑全文检索。
  if (["1", "true", "on"].includes((process.env.MILVUS_DISABLED ?? "").toLowerCase())) return false;
  return Boolean(process.env.MILVUS_ADDRESS?.trim() || true);
}

let cachedClient: MilvusClient | null = null;

/**
 * 取客户端（进程内复用）。
 *
 * 为什么缓存：Milvus 客户端建连要握手，每次检索新建一个连接会让
 * 一次知识库查询多出几十毫秒。但缓存也意味着**连接断开后不会自动重连**——
 * 所以调用方要能处理失败，见 `withMilvus`。
 */
export function milvusClient(): MilvusClient {
  if (cachedClient) return cachedClient;
  const config = milvusConfig();
  cachedClient = new MilvusClient(config);
  return cachedClient;
}

/** 断开并清缓存。测试和配置变更后用。 */
export async function resetMilvusClient(): Promise<void> {
  if (!cachedClient) return;
  try {
    await cachedClient.closeConnection();
  } catch {
    // 关连接失败不影响后续重建。
  }
  cachedClient = null;
}

export type MilvusHealth = { ok: boolean; version?: string; collections?: string[]; error?: string };

export async function milvusHealth(): Promise<MilvusHealth> {
  try {
    const client = milvusClient();
    const health = await client.checkHealth();
    if (!health?.isHealthy) return { ok: false, error: "服务报告不健康" };
    const collections = await client.listCollections();
    return {
      ok: true,
      collections: (collections?.data ?? []).map((entry) => String((entry as { name?: string }).name ?? entry)),
    };
  } catch (error) {
    // 连接失败时清缓存，下次调用重新建连。
    cachedClient = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 确保 collection 存在。
 *
 * schema 设计：
 *   id            VarChar 主键（文档版本 id + 块序号的哈希）
 *   document_id   文档 id，删除整篇时按它过滤
 *   version_id    文档版本 id，改版时旧块据此失效
 *   chunk_index   块序号，用于按原文顺序还原
 *   title         标题，检索结果直接展示，不必回查数据库
 *   kind          文档类型（company/pricing/case_study…）
 *   tags          标签数组，支持按标签过滤
 *   text          原文，命中后直接给模型，省一次数据库查询
 *   vector        1024 维，COSINE
 *
 * 索引用 HNSW：比 IVF_FLAT 在小数据集上召回更稳，且不需要训练。
 * 参数 M=16 / efConstruction=200 是 Milvus 文档推荐的中等规模默认值。
 */
export async function ensureCollection(): Promise<{ created: boolean }> {
  const client = milvusClient();
  const existing = await client.hasCollection({ collection_name: COLLECTION });
  const exists = Boolean(existing?.value);
  if (exists) return { created: false };

  await client.createCollection({
    collection_name: COLLECTION,
    fields: [
      { name: "id", data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
      { name: "document_id", data_type: DataType.VarChar, max_length: 64 },
      { name: "version_id", data_type: DataType.VarChar, max_length: 64 },
      { name: "chunk_index", data_type: DataType.Int64 },
      { name: "title", data_type: DataType.VarChar, max_length: 512 },
      { name: "kind", data_type: DataType.VarChar, max_length: 64 },
      { name: "tags", data_type: DataType.Array, element_type: DataType.VarChar, max_capacity: 32, max_length: 128 },
      { name: "text", data_type: DataType.VarChar, max_length: 8192 },
      { name: "vector", data_type: DataType.FloatVector, dim: EMBEDDING_DIM },
    ],
  });

  // 向量索引（HNSW）
  await client.createIndex({
    collection_name: COLLECTION,
    field_name: "vector",
    index_type: "HNSW",
    metric_type: "COSINE",
    params: { M: 16, efConstruction: 200 },
  });

  // 标量索引：按文档查/删是高频操作。
  await client.createIndex({ collection_name: COLLECTION, field_name: "document_id", index_type: "INVERTED" });
  await client.createIndex({ collection_name: COLLECTION, field_name: "kind", index_type: "INVERTED" });

  await client.loadCollection({ collection_name: COLLECTION });
  return { created: true };
}

/** 确保已 load（search 前必须 load，否则报 collection not loaded）。 */
export async function ensureLoaded(): Promise<void> {
  const client = milvusClient();
  try {
    await client.loadCollection({ collection_name: COLLECTION });
  } catch (error) {
    // 已经 load 过会报错，这不是失败。
    const message = error instanceof Error ? error.message : String(error);
    if (!/already loaded|loaded/i.test(message)) throw error;
  }
}
/**
 * 删除整个 collection（重建索引用）。
 *
 * Milvus 的 drop 是确定性的：collection 不存在之后再 create，就是一个干净的
 * 空索引。这比"用 filter 全删"可靠得多——后者是标记删除，实测不可靠。
 */
export async function dropCollection(): Promise<void> {
  const client = milvusClient();
  const existing = await client.hasCollection({ collection_name: COLLECTION });
  if (existing?.value) {
    await client.dropCollection({ collection_name: COLLECTION });
  }
}
