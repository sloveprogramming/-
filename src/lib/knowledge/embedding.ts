import "server-only";

import { createHash } from "node:crypto";

/**
 * Embedding 客户端：调用本地 bge-m3 服务（scripts/embedding/serve.py）。
 *
 * 为什么走本地服务而不是云 API：
 * 1. 免费。8 篇文档要切 17 块，将来上万文档要几十万次调用，云 API 是持续成本。
 * 2. 维度可控。bge-m3 是 1024，与已有 collection 一致。
 * 3. 无网络依赖，离线也能跑。
 *
 * 失败策略：**不静默降级**。embedding 挂了就让检索失败，而不是悄悄退回
 * 纯关键词检索——后者会让「语义检索没生效」这件事藏上好几天。
 */

export const EMBEDDING_DIM = 1024;

export type EmbeddingConfig = {
  url: string;
  timeoutMs: number;
  batchSize: number;
};

/**
 * 从环境变量读配置。
 *
 * 为什么读 env 而不是平台集成：这个服务是本机进程，不是「每组织一条凭据」
 * 的外部 SaaS。放进集成体系反而增加复杂度（无凭据可加密）。
 */
export function embeddingConfig(): EmbeddingConfig {
  return {
    url: process.env.EMBEDDING_URL?.trim() || "http://127.0.0.1:8100",
    timeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? 30_000),
    batchSize: Number(process.env.EMBEDDING_BATCH ?? 16),
  };
}

export function embeddingEnabled(): boolean {
  // 显式关闭用 EMBEDDING_DISABLED=1，方便本地只跑全文检索。
  return !["1", "true", "on"].includes((process.env.EMBEDDING_DISABLED ?? "").toLowerCase());
}

export type EmbedResult = {
  vectors: number[][];
  dim: number;
  tookMs: number;
};

/** 批量编码。调用方负责分批，这里一次最多送 batchSize 条。 */
export async function embedTexts(texts: readonly string[], config = embeddingConfig()): Promise<EmbedResult> {
  if (!texts.length) return { vectors: [], dim: EMBEDDING_DIM, tookMs: 0 };
  const payload = texts.map((text) => (text.trim() ? text : " "));
  const started = Date.now();
  const response = await fetch(`${config.url.replace(/\/$/, "")}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts: payload }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const body = (await response.json().catch(() => null)) as
    | { vectors?: number[][]; dim?: number; took_ms?: number; error?: string }
    | null;
  if (!response.ok || !body?.vectors) {
    throw new Error(`向量化失败：${body?.error ?? `HTTP ${response.status}`}`);
  }
  if (body.vectors.length !== texts.length) {
    throw new Error(`向量化条数不符：期望 ${texts.length}，返回 ${body.vectors.length}`);
  }
  if (body.vectors[0] && body.vectors[0].length !== EMBEDDING_DIM) {
    // 维度不对是最危险的错误：Milvus 会拒绝写入，但错误信息很难懂。
    throw new Error(`向量维度不符：期望 ${EMBEDDING_DIM}，实际 ${body.vectors[0].length}。检查 bge-m3 模型是否被替换。`);
  }
  return { vectors: body.vectors, dim: body.dim ?? EMBEDDING_DIM, tookMs: body.took_ms ?? Date.now() - started };
}

/** 单条编码，取第一个结果。 */
export async function embedText(text: string, config = embeddingConfig()): Promise<number[]> {
  const result = await embedTexts([text], config);
  return result.vectors[0];
}

/** 健康检查：给启动自检和设置页用。 */
export async function embeddingHealth(config = embeddingConfig()): Promise<{ ok: boolean; dim?: number; error?: string }> {
  try {
    const response = await fetch(`${config.url.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; dim?: number } | null;
    if (!response.ok || !body?.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, dim: body.dim };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 稳定 id：Milvus 的主键必须是字符串/int64，而我们要能在文档改版后
 * 精确删除旧块。用 documentVersionId + chunkIndex 的哈希，既短又稳定。
 */
export function chunkVectorId(documentVersionId: string, chunkIndex: number): string {
  const hash = createHash("sha1").update(`${documentVersionId}:${chunkIndex}`).digest();
  // Milvus VarChar 主键长度限制内，取前 24 个 hex 字符足够防碰撞。
  return hash.toString("hex").slice(0, 24);
}

/** 分批编码：大文档切入几十块时，一次性送会超服务端的批上限。 */
export async function embedInBatches(
  texts: readonly string[],
  config = embeddingConfig(),
): Promise<number[][]> {
  const out: number[][] = [];
  const size = Math.max(1, config.batchSize);
  for (let offset = 0; offset < texts.length; offset += size) {
    const slice = texts.slice(offset, offset + size);
    const result = await embedTexts(slice, config);
    out.push(...result.vectors);
  }
  return out;
}
