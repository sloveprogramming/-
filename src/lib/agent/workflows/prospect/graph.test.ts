import { describe, expect, test } from "bun:test";
import { matchDictionary } from "@/lib/icp/productIntent";
import type { ProspectRuntime } from "./nodes";
import { buildProspectGraph } from "./graph";
import { routeAfterSourcing } from "./nodes";
import type { ProspectStateType } from "./state";

function runtime(overrides: Partial<ProspectRuntime> = {}): ProspectRuntime {
  return {
    product: "面包丝",
    organizationId: "00000000-0000-4000-8000-000000000001",
    traceId: "11111111-1111-4111-8111-111111111111",
    progress: () => {},
    interpret: async ({ query }) => matchDictionary(query)!,
    search: async () => ({ source: "local", total: 0, hits: [], notice: null }),
    replan: null,
    qualify: null,
    ...overrides,
  };
}

function state(overrides: Partial<ProspectStateType> = {}): ProspectStateType {
  return {
    product: "面包丝",
    organizationId: "org",
    traceId: "trace",
    intent: null,
    termHits: [],
    hits: [],
    replan: null,
    assessed: [],
    reachable: 0,
    priority: 0,
    error: null,
    trail: [],
    ...overrides,
  } as ProspectStateType;
}

describe("ProspectGraph 结构", () => {
  test("图里只有业务节点，没有全局 Supervisor", () => {
    const graph = buildProspectGraph(runtime());
    const nodes = Object.keys(graph.getGraph().nodes);
    for (const name of ["product_intent", "sourcing", "scoring", "contact", "finish"]) {
      expect(nodes).toContain(name);
    }
    expect(nodes).not.toContain("supervisor");
  });
});
describe("ProspectGraph 路由", () => {
  test("没有公司时跳过评分和联系方式，直接收尾", () => {
    expect(routeAfterSourcing(state())).toBe("finish");
  });

  test("有公司时进入合作评分", () => {
    expect(routeAfterSourcing(state({
      hits: [{
        key: "k1",
        name: "临安烘焙食品有限公司",
        creditCode: null,
        region: "浙江省 杭州市",
        industry: "烘焙食品",
        legalPerson: null,
        foundedAt: "2012-06-15",
        registeredCapital: "5000万元人民币",
        phones: [],
        scope: "烘焙食品生产与销售",
        status: "存续",
        inLibrary: false,
      }],
    }))).toBe("scoring");
  });

  test("上游出错时不再继续花钱调用 Agent", () => {
    expect(routeAfterSourcing(state({
      error: "产品画像缺失",
      hits: [{ key: "k1" } as never],
    }))).toBe("finish");
  });
});

