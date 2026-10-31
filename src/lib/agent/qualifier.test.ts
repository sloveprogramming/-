import { describe, expect, test } from "bun:test";
import { GRAY_ZONE, MAX_DEEP_CHECK, inGrayZone, parseQualifierOutput } from "./qualifier";
import { runProspectPipeline } from "./pipeline";
import { matchDictionary } from "@/lib/icp/productIntent";
import type { CompanyHit } from "@/lib/qcc/types";
import type { RawArtifact } from "./artifacts";

/**
 * 资格员（灰色带深查）。
 *
 * 三件事要钉死：
 * 1. 只在灰色带触发（不该花的钱不花）
 * 2. 深查结论**不改分数**（可解释性不能被模型替换）
 * 3. 失败一律降级（深查挂了，名单照出）
 */

const orgId = "00000000-0000-4000-8000-000000000001";

function hit(name: string, overrides: Partial<CompanyHit> = {}): CompanyHit {
  return {
    key: name,
    name,
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

/** 实测 58 分，落在灰色带（45–65）。 */
const grayCompany = (name: string) =>
  hit(name, { registeredCapital: "200万元人民币", foundedAt: "2024-01-01" });

/** 实测 86 分，明确不该深查。 */
const strongCompany = (name: string) =>
  hit(name, { registeredCapital: "5000万元人民币", foundedAt: "2010-01-01" });

const fakeQualify = async (input: { companyName: string }) => ({
  verdict: "pursue" as const,
  reasoning: `${input.companyName} 正在招渠道经理，且持有食品经营许可`,
  lookups: [
    { tool: "lookup_recruitment", ok: true },
    { tool: "lookup_qualifications", ok: true },
  ],
  usage: { inputTokens: 300, outputTokens: 60 },
  stopReason: "final_answer",
});

describe("解析深查结论", () => {
  test("标准 JSON", () => {
    const parsed = parseQualifierOutput('{"verdict":"pursue","reasoning":"在招渠道岗"}');
    expect(parsed?.verdict).toBe("pursue");
    expect(parsed?.reasoning).toBe("在招渠道岗");
  });

  test("带围栏与前言也能捞出来", () => {
    const parsed = parseQualifierOutput('我查了三项：\n```json\n{"verdict":"drop","reasoning":"有食品安全处罚"}\n```');
    expect(parsed?.verdict).toBe("drop");
  });

  test("verdict 不在三档内一律拒绝（不让模型自创结论）", () => {
    expect(parseQualifierOutput('{"verdict":"maybe","reasoning":"看情况"}')).toBeNull();
    expect(parseQualifierOutput('{"verdict":"PURSUE"}')).toBeNull();
  });

  test("没有 verdict、不是 JSON、空串 → null", () => {
    expect(parseQualifierOutput('{"reasoning":"缺少结论"}')).toBeNull();
    expect(parseQualifierOutput("这家公司还行")).toBeNull();
    expect(parseQualifierOutput("")).toBeNull();
  });

  test("reasoning 缺失不报错", () => {
    expect(parseQualifierOutput('{"verdict":"hold"}')?.reasoning).toBe("");
  });
});

describe("灰色带边界", () => {
  test("45 与 65 都在带内（含端点）", () => {
    expect(inGrayZone(GRAY_ZONE.min)).toBe(true);
    expect(inGrayZone(GRAY_ZONE.max)).toBe(true);
  });

  test("带外一律不触发", () => {
    expect(inGrayZone(44)).toBe(false);
    expect(inGrayZone(66)).toBe(false);
    expect(inGrayZone(0)).toBe(false);
    expect(inGrayZone(100)).toBe(false);
  });
});

describe("D2 在编排里的行为", () => {
  test("灰色带公司会被深查，结论进产物且不改分数", async () => {
    const collected: RawArtifact[] = [];
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
        search: async () => ({
          source: "local" as const,
          total: 1,
          hits: [grayCompany("临安烘焙食品有限公司")],
          notice: null,
        }),
        qualify: fakeQualify,
        recordArtifact: async (artifact) => {
          collected.push(artifact);
        },
      },
    });

    const row = result.companies[0]!;
    // 分数仍是公式算的 58，没有被模型的结论改写
    expect(row.score).toBe(58);
    expect(row.tier).toBe("workable");

    const qualification = collected.find((item) => item.kind === "qualification");
    const payload = qualification?.payload as {
      companies: Array<{ name: string; score: number; deepCheck?: { verdict: string; lookups: string[] } }>;
    };
    const target = payload.companies[0]!;
    expect(target.score).toBe(58);
    expect(target.deepCheck?.verdict).toBe("pursue");
    expect(target.deepCheck?.lookups).toContain("lookup_recruitment");
  });

  test("高分公司不深查（不为已经清楚的事花钱）", async () => {
    let called = 0;
    await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
        search: async () => ({
          source: "local" as const,
          total: 1,
          hits: [strongCompany("大厂食品有限公司")],
          notice: null,
        }),
        qualify: async () => {
          called += 1;
          return fakeQualify({ companyName: "x" });
        },
      },
    });
    expect(called).toBe(0);
  });

  test("最多只深查 MAX_DEEP_CHECK 家", async () => {
    const seen: string[] = [];
    await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
        search: async () => ({
          source: "local" as const,
          total: 3,
          hits: [
            grayCompany("甲公司有限公司"),
            grayCompany("乙公司有限公司"),
            grayCompany("丙公司有限公司"),
          ],
          notice: null,
        }),
        qualify: async ({ companyName }) => {
          seen.push(companyName);
          return fakeQualify({ companyName });
        },
      },
    });
    expect(seen).toHaveLength(MAX_DEEP_CHECK);
  });

  test("深查抛错时名单照出，只是没有深查结论", async () => {
    const collected: RawArtifact[] = [];
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
        search: async () => ({
          source: "local" as const,
          total: 1,
          hits: [grayCompany("临安烘焙食品有限公司")],
          notice: null,
        }),
        qualify: async () => {
          throw new Error("企查查 429");
        },
        recordArtifact: async (artifact) => {
          collected.push(artifact);
        },
      },
    });

    expect(result.companies).toHaveLength(1);
    const qualification = collected.find((item) => item.kind === "qualification");
    const payload = qualification?.payload as { companies: Array<{ deepCheck?: unknown }> };
    expect(payload.companies[0]!.deepCheck).toBeUndefined();
  });

  test("深查返回 null（模型没给可用结论）时当作没结论", async () => {
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
        search: async () => ({
          source: "local" as const,
          total: 1,
          hits: [grayCompany("临安烘焙食品有限公司")],
          notice: null,
        }),
        qualify: async () => null,
      },
    });
    expect(result.companies).toHaveLength(1);
    expect(result.companies[0]!.score).toBe(58);
  });

  test("显式传 qualify: null 时永不深查", async () => {
    const collected: RawArtifact[] = [];
    await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
        search: async () => ({
          source: "local" as const,
          total: 1,
          hits: [grayCompany("临安烘焙食品有限公司")],
          notice: null,
        }),
        qualify: null,
        recordArtifact: async (artifact) => {
          collected.push(artifact);
        },
      },
    });
    const qualification = collected.find((item) => item.kind === "qualification");
    const payload = qualification?.payload as { companies: Array<{ deepCheck?: unknown }> };
    expect(payload.companies[0]!.deepCheck).toBeUndefined();
  });
});
