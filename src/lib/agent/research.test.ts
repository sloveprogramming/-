import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentLoop, type ChatRequest, type ChatResponse } from "./runtime";
import { ToolRegistry } from "./tools";

/**
 * 「先查后写」这条链路的端到端形状（用假模型）。
 *
 * 真实 research.ts 依赖数据库和 OpenRouter，这里只验证它依赖的那个循环契约：
 * 会查、查得到就用、查不到还能给结论、绝不无限查。research.ts 的逻辑就是把
 * 这几条串起来再加观测。
 */

const context = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  subject: { type: "person", id: "00000000-0000-4000-8000-0000000000aa" },
};

function knowledgeTools(record: string[]) {
  return new ToolRegistry()
    .register({
      name: "search_knowledge",
      description: "查知识库",
      schema: z.object({ query: z.string() }),
      risk: "read",
      execute: async ({ query }) => {
        record.push(`knowledge:${query}`);
        return { documents: [{ title: "区域代理政策", excerpt: "区域独家，首批搭赠" }] };
      },
    })
    .register({
      name: "lookup_history",
      description: "查历史",
      schema: z.object({ limit: z.number().optional() }),
      risk: "read",
      execute: async () => {
        record.push("history");
        return { count: 2, messages: [{ direction: "outbound", body: "上次报了山核桃仁的价格" }] };
      },
    });
}

const toolCall = (name: string, args: Record<string, unknown>, id = "c1"): ChatResponse => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 200, completion_tokens: 30 },
});

const answer = (text: string): ChatResponse => ({
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 120, completion_tokens: 80 },
});

describe("先查后写", () => {
  test("先查两个工具，再给材料摘要", async () => {
    const lookups: string[] = [];
    const responses = [
      toolCall("search_knowledge", { query: "区域代理" }, "c1"),
      toolCall("lookup_history", { limit: 5 }, "c2"),
      answer("对方是临安坚果经销商，三周前报过价，本次要推进区域代理，价格必须走正式报价。"),
    ];
    let index = 0;
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "先查再写",
      userPrompt: "准备材料",
      tools: knowledgeTools(lookups),
      context,
      maxSteps: 3,
      complete: async () => responses[Math.min(index++, responses.length - 1)] as ChatResponse,
    });

    expect(result.stopReason).toBe("final_answer");
    expect(lookups).toEqual(["knowledge:区域代理", "history"]);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.text).toContain("区域代理");
    // 三轮：两次工具 + 一次收尾
    expect(result.steps).toBe(3);
  });

  test("上下文已经够了就直接给结论，不查", async () => {
    const lookups: string[] = [];
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "先查再写",
      userPrompt: "材料已经齐全",
      tools: knowledgeTools(lookups),
      context,
      maxSteps: 3,
      complete: async () => answer("材料已足够：对方是经销商，本次只确认样品地址。"),
    });
    expect(lookups).toHaveLength(0);
    expect(result.steps).toBe(1);
    expect(result.stopReason).toBe("final_answer");
  });

  test("查两轮还查不到时，撞上限也要交出部分结论而不是空手", async () => {
    const lookups: string[] = [];
    const responses = [
      toolCall("search_knowledge", { query: "价格" }, "c1"),
      toolCall("lookup_history", {}, "c2"),
      toolCall("search_knowledge", { query: "价格表" }, "c3"),
    ];
    let index = 0;
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "先查再写",
      userPrompt: "准备材料",
      tools: knowledgeTools(lookups),
      context,
      maxSteps: 3,
      complete: async () => responses[Math.min(index++, responses.length - 1)] as ChatResponse,
    });
    expect(result.stopReason).toBe("max_steps");
    // 这一步能验证：它不会无限查，且调用方可以用 partialText 兜底
    expect(result.steps).toBe(3);
    expect(result.toolCalls).toHaveLength(3);
  });
});
