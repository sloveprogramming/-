import { describe, expect, test } from "bun:test";
import {
  AGENT_ROLES,
  ARTIFACT_KINDS,
  ARTIFACT_SCHEMAS,
  KIND_LABEL,
  ROLE_ARTIFACT,
  ROLE_LABEL,
  isAgentRole,
  isArtifactKind,
  missingArtifacts,
  validateArtifact,
  type ArtifactKind,
  type RawArtifact,
} from "./artifacts";
import { runProspectPipeline } from "./pipeline";
import { matchDictionary } from "@/lib/icp/productIntent";
import type { CompanyHit } from "@/lib/qcc/types";

/**
 * artifact 契约 + 编排产物。
 *
 * 这些测试守的是"角色之间怎么通信"，不是业务逻辑。重点三件：
 * 1. 每种产物都有合法样例能过、有非法样例会被拒（契约不能形同虚设）
 * 2. 编排按流程顺序产出四段产物（顺序错了下游就拿到错的东西）
 * 3. 记录器出错不能影响业务（观测失败≠业务失败）
 */

const orgId = "00000000-0000-4000-8000-000000000001";
const traceId = "11111111-1111-4111-8111-111111111111";

/** 每种产物的一份最小合法样例。加了新 kind 必须在这里补一份。 */
const VALID: Record<ArtifactKind, RawArtifact> = {
  plan: {
    role: "planner",
    kind: "plan",
    payload: {
      query: "面包丝",
      category: "烘焙原料",
      segment: "distributor",
      buyerDescription: "烘焙厂、速冻食品厂",
      searchTerms: ["烘焙食品", "速冻食品"],
      excludeTerms: [],
      source: "dictionary",
      confidence: 1,
      uncertainties: [],
    },
  },
  sourcing: {
    role: "sourcer",
    kind: "sourcing",
    payload: {
      terms: [{ term: "烘焙食品", hits: 1 }],
      total: 1,
      companies: [
        { key: "k1", name: "临安烘焙食品有限公司", region: "浙江省 杭州市", industry: "烘焙食品", status: "存续", inLibrary: false },
      ],
    },
  },
  qualification: {
    role: "qualifier",
    kind: "qualification",
    payload: {
      companies: [
        {
          name: "临安烘焙食品有限公司",
          score: 80,
          tier: "priority",
          verdict: "值得优先联系",
          caveats: ["体量为推断"],
          dimensions: [
            { key: "capital", label: "注册资本", score: 25, max: 25, basis: "5000万元人民币", nature: "measured" },
          ],
        },
      ],
    },
  },
  contact: {
    role: "contact",
    kind: "contact",
    payload: { companies: [{ name: "临安烘焙食品有限公司", phones: ["0571-88880001"], reachable: true }] },
  },
  draft: {
    role: "composer",
    kind: "draft",
    payload: { channel: "wecom", stepLabel: "首触", body: "王总您好，我是新农哥华东区的小李。" },
  },
  review: {
    role: "reviewer",
    kind: "review",
    payload: { verdict: "pass", violations: [] },
  },
};

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

describe("产物契约", () => {
  test("每种 kind 都有合法样例且能通过校验", () => {
    for (const kind of ARTIFACT_KINDS) {
      const result = validateArtifact(VALID[kind]);
      expect(result.ok).toBe(true);
    }
  });

  test("每种 kind 都有自己的 schema（漏写会在这里炸）", () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(ARTIFACT_SCHEMAS[kind]).toBeTruthy();
    }
  });

  test("缺字段被拒，错误信息说人话", () => {
    const result = validateArtifact({
      role: "planner",
      kind: "plan",
      payload: { query: "面包丝", searchTerms: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("planner/plan");
    }
  });

  test("数值越界被拒：分数不能超过 100", () => {
    const bad = structuredClone(VALID.qualification) as RawArtifact;
    (bad.payload as { companies: Array<{ score: number }> }).companies[0]!.score = 120;
    const result = validateArtifact(bad);
    expect(result.ok).toBe(false);
  });

  test("枚举被守住：分档只能是三档之一", () => {
    const bad = structuredClone(VALID.qualification) as RawArtifact;
    (bad.payload as { companies: Array<{ tier: string }> }).companies[0]!.tier = "vip";
    expect(validateArtifact(bad).ok).toBe(false);
  });

  test("未知角色 / 未知种类都被拒", () => {
    expect(validateArtifact({ role: "hacker" as never, kind: "plan", payload: {} }).ok).toBe(false);
    expect(validateArtifact({ role: "planner", kind: "truth" as never, payload: {} }).ok).toBe(false);
  });

  test("规划产物不接受空搜索词——下游会搜不到任何东西", () => {
    const bad = structuredClone(VALID.plan) as RawArtifact;
    (bad.payload as { searchTerms: string[] }).searchTerms = [];
    expect(validateArtifact(bad).ok).toBe(false);
  });

  test("草稿正文不能为空", () => {
    const bad = structuredClone(VALID.draft) as RawArtifact;
    (bad.payload as { body: string }).body = "";
    expect(validateArtifact(bad).ok).toBe(false);
  });
});

