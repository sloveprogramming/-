import "server-only";

import { Annotation } from "@langchain/langgraph";
import type { ProductIntent } from "@/lib/icp/productIntent";
import type { CompanyHit } from "@/lib/qcc/types";
import type { SourcingReplan } from "@/lib/agent/artifacts";
import type { AssessedCompany } from "./types";

export type TermHit = { term: string; hits: number; error?: string };

/**
 * 拓客图的共享状态。
 *
 * 节点之间只传结构化数据，不传自然语言总结。`trail` 只用于排障，不参与业务
 * 判断；真正驱动下一步的是 `intent`、`hits`、`assessed` 这些有明确形状的字段。
 */
export const ProspectState = Annotation.Root({
  product: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  organizationId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  traceId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  intent: Annotation<ProductIntent | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  termHits: Annotation<TermHit[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  hits: Annotation<CompanyHit[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  replan: Annotation<SourcingReplan | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  assessed: Annotation<AssessedCompany[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  reachable: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  priority: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  error: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  trail: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

export type ProspectStateType = typeof ProspectState.State;
