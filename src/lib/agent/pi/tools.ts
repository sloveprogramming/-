import "server-only";

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition, ToolRegistry, ToolRisk } from "../tools";
import { toToolParameters } from "../tools";

/**
 * 把项目的工具（zod schema + 风险分级）适配成 Pi 的工具。
 *
 * Pi 的工具形状：
 *
 * ```ts
 * defineTool({
 *   name, label, description,
 *   parameters: JSON Schema,
 *   execute(toolCallId, args, signal) { return { content: [...], ... } }
 * })
 * ```
 *
 * ## 风险分级怎么保
 *
 * Pi **没有**工具风险分级这个概念。所以这层适配必须把风险控制补回去：
 *
 * - `read` / `write`：正常执行
 * - `destructive`：**在 execute 内部直接拒绝**，返回一句"需要人工审批"
 *
 * 这和自研 runtime 的做法一致——把"模型不能自己删数据"变成代码约束，
 * 而不是靠提示词祈祷。Pi 的 `noTools: true` 只关掉了它内置的 bash/edit/write，
 * 我们自己注册的工具仍然需要这层保护。
 *
 * ## 返回值形状
 *
 * Pi 期望 execute 返回 `{ content: [{ type: "text", text }], isError? }`。
 * 我们统一把结果 JSON 序列化成 text——模型看到的永远是结构化数据。
 */

/**
 * Pi 工具执行的返回值。
 *
 * Pi 要求 `details` 字段（给终端 UI 渲染用）。服务端场景用不上，但类型是
 * 必填的，所以传一个轻量摘要——它同时也能进模型上下文，算是有用。
 */
type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { ok: boolean; summary?: string };
  isError?: boolean;
};

/** 单个工具输出的最大字符数——和自研 runtime 保持一致（4000）。 */
const MAX_OUTPUT_CHARS = 4_000;

export type ToolBridgeContext = {
  organizationId: string;
  subject: { type: string | null; id: string | null };
};

/** 把一个项目工具转成 Pi 工具。 */
export function toPiTool(tool: ToolDefinition, context: ToolBridgeContext) {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: toToolParameters(tool.schema) as never,
    // Pi 会传 (toolCallId, args, signal, onUpdate, ctx)；只用前三。
    execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal): Promise<PiToolResult> => {
      // ---- 风险闸门：destructive 一律不执行 ----
      if (tool.risk === "destructive") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              refused: true,
              reason: "这个操作需要人工审批，Agent 不能直接执行。",
            }),
          }],
          details: { ok: false, summary: "已拒绝：需要人工审批" },
          isError: true,
        };
      }

      // ---- 参数校验（zod）：模型给的参数经常不合 schema ----
      const parsed = tool.schema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "参数不符合工具定义。",
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            }),
          }],
          details: { ok: false, summary: "参数不合 schema" },
          isError: true,
        };
      }

      try {
        const output = await tool.execute(parsed.data, {
          organizationId: context.organizationId,
          subject: context.subject,
          signal,
        });
        const text = truncate(JSON.stringify(output ?? null));
        return { content: [{ type: "text" as const, text }], details: { ok: true } };
      } catch (error) {
        // 工具失败不抛出去：回灌给模型，它通常能换个查法。
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[agent/pi] 工具 ${tool.name} 执行失败：`, message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          details: { ok: false, summary: message },
          isError: true,
        };
      }
    },
    // 渲染函数（终端 UI 用）在服务端场景不需要。
    renderCall: () => null as never,
    renderResult: () => null as never,
  });
}

/** 把整个注册表转成 Pi 工具数组。 */
export function toPiTools(registry: ToolRegistry, context: ToolBridgeContext) {
  return registry.names().map((name) => {
    const tool = registry.get(name);
    if (!tool) throw new Error(`工具 ${name} 不存在`);
    return toPiTool(tool, context);
  });
}

/** 风险等级的中文说明，给日志用。 */
export const RISK_LABEL: Record<ToolRisk, string> = {
  read: "只读",
  write: "写入",
  destructive: "危险（需人工审批）",
};

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（输出过长，已截断，共 ${text.length} 字符）`;
}
