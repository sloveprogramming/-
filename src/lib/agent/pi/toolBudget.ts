import "server-only";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * 工具调用上限扩展。
 *
 * ## 为什么需要它
 *
 * Pi **没有原生的步数/轮数限制**（实测：构造参数里传 maxSteps 完全无效，
 * 一次调研跑了 13 步、1579 个输出 token）。这意味着成本不受控——同一个任务
 * 在不同模型下可能是 3 步，也可能是 20 步。
 *
 * ## 实现方式
 *
 * Pi 的扩展可以监听 `tool_call` 事件，返回 `{ block: true, terminate: true }`
 * 就能拦下这次调用并结束本轮。这是唯一能真正控制查询次数的机制。
 *
 * 为什么不数「助手消息」：一轮里模型可能并发调多个工具，数消息会漏；
 * `tool_call` hook 精确到每一次调用。
 *
 * ## 为什么拦工具而不是拦模型调用
 *
 * 拦模型调用等于杀掉整轮，拿不到任何产出；拦工具调用则是**告诉模型
 * "预算用完了，用手上的信息给结论"**——它通常会照做，而且能说明哪些没查到。
 * 这比硬中断有用得多。
 */

export type ToolCallBudget = {
  max: number;
  /** 已用次数。调用方在结算时读取。 */
  used: () => number;
  /** 是否发生过截断。 */
  truncated: () => boolean;
};

/**
 * 创建「工具调用预算」扩展。
 *
 * @param max 最多允许几次工具调用
 * @param onTruncate 被截断时的回调（用于把 stopReason 标成 max_steps）
 */
export function createToolBudgetExtension(
  max: number,
  onTruncate?: () => void,
): { extension: InlineExtension; budget: ToolCallBudget } {
  let used = 0;
  let truncated = false;

  const extension: InlineExtension = {
    name: "agent-sdr-tool-budget",
    factory: (pi) => {
      pi.on("tool_call", () => {
        if (used >= max) {
          if (!truncated) {
            truncated = true;
            onTruncate?.();
          }
          return {
            block: true,
            // terminate 让 agent 在当前工具批次结束后停止，不再继续循环。
            terminate: true,
            reason:
              `本次任务最多调用 ${max} 次工具。你已经查了 ${used} 次，` +
              `请基于已有信息给出结论，并明确说明哪些内容没查到。不要猜测。`,
          };
        }
        used += 1;
        return undefined;
      });
    },
  };

  return {
    extension,
    budget: {
      max,
      used: () => used,
      truncated: () => truncated,
    },
  };
}
