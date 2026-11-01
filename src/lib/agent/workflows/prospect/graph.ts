import "server-only";

import { END, START, StateGraph } from "@langchain/langgraph";
import { fallbackIntent } from "@/lib/icp/productIntent";
import { interpretProduct } from "@/lib/icp/productIntent.server";
import { searchCompanies } from "@/lib/qcc/provider";
import { qualifyCompany, qualifierEnabled } from "@/lib/agent/qualifier";
import { replanEnabled, replanSearch } from "@/lib/agent/replanner";
import { ProspectState, type ProspectStateType } from "./state";
import {
  createContactNode,
  createProductIntentNode,
  createScoringNode,
  createSourcingNode,
  finishProspectNode,
  routeAfterSourcing,
  type ProspectRuntime,
} from "./nodes";
import type { ProspectResult, ProspectWorkflowInput } from "./types";

export const PROSPECT_WORKFLOW_VERSION = "prospect.v1";

/**
 * 拓客业务图。
 *
 * START
 *   -> ProductIntentAgent（产品卖给谁）
 *   -> SourcingAgent（找公司，必要时换词）
 *   -> ScoringAgent（确定性合作评分 + 可选灰色带证据深查）
 *   -> contact_enrichment（确定性清洗电话）
 *   -> finish
 *   -> END
 *
 * 这不是一个覆盖全系统的大 Supervisor。每段业务独立成图，CRM 回复另有自己的
 * 生命周期；两张图只共享角色契约和 trace。
 */
export function buildProspectGraph(runtime: ProspectRuntime) {
  const graph = new StateGraph(ProspectState)
    .addNode("product_intent", createProductIntentNode(runtime))
    .addNode("sourcing", createSourcingNode(runtime))
    .addNode("scoring", createScoringNode(runtime))
    .addNode("contact", createContactNode(runtime))
    .addNode("finish", finishProspectNode)
    .addEdge(START, "product_intent")
    .addEdge("product_intent", "sourcing")
    .addConditionalEdges("sourcing", routeAfterSourcing, {
      scoring: "scoring",
      finish: "finish",
    })
    .addEdge("scoring", "contact")
    .addEdge("contact", "finish")
    .addEdge("finish", END);

  return graph.compile();
}

export async function runProspectGraph(input: ProspectWorkflowInput): Promise<ProspectResult> {
  const product = input.product.trim();
  const traceId = input.traceId ?? crypto.randomUUID();
  const progress = input.onProgress ?? (() => {});
  const deps = input.deps;

  const runtime: ProspectRuntime = {
    product,
    organizationId: input.organizationId,
    traceId,
    progress,
    signal: input.signal,
    interpret: deps?.interpret ?? interpretProduct,
    search: deps?.search ?? searchCompanies,
    recordArtifact: deps?.recordArtifact,
    replan: deps && "replan" in deps
      ? deps.replan ?? null
      : replanEnabled()
        ? replanSearch
        : null,
    qualify: deps && "qualify" in deps
      ? deps.qualify ?? null
      : qualifierEnabled()
        ? qualifyCompany
        : null,
  };

  const graph = buildProspectGraph(runtime);
  const state = await graph.invoke({
    product,
    organizationId: input.organizationId,
    traceId,
  }) as ProspectStateType;

  // 产品节点本身有兜底；这里再保一层，确保响应契约永远有可执行的搜索计划。
  const intent = state.intent ?? fallbackIntent(product);
  return {
    product,
    intent,
    companies: state.assessed,
    stats: {
      searchedTerms: intent.searchTerms.length,
      found: state.hits.length,
      reachable: state.reachable,
      priority: state.priority,
    },
    runIds: [],
    traceId,
    replan: state.replan,
  };
}
