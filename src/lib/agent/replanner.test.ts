import { describe, expect, test } from "bun:test";
import { MIN_COMPANIES_BEFORE_REPLAN, parseReplanOutput } from "./replanner";
import { runProspectPipeline } from "./pipeline";
import { matchDictionary } from "@/lib/icp/productIntent";
import type { CompanyHit } from "@/lib/qcc/types";
import type { RawArtifact } from "./artifacts";

/**
 * D1 重规划：搜到的公司太少时，让 Agent 换词重搜。
 *
 * 两件同等重要的事：
 * 1. 解析要能捞回模型的各种输出格式（带围栏、带前言、全角标点）
 * 2. **失败必须降级**——重规划是增强，挂了不能把主链路带死
 */

const orgId = "00000000-0000-4000-8000-000000000001";

function hit(name: string, phones: string[] = ["0571-88880001"]): CompanyHit {
  return {
    key: name,
    name,
    creditCode: null,
    region: "浙江省 杭州市",
    industry: "烘焙食品",
    legalPerson: null,
    foundedAt: "2012-06-15",
    registeredCapital: "5000万元人民币",
    phones,
    scope: "烘焙食品生产与销售",
    status: "存续",
    inLibrary: false,
  };
}

const fakeReplan = async () => ({
  newTerms: ["食品批发", "休闲食品"],
  reasoning: "「烘焙食品」命中 0，改用更上位的行业词",
  probes: [{ tool: "probe_search", ok: true }],
  usage: { inputTokens: 120, outputTokens: 40 },
  stopReason: "final_answer",
});

const baseDeps = {
  interpret: async ({ query }: { query: string }) => matchDictionary(query)!,
};

describe("解析模型输出", () => {
  test("纯 JSON", () => {
    const parsed = parseReplanOutput('{"newTerms":["烘焙食品"],"reasoning":"因为命中 0"}');
    expect(parsed?.newTerms).toEqual(["烘焙食品"]);
    expect(parsed?.reasoning).toBe("因为命中 0");
  });

  test("带 ```json 围栏", () => {
    const parsed = parseReplanOutput('```json\n{"newTerms":["速冻食品"]}\n```');
    expect(parsed?.newTerms).toEqual(["速冻食品"]);
  });

  test("前面带一句人话也能捞出 JSON", () => {
    const parsed = parseReplanOutput(
      '我试了三个词，只有「食品批发」有结果。\n\n{"newTerms":["食品批发"],"reasoning":"其他两个都 0"}',
    );
    expect(parsed?.newTerms).toEqual(["食品批发"]);
  });

  test("去重、去空白、丢掉过短过长的词", () => {
    const parsed = parseReplanOutput(
      JSON.stringify({ newTerms: ["  烘焙食品 ", "烘焙食品", "a", "这个词实在是太长了不应该被接受超出限制", "速冻食品"] }),
    );
    expect(parsed?.newTerms).toEqual(["烘焙食品", "速冻食品"]);
  });

  test("最多只要 3 个词（多给的不收）", () => {
    const parsed = parseReplanOutput(
      JSON.stringify({ newTerms: ["词一", "词二", "词三", "词四", "词五"] }),
    );
    expect(parsed?.newTerms).toHaveLength(3);
  });

  test("空数组、非 JSON、纯文本一律返回 null（调用方保持原结果）", () => {
    expect(parseReplanOutput("")).toBeNull();
    expect(parseReplanOutput("我觉得可以试试烘焙食品")).toBeNull();
    expect(parseReplanOutput('{"newTerms":[]}')).toBeNull();
    expect(parseReplanOutput('{"newTerms":"烘焙食品"}')).toBeNull();
    expect(parseReplanOutput("{坏掉的 json}")).toBeNull();
  });

  test("reasoning 缺失时不报错，只给空串", () => {
    const parsed = parseReplanOutput('{"newTerms":["烘焙食品"]}');
    expect(parsed?.newTerms).toEqual(["烘焙食品"]);
    expect(parsed?.reasoning).toBe("");
  });
});

describe("D1 在编排里的行为", () => {
  test("搜到的太少会触发重规划，新词带来的公司进结果", async () => {
    let round = 0;
    const collected: RawArtifact[] = [];
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        ...baseDeps,
        // 第一轮（产品自带的词）只给 1 家；重规划的新词各给 1 家
        search: async (term) => {
          const isNew = ["食品批发", "休闲食品"].includes(term);
          if (!isNew) {
            round += 1;
            return { source: "local" as const, total: 0, hits: [], notice: null };
          }
          return { source: "local" as const, total: 1, hits: [hit(`${term}有限公司`)], notice: null };
        },
        replan: fakeReplan,
        recordArtifact: async (artifact) => {
          collected.push(artifact);
        },
      },
    });

    expect(result.companies.length).toBe(2);
    const sourcing = collected.find((item) => item.kind === "sourcing");
    const payload = sourcing?.payload as {
      replan?: { triggered: boolean; newTerms: string[]; addedCompanies: number };
    };
    expect(payload.replan?.triggered).toBe(true);
    expect(payload.replan?.newTerms).toEqual(["食品批发", "休闲食品"]);
    expect(payload.replan?.addedCompanies).toBe(2);
    expect(round).toBeGreaterThan(0);
  });

  test("结果已经够多就不触发（不花那个钱）", async () => {
    let called = 0;
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        ...baseDeps,
        search: async (term) => ({
          source: "local" as const,
          total: 1,
          hits: [hit(`${term}有限公司`)],
          notice: null,
        }),
        replan: async () => {
          called += 1;
          return fakeReplan();
        },
      },
    });
    expect(called).toBe(0);
    expect(result.companies.length).toBeGreaterThanOrEqual(MIN_COMPANIES_BEFORE_REPLAN);
  });

  test("显式传 replan: null 时永不触发（测试与脚本的关闭方式）", async () => {
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        ...baseDeps,
        search: async () => ({ source: "local" as const, total: 0, hits: [], notice: null }),
        replan: null,
      },
    });
    expect(result.companies).toHaveLength(0);
    expect(result.traceId).toBeTruthy();
  });

  test("重规划抛错时保持第一轮结果，并留下失败记录", async () => {
    const collected: RawArtifact[] = [];
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        ...baseDeps,
        // 第一轮就给 1 家，重规划本该补更多，但它挂了
        search: async () => ({
          source: "local" as const,
          total: 1,
          hits: [hit("临安烘焙食品有限公司")],
          notice: null,
        }),
        replan: async () => {
          throw new Error("模型超时");
        },
        recordArtifact: async (artifact) => {
          collected.push(artifact);
        },
      },
    });

    expect(result.companies).toHaveLength(1);
    const sourcing = collected.find((item) => item.kind === "sourcing");
    const payload = sourcing?.payload as { replan?: { triggered: boolean; reasoning: string } };
    // 触发了但失败 —— 与"没触发"要区分开
    expect(payload.replan?.triggered).toBe(false);
    expect(payload.replan?.reasoning).toContain("失败");
  });

  test("重规划给了词但这些词也搜不到，结果不为负、链路不断", async () => {
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        ...baseDeps,
        search: async () => ({ source: "local" as const, total: 0, hits: [], notice: "没有结果" }),
        replan: fakeReplan,
      },
    });
    expect(result.companies).toHaveLength(0);
    expect(result.stats.found).toBe(0);
  });
});
