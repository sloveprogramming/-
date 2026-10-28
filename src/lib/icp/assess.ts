/**
 * 公司体量评估：用**能拿到的公开数据**推断"这家公司值不值得打"。
 *
 * 先说清楚局限：探迹那类平台能拿到「参保人数」和「实缴出资」，是因为买了
 * 企查查的详情接口。我们能拿到的只有搜索接口的公示字段——
 *
 *   注册资本（认缴）、成立日期、行业、经营范围、经营状态
 *
 * 所以这里算的是**代理指标**，不是真实体量。这个区别必须一路带到界面上：
 * 销售看到的每个分数都要知道它是"实缴"还是"推断"，否则拿一个虚高的分数
 * 去判断"这客户有实力"，是要出事的。
 *
 * 设计上分两层：
 *   1. `assessCompany` —— 纯函数，从字段算分。可测、可解释、无依赖。
 *   2. Agent 用它作为工具 —— 让模型自己决定要不要评估、评估哪家。
 */

export type CompanyFacts = {
  name: string;
  /** 注册资本原文，如「5000万元人民币」。 */
  registeredCapital: string | null;
  /** 成立日期 YYYY-MM-DD。 */
  foundedAt: string | null;
  industry: string | null;
  scope: string | null;
  /** 经营状态：存续 / 在业 / 注销 / 吊销。 */
  status: string | null;
  region: string | null;
};

export type AssessmentDimension = {
  key: string;
  label: string;
  /** 这一项拿到的分。 */
  score: number;
  max: number;
  /** 判断依据，人话。 */
  basis: string;
  /**
   * 数据性质：
   * - measured：直接拿到的公开数据（注册资本、成立日期、状态）
   * - inferred：从公开数据推断的（体量档位）
   * - unknown：拿不到，没有分
   */
  nature: "measured" | "inferred" | "unknown";
};

export type CompanyAssessment = {
  companyName: string;
  /** 0-100。 */
  score: number;
  /** 分档：值得优先联系 / 可联系 / 不建议。 */
  tier: "priority" | "workable" | "skip";
  dimensions: AssessmentDimension[];
  /** 一句话结论。 */
  verdict: string;
  /** 明确告诉用户哪些数据是推断的。 */
  caveats: string[];
};

const WEIGHTS = {
  capital: 25,
  age: 20,
  industry: 25,
  status: 15,
  scope: 15,
} as const;

/**
 * 注册资本 → 分。
 *
 * 按食品分销/生产行业的常识分档：5000 万以上算大厂，1000-5000 万算中型，
 * 100-1000 万是主流经销商体量，100 万以下是小微。
 *
 * 注意：注册资本是**认缴**，不代表实缴，也不代表现金流。所以这一项最多给
 * 「推测有规模」，不能当实力证明。
 */
export function capitalScore(raw: string | null): { score: number; value: number | null; unit: string | null } {
  if (!raw) return { score: 0, value: null, unit: null };
  const match = raw.replace(/,/g, "").match(/([\d.]+)\s*(亿|万)?/);
  if (!match) return { score: 0, value: null, unit: null };
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return { score: 0, value: null, unit: null };
  const unit = match[2] ?? null;
  // 统一折算成万元
  const wan = unit === "亿" ? value * 10_000 : value;
  if (wan >= 5000) return { score: WEIGHTS.capital, value, unit };
  if (wan >= 1000) return { score: 18, value, unit };
  if (wan >= 100) return { score: 12, value, unit };
  if (wan >= 10) return { score: 5, value, unit };
  return { score: 2, value, unit };
}

/** 成立年限 → 分。5 年以上更可能稳定经营。 */
export function ageScore(foundedAt: string | null, now: Date = new Date()): { score: number; years: number | null } {
  if (!foundedAt) return { score: 0, years: null };
  const founded = new Date(foundedAt);
  const ms = now.getTime() - founded.getTime();
  if (Number.isNaN(ms) || ms < 0) return { score: 0, years: null };
  const years = Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
  if (years >= 10) return { score: WEIGHTS.age, years };
  if (years >= 5) return { score: 15, years };
  if (years >= 3) return { score: 10, years };
  if (years >= 1) return { score: 5, years };
  return { score: 2, years };
}

/** 经营状态 → 分。注销/吊销的直接出局。 */
export function statusScore(status: string | null): { score: number; healthy: boolean } {
  if (!status) return { score: 0, healthy: false };
  const text = status.trim();
  if (/存续|在业|开业|正常/.test(text)) return { score: WEIGHTS.status, healthy: true };
  if (/迁出|停业|清算/.test(text)) return { score: 5, healthy: false };
  if (/注销|吊销|撤销/.test(text)) return { score: 0, healthy: false };
  // 认不出的状态给中间分，并标为"未知"
  return { score: 7, healthy: false };
}

