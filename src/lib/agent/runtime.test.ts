import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentLoop, type ChatRequest, type ChatResponse, type AgentStepEvent } from "./runtime";
import { ToolRegistry } from "./tools";

/**
 * Agent 主循环。用一个假的模型替代真实调用，把「它会不会自己查资料」
 * 和「它会不会失控」两件事都测到。
 *
 * 最有价值的三条：撞轮数上限必须停、destructive 工具必须被拒、工具报错
 * 不能让整次执行失败（回灌给模型让它换查法）。
 */

const context = { organizationId: "00000000-0000-4000-8000-000000000001", subject: { type: "person", id: null } };

function registryWith(record: string[] = []) {
  return new ToolRegistry()
    .register({
      name: "lookup_customer",
      description: "查客户",
      schema: z.object({ q: z.string() }),
      risk: "read",
      execute: async ({ q }) => {
        record.push(q);
        return { name: "临安坚果炒货", q };
      },
    })
    .register({
      name: "delete_lead",
      description: "删线索",
      schema: z.object({ id: z.string() }),
      risk: "destructive",
      execute: async () => ({ deleted: true }),
    });
}

/** 依次返回预设响应的假模型。 */
function fakeModel(responses: ChatResponse[]): (request: ChatRequest) => Promise<ChatResponse> {
  let index = 0;
  return async () => responses[Math.min(index++, responses.length - 1)];
}

const toolCall = (name: string, args: Record<string, unknown>, id = "call_1"): ChatResponse => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

const finalAnswer = (text: string): ChatResponse => ({
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 50, completion_tokens: 30 },
});

describe("Agent 循环", () => {
  test("先调工具，再给答案", async () => {
    const calls: string[] = [];
    const events: AgentStepEvent[] = [];
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "你是拓客助手",
      userPrompt: "这个客户是谁？",
      tools: registryWith(calls),
      context,
      complete: fakeModel([toolCall("lookup_customer", { q: "临安" }), finalAnswer("他是临安的坚果经销商")]),
      onEvent: (event) => events.push(event),
    });

    expect(result.stopReason).toBe("final_answer");
    expect(result.text).toBe("他是临安的坚果经销商");
    expect(result.steps).toBe(2);
    expect(calls).toEqual(["临安"]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].ok).toBe(true);
    // token 会累加
    expect(result.usage.inputTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(50);
    // 事件里有 llm_call 与 tool_call
    expect(events.filter((e) => e.type === "llm_call")).toHaveLength(2);
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(1);
  });

  test("撞到轮数上限就停，不会无限查下去", async () => {
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "s",
      userPrompt: "u",
      tools: registryWith(),
      context,
      maxSteps: 3,
      complete: fakeModel([toolCall("lookup_customer", { q: "a" }), toolCall("lookup_customer", { q: "b" }), toolCall("lookup_customer", { q: "c" })]),
    });
    expect(result.stopReason).toBe("max_steps");
    expect(result.steps).toBe(3);
    expect(result.toolCalls).toHaveLength(3);
  });

  test("destructive 工具被拒绝，不执行", async () => {
    let deleted = false;
    const registry = new ToolRegistry().register({
      name: "delete_lead",
      description: "删线索",
      schema: z.object({ id: z.string() }),
      risk: "destructive",
      execute: async () => { deleted = true; return { deleted: true }; },
    });
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "s",
      userPrompt: "u",
      tools: registry,
      context,
      complete: fakeModel([toolCall("delete_lead", { id: "1" }), finalAnswer("需要人工审批")]),
    });
    expect(deleted).toBe(false);
    expect(result.toolCalls[0].ok).toBe(false);
    expect(result.stopReason).toBe("final_answer");
  });

  test("模型编出不存在的工具时给出可用清单，不崩溃", async () => {
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "s",
      userPrompt: "u",
      tools: registryWith(),
      context,
      complete: fakeModel([toolCall("nonexistent_tool", {}), finalAnswer("好的")]),
    });
    expect(result.stopReason).toBe("final_answer");
    expect(result.toolCalls).toHaveLength(0);
  });

  test("工具抛错不中断整次执行，错误回灌给模型", async () => {
    const registry = new ToolRegistry().register({
      name: "broken",
      description: "会失败的工具",
      schema: z.object({}),
      risk: "read",
      execute: async () => { throw new Error("数据库连不上"); },
    });
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "s",
      userPrompt: "u",
      tools: registry,
      context,
      complete: fakeModel([toolCall("broken", {}), finalAnswer("换个方式查")]),
    });
    expect(result.stopReason).toBe("final_answer");
    expect(result.toolCalls[0].ok).toBe(false);
    expect(result.text).toBe("换个方式查");
  });

  test("参数不合 schema 时不执行工具，把问题回给模型", async () => {
    let ran = false;
    const registry = new ToolRegistry().register({
      name: "needs_q",
      description: "需要 q",
      schema: z.object({ q: z.string() }),
      risk: "read",
      execute: async () => { ran = true; return {}; },
    });
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "s",
      userPrompt: "u",
      tools: registry,
      context,
      complete: fakeModel([toolCall("needs_q", { wrong: 1 }), finalAnswer("参数错了")]),
    });
    expect(ran).toBe(false);
    expect(result.toolCalls[0].ok).toBe(false);
  });

  test("模型连续报错时返回 model_error 而不是抛异常", async () => {
    const result = await runAgentLoop({
      client: {} as never,
      model: "test/model",
      systemPrompt: "s",
      userPrompt: "u",
      tools: registryWith(),
      context,
      complete: async () => { throw new Error("网关 500"); },
    });
    expect(result.stopReason).toBe("model_error");
    expect(result.text).toBe("");
  });
});
