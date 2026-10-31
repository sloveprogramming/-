import "server-only";

import { assessCompany, type CompanyAssessment, type CompanyFacts } from "@/lib/icp/assess";
import type { ProductIntent } from "@/lib/icp/productIntent";
import { interpretProduct } from "@/lib/icp/productIntent.server";
import { searchCompanies } from "@/lib/qcc/provider";
import type { CompanyHit } from "@/lib/qcc/types";
import type { ArtifactRecorder, DeepCheck, RawArtifact, SourcingReplan } from "./artifacts";
import { MIN_COMPANIES_BEFORE_REPLAN, replanEnabled, replanSearch } from "./replanner";
import { MAX_DEEP_CHECK, inGrayZone, qualifyCompany, qualifierEnabled } from "./qualifier";

/**
 * 找客户流水线：从"一个产品"到"一批值得打电话的公司"。
 *
 * 四段顺序执行，每段产出一个 artifact（见 `artifacts.ts`）交给下一段：
 *
 *   ① 产品解析  productIntent  ── 产品 → 买家画像 + 搜索词    → plan
 *   ② 检索      prospectSearch ── 按词搜公司                  → sourcing
 *   ③ 初筛      assessBatch    ── 按体量与匹配度打分、分档     → qualification
 *   ④ 联系方式  contactEnrich  ── 挑出能打的电话、标可信度     → contact
 *
 * 为什么拆成四段而不是一个大 Agent：
 *
 * - **失败隔离**：检索失败不该让整条链断掉——产品解析结果仍然有用，可以让用户
 *   手动改搜索词再试。一个巨型 Agent 里，任何一步失败都得从头再来。
 * - **成本可控**：①②④ 大部分走确定性代码（词典、SQL、正则），只有解析和兜底
 *   才调模型。
 * - **可观测**：每段产物单独落库，能回答"这次到底哪一步慢/贵/失败"。
 *
 * 措辞上要诚实：**这不是"多个模型互相商量"，也不是"四个 Agent"**。
 * 真正的模型决策只有一处——产品解析（词典没收录时才问模型）；其余三段是
 * 确定性代码：搜索是 SQL/API、评分是公式、电话清洗是正则。把流水线说成
 * "多智能体协作"经不起追问。
 */

// 阶段名与类型放在 pipelineTypes.ts（客户端安全）；这里重导出，调用方不用改 import。
export { PROSPECT_STAGES, STAGE_LABEL, NATURE_LABEL } from "./pipelineTypes";
export type { ProspectStage, ProspectProgress, ProspectStats, AssessmentNature } from "./pipelineTypes";
import type { ProspectProgress, ProspectStats } from "./pipelineTypes";

export type AssessedCompany = CompanyAssessment & {
  hit: CompanyHit;
  /** 可打的电话，已排序（优先座机、去重）。 */
  phones: string[];
  /** 有没有联系方式；没有的公司即使分高也很难推进。 */
  reachable: boolean;
  /**
   * 灰色带深查的结论。没触发或深查失败时为 null。
   *
   * 与 `score` 并列而不是合并进分档：分数是公式算的、可解释；深查是附加信号。
   */
  deepCheck: DeepCheck | null;
};

export type ProspectResult = {
  product: string;
  intent: ProductIntent;
  companies: AssessedCompany[];
  /** 各阶段的统计，用于向用户解释。 */
  stats: ProspectStats;
  /** 运行记录 id，便于去 agent_runs 查这次到底做了什么。 */
  runIds: string[];
  /**
   * 本次执行的追踪 id。
   *
   * 同一次"找客户"里所有角色共享它，产物按 `seq` 挂在下面。有它才能回答
   * "这次为什么花了这么多、哪一步最慢"——没有它，日志只是一堆孤立的记录。
   */
  traceId: string;
  /**
   * 重规划记录：第一轮结果太少时，规划员换词重搜过。
   *
   * 没触发时为 null（而不是空对象）——"没跑"和"跑了没效果"是两件事。
   */
  replan: SourcingReplan | null;
};

const SEARCH_LIMIT_PER_TERM = 20;
const MAX_COMPANIES = 60;

/**
 * 把产物交给记录器。
 *
 * 记录失败绝不影响流水线：产物是给观测和下游角色用的，业务结果不该因为它
 * 而失败。所以这里吞掉异常只打日志（与 `observe.ts` 同一原则）。
 */
async function emit(recorder: ArtifactRecorder | undefined, artifact: RawArtifact): Promise<void> {
  if (!recorder) return;
  try {
    await recorder(artifact);
  } catch (error) {
    console.error("[agent/pipeline] 产物落库失败（不影响业务）：", error);
  }
}

/**
 * 执行完整流程。`onProgress` 让界面能实时显示"现在在做哪一步"。
 *
 * 每一步都在 try/catch 里：某一步失败时返回已完成的部分，而不是整体抛错。
 * 销售宁可看到"搜到 12 家但评估没跑完"，也不想看到一片空白。
 */
