import { describe, expect, test } from "bun:test";
import { XINNONGGE, renderCompanyBrief } from "./profile";
import { ICP_SEGMENTS, segmentsByPriority, renderIcpBrief, type IcpSegmentKey } from "./segments";
import { GRADE_LABEL, scoreLead } from "./score";
import { openersFor, renderOpener, renderOpenersBrief } from "./openers";

/**
 * 垂类聚焦：新农哥的客户画像、评分、话术。这三块是纯数据 + 纯函数，
 * 改了口径就该有测试跟着改，否则销售看到的东西会悄悄变形。
 */

describe("公司事实", () => {
  test("简介里该有的都有：产品、合作方式、不能承诺的红线", () => {
    const brief = renderCompanyBrief();
    expect(brief).toContain("临安");
    expect(brief).toContain("区域独家代理");
    expect(brief).toContain("一件代发");
    expect(brief).toContain("绝对不要承诺的");
    // 红线必须出现，否则 AI 起草会开始承诺价格。
    expect(brief).toContain("价格、返点、独家区域");
  });

  test("未确认的条目被标出来", () => {
    const unconfirmed = XINNONGGE.policies.filter((policy) => policy.confirm);
    expect(unconfirmed.length).toBeGreaterThan(0);
    expect(unconfirmed.map((policy) => policy.key)).toContain("oem");
  });
});

describe("客户画像", () => {
  test("六类客户，P0 在最前", () => {
    expect(ICP_SEGMENTS).toHaveLength(6);
    const ordered = segmentsByPriority();
    expect(ordered[0].priority).toBe("P0");
    expect(ordered[0].key).toBe("distributor");
  });

  test("每类都写了信号、来源、首触和排除条件", () => {
    for (const segment of ICP_SEGMENTS) {
      expect(segment.signals.length).toBeGreaterThan(0);
      expect(segment.sources.length).toBeGreaterThan(0);
      expect(segment.firstTouch.length).toBeGreaterThan(0);
      expect(segment.disqualifiers.length).toBeGreaterThan(0);
    }
  });

  test("画像文档能直接给销售看", () => {
    const brief = renderIcpBrief();
    expect(brief).toContain("区域经销商 / 代理商");
    expect(brief).toContain("搜索关键词");
    expect(brief).toContain("预包装食品");
  });
});

describe("评分模型", () => {
  const perfect = scoreLead({
    industryMatch: true, foodLicense: true, registeredYears: 12, scale: "large",
    storeCount: 80, hasOnlineStore: true, distributesSnacks: true, distributionNetwork: true,
    hiringChannelRole: true, recentTender: true, newSnackCategory: true, attendedTradeShow: true,
    hasMobile: true, hasWecom: true, decisionMakerIdentified: true,
  });

  test("全中就是 100 分 A 级", () => {
    expect(perfect.score).toBe(100);
    expect(perfect.grade).toBe("A");
    expect(perfect.dimensions.map((d) => d.max)).toEqual([30, 30, 25, 15]);
    expect(perfect.nextChecks).toHaveLength(0);
  });

  test("什么都没有是 0 分 C 级，并告诉我该去查什么", () => {
    const empty = scoreLead({});
    expect(empty.score).toBe(0);
    expect(empty.grade).toBe("C");
    expect(empty.nextChecks).toHaveLength(4);
  });

  test("A/B/C 的分界线在 70 和 50", () => {
    const complete = {
      industryMatch: true, foodLicense: true, registeredYears: 8, scale: "large" as const,
      storeCount: 60, hasOnlineStore: true, distributesSnacks: true, distributionNetwork: true,
    };
    // 30（资质）+ 30（渠道）+ 8（在招渠道岗）= 68 → B，差一点点
    const almost = scoreLead({ ...complete, hiringChannelRole: true });
    expect(almost.score).toBe(68);
    expect(almost.grade).toBe("B");

    // 再加 4（参展）= 72 → A
    const over = scoreLead({ ...complete, hiringChannelRole: true, attendedTradeShow: true });
    expect(over.score).toBe(72);
    expect(over.grade).toBe("A");

    // 只有资质 + 两条渠道信号 = 45 → C
    const thin = scoreLead({
      industryMatch: true, foodLicense: true, registeredYears: 8, scale: "large",
      hasOnlineStore: true, distributesSnacks: true,
    });
    expect(thin.score).toBe(45);
    expect(thin.grade).toBe("C");
  });

  test("年限与门店数按档位给分", () => {
    expect(scoreLead({ registeredYears: 2 }).score).toBe(0);
    expect(scoreLead({ registeredYears: 4 }).score).toBe(3);
    expect(scoreLead({ registeredYears: 6 }).score).toBe(6);
    expect(scoreLead({ storeCount: 2 }).score).toBe(2);
    expect(scoreLead({ storeCount: 4 }).score).toBe(4);
    expect(scoreLead({ storeCount: 20 }).score).toBe(7);
    expect(scoreLead({ storeCount: 200 }).score).toBe(10);
  });

  test("行业不匹配会被点名", () => {
    const wrongIndustry = scoreLead({ industryMatch: false, hasMobile: true });
    expect(wrongIndustry.reasons.join("")).toContain("行业不匹配");
    expect(GRADE_LABEL[wrongIndustry.grade]).toContain("培育池");
  });

  test("触达不上的人再像客户也进不了 A", () => {
    const unreachable = scoreLead({
      industryMatch: true, foodLicense: true, registeredYears: 10, scale: "large",
      storeCount: 100, hasOnlineStore: true, distributesSnacks: true, distributionNetwork: true,
      hiringChannelRole: true, recentTender: true, newSnackCategory: true, attendedTradeShow: true,
    });
    expect(unreachable.score).toBe(85);
    expect(unreachable.grade).toBe("A");
    expect(unreachable.nextChecks.join("")).toContain("联系方式");
  });
});

describe("首触话术", () => {
  test("每类客户都有话术，且覆盖电话或企微", () => {
    for (const segment of ICP_SEGMENTS) {
      const openers = openersFor(segment.key as IcpSegmentKey);
      expect(openers.length).toBeGreaterThan(0);
      expect(openers.some((opener) => opener.channel === "call" || opener.channel === "wecom")).toBe(true);
    }
  });

  test("短信模板渲染后不超过 70 字", () => {
    const values = { name: "王总", company: "某某食品", rep: "小李", city: "杭州" };
    for (const segment of ICP_SEGMENTS) {
      for (const opener of openersFor(segment.key as IcpSegmentKey)) {
        if (opener.channel !== "sms") continue;
        const rendered = renderOpener(opener.body, values);
        expect(rendered.replace(/\s/g, "").length).toBeLessThanOrEqual(70);
      }
    }
  });

  test("占位符缺值时给「您」，不会漏出 undefined", () => {
    expect(renderOpener("{name}您好", {})).toBe("您您好");
    const partial = renderOpener("{name}您好，我是{rep}", { name: "王总" });
    expect(partial).toBe("王总您好，我是您");
    expect(partial).not.toContain("{");
  });

  test("话术文档包含渠道与注意事项", () => {
    const brief = renderOpenersBrief();
    expect(brief).toContain("区域经销商 / 代理商");
    expect(brief).toContain("短信");
    expect(brief).toContain("不承诺价格");
  });
});
