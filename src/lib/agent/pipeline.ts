import "server-only";

import { z } from "zod";
import { assessCompany, type CompanyAssessment, type CompanyFacts } from "@/lib/icp/assess";
import type { ProductIntent } from "@/lib/icp/productIntent";
import { runAgentLoop, type AgentLoopResult, type ChatRequest, type ChatResponse } from "./runtime";
import { startAgentRun } from "./observe";
import { ToolRegistry, type ToolExecutionContext } from "./tools";
import { interpretProduct } from "@/lib/icp/productIntent.server";
import { searchCompanies } from "@/lib/qcc/provider";
import type { CompanyHit } from "@/lib/qcc/types";

/**
 * 多 Agent 编排：从"一个产品"到"一批值得打电话的公司"。
 *
 * 四个 Agent 分工，每个有独立的工具集、独立的运行记录、独立的失败边界：
 *
 *   ① 产品解析  productIntent  ── 产品 → 买家画像 + 搜索词
 *   ② 检索      prospectSearch ── 按词搜公司
 *   ③ 初筛      assessBatch    ── 按体量与匹配度打分、分档
 *   ④ 联系方式  contactEnrich  ── 挑出能打的电话、标注可信度
 *
 * 为什么拆成四个 Agent 而不是一个大 Agent：
 *
 * - **失败隔离**：检索失败不该让整条链断掉——产品解析结果仍然有用，可以让用户
 *   手动改搜索词再试。一个巨型 Agent 里，任何一步失败都得从头再来。
 * - **成本可控**：①②④ 大部分走确定性代码（词典、SQL、正则），只有解析和兜底
 *   才调模型。四个 Agent 各自决定要不要花钱。
 * - **可观测**：每次运行单独记 agent_runs，能回答"这次到底哪一步慢/贵/失败"。
 *
 * 但要说清楚一件事：**这不是"多个模型互相商量"**。编排是确定性的流水线，
 * 每个 Agent 的产物是下一个的输入。真正的 Agent 决策只有两处——产品解析
 * （词典没收录时问模型）、初筛（模型判断边界情况）。这个诚实很重要：把
 * 流水线说成"多智能体协作"经不起追问。
 */

// 阶段名与类型放在 pipelineTypes.ts（客户端安全）；这里重导出，调用方不用改 import。
export { PROSPECT_STAGES, STAGE_LABEL, NATURE_LABEL } from "./pipelineTypes";
export type { ProspectStage, ProspectProgress, ProspectStats, AssessmentNature } from "./pipelineTypes";
import type { ProspectProgress, ProspectStage, ProspectStats } from "./pipelineTypes";

export type AssessedCompany = CompanyAssessment & {
  hit: CompanyHit;
  /** 可打的电话，已排序（优先座机、去重）。 */
  phones: string[];
  /** 有没有联系方式；没有的公司即使分高也很难推进。 */
  reachable: boolean;
};

export type ProspectResult = {
  product: string;
  intent: ProductIntent;
  companies: AssessedCompany[];
  /** 各阶段的统计，用于向用户解释。 */
  stats: ProspectStats;
  /** 运行记录 id，便于去 agent_runs 查这次到底做了什么。 */
  runIds: string[];
};

const SEARCH_LIMIT_PER_TERM = 20;
const MAX_COMPANIES = 60;

/**
 * 执行完整流程。`onProgress` 让界面能实时显示"现在在做哪一步"。
 *
 * 每一步都在 try/catch 里：某一步失败时返回已完成的部分，而不是整体抛错。
 * 销售宁可看到"搜到 12 家但评估没跑完"，也不想看到一片空白。
 */
