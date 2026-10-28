import { describe, expect, test } from "bun:test";
import { buyerTermsFor, cleanPhones, runProspectPipeline, STAGE_LABEL, summarizeResult } from "./pipeline";
import { matchDictionary } from "@/lib/icp/productIntent";
import type { CompanyHit } from "@/lib/qcc/types";

/**
 * 多 Agent 编排。
 *
 * 用注入的假搜索替代真实数据源，把编排行为钉死。重点测三件事：
 * 1. 四个阶段按顺序跑完，进度事件齐全
 * 2. 某一步失败时返回已完成的部分，不整体抛错
 * 3. 排序把"能打通的"排在前面——这直接决定销售先打谁
 */

const orgId = "00000000-0000-4000-8000-000000000001";

function hit(overrides: Partial<CompanyHit> & { name: string }): CompanyHit {
  return {
    key: overrides.name,
    creditCode: null,
    region: "浙江省 杭州市",
    industry: "烘焙食品",
    legalPerson: null,
    foundedAt: "2012-06-15",
    registeredCapital: "5000万元人民币",
    phones: ["0571-88880001"],
    scope: "烘焙食品生产与销售",
    status: "存续",
    inLibrary: false,
    ...overrides,
  };
}

const fakeInterpret = async ({ query }: { query: string }) => matchDictionary(query)!;

describe("编排流程", () => {
  test("四个阶段按顺序完成", async () => {
    const progress: string[] = [];
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      onProgress: (event) => progress.push(`${event.stage}:${event.status}`),
      deps: {
        interpret: fakeInterpret,
        search: async (term) => ({
          source: "local" as const,
          total: 1,
          hits: [hit({ name: `${term}公司` })],
          notice: null,
        }),
      },
    });

    expect(progress).toContain("parse:running");
    expect(progress).toContain("parse:done");
    expect(progress).toContain("search:done");
    expect(progress).toContain("assess:done");
    expect(progress).toContain("contact:done");
    expect(result.companies.length).toBeGreaterThan(0);
  });

  test("同一家公司被多个关键词命中时只出现一次", async () => {
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: fakeInterpret,
        // 每个关键词都返回同一家公司
        search: async () => ({
          source: "local" as const,
          total: 1,
          hits: [hit({ name: "临安烘焙食品有限公司" })],
          notice: null,
        }),
      },
    });
    expect(result.companies).toHaveLength(1);
  });

  test("按名字去重，不同公司都保留", async () => {
    let index = 0;
    const names = ["甲公司", "乙公司", "丙公司"];
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: fakeInterpret,
        search: async () => ({
          source: "local" as const,
          total: 1,
          hits: [hit({ name: names[index++ % names.length] })],
          notice: null,
        }),
      },
    });
    expect(result.companies).toHaveLength(3);
  });

  test("检索失败不中断整体，仍返回已完成的部分", async () => {
    let calls = 0;
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: fakeInterpret,
        search: async (term) => {
          calls += 1;
          // 第一个词成功，其余全失败
          if (calls > 1) throw new Error("企查查限流");
          return { source: "local" as const, total: 1, hits: [hit({ name: `${term}公司` })], notice: null };
        },
      },
    });
    expect(result.companies).toHaveLength(1);
    expect(result.intent.query).toBe("面包丝");
  });

  test("一家都没搜到也正常返回，不是抛错", async () => {
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: fakeInterpret,
        search: async () => ({ source: "local" as const, total: 0, hits: [], notice: "没有结果" }),
      },
    });
    expect(result.companies).toHaveLength(0);
    expect(result.stats.found).toBe(0);
    expect(summarizeResult(result)).toContain("没有搜到");
  });
});

describe("排序", () => {
  test("有电话的排在没电话的前面，哪怕分更低", async () => {
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: fakeInterpret,
        search: async () => ({
          source: "local" as const,
          total: 2,
          hits: [
            // 体量强但没有电话
            hit({ name: "强但没电话有限公司", phones: [], registeredCapital: "5亿元" }),
            // 体量一般但有电话
            hit({ name: "弱但有电话有限公司", phones: ["0571-88880002"], registeredCapital: "50万元" }),
          ],
          notice: null,
        }),
      },
    });
    expect(result.companies[0].hit.name).toBe("弱但有电话有限公司");
    expect(result.companies[0].reachable).toBe(true);
  });

  test("都有电话时按分数降序", async () => {
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: fakeInterpret,
        search: async () => ({
          source: "local" as const,
          total: 2,
          hits: [
            hit({ name: "小公司", registeredCapital: "50万元", foundedAt: "2025-01-01" }),
            hit({ name: "大公司", registeredCapital: "5亿元", foundedAt: "2005-01-01" }),
          ],
          notice: null,
        }),
      },
    });
    expect(result.companies[0].hit.name).toBe("大公司");
    expect(result.companies[0].score).toBeGreaterThanOrEqual(result.companies[1].score);
  });
});

describe("电话号码清洗", () => {
  test("逗号分号分隔的多个号码拆开、去重", () => {
    expect(cleanPhones(["0571-88880001，0571-88880001；0571-88880002"])).toEqual([
      "0571-88880001",
      "0571-88880002",
    ]);
  });

  test("带分机的座机保留区号部分，非法字符去掉", () => {
    const phones = cleanPhones(["0571-88880001 转 8002"]);
    expect(phones.length).toBeGreaterThan(0);
    expect(phones[0]).toMatch(/^[\d-]+$/);
  });

  test("太短或太长的丢掉", () => {
    expect(cleanPhones(["123", "1".repeat(20), ""])).toEqual([]);
  });

  test("空数组安全", () => {
    expect(cleanPhones([])).toEqual([]);
  });
});

describe("买家词提取", () => {
  test("产品词本身不算买家词", () => {
    const terms = buyerTermsFor(matchDictionary("面包丝")!);
    expect(terms).not.toContain("面包丝");
    expect(terms).toContain("烘焙食品");
  });
});

describe("阶段名", () => {
  test("四个阶段都有中文名", () => {
    for (const stage of ["parse", "search", "assess", "contact"] as const) {
      expect(STAGE_LABEL[stage]).toBeTruthy();
    }
  });
});
