import { describe, expect, test } from "bun:test";
import { buildDraftPrompt, draftChannelConstraints, draftJsonSchema, validateDraftOutput, type DraftPromptInput } from "./draft";

/**
 * 渠道覆盖（channelOverride）。
 *
 * 业务场景：探迹外呼打完电话（会话渠道是 call），下一步不是再打电话，
 * 而是发一条微信。如果只能按会话渠道写，AI 就会产出「下次通话要点」，
 * 而销售要的是「一段能直接粘到微信的话」。
 *
 * 这个能力的关键是：**只改「写什么形态的内容」，不改「发送走哪个通道」**。
 * 所以测试既要确认覆盖生效，也要确认不覆盖时老行为完全不变。
 */

function baseInput(overrides: Partial<DraftPromptInput> = {}): DraftPromptInput {
  return {
    channel: "call",
    sequenceStep: {
      id: null,
      name: "电话后跟进",
      position: 1,
      stepType: "reply",
      subjectTemplate: null,
      bodyTemplate: null,
      aiInstructions: "打完电话之后写一条跟进消息",
      knowledgeTags: [],
    },
    knowledge: [],
    person: { id: "p1", fullName: "王经理", firstName: "王", lastName: "经理", email: null, linkedinUrl: null, title: "采购经理", attributes: {} },
    company: { id: "c1", name: "杭州速冻食品有限公司", domain: null, linkedinUrl: null, attributes: {} },
    recentConversation: [],
    acceptedClassification: { categoryKey: "interested", subcategoryKey: "information_requested", reasoning: "客户同意发资料" },
    ...overrides,
  } as DraftPromptInput;
}

describe("渠道覆盖", () => {
  test("不传覆盖时用会话渠道（老行为不变）", () => {
    const built = buildDraftPrompt(baseInput());
    expect((built.snapshot as { channel?: string }).channel).toBe("call");
  });

  test("传了覆盖就按覆盖的渠道写", () => {
    const built = buildDraftPrompt(baseInput({ channelOverride: "wecom" }));
    expect((built.snapshot as { channel?: string }).channel).toBe("wecom");
  });

  test("覆盖成微信后，提示词里是微信的约束（不是电话要点）", () => {
    const built = buildDraftPrompt(baseInput({ channelOverride: "wecom" }));
    // 渠道约束在 userPrompt 的 JSON 快照里，不在 systemPrompt（后者是通用销售规则）。
    expect(built.userPrompt).toContain("企业微信");
    expect(built.userPrompt).toContain("说人话");
    // 不该出现「通话要点」那套说法
    expect(built.userPrompt).not.toContain("通话要点");
  });

  test("覆盖成微信后，JSON schema 要求 subject 为 null", () => {
    const built = buildDraftPrompt(baseInput({ channelOverride: "wecom" }));
    const schema = built.jsonSchema as { properties?: Record<string, { type?: string }> };
    expect(schema.properties?.subject?.type).toBe("null");
  });
});

describe("各渠道的输出校验", () => {
  test("电话渠道产出的是要点（纯文本，无主题）", () => {
    const built = buildDraftPrompt(baseInput());
    expect(() => validateDraftOutput(JSON.stringify({ subject: null, bodyText: "1. 开场自报家门\n2. 确认用量", bodyHtml: null }), "call")).not.toThrow();
  });

  test("微信渠道同样要求纯文本", () => {
    expect(() =>
      validateDraftOutput(JSON.stringify({ subject: null, bodyText: "王总，资料我发您了，价格明天给。", bodyHtml: null }), "wecom"),
    ).not.toThrow();
  });

  test("邮件渠道必须有主题", () => {
    expect(() =>
      validateDraftOutput(JSON.stringify({ subject: "", bodyText: "正文", bodyHtml: null }), "email"),
    ).toThrow();
  });

  test("微信渠道不接受带主题的产出", () => {
    expect(() =>
      validateDraftOutput(JSON.stringify({ subject: "主题", bodyText: "正文", bodyHtml: null }), "wecom"),
    ).toThrow();
  });
});

describe("渠道约束的形态差异", () => {
  test("电话是「要点」不是稿子", () => {
    expect(draftChannelConstraints("call").join("")).toContain("要点");
  });

  test("微信要求短、像人话", () => {
    expect(draftChannelConstraints("wecom").join("")).toContain("说人话");
  });

  test("短信限制 70 字", () => {
    expect(draftChannelConstraints("sms").join("")).toContain("70");
  });

  test("三个国内渠道的 schema 都不含 subject 字符串", () => {
    for (const channel of ["wecom", "sms", "call"] as const) {
      const schema = draftJsonSchema(channel) as { properties?: Record<string, { type?: string }> };
      expect(schema.properties?.subject?.type).toBe("null");
    }
  });
});
