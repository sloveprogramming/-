import "server-only";

import { z } from "zod";
import { searchCompanies } from "@/lib/qcc/provider";
import type { ToolRegistry } from "../tools";

/**
 * 拓客场景的只读工具：让 Agent 在重规划搜索词时能"先试再答"。
 *
 * ## 为什么要有这个工具，而不是让它直接给词
 *
 * 模型给搜索词的问题是它不知道哪个词在这家企业库里能命中——「面包丝」听起来
 * 很具体，实际命中 0 家；「烘焙食品」很泛，反而能搜到。不给它试的机会，它只能
 * 凭语感猜，而语感和企业命名习惯经常不匹配。
 *
 * 有了 `probe_search`，它可以说"我先试三个词，哪个有结果就用哪个"——这是真
 * 的在做决策，而不是在编词。
 *
 * ## 为什么只返回命中数，不返回公司
 *
 * 重规划阶段要的是"这个词行不行"，不是"有哪些公司"。返回公司列表会让上下文
 * 瞬间膨胀（一个词 20 家 × 5 个词），而它只需要一个数字。真正取公司留在
 * 搜索阶段做——**同一个数据源，两种信息粒度，各取所需**。
 *
 * 这也是成本控制：`limit: 1` 只取 1 条（够算 total），不拉整页。
 */
export function registerProspectingTools(registry: ToolRegistry): ToolRegistry {
  return registry.register({
    name: "probe_search",
    description:
      "用关键词搜一次企业库，只返回命中数量，不返回公司明细。用来试哪个词能搜到公司：命中 0 说明这个词在这家企业库里没有，要换词。",
    risk: "read",
    // 单次搜索可能慢（企查查要签名+网络），给 15 秒；外层还有整体超时兜着。
    timeoutMs: 15_000,
    schema: z.object({
      term: z
        .string()
        .min(1)
        .max(40)
        .describe("要试的搜索词，比如「烘焙食品」「速冻食品」。不要传产品名本身。"),
    }),
    execute: async ({ term }) => {
      const clean = term.trim();
      if (!clean) return { error: "搜索词为空" };
      try {
        const result = await searchCompanies(clean, { source: "auto", limit: 1 });
        return {
          term: clean,
          /** 命中多少家。0 表示这个词在这家企业库里搜不到东西。 */
          total: result.total,
          /** local = 搜自家库；qcc = 搜全国企业。两者命中量不可直接比较。 */
          source: result.source,
          notice: result.notice,
        };
      } catch (error) {
        // 工具失败不抛错，回灌给模型让它换个词——这与 tools.ts 的约定一致。
        return { term: clean, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
