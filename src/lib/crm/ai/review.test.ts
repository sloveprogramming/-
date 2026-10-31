import { describe, expect, test } from "bun:test";
import { blockingViolations, reviewDraft, summarizeReview } from "./review";

/**
 * 草稿审校。
 *
 * 两类测试同等重要：
 * 1. **该拦的拦住**——报价、独家、账期、交期、认证结论，发出去就是事故
 * 2. **不该拦的别拦**——"方便发您一份报价单吗"是话术模板里的合规表达，
 *    误报一次，销售就不再信任这个提示，功能等于废掉
 */

function rules(text: string, channel: "email" | "wecom" | "sms" | "call" = "wecom") {
  return reviewDraft({ bodyText: text, channel }).violations.map((item) => item.rule);
}

describe("硬红线（block）", () => {
  test("报了具体金额", () => {
    const review = reviewDraft({ bodyText: "山核桃仁 120 元/箱，可以给您留着。", channel: "wecom" });
    expect(review.verdict).toBe("block");
    expect(review.violations.map((v) => v.rule)).toContain("price");
    expect(blockingViolations(review).length).toBeGreaterThan(0);
  });

  test("报价后面跟数字", () => {
    expect(rules("报价是 150，您看合适吗")).toContain("quote_number");
  });

  test("折扣与返点", () => {
    expect(rules("首批给您打 8 折，返点 5%")).toContain("discount");
  });

  test("账期与结算方式", () => {
    expect(rules("账期 60 天可以谈")).toContain("payment_terms");
    expect(rules("先货后款也行")).toContain("payment_terms");
  });

  test("承诺独家授权", () => {
    expect(rules("这个区域只给您做")).toContain("exclusive_grant");
    expect(rules("独家授权给您")).toContain("exclusive_grant");
  });

  test("承诺交期与产能", () => {
    expect(rules("下单后 3 天内发货")).toContain("lead_time");
    expect(rules("我们日产 20 吨")).toContain("lead_time");
  });

  test("编了认证或检测结论", () => {
    expect(rules("我们的产品零添加，符合国家标准")).toContain("certification_claim");
  });

  test("主题行也查", () => {
    const review = reviewDraft({
      bodyText: "王总您好，附上资料。",
      subject: "新农哥报价 120 元/箱",
      channel: "email",
    });
    expect(review.verdict).toBe("block");
    expect(review.violations[0]?.rule).toBe("price");
  });
});

describe("提醒（warn）", () => {
  test("提到独家政策但没承诺范围", () => {
    const review = reviewDraft({ bodyText: "我们有区域独家政策，细则发您。", channel: "wecom" });
    expect(review.verdict).toBe("pass");
    expect(review.violations.map((v) => v.rule)).toContain("exclusive_mention");
    expect(review.violations.every((v) => v.severity === "warn")).toBe(true);
  });

  test("说附检测报告是提醒，不是拦截", () => {
    const review = reviewDraft({ bodyText: "检测报告随报价单一并附上。", channel: "email" });
    expect(review.verdict).toBe("pass");
    expect(review.violations.map((v) => v.rule)).toContain("certification_mention");
  });

  test("绝对化措辞", () => {
    expect(rules("保证让您满意")).toContain("absolute_claim");
  });

  test("短信超 70 字会提醒（按条计费）", () => {
    const long = "王总您好".repeat(20);
    const review = reviewDraft({ bodyText: long, channel: "sms" });
    const sms = review.violations.find((v) => v.rule === "sms_length");
    expect(sms).toBeTruthy();
    expect(sms?.severity).toBe("warn");
    expect(sms?.label).toContain(String(long.length));
  });

  test("同一条短信刚好 70 字不提醒", () => {
    const exact = "好".repeat(70);
    expect(reviewDraft({ bodyText: exact, channel: "sms" }).violations.map((v) => v.rule)).not.toContain("sms_length");
  });

  test("微信长文本不套用短信长度规则", () => {
    const long = "好".repeat(120);
    expect(rules(long, "wecom")).not.toContain("sms_length");
  });
});

describe("不该误报的合规表达", () => {
  test("话术模板原句：方便发您一份产品报价单吗", () => {
    const review = reviewDraft({
      bodyText: "王总您好，我是新农哥华东区的小李。我们在临安自有工厂，主做山核桃仁、每日坚果，支持区域独家代理和一件代发，方便发您一份产品报价单吗？",
      channel: "wecom",
    });
    expect(blockingViolations(review)).toHaveLength(0);
  });

  test("公司简介里的注册信息不算报价", () => {
    const review = reviewDraft({
      bodyText: "公司成立于 2006 年，注册资本 5000 万元，工厂在临安。",
      channel: "wecom",
    });
    expect(blockingViolations(review)).toHaveLength(0);
  });

  test("规格描述「每箱 24 袋」不是价格", () => {
    expect(blockingViolations(reviewDraft({ bodyText: "每箱 24 袋，小包装适合端架。", channel: "wecom" }))).toHaveLength(0);
  });

  test("起订量不是价格", () => {
    expect(blockingViolations(reviewDraft({ bodyText: "起订量 200 箱，按箱起订。", channel: "wecom" }))).toHaveLength(0);
  });

  test("约时间不触发绝对化", () => {
    expect(blockingViolations(reviewDraft({ bodyText: "方便的话下周约 15 分钟电话？", channel: "wecom" }))).toHaveLength(0);
  });

  test("干净的追问草稿完全通过", () => {
    const review = reviewDraft({
      bodyText: "王总，您这边山核桃这条线现在是哪家在供？我们今年在拓华东区域。",
      channel: "wecom",
    });
    expect(review.verdict).toBe("pass");
    expect(review.violations).toHaveLength(0);
    expect(summarizeReview(review)).toBe("未发现红线");
  });
});

describe("输出形状", () => {
  test("命中片段带上下文，能定位到原文", () => {
    const review = reviewDraft({
      bodyText: "前面说了一堆铺垫，然后我们这批货 120 元/箱，后面还有话。",
      channel: "wecom",
    });
    const price = review.violations.find((v) => v.rule === "price");
    expect(price?.quote).toContain("120 元");
    expect(price?.suggestion).toBeTruthy();
  });

  test("每条违规都有可执行的建议", () => {
    const review = reviewDraft({
      bodyText: "120 元/箱，打 8 折，账期 60 天，3 天内发货，零添加，保证独家给您。",
      channel: "wecom",
    });
    expect(review.verdict).toBe("block");
    for (const violation of review.violations) {
      expect(violation.suggestion.length).toBeGreaterThan(5);
      expect(violation.label).toBeTruthy();
    }
  });

  test("摘要说清有几项必须改、几项提醒", () => {
    const review = reviewDraft({ bodyText: "120 元/箱，保证质量。", channel: "wecom" });
    const summary = summarizeReview(review);
    expect(summary).toContain("必须改");
    expect(summary).toContain("提醒");
  });

  test("报告跑了多少条规则（解释为什么没查出来）", () => {
    const review = reviewDraft({ bodyText: "您好", channel: "wecom" });
    expect(review.checkedRules).toBeGreaterThan(10);
  });
});
