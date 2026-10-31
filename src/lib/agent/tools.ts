import "server-only";

import { z } from "zod";

/**
 * 工具定义：Agent 能主动调用的一件事。
 *
 * 与 Skill 的区别：Skill 是「做什么」（提示里的一段指令），Tool 是「怎么做」
 * （一段确定性代码）。模型只能决定调哪个工具、传什么参数，真正的执行永远
 * 是这里的 TypeScript 在跑——所以工具是可控的，模型的想象力不是。
 *
 * 三个设计点：
 *
 * 1. `risk` 分级是硬约束，不是提示词。read 直接执行；write 执行但记为"需审计"；
 *    destructive 在 Agent 循环里直接被拒绝，要求走人工审批。这把"模型幻觉调了
 *    删除接口"变成一个代码问题，而不是祈祷它别乱来。
 *
 * 2. `schema` 用 zod 校验模型给的参数。模型经常给出多一个字段、少一个必填、
 *    类型不对的 JSON——不校验就会出现 `undefined.includes()` 这种运行时崩溃。
 *
 * 3. `execute` 永远返回纯数据（可 JSON 序列化），由 Runtime 统一截断。
 *    工具自己不要拼接给模型看的自然语言说明，那是提示层的事。
 */

export type ToolRisk = "read" | "write" | "destructive";

export type ToolExecutionContext = {
  organizationId: string;
  /** 本次 Agent 执行关联的业务对象，工具可据此取上下文。 */
  subject: { type: string | null; id: string | null };
  signal?: AbortSignal;
};

export type ToolDefinition<S extends z.ZodType = z.ZodType> = {
  /** 模型看到的工具名：snake_case，全项目唯一。 */
  name: string;
  /** 模型看到的一句话说明。写清楚"什么时候该用"，比写"它做什么"更重要。 */
  description: string;
  schema: S;
  risk: ToolRisk;
  /** 单次执行的超时（毫秒）。默认 10 秒。 */
  timeoutMs?: number;
  execute: (input: z.infer<S>, context: ToolExecutionContext) => Promise<unknown>;
};

/** 给模型看的工具清单（OpenAI tools 格式）。 */
export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** 工具注册表。Agent 只允许调用这里登记过的工具。 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<S extends z.ZodType>(tool: ToolDefinition<S>): this {
    if (this.tools.has(tool.name)) throw new Error(`工具重名：${tool.name}`);
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toToolParameters(tool.schema),
      },
    }));
  }

  /** 按名字白名单取子集；未登记的名字忽略。 */
  subset(names: readonly string[]): ToolRegistry {
    const next = new ToolRegistry();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) next.tools.set(name, tool);
    }
    return next;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  size(): number {
    return this.tools.size;
  }
}

/**
 * zod → 工具参数 JSON Schema。
 *
 * zod v4 自带 `toJSONSchema`，比手写转换器可靠（它正确处理 optional / default /
 * union / nullable）。这里只做两件收尾：
 * - 去掉顶层 `$schema`：OpenAI 兼容接口不认这个键，部分网关会直接报错。
 * - 去掉 `default`：让模型自己判断，而不是照抄默认值（照抄会让 limit 永远是 20）。
 */
export function toToolParameters(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  const rest = { ...generated };
  delete rest.$schema;
  return stripDefaults(rest) as Record<string, unknown>;
}

function stripDefaults(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDefaults);
  if (!node || typeof node !== "object") return node;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "default") continue;
    output[key] = stripDefaults(value);
  }
  return output;
}
