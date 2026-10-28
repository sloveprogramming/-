import { describe, expect, test } from "bun:test";
import { buildCallScript, renderCallScriptText } from "./callScript";
import { matchDictionary, fallbackIntent, type ProductIntent } from "./productIntent";

/**
 * 电话话术：结构、占位符、以及"不同客户类型开场不同"。
 *
 * 话术是最容易被写成"念起来像机器"的地方，所以测试重点不在措辞好不好，
 * 而在几条硬规则：四段齐全、占位符不漏、客户类型影响开场、免责红线在内。
 */

const breadIntent: ProductIntent = matchDictionary("面包丝")!;

describe("通话结构", () => {
  test("四段齐全，且总时长在人能接受的范围内", () => {
    const script = buildCallScript({ product: breadIntent, companyName: "临安烘焙食品有限公司", repName: "小李" });
    expect(script.segments.map((s) => s.key)).toEqual(["opening", "probing", "value", "closing"]);
    const total = script.segments.reduce((sum, s) => sum + s.seconds, 0);
    // 90 秒左右是销售能记住的上限
    expect(total).toBe(90);
  });

  test("每段都有目标，不只是内容", () => {
    const script = buildCallScript({ product: breadIntent, companyName: "某公司" });
    for (const part of script.segments) {
      expect(part.goal.length).toBeGreaterThan(0);
    }
  });

  test("必须拿到的东西和不能说的话都列出来了", () => {
    const script = buildCallScript({ product: breadIntent, companyName: "某公司" });
    expect(script.mustGet.length).toBeGreaterThanOrEqual(3);
    expect(script.avoid.join("")).toContain("不要承诺");
  });
});

describe("客户类型决定开场", () => {
  test("经销商问「现在从哪进货」，连锁是「帮我转采购」", () => {
    const distributor = buildCallScript({ product: breadIntent, companyName: "A", segment: "distributor" });
    const chain = buildCallScript({ product: breadIntent, companyName: "A", segment: "retail_chain" });
    expect(distributor.segments[0].text).toContain("从哪家进的货");
    expect(chain.segments[0].text).toContain("采购");
    expect(distributor.segments[0].text).not.toBe(chain.segments[0].text);
  });

  test("客户类型不明时用中性开场，不假设对方是做什么的", () => {
    const script = buildCallScript({
      product: fallbackIntent("某冷门原料"),
      companyName: "某公司",
      segment: null,
    });
    expect(script.segments[0].text).toContain("是哪位在负责");
  });

  test("沿用产品意图里推断出的客户类型", () => {
    const script = buildCallScript({ product: breadIntent, companyName: "A" });
    // 面包丝词典里归到 distributor
    expect(script.segment).toBe("distributor");
  });
});

describe("渲染成文本", () => {
  test("占位符全部被替换，不漏 {xxx}", () => {
    const script = buildCallScript({ product: breadIntent, companyName: "临安烘焙食品有限公司" });
    const text = renderCallScriptText(script, { name: "王总", rep: "小李" });
    expect(text).not.toContain("{company}");
    expect(text).not.toContain("{name}");
    expect(text).not.toContain("{rep}");
    expect(text).toContain("临安烘焙食品有限公司");
    expect(text).toContain("王总");
  });

  test("没有联系人姓名时用「您」，不写 undefined", () => {
    const script = buildCallScript({ product: breadIntent, companyName: "某公司", contactName: null });
    const text = renderCallScriptText(script, {});
    expect(text).not.toContain("undefined");
    expect(text).toContain("您");
  });

  test("渲染结果包含产品名与所有段落标题", () => {
    const script = buildCallScript({ product: breadIntent, companyName: "某公司" });
    const text = renderCallScriptText(script, { name: "王总" });
    expect(text).toContain("面包丝");
    for (const label of ["开场", "探询", "价值", "收尾"]) {
      expect(text).toContain(label);
    }
  });
});