export async function runProspectPipeline(input: {
  product: string;
  organizationId: string;
  /** 复用已有 trace（从上一层业务动作发起时传）；不传则新建一个。 */
  traceId?: string;
  onProgress?: (progress: ProspectProgress) => void;
  signal?: AbortSignal;
  /** 测试注入：跳过真实模型与真实搜索。 */
  deps?: {
    interpret?: typeof interpretProduct;
    search?: typeof searchCompanies;
    /**
     * 产物记录器。不传就不落库——测试天然走这条路，不必连数据库。
     * 真实请求由 API 层用 `createArtifactRecorder` 注入。
     */
    recordArtifact?: ArtifactRecorder;
    /**
     * 重规划（D1）。三种取值含义不同：
     * - 不传：按 env 开关决定（生产默认关闭）
     * - 传函数：用它，不看开关（测试显式要求跑）
     * - 传 null：禁用（测试要验证"没触发"时用）
     */
    replan?: typeof replanSearch | null;
    /**
     * 灰色带深查（D2）。取值语义与 `replan` 一致。
     */
    qualify?: typeof qualifyCompany | null;
  };
}): Promise<ProspectResult> {
  const product = input.product.trim();
  const progress = input.onProgress ?? (() => {});
  const runIds: string[] = [];
  const interpret = input.deps?.interpret ?? interpretProduct;
  const search = input.deps?.search ?? searchCompanies;
  const recordArtifact = input.deps?.recordArtifact;
  const traceId = input.traceId ?? crypto.randomUUID();
  // 显式传了 replan（哪怕是 null）就听调用方的，否则看 env 开关。
  const replanFn = input.deps && "replan" in input.deps
    ? input.deps.replan ?? null
    : replanEnabled()
      ? replanSearch
      : null;
  const qualifyFn = input.deps && "qualify" in input.deps
    ? input.deps.qualify ?? null
    : qualifierEnabled()
      ? qualifyCompany
      : null;

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

  // 产物：搜索计划。下游（找源员）只需要这些字段，不需要知道"为什么这么判定"。
  await emit(recordArtifact, { role: "planner", kind: "plan", payload: intent });

  // ---- ② 检索 ----
  progress({ stage: "search", status: "running", detail: `按 ${intent.searchTerms.length} 个关键词搜公司` });
  const byName = new Map<string, CompanyHit>();
  const termHits: Array<{ term: string; hits: number; error?: string }> = [];

  /** 按一组词搜索并并入结果。第一轮与重规划的补搜共用这一段。 */
  const runTerms = async (terms: readonly string[]): Promise<void> => {
    for (const term of terms) {
      if (input.signal?.aborted) break;
      try {
        const result = await search(term, { source: "auto", limit: SEARCH_LIMIT_PER_TERM });
        termHits.push({ term, hits: result.total });
        for (const item of result.hits) {
          if (!byName.has(item.name)) byName.set(item.name, item);
        }
      } catch (error) {
        termHits.push({ term, hits: 0, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  await runTerms(intent.searchTerms);

  // ---- D1：搜到的太少，让规划员换词再搜一轮 ----
  //
  // 触发条件是"结果不够打一天电话"。为什么值得多花一次模型调用：用「面包丝」
  // 搜企业库命中 0 家，但换成「烘焙食品」就有——词典能猜出行业词，猜不出
  // 新品类和地方叫法。让 Agent 先 probe 再给词，比它凭空猜准得多。
  //
  // 失败一律降级：重规划挂了、超时、解析不出来，都保持第一轮结果继续往下走。
  let replanInfo: SourcingReplan | null = null;
  if (replanFn && !input.signal?.aborted && byName.size < MIN_COMPANIES_BEFORE_REPLAN) {
    progress({
      stage: "search",
      status: "running",
      detail: `只搜到 ${byName.size} 家，尝试换关键词`,
    });
    try {
      const attempt = await replanFn({
        product,
        buyerDescription: intent.buyerDescription,
        triedTerms: termHits.map((item) => ({ term: item.term, hits: item.hits })),
        organizationId: input.organizationId,
        signal: input.signal,
      });
      const before = byName.size;
      if (attempt.newTerms.length) await runTerms(attempt.newTerms);
      replanInfo = {
        triggered: true,
        newTerms: attempt.newTerms,
        reasoning: attempt.reasoning,
        addedCompanies: byName.size - before,
      };
      progress({
        stage: "search",
        status: "running",
        detail: `换了 ${attempt.newTerms.length} 个词，新增 ${byName.size - before} 家`,
      });
    } catch (error) {
      // 重规划是增强，不是主链路的必要环节。失败就退回第一轮结果。
      console.error("[agent/pipeline] 重规划失败，保持原搜索结果：", error);
      replanInfo = {
        triggered: false,
        newTerms: [],
        reasoning: "重规划失败，已保持第一轮结果",
        addedCompanies: 0,
      };
    }
  }

  const found = [...byName.values()].slice(0, MAX_COMPANIES);
  progress({
    stage: "search",
    status: "done",
    detail: `搜到 ${found.length} 家公司`,
    count: found.length,
  });

  // 产物：企业名单。即使一家都没搜到也要写——"搜空"本身就是结论，
  // 下游要靠它判断是换词重搜还是直接放弃。
  await emit(recordArtifact, {
    role: "sourcer",
    kind: "sourcing",
    payload: {
      terms: termHits,
      total: found.length,
      companies: found.map((hit) => ({
        key: hit.key,
        name: hit.name,
        region: hit.region,
        industry: hit.industry,
        status: hit.status,
        inLibrary: hit.inLibrary,
      })),
      // 没触发重规划时整个字段不出现：'没跑' 与 '跑了没效果' 要能区分。
      ...(replanInfo ? { replan: replanInfo } : {}),
    },
  });

  if (!found.length) {
    return {
      product,
      intent,
      companies: [],
      stats: { searchedTerms: intent.searchTerms.length, found: 0, reachable: 0, priority: 0 },
      runIds,
      traceId,
      replan: replanInfo,
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
    // deepCheck 先占位为 null，D2 阶段算完再回填（只有灰色带会被填）。
    return { ...assessment, hit, phones, reachable: phones.length > 0, deepCheck: null };
  });
  // 排序：能打电话的优先，再按分数。
  assessed.sort((a, b) => {
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    return b.score - a.score;
  });
  const priority = assessed.filter((item) => item.tier === "priority").length;

  // ---- D2：灰色带深查 ----
  //
  // 分数 45–65 的公司最尴尬：工商信息看着像客户，但看不出"他现在到底做不做这门
  // 生意"。让资格员查招聘（在招渠道岗=在扩张）、招标（有中标=业务真在跑）、
  // 资质（食品许可=能铺货）、食品安全（有处罚=硬风险）。
  //
  // 结论**不改分数**：分数是公式算的，销售问"为什么 87 分"能逐项答出来；让模型
  // 改分数的代价是丢掉这份可解释性。所以深查结论与分数并列，作为附加信号。
  const deepChecks = new Map<string, DeepCheck>();
  if (qualifyFn && !input.signal?.aborted) {
    const candidates = assessed.filter((item) => inGrayZone(item.score)).slice(0, MAX_DEEP_CHECK);
    if (candidates.length) {
      progress({
        stage: "assess",
        status: "running",
        detail: `深查 ${candidates.length} 家灰色带公司（招聘 / 招标 / 资质 / 食品安全）`,
      });
      for (const item of candidates) {
        if (input.signal?.aborted) break;
        try {
          const outcome = await qualifyFn({
            companyName: item.companyName,
            score: item.score,
            tier: item.tier,
            buyerDescription: intent.buyerDescription,
            product,
            organizationId: input.organizationId,
            signal: input.signal,
          });
          if (outcome) {
            deepChecks.set(item.companyName, {
              verdict: outcome.verdict,
              reasoning: outcome.reasoning,
              lookups: outcome.lookups.map((lookup) => lookup.tool),
            });
          }
        } catch (error) {
          // 一家深查失败不影响其他家，更不影响主链路。
          console.error(`[agent/pipeline] 深查失败 ${item.hit.name}：`, error);
        }
      }
    }
  }

  progress({
    stage: "assess",
    status: "done",
    detail: deepChecks.size
      ? `${priority} 家优先联系；深查 ${deepChecks.size} 家，建议跟进 ${[...deepChecks.values()].filter((item) => item.verdict === "pursue").length} 家`
      : `${priority} 家优先联系`,
    count: priority,
  });

  // 产物：资格分档。带上每一维的依据，界面和审校才能解释"为什么是这个分"。
  await emit(recordArtifact, {
    role: "qualifier",
    kind: "qualification",
    payload: {
      companies: assessed.map((item) => ({
        name: item.companyName,
        score: item.score,
        tier: item.tier,
        verdict: item.verdict,
        caveats: item.caveats,
        dimensions: item.dimensions,
        ...(deepChecks.has(item.companyName) ? { deepCheck: deepChecks.get(item.companyName) } : {}),
      })),
    },
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

  // 产物：可打的电话。只留号码与可达性——话术由 API 层按需生成，不进产物。
  await emit(recordArtifact, {
    role: "contact",
    kind: "contact",
    payload: {
      companies: assessed.map((item) => ({
        name: item.hit.name,
        phones: item.phones,
        reachable: item.reachable,
      })),
    },
  });

  return {
    product,
    intent,
    // 回填深查结论：assessed 是按"可打性 + 分数"排好的，这里只补充不重排。
    companies: assessed.map((item) => ({
      ...item,
      deepCheck: deepChecks.get(item.companyName) ?? null,
    })),
    stats: {
      searchedTerms: intent.searchTerms.length,
      found: found.length,
      reachable,
      priority,
    },
    runIds,
    traceId,
    replan: replanInfo,
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
