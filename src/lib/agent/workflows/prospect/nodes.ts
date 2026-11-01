import "server-only";

import { assessCompany, type CompanyFacts } from "@/lib/icp/assess";
import { fallbackIntent, type ProductIntent } from "@/lib/icp/productIntent";
import { interpretProduct } from "@/lib/icp/productIntent.server";
import { searchCompanies } from "@/lib/qcc/provider";
import type { CompanyHit } from "@/lib/qcc/types";
import type { ArtifactRecorder, RawArtifact, SourcingReplan } from "@/lib/agent/artifacts";
import { MIN_COMPANIES_BEFORE_REPLAN, replanSearch } from "@/lib/agent/replanner";
import { MAX_DEEP_CHECK, inGrayZone, qualifyCompany } from "@/lib/agent/qualifier";
import type { ProspectProgress } from "@/lib/agent/pipelineTypes";
import { buyerTermsFor, cleanPhones } from "./helpers";
import type { ProspectStateType, TermHit } from "./state";
import type { AssessedCompany } from "./types";

const SEARCH_LIMIT_PER_TERM = 20;
const MAX_COMPANIES = 60;

export type ProspectRuntime = {
  product: string;
  organizationId: string;
  traceId: string;
  progress: (progress: ProspectProgress) => void;
  signal?: AbortSignal;
  interpret: typeof interpretProduct;
  search: typeof searchCompanies;
  recordArtifact?: ArtifactRecorder;
  replan: typeof replanSearch | null;
  qualify: typeof qualifyCompany | null;
};

/** 观测失败不能拖垮业务；契约错误只记录，不改变结果。 */
async function emit(recorder: ArtifactRecorder | undefined, artifact: RawArtifact): Promise<void> {
  if (!recorder) return;
  try {
    await recorder(artifact);
  } catch (error) {
    console.error("[agent/prospect] 产物落库失败（不影响业务）：", error);
  }
}

export function createProductIntentNode(runtime: ProspectRuntime) {
  return async (state: ProspectStateType): Promise<Partial<ProspectStateType>> => {
    runtime.progress({ stage: "parse", status: "running", detail: "判断这个产品该卖给谁" });

    let intent: ProductIntent;
    try {
      intent = await runtime.interpret({ query: state.product });
    } catch (error) {
      console.error("[agent/prospect] 产品画像失败，退回兜底画像：", error);
      intent = fallbackIntent(state.product);
    }

    runtime.progress({
      stage: "parse",
      status: "done",
      detail: intent.category
        ? `${intent.category} · 买家：${intent.buyerDescription}`
        : intent.buyerDescription,
      count: intent.searchTerms.length,
    });

    await emit(runtime.recordArtifact, { role: "planner", kind: "plan", payload: intent });
    return {
      intent,
      trail: [`product_intent: ${intent.category ?? "未识别品类"}，${intent.searchTerms.length} 个搜索词`],
    };
  };
}