/**
 * 行业与经营范围是否匹配目标买家。
 *
 * 这是评估里最影响"该不该打"的一项：一家注册资本 1 亿的房地产公司，
 * 体量分很高，但和我们卖面包丝毫无关系。
 */
export function industryFitScore(facts: CompanyFacts, buyerTerms: readonly string[]): { score: number; hit: string[] } {
  const haystack = `${facts.industry ?? ""} ${facts.scope ?? ""} ${facts.name}`.toLowerCase();
  const hit = buyerTerms.filter((term) => term.trim() && haystack.includes(term.trim().toLowerCase()));
  if (hit.length >= 3) return { score: WEIGHTS.industry, hit };
  if (hit.length === 2) return { score: 18, hit };
  if (hit.length === 1) return { score: 11, hit };
  return { score: 0, hit };
}

/** 经营范围里是否含"卖货"特征（批发、销售、供应链），用来区分贸易商和纯服务商。 */
export function scopeScore(scope: string | null): { score: number; trading: boolean } {
  if (!scope) return { score: 0, trading: false };
  const trading = /批发|销售|贸易|供应链|配送|经销|代理/.test(scope);
  return { score: trading ? WEIGHTS.scope : 4, trading };
}

/** 评估一家公司。`buyerTerms` 来自产品意图（谁需要这个产品）。 */
export function assessCompany(facts: CompanyFacts, buyerTerms: readonly string[], now: Date = new Date()): CompanyAssessment {
  const capital = capitalScore(facts.registeredCapital);
  const age = ageScore(facts.foundedAt, now);
  const status = statusScore(facts.status);
  const industry = industryFitScore(facts, buyerTerms);
  const scope = scopeScore(facts.scope);

  const score = capital.score + age.score + industry.score + status.score + scope.score;

  const dimensions: AssessmentDimension[] = [
    {
      key: "capital",
      label: "注册资本",
      score: capital.score,
      max: WEIGHTS.capital,
      nature: capital.value === null ? "unknown" : "measured",
      basis: capital.value === null
        ? "没有拿到注册资本"
        : `${facts.registeredCapital}（认缴，不代表实缴或现金流）`,
    },
    {
      key: "age",
      label: "成立年限",
      score: age.score,
      max: WEIGHTS.age,
      nature: age.years === null ? "unknown" : "measured",
      basis: age.years === null ? "没有拿到成立日期" : `成立 ${age.years} 年`,
    },
    {
      key: "industry",
      label: "行业匹配",
      score: industry.score,
      max: WEIGHTS.industry,
      nature: industry.hit.length ? "measured" : "unknown",
      basis: industry.hit.length
        ? `命中买家关键词：${industry.hit.join("、")}`
        : "行业与经营范围没有命中目标买家特征",
    },
    {
      key: "status",
      label: "经营状态",
      score: status.score,
      max: WEIGHTS.status,
      nature: facts.status ? "measured" : "unknown",
      basis: facts.status ?? "没有拿到经营状态",
    },
    {
      key: "scope",
      label: "是否做贸易/分销",
      score: scope.score,
      max: WEIGHTS.scope,
      nature: facts.scope ? "inferred" : "unknown",
      basis: scope.trading ? "经营范围含批发/销售/供应链等字眼" : "经营范围看不出做分销",
    },
  ];

  // 注销/吊销直接判 skip，不看总分——这类公司打过去是浪费话费。
  const tier: CompanyAssessment["tier"] = !status.healthy && /注销|吊销|撤销/.test(facts.status ?? "")
    ? "skip"
    : score >= 65
      ? "priority"
      : score >= 40
        ? "workable"
        : "skip";

  return {
    companyName: facts.name,
    score,
    tier,
    dimensions,
    verdict: verdictLine(tier, score, industry.hit),
    caveats: [
      "分数由公开工商数据推断，不含参保人数与实缴出资——那两项需要企查查付费接口",
      "注册资本是认缴金额，不代表实缴，也不代表现金流",
    ],
  };
}

function verdictLine(tier: CompanyAssessment["tier"], score: number, hits: readonly string[]): string {
  const fit = hits.length >= 2 ? "行业对得上" : hits.length === 1 ? "行业部分相关" : "行业存疑";
  switch (tier) {
    case "priority":
      return `${fit}，体量看起来够，建议优先联系`;
    case "workable":
      return `${fit}，可以联系，先探需求`;
    case "skip":
      return score < 20
        ? "数据太少或明显不匹配，建议跳过"
        : "体量或行业偏弱，放到低优先级";
  }
}

export const TIER_LABEL: Record<CompanyAssessment["tier"], string> = {
  priority: "优先联系",
  workable: "可联系",
  skip: "不建议",
};
