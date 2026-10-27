import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry, toToolParameters } from "./tools";
import { excerptAround } from "./tools/customer";

/**
 * Agent 工具层：注册、白名单、参数 schema 生成。
 *
 * 这里测的是"边界"，不是"功能"——工具本身查库要靠集成测试，但下面这几件事
 * 一旦错了，Agent 会以很难排查的方式失败（模型永远调不对工具、或者能调不该
 * 调的），所以必须钉住。
 */

describe("ToolRegistry", () => {
  const makeTool = (name: string) => ({
    name,
    description: `${name} 的说明`,
    schema: z.object({ q: z.string() }),
    risk: "read" as const,
    execute: async () => ({ ok: true }),
  });

  test("登记后能按名字取到", () => {
    const registry = new ToolRegistry().register(makeTool("lookup_customer"));
    expect(registry.get("lookup_customer")?.name).toBe("lookup_customer");
    expect(registry.names()).toEqual(["lookup_customer"]);
  });

  test("重名直接报错，不静默覆盖", () => {
    const registry = new ToolRegistry().register(makeTool("a"));
    expect(() => registry.register(makeTool("a"))).toThrow(/重名/);
  });

  test("白名单只留登记过的名字", () => {
    const registry = new ToolRegistry().register(makeTool("a")).register(makeTool("b"));
    const subset = registry.subset(["a", "nope"]);
    expect(subset.names()).toEqual(["a"]);
    expect(registry.size()).toBe(2);
  });
});

describe("toToolParameters", () => {
  test("去掉 $schema 与 default（模型不该照抄默认值）", () => {
    const spec = toToolParameters(z.object({
      keyword: z.string(),
      limit: z.number().default(20),
      region: z.string().optional(),
    }));
    expect(spec.$schema).toBeUndefined();
    const properties = spec.properties as Record<string, Record<string, unknown>>;
    expect(properties.limit.default).toBeUndefined();
    expect(properties.limit.type).toBe("number");
    // optional 字段不进 required
    expect(spec.required).toEqual(["keyword"]);
  });

  test("枚举与数组能正确表达", () => {
    const spec = toToolParameters(z.object({
      kind: z.enum(["a", "b"]),
      tags: z.array(z.string()),
    }));
    const properties = spec.properties as Record<string, Record<string, unknown>>;
    expect(properties.kind.enum).toEqual(["a", "b"]);
    expect(properties.tags.type).toBe("array");
  });
});

describe("excerptAround", () => {
  test("命中位置附近取片段，并标出省略", () => {
    const text = "前缀".repeat(50) + "区域代理政策说明" + "后缀".repeat(50);
    const excerpt = excerptAround(text, "区域代理", 60);
    expect(excerpt).toContain("区域代理");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  test("找不到关键词时给开头一段，不返回空", () => {
    const excerpt = excerptAround("完全无关的内容", "坚果", 10);
    expect(excerpt.length).toBeGreaterThan(0);
    expect(excerpt.length).toBeLessThanOrEqual(10);
    expect(excerpt).toBe("完全无关的内容".slice(0, 10));
  });
});