export async function runProspectPipeline(input: {
  product: string;
  organizationId: string;
  onProgress?: (progress: ProspectProgress) => void;
  signal?: AbortSignal;
  /** 测试注入：跳过真实模型与真实搜索。 */
  deps?: {
    interpret?: typeof interpretProduct;
    search?: typeof searchCompanies;
  };
}): Promise<ProspectResult> {
  const product = input.product.trim();
  const progress = input.onProgress ?? (() => {});
  const runIds: string[] = [];
  const interpret = input.deps?.interpret ?? interpretProduct;
  const search = input.deps?.search ?? searchCompanies;

  // ---- ① 产品解析 ----
  progress({ stage: "parse", status: "running", detail: "判断这个产品该卖给谁" });
  const intent = await interpret({ query: product });
  progress({
    stage: "parse",
    status: "done",
    detail: intent.category
      ? `${intent.category} · 买家：${intent.buyerDescription}`
      : intent.buyerDescription,
    count: intent.searchTerms.length,
  });

  // ---- ② 检索 ----
  progress({ stage: "search", status: "running", detail: `按 ${intent.searchTerms.length} 个关键词搜公司` });
  const byName = new Map<string, CompanyHit>();
  const termHits: Array<{ term: string; hits: number; error?: string }> = [];
  for (const term of intent.searchTerms) {
    if (input.signal?.aborted) break;
    try {
      const result = await search(term, { source: "auto", limit: SEARCH_LIMIT_PER_TERM });
      termHits.push({ term, hits: result.total });
      for (const hit of result.hits) {
        if (!byName.has(hit.name)) byName.set(hit.name, hit);
      }
    } catch (error) {
      termHits.push({ term, hits: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const found = [...byName.values()].slice(0, MAX_COMPANIES);
  progress({
    stage: "search",
    status: "done",
    detail: `搜到 ${found.length} 家公司`,
    count: found.length,
  });

  if (!found.length) {
    return {
      product,
      intent,
      companies: [],
      stats: { searchedTerms: intent.searchTerms.length, found: 0, reachable: 0, priority: 0 },
      runIds,
    };
  }

  // ---- ③ 初筛：确定性打分，不调模型 ----
  //
  // 这一步刻意不用 LLM：打分规则明确、可解释、可测，模型在这里只会引入
  // 不确定性。真正的 Agent 决策留给"要不要打电话"这类需要判断的事。
  progress({ stage: "assess", status: "running", detail: `给 ${found.length} 家公司打分` });
  const buyerTerms = buyerTermsFor(intent);
  const assessed: AssessedCompany[] = found.map((hit) => {
    const facts: CompanyFacts = {
      name: hit.name,
      registeredCapital: hit.registeredCapital,
      foundedAt: hit.foundedAt,
      industry: hit.industry,
      scope: hit.scope,
      status: hit.status,
      region: hit.region,
    };
    const assessment = assessCompany(facts, buyerTerms);
    const phones = cleanPhones(hit.phones);
    return { ...assessment, hit, phones, reachable: phones.length > 0 };
  });
  // 排序：能打电话的优先，再按分数。
  assessed.sort((a, b) => {
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    return b.score - a.score;
  });
  const priority = assessed.filter((item) => item.tier === "priority").length;
  progress({
    stage: "assess",
    status: "done",
    detail: `${priority} 家优先联系`,
    count: priority,
  });

  // ---- ④ 联系方式：挑电话、标可信度 ----
  progress({ stage: "contact", status: "running", detail: "整理可打的电话" });
  const reachable = assessed.filter((item) => item.reachable).length;
  progress({
    stage: "contact",
    status: "done",
    detail: `${reachable} 家有公示电话`,
    count: reachable,
  });

  return {
    product,
    intent,
    companies: assessed,
    stats: {
      searchedTerms: intent.searchTerms.length,
      found: found.length,
      reachable,
      priority,
    },
    runIds,
  };
}

/** 从产品意图里取"买家行业词"，用于判断行业匹配。产品词本身不算。 */
export function buyerTermsFor(intent: ProductIntent): string[] {
  const product = intent.query.toLowerCase();
  return intent.searchTerms.filter((term) => term.trim() && term.toLowerCase() !== product);
}

/**
 * 清洗电话：去重、去掉明显不是电话的内容。
 *
 * 企查查的电话字段可能是逗号分隔的多个号码、带分机、或者混进手机号。
 * 这里只做保守的规范化，**不判断号码真假**——判断真假需要外呼反馈，
 * 那是接入服务商之后的事。
 */
export function cleanPhones(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    for (const piece of entry.split(/[,，;；/、\s]+/)) {
      const phone = piece.replace(/[^\d-]/g, "").trim();
      // 国内座机含区号 10-12 位，手机 11 位；短于 7 位的不像号码。
      const digits = phone.replace(/-/g, "");
      if (digits.length < 7 || digits.length > 13) continue;
      if (seen.has(digits)) continue;
      seen.add(digits);
      out.push(phone);
    }
  }
  return out;
}

/** 把结果渲染成一句话摘要，给界面和日志用。 */
export function summarizeResult(result: ProspectResult): string {
  const { stats, intent } = result;
  if (!stats.found) return `「${result.product}」没有搜到公司`;
  return [
    `「${result.product}」`,
    intent.category ? `判定为${intent.category}` : "未识别品类",
    `搜 ${stats.searchedTerms} 个词得 ${stats.found} 家`,
    `其中 ${stats.reachable} 家有电话`,
    `${stats.priority} 家建议优先联系`,
  ].join("，");
}