describe("角色与标签", () => {
  test("每个角色都有中文名和默认产物", () => {
    for (const role of AGENT_ROLES) {
      expect(ROLE_LABEL[role]).toBeTruthy();
      expect(ROLE_ARTIFACT[role]).toBeTruthy();
    }
  });

  test("每个产物种类都有中文名", () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(KIND_LABEL[kind]).toBeTruthy();
    }
  });

  test("守卫函数认得出合法值、挡得住非法值", () => {
    expect(isAgentRole("qualifier")).toBe(true);
    expect(isAgentRole("Qualifier")).toBe(false);
    expect(isArtifactKind("review")).toBe(true);
    expect(isArtifactKind(undefined)).toBe(false);
  });

  test("缺哪些产物能一眼看出来", () => {
    expect(missingArtifacts(["plan", "sourcing"])).toEqual(["qualification", "contact", "draft", "review"]);
    expect(missingArtifacts([...ARTIFACT_KINDS])).toEqual([]);
  });
});

describe("编排产出", () => {
  test("按流程顺序产出四段产物，且每段都能通过校验", async () => {
    const collected: RawArtifact[] = [];
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      traceId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
        search: async (term) => ({
          source: "local" as const,
          total: 1,
          hits: [hit({ name: `${term}公司` })],
          notice: null,
        }),
        recordArtifact: async (artifact) => {
          collected.push(artifact);
        },
      },
    });

    expect(collected.map((item) => item.kind)).toEqual(["plan", "sourcing", "qualification", "contact"]);
    expect(collected.map((item) => item.role)).toEqual(["planner", "sourcer", "qualifier", "contact"]);
    for (const artifact of collected) {
      expect(validateArtifact(artifact).ok).toBe(true);
    }
    expect(result.traceId).toBe(traceId);
  });

  test("复用传入的 traceId；不传则自己生成一个", async () => {
    const deps = {
      interpret: async ({ query }: { query: string }) => matchDictionary(query)!,
      search: async () => ({ source: "local" as const, total: 0, hits: [], notice: null }),
    };
    const withTrace = await runProspectPipeline({ product: "面包丝", organizationId: orgId, traceId, deps });
    expect(withTrace.traceId).toBe(traceId);

    const generated = await runProspectPipeline({ product: "面包丝", organizationId: orgId, deps });
    expect(generated.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("一家都没搜到也要留下'搜空'这个结论", async () => {
    const collected: RawArtifact[] = [];
    await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
        search: async () => ({ source: "local" as const, total: 0, hits: [], notice: "没有结果" }),
        recordArtifact: async (artifact) => {
          collected.push(artifact);
        },
      },
    });
    expect(collected.map((item) => item.kind)).toEqual(["plan", "sourcing"]);
    const sourcing = collected[1]!.payload as { total: number };
    expect(sourcing.total).toBe(0);
  });

  test("记录器抛错不影响业务结果", async () => {
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
        search: async () => ({
          source: "local" as const,
          total: 1,
          hits: [hit({ name: "临安烘焙食品有限公司" })],
          notice: null,
        }),
        recordArtifact: async () => {
          throw new Error("数据库挂了");
        },
      },
    });
    expect(result.companies).toHaveLength(1);
    expect(result.stats.found).toBe(1);
  });

  test("不传记录器时不报错（测试与脚本的默认路径）", async () => {
    const result = await runProspectPipeline({
      product: "面包丝",
      organizationId: orgId,
      deps: {
        interpret: async ({ query }) => matchDictionary(query)!,
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
});
