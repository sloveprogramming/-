import { describe, expect, test } from "bun:test";
import { aggregateSearchTerms } from "./history";
import { ToolRegistry } from "../tools";
import { registerProspectingTools } from "./prospecting";
import { registerHistoryTools } from "./history";

/**
 * 搜索词历史。
 *
 * 聚合逻辑是最容易写错的地方：补搜的词要算进去、出错不能算成"这词不行"、
 * 脏数据不能把整条链路带崩。
 */

function payload(terms: Array<{ term: string; hits: number; error?: string }>, replanTerms?: string[]) {
  return {
    terms,
    total: 0,
    companies: [],
    ...(replanTerms ? { replan: { triggered: true, newTerms: replanTerms, reasoning: "", addedCompanies: 0 } } : {}),
  };
}

describe("聚合搜索词", () => {
  test("同一个词跨多次搜索会被累加", () => {
    const { stats, scanned } = aggregateSearchTerms([
      payload([{ term: "烘焙食品", hits: 3 }]),
      payload([{ term: "烘焙食品", hits: 5 }]),
    ]);
    expect(scanned).toBe(2);
    const item = stats.find((row) => row.term === "烘焙食品");
    expect(item?.runs).toBe(2);
    expect(item?.hitRuns).toBe(2);
    expect(item?.totalHits).toBe(8);
  });

  test("命中 0 的词保留下来（这才是最该记住的信息）", () => {
    const { stats } = aggregateSearchTerms([
      payload([
        { term: "面包丝", hits: 0 },
        { term: "烘焙食品", hits: 2 },
      ]),
    ]);
    const dead = stats.find((row) => row.term === "面包丝");
    expect(dead?.totalHits).toBe(0);
    expect(dead?.hitRuns).toBe(0);
  });

  test("按累计命中降序，好词排前面", () => {
    const { stats } = aggregateSearchTerms([
      payload([
        { term: "面包丝", hits: 0 },
        { term: "烘焙食品", hits: 9 },
        { term: "速冻食品", hits: 4 },
      ]),
    ]);
    expect(stats.map((row) => row.term)).toEqual(["烘焙食品", "速冻食品", "面包丝"]);
  });

  test("补搜的词也被记住（它们同样回答「这词行不行」）", () => {
    const { stats } = aggregateSearchTerms([
      payload([{ term: "面包丝", hits: 0 }], ["食品批发"]),
    ]);
    expect(stats.some((row) => row.term === "食品批发")).toBe(true);
  });

  test("补搜命中后与普通词合并成一条", () => {
    const { stats } = aggregateSearchTerms([
      payload([{ term: "食品批发", hits: 2 }], ["食品批发"]),
    ]);
    const merged = stats.filter((row) => row.term === "食品批发");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.totalHits).toBe(2);
  });

  test("出错记为异常来源，但不算命中（限流不该被当成「这词不行」）", () => {
    const { stats } = aggregateSearchTerms([
      payload([{ term: "烘焙食品", hits: 0, error: "企查查限流" }]),
    ]);
    const item = stats.find((row) => row.term === "烘焙食品");
    expect(item?.sources).toContain("error");
    expect(item?.hitRuns).toBe(0);
  });

  test("只看指定词时其余不返回", () => {
    const { stats } = aggregateSearchTerms(
      [payload([{ term: "烘焙食品", hits: 3 }, { term: "速冻食品", hits: 1 }])],
      { filterTerms: ["速冻食品"] },
    );
    expect(stats.map((row) => row.term)).toEqual(["速冻食品"]);
  });

  test("过滤时大小写不敏感", () => {
    const { stats } = aggregateSearchTerms(
      [payload([{ term: "Sales", hits: 2 }])],
      { filterTerms: ["sales"] },
    );
    expect(stats).toHaveLength(1);
  });

  test("限制返回条数", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ term: `词${i}`, hits: i }));
    const { stats } = aggregateSearchTerms([payload(many)], { limit: 5 });
    expect(stats).toHaveLength(5);
  });

  test("脏数据不崩：null、缺字段、类型不对都跳过", () => {
    const { stats, scanned } = aggregateSearchTerms([
      null,
      undefined,
      "不是对象",
      {},
      { terms: "不是数组" },
      { terms: [{ term: 123, hits: "abc" }] },
      { terms: [{ term: "烘焙食品", hits: "3" }] },
    ]);
    // scanned 数的是"有 terms 数组的产物"：后两条都算，前五条不算。
    expect(scanned).toBe(2);
    // 只有最后一条是有效数据，hits 转成数字 3
    expect(stats.find((row) => row.term === "烘焙食品")?.totalHits).toBe(3);
  });

  test("空历史返回空统计，不报错", () => {
    expect(aggregateSearchTerms([])).toEqual({ stats: [], scanned: 0 });
  });
});

describe("工具注册", () => {
  test("重规划时会同时拿到探测与历史两个工具", () => {
    const registry = registerHistoryTools(registerProspectingTools(new ToolRegistry()));
    expect(registry.names()).toContain("probe_search");
    expect(registry.names()).toContain("search_history");
  });

  test("历史工具是只读的", () => {
    const registry = registerHistoryTools(new ToolRegistry());
    expect(registry.get("search_history")?.risk).toBe("read");
  });
});
