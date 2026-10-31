import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentArtifacts } from "./schema";
import { validateArtifact, type ArtifactKind, type ArtifactRecorder, type RawArtifact, type ProspectArtifact } from "./artifacts";

export type { ArtifactRecorder };

/**
 * artifact 的落库。
 *
 * 与 `observe.ts` 同一个原则：**观测失败不能让业务失败**。所以这里所有写操作
 * 都吞异常并打日志——一个找客户的请求不该因为"记不下来"而返回 500。
 *
 * 与 `artifacts.ts` 分开的原因：那个文件是纯契约，任何环境都能测；这里要碰数据库。
 */

export type StoredArtifact = ProspectArtifact & {
  id: string;
  traceId: string;
  seq: number;
  createdAt: Date;
};

/**
 * 创建一个绑定到某条 trace 的记录器。
 *
 * `seq` 由闭包自己递增：调用方不需要关心顺序，只要按流程顺序调用即可。
 */
export function createArtifactRecorder(input: {
  organizationId: string;
  traceId: string;
}): ArtifactRecorder {
  let seq = 0;
  return async (raw) => {
    const checked = validateArtifact(raw);
    if (!checked.ok) {
      // 契约不符是代码问题，不是运行时问题：记下来但继续跑。
      console.error("[agent/artifacts] 契约校验失败：", checked.error);
      return;
    }
    try {
      await db.insert(agentArtifacts).values({
        organizationId: input.organizationId,
        traceId: input.traceId,
        role: checked.artifact.role,
        kind: checked.artifact.kind,
        seq: (seq += 1),
        payload: checked.artifact.payload,
      });
    } catch (error) {
      console.error("[agent/artifacts] 落库失败（不影响业务）：", error);
    }
  };
}

/**
 * 读一条 trace 的全部产物，按流程顺序返回。
 *
 * 注意这里用 `and()` 而不是 `a && b`：JS 里 `&&` 返回的是后一个操作数，
 * 前一个条件会被静默丢弃——本项目的 Milvus 同步就栽在同一个坑里（详见
 * RAG 改造记录）。多租户查询漏掉组织条件意味着跨组织读数据。
 */
export async function listArtifacts(input: {
  organizationId: string;
  traceId: string;
}): Promise<StoredArtifact[]> {
  try {
    const rows = await db
      .select()
      .from(agentArtifacts)
      .where(
        and(
          eq(agentArtifacts.organizationId, input.organizationId),
          eq(agentArtifacts.traceId, input.traceId),
        ),
      )
      .orderBy(asc(agentArtifacts.seq));
    return rows.map((row) => ({
      id: row.id,
      traceId: row.traceId,
      seq: row.seq,
      role: row.role as StoredArtifact["role"],
      kind: row.kind as ArtifactKind,
      payload: row.payload,
      createdAt: row.createdAt,
    }));
  } catch (error) {
    // 读失败时退回空数组：调用方（界面、调试脚本）应该显示"还没有产物"，
    // 而不是整页报错。
    console.error("[agent/artifacts] 读取失败：", error);
    return [];
  }
}

/** 按种类取最后一条产物（同种类重复写入时以最新为准）。 */
export async function latestArtifact(input: {
  organizationId: string;
  traceId: string;
  kind: ArtifactKind;
}): Promise<StoredArtifact | null> {
  const all = await listArtifacts({ organizationId: input.organizationId, traceId: input.traceId });
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (all[index]?.kind === input.kind) return all[index] ?? null;
  }
  return null;
}
