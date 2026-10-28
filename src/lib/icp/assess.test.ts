import { describe, expect, test } from "bun:test";
import {
  TIER_LABEL,
  ageScore,
  assessCompany,
  capitalScore,
  industryFitScore,
  scopeScore,
  statusScore,
  type CompanyFacts,
} from "./assess";

/**
 * 公司体量评估。
 *
 * 这个模块最容易出的问题不是算错，而是**把推断说成事实**。所以测试里除了
 * 边界值，还专门钉住"数据性质标注"和"注销直接出局"——这两条错了，销售会
 * 拿着一家已注销公司的 90 分去打一天电话。
 */

const BUYER_TERMS = ["烘焙食品", "食品加工", "速冻食品", "餐饮供应链"];

function facts(overrides: Partial<CompanyFacts> = {}): CompanyFacts {
  return {
    name: "临安烘焙食品有限公司",
    registeredCapital: "5000万元人民币",
    foundedAt: "2012-06-15",
    industry: "烘焙食品",
    scope: "面包糠、裹粉生产与销售",
    status: "存续",
    region: "浙江省 杭州市",
    ...overrides,
  };
}

describe("注册资本换算", () => {
  test("亿与万都能折算", () => {
    expect(capitalScore("1.2亿元人民币").value).toBe(1.2);
    expect(capitalScore("5000万元人民币").value).toBe(5000);
    // 1.2 亿 = 12000 万，应拿到满分档
    expect(capitalScore("1.2亿元人民币").score).toBe(25);
  });

  test("分档递减，但不会负分", () => {
    expect(capitalScore("5000万元").score).toBe(25);
    expect(capitalScore("1000万元").score).toBe(18);
    expect(capitalScore("100万元").score).toBe(12);
    expect(capitalScore("10万元").score).toBe(5);
    expect(capitalScore("1万元").score).toBe(2);
  });

  test("拿不到或格式怪 → 0 分而不是崩", () => {
    expect(capitalScore(null).score).toBe(0);
    expect(capitalScore("未公开").score).toBe(0);
    expect(capitalScore("").score).toBe(0);
  });
});

describe("成立年限", () => {
  const now = new Date("2026-10-28T00:00:00Z");
  test("十年以上满分，五年以上次高", () => {
    expect(ageScore("2010-01-01", now).score).toBe(20);
    expect(ageScore("2020-01-01", now).score).toBe(15);
    expect(ageScore("2022-06-01", now).score).toBe(10);
  });

  test("未来日期与空值都给 0，不产生负年份", () => {
    expect(ageScore("2030-01-01", now).score).toBe(0);
    expect(ageScore("2030-01-01", now).years).toBeNull();
    expect(ageScore(null, now).score).toBe(0);
    expect(ageScore("不是日期", now).score).toBe(0);
  });
});

describe("经营状态", () => {
  test("存续/在业算健康", () => {
    expect(statusScore("存续").healthy).toBe(true);
    expect(statusScore("在业").healthy).toBe(true);
    expect(statusScore("存续").score).toBe(15);
  });

  test("注销/吊销零分且不健康", () => {
    for (const status of ["注销", "吊销", "撤销"]) {
      expect(statusScore(status).score).toBe(0);
      expect(statusScore(status).healthy).toBe(false);
    }
  });

  test("认不出的状态给中间分但不算健康", () => {
    expect(statusScore("某种奇怪状态").healthy).toBe(false);
    expect(statusScore(null).score).toBe(0);
  });
});

describe("行业匹配", () => {
  test("命中越多分越高", () => {
    // 三项都命中：烘焙食品（industry/name）+ 食品加工（scope）+ 餐饮供应链（scope）
    const strong = facts({
      industry: "烘焙食品",
      scope: "食品加工、餐饮供应链配送、烘焙食品销售",
    });
    expect(industryFitScore(strong, BUYER_TERMS).score).toBe(25);

    // 只命中一项：名字改成中性，否则名称里的"烘焙食品"会额外命中
    const single = facts({ name: "杭州某某商贸有限公司", industry: "餐饮供应链", scope: "餐饮配送" });
    expect(industryFitScore(single, BUYER_TERMS).score).toBe(11);

    // 一项都不命中
    const none = facts({ name: "某某置业有限公司", industry: "房地产", scope: "房屋开发" });
    expect(industryFitScore(none, BUYER_TERMS).score).toBe(0);
  });

  test("名称里的词也算命中", () => {
    const hit = industryFitScore(
      facts({ name: "宁波餐饮供应链管理有限公司", industry: "商务服务", scope: "企业管理咨询" }),
      BUYER_TERMS,
    );
    expect(hit.hit).toContain("餐饮供应链");
  });
});

describe("分销特征", () => {
  test("经营范围含批发销售等字眼算贸易商", () => {
    expect(scopeScore("食品批发、销售").trading).toBe(true);
    expect(scopeScore("供应链管理服务").trading).toBe(true);
    expect(scopeScore("技术咨询、软件开发").trading).toBe(false);
    expect(scopeScore(null).score).toBe(0);
  });
});

describe("整体评估", () => {
  test("各方面都好的公司进优先档", () => {
    const result = assessCompany(facts(), BUYER_TERMS, new Date("2026-10-28T00:00:00Z"));
    expect(result.tier).toBe("priority");
    expect(result.score).toBeGreaterThanOrEqual(65);
    expect(result.verdict).toContain("优先");
  });

  test("注销公司无论分数多高都判 skip", () => {
    // 注册资本、年限、行业都很好，但已注销
    const result = assessCompany(
      facts({ status: "注销" }),
      BUYER_TERMS,
      new Date("2026-10-28T00:00:00Z"),
    );
    expect(result.tier).toBe("skip");
    // 这一点是关键：不能被高分带偏
    expect(result.score).toBeGreaterThan(50);
  });

  test("行业完全不相关的不进优先档", () => {
    // 公司名也要一起换掉：名字里带"烘焙食品"本身就是行业证据，留着会误判。
    const result = assessCompany(
      facts({ name: "某某置业有限公司", industry: "房地产", scope: "房屋开发" }),
      BUYER_TERMS,
      new Date("2026-10-28T00:00:00Z"),
    );
    expect(result.tier).not.toBe("priority");
  });

  test("每个维度都有分数上限与依据", () => {
    const result = assessCompany(facts(), BUYER_TERMS);
    expect(result.dimensions).toHaveLength(5);
    for (const dimension of result.dimensions) {
      expect(dimension.score).toBeLessThanOrEqual(dimension.max);
      expect(dimension.score).toBeGreaterThanOrEqual(0);
      expect(dimension.basis.length).toBeGreaterThan(0);
      expect(["measured", "inferred", "unknown"]).toContain(dimension.nature);
    }
  });

  test("必须带出「这是推断不是实缴」的说明", () => {
    const result = assessCompany(facts(), BUYER_TERMS);
    const joined = result.caveats.join("");
    expect(joined).toContain("参保人数");
    expect(joined).toContain("认缴");
  });

  test("三档都有中文名", () => {
    for (const tier of ["priority", "workable", "skip"] as const) {
      expect(TIER_LABEL[tier]).toBeTruthy();
    }
  });
});
