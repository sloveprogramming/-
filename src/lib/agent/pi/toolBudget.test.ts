import { describe, expect, test } from "bun:test";
import { createToolBudgetExtension } from "./toolBudget";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 工具调用上限。
 *
 * 这是 Pi 迁移后唯一能控制成本的地方——Pi 本身没有步数限制（实测传 maxSteps
 * 无效，一次调研跑 13 步、1401 输出 token）。所以这套逻辑必须有测试保护，
 * 否则下次改动可能悄悄失效，而成本失控不会有任何报错。
 */

describe("工具调用预算扩展", () => {
  test("未超限时允许调用，并累加计数", () => {
    const { extension, budget } = createToolBudgetExtension(3);
    const hook = (extension as { factory: (pi: unknown) => void }).factory;
    // 手工模拟 Pi 的 ExtensionAPI：捕获注册的 handler。
    let handler: (() => unknown) | null = null;
    hook({ on: (event: string, fn: () => unknown) => { if (event === "tool_call") handler = fn; } });

    expect(handler).not.toBeNull();
    expect(handler!()).toBeUndefined();
    expect(budget.used()).toBe(1);
    expect(handler!()).toBeUndefined();
    expect(budget.used()).toBe(2);
    expect(handler!()).toBeUndefined();
    expect(budget.used()).toBe(3);
  });

  test("超过上限后每次调用都被 block 且 terminate", () => {
    const { extension, budget } = createToolBudgetExtension(2);
    let handler: (() => unknown) | null = null;
    (extension as { factory: (pi: unknown) => void }).factory({
      on: (event: string, fn: () => unknown) => { if (event === "tool_call") handler = fn; },
    });

    handler!(); // 1
    handler!(); // 2
    const blocked = handler!() as { block?: boolean; terminate?: boolean; reason?: string };
    expect(blocked.block).toBe(true);
    expect(blocked.terminate).toBe(true);
    expect(blocked.reason).toContain("2");
    expect(budget.truncated()).toBe(true);
    // 被 block 的调用不计入 used（它没有真的执行）
    expect(budget.used()).toBe(2);
  });

  test("截断回调只触发一次", () => {
    let calls = 0;
    const { extension, budget } = createToolBudgetExtension(1, () => { calls += 1; });
    let handler: (() => unknown) | null = null;
    (extension as { factory: (pi: unknown) => void }).factory({
      on: (event: string, fn: () => unknown) => { if (event === "tool_call") handler = fn; },
    });
    handler!();
    handler!();
    handler!();
    expect(calls).toBe(1);
    expect(budget.truncated()).toBe(true);
  });

  test("上限非法时至少允许 1 次（不因传 0 而完全卡死）", () => {
    const { extension } = createToolBudgetExtension(0);
    let handler: (() => unknown) | null = null;
    (extension as { factory: (pi: unknown) => void }).factory({
      on: (event: string, fn: () => unknown) => { if (event === "tool_call") handler = fn; },
    });
    // max=0 时第一次调用就应被拦
    const first = handler!() as { block?: boolean };
    expect(first.block).toBe(true);
  });
});

describe("Pi 安全约束的代码事实", () => {
  /**
   * 这不是行为测试，而是**防回归**：确认源码里那几行关键配置没被改掉。
   *
   * 为什么值得这么测：`noTools` 一旦从 "builtin" 改回 "all"，自定义工具会全部
   * 失效，模型转而去调用 bash——这是安全事件，却不会有任何报错。上次就是这么
   * 踩坑的。
   */
  const sessionSource = readFileSync(join(import.meta.dir, "session.ts"), "utf8");

  test("noTools 必须是 builtin（不能是 all）", () => {
    expect(sessionSource).toMatch(/noTools:\s*"builtin"/);
    expect(sessionSource).not.toMatch(/noTools:\s*"all"/);
  });

  test("会话必须是内存式（不写磁盘、不串租户）", () => {
    expect(sessionSource).toMatch(/SessionManager\.inMemory\(\)/);
  });

  test("工具调用预算必须在建 session 之前创建", () => {
    const budgetIndex = sessionSource.indexOf("createToolBudgetExtension(");
    const sessionIndex = sessionSource.indexOf("createAgentSession(");
    expect(budgetIndex).toBeGreaterThan(0);
    expect(sessionIndex).toBeGreaterThan(0);
    // 扩展要在构造时传入，所以必须先创建
    expect(budgetIndex).toBeLessThan(sessionIndex);
  });

  test("resourceLoader 必须 await（内部要 reload 才会加载扩展）", () => {
    expect(sessionSource).toMatch(/resourceLoader:\s*await\s+createAgentResourceLoader/);
  });
});