export function createSourcingNode(runtime: ProspectRuntime) {
  return async (state: ProspectStateType): Promise<Partial<ProspectStateType>> => {
    const intent = state.intent;
    if (!intent) return { error: "产品画像缺失", trail: ["sourcing: 缺少产品画像"] };

    runtime.progress({
      stage: "search",
      status: "running",
      detail: `按 ${intent.searchTerms.length} 个关键词搜公司`,
    });

    const byName = new Map<string, CompanyHit>();
    const termHits: TermHit[] = [];

    const runTerms = async (terms: readonly string[]): Promise<void> => {
      for (const term of terms) {
        if (runtime.signal?.aborted) break;
        try {
          const result = await runtime.search(term, { source: "auto", limit: SEARCH_LIMIT_PER_TERM });
          termHits.push({ term, hits: result.total });
          for (const item of result.hits) {
            if (!byName.has(item.name)) byName.set(item.name, item);
          }
        } catch (error) {
          termHits.push({
            term,
            hits: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    await runTerms(intent.searchTerms);

    let replanInfo: SourcingReplan | null = null;
    if (runtime.replan && !runtime.signal?.aborted && byName.size < MIN_COMPANIES_BEFORE_REPLAN) {
      runtime.progress({
        stage: "search",
        status: "running",
        detail: `只搜到 ${byName.size} 家，尝试换关键词`,
      });
      try {
        const attempt = await runtime.replan({
          product: runtime.product,
          buyerDescription: intent.buyerDescription,
          triedTerms: termHits.map((item) => ({ term: item.term, hits: item.hits })),
          organizationId: runtime.organizationId,
          signal: runtime.signal,
        });
        const before = byName.size;
        if (attempt.newTerms.length) await runTerms(attempt.newTerms);
        replanInfo = {
          triggered: true,
          newTerms: attempt.newTerms,
          reasoning: attempt.reasoning,
          addedCompanies: byName.size - before,
        };
        runtime.progress({
          stage: "search",
          status: "running",
          detail: `换了 ${attempt.newTerms.length} 个词，新增 ${byName.size - before} 家`,
        });
      } catch (error) {
        console.error("[agent/prospect] 重规划失败，保持原搜索结果：", error);
        replanInfo = {
          triggered: false,
          newTerms: [],
          reasoning: "重规划失败，已保持第一轮结果",
          addedCompanies: 0,
        };
      }
    }

    const hits = [...byName.values()].slice(0, MAX_COMPANIES);
    runtime.progress({
      stage: "search",
      status: "done",
      detail: `搜到 ${hits.length} 家公司`,
      count: hits.length,
    });

    await emit(runtime.recordArtifact, {
      role: "sourcer",
      kind: "sourcing",
      payload: {
        terms: termHits,
        total: hits.length,
        companies: hits.map((hit) => ({
          key: hit.key,
          name: hit.name,
          region: hit.region,
          industry: hit.industry,
          status: hit.status,
          inLibrary: hit.inLibrary,
        })),
        ...(replanInfo ? { replan: replanInfo } : {}),
      },
    });

    return {
      hits,
      termHits,
      replan: replanInfo,
      trail: [`sourcing: ${termHits.length} 个词，去重后 ${hits.length} 家`],
    };
  };
}

export function createScoringNode(runtime: ProspectRuntime) {
  return async (state: ProspectStateType): Promise<Partial<ProspectStateType>> => {
    const intent = state.intent;
    if (!intent) return { error: "产品画像缺失", trail: ["scoring: 缺少产品画像"] };

    runtime.progress({ stage: "assess", status: "running", detail: `给 ${state.hits.length} 家公司评分` });

    const buyerTerms = buyerTermsFor(intent);
    const assessed: AssessedCompany[] = state.hits.map((hit) => {
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
      return { ...assessment, hit, phones, reachable: phones.length > 0, deepCheck: null };
    });

    assessed.sort((a, b) => {
      if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
      return b.score - a.score;
    });
    const priority = assessed.filter((item) => item.tier === "priority").length;

    const deepChecks = new Map<string, NonNullable<AssessedCompany["deepCheck"]>>();
    if (runtime.qualify && !runtime.signal?.aborted) {
      const candidates = assessed.filter((item) => inGrayZone(item.score)).slice(0, MAX_DEEP_CHECK);
      if (candidates.length) {
        runtime.progress({
          stage: "assess",
          status: "running",
          detail: `深查 ${candidates.length} 家灰色带公司（招聘 / 招标 / 资质 / 食品安全）`,
        });
        for (const item of candidates) {
          if (runtime.signal?.aborted) break;
          try {
            const outcome = await runtime.qualify({
              companyName: item.companyName,
              score: item.score,
              tier: item.tier,
              buyerDescription: intent.buyerDescription,
              product: runtime.product,
              organizationId: runtime.organizationId,
              signal: runtime.signal,
            });
            if (outcome) {
              deepChecks.set(item.companyName, {
                verdict: outcome.verdict,
                reasoning: outcome.reasoning,
                lookups: outcome.lookups.map((lookup) => lookup.tool),
              });
            }
          } catch (error) {
            console.error(`[agent/prospect] 深查失败 ${item.hit.name}：`, error);
          }
        }
      }
    }

    runtime.progress({
      stage: "assess",
      status: "done",
      detail: deepChecks.size
        ? `${priority} 家优先联系；深查 ${deepChecks.size} 家，建议跟进 ${[...deepChecks.values()].filter((item) => item.verdict === "pursue").length} 家`
        : `${priority} 家优先联系`,
      count: priority,
    });

    const withDeepChecks = assessed.map((item) => ({
      ...item,
      deepCheck: deepChecks.get(item.companyName) ?? null,
    }));

    await emit(runtime.recordArtifact, {
      role: "qualifier",
      kind: "qualification",
      payload: {
        companies: withDeepChecks.map((item) => ({
          name: item.companyName,
          score: item.score,
          tier: item.tier,
          verdict: item.verdict,
          caveats: item.caveats,
          dimensions: item.dimensions,
          ...(item.deepCheck ? { deepCheck: item.deepCheck } : {}),
        })),
      },
    });

    return {
      assessed: withDeepChecks,
      priority,
      trail: [`scoring: ${withDeepChecks.length} 家，${priority} 家优先${deepChecks.size ? `，深查 ${deepChecks.size} 家` : ""}`],
    };
  };
}

export function createContactNode(runtime: ProspectRuntime) {
  return async (state: ProspectStateType): Promise<Partial<ProspectStateType>> => {
    runtime.progress({ stage: "contact", status: "running", detail: "整理可打的电话" });
    const reachable = state.assessed.filter((item) => item.reachable).length;
    runtime.progress({
      stage: "contact",
      status: "done",
      detail: `${reachable} 家有公示电话`,
      count: reachable,
    });

    await emit(runtime.recordArtifact, {
      role: "contact",
      kind: "contact",
      payload: {
        companies: state.assessed.map((item) => ({
          name: item.hit.name,
          phones: item.phones,
          reachable: item.reachable,
        })),
      },
    });

    return {
      reachable,
      trail: [`contact: ${reachable} 家可联系`],
    };
  };
}

export async function finishProspectNode(state: ProspectStateType): Promise<Partial<ProspectStateType>> {
  return {
    trail: [`finish: ${state.hits.length ? `${state.assessed.length} 家完成判断` : "没有可用企业"}`],
  };
}

export function routeAfterSourcing(state: ProspectStateType): "scoring" | "finish" {
  return !state.error && state.hits.length > 0 ? "scoring" : "finish";
}
