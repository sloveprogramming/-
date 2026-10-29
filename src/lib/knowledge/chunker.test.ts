import { describe, expect, test } from "bun:test";
import { chunkDocument, splitSentences } from "./chunker";
import { fuseRrf } from "./rrf";

/**
 * 切分与融合：两个纯逻辑模块，也是最容易"看起来对、实际错"的地方。
 *
 * 切分的错误表现为「检索命中了，但给的片段不完整」——很难在功能测试里发现，
 * 只有在真实提问时才暴露。RRF 的错误表现为「排序看起来合理但完全没按预期」，
 * 所以公式必须钉住。
 */

describe("中文切分", () => {
  const content = [
    "## 新农哥是谁",
    "杭州新农哥食品科技有限公司，2006 年成立于浙江杭州临安。",
    "",
    "## 产品线",
    "山核桃、每日坚果、风味坚果、板栗、礼盒。每类都有独立的生产线与质检流程。",
    "",
    "## 合作方式",
    "区域独家、一件代发、批发供货、OEM 定制。OEM 需要确认包装与起订量。",
  ].join("\n");

  test("按段落优先切分，不破坏句子", () => {
    const chunks = chunkDocument("v1", content, { maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(0);
    // 每个块都不应该以半句话开头（说明没被腰斩）
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(200);
      expect(chunk.text).not.toMatch(/^\s*[，。、；]/);
    }
  });

  test("块序号连续，key 稳定", () => {
    const chunks = chunkDocument("doc-v1", content);
    chunks.forEach((chunk, index) => {
      expect(chunk.index).toBe(index);
      expect(chunk.key).toBe(`doc-v1:${index}`);
    });
  });

  test("同样的内容与版本号，切分结果完全一致", () => {
    const a = chunkDocument("v1", content);
    const b = chunkDocument("v1", content);
    expect(a.map((chunk) => chunk.text)).toEqual(b.map((chunk) => chunk.text));
  });

  test("空内容返回空数组，不产生空块", () => {
    expect(chunkDocument("v1", "")).toEqual([]);
    expect(chunkDocument("v1", "   \n\n  ")).toEqual([]);
  });

  test("超长无标点内容按长度硬切，不会丢内容", () => {
    const long = "字".repeat(1500);
    const chunks = chunkDocument("v1", long, { maxChars: 500 });
    const total = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    // 允许重叠导致的多余，但不能少于原文
    expect(total).toBeGreaterThanOrEqual(1500);
    expect(chunks.every((chunk) => chunk.text.length <= 500 + 80)).toBe(true);
  });
});

describe("分句", () => {
  test("按中文标点切，标点保留", () => {
    const sentences = splitSentences("第一句。第二句！第三句？");
    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toBe("第一句。");
    expect(sentences[1]).toBe("第二句！");
  });

  test("无标点时整段返回", () => {
    expect(splitSentences("没有标点的一句话")).toEqual(["没有标点的一句话"]);
  });
});

describe("RRF 融合", () => {
  const doc = (id: string) => ({ id });

  test("两路都命中的排最前（证据更强）", () => {
    const fused = fuseRrf(
      [
        { source: "bm25", items: [doc("a"), doc("b")] },
        { source: "vector", items: [doc("b"), doc("c")] },
      ],
      { key: (item) => item.id },
    );
    // b 在两路里都有，分数最高
    expect(fused[0].item.id).toBe("b");
    expect(fused[0].sources).toEqual(["bm25", "vector"]);
  });

  test("分数按 1/(k+rank) 计算，k 默认 60", () => {
    const fused = fuseRrf([{ source: "x", items: [doc("a")] }], { key: (item) => item.id });
    expect(fused[0].score).toBeCloseTo(1 / 61, 6);
  });

  test("同一路内名次越靠前分数越高", () => {
    const fused = fuseRrf([{ source: "x", items: [doc("a"), doc("b")] }], { key: (item) => item.id });
    expect(fused[0].item.id).toBe("a");
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  test("两路结果完全不重叠时都能保留", () => {
    const fused = fuseRrf(
      [
        { source: "bm25", items: [doc("a")] },
        { source: "vector", items: [doc("b")] },
      ],
      { key: (item) => item.id },
    );
    expect(fused.map((entry) => entry.item.id).sort()).toEqual(["a", "b"]);
  });

  test("limit 生效", () => {
    const items = [doc("a"), doc("b"), doc("c")];
    const fused = fuseRrf([{ source: "x", items }], { key: (item) => item.id, limit: 2 });
    expect(fused).toHaveLength(2);
  });

  test("空输入返回空数组", () => {
    expect(fuseRrf([], { key: (item: { id: string }) => item.id })).toEqual([]);
  });
});
