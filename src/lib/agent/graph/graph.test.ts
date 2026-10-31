import { describe, expect, test } from "bun:test";
import { decideNext, isNegativeIntent, needsHumanReview } from "./supervisor";
import { buildAgentGraph, buildInterruptibleGraph } from "./build";
import type { AgentStateType } from "./state";

/**
 * 多 Agent 协同的路由逻辑。
 *
 * 这是整个 LangGraph 改造的核心——**同一个图，输入不同会走不同路径**。
 * 如果路由写错，表现会是「该起草时没起草」或「拒绝的客户还在跟进」，
 * 这两类错误在业务上都很严重，所以每种情况都要钉住。
 */

function state(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    personId: "p1",
    organizationId: "o1",
    product: "面包丝",
    companyName: "临安烘焙",
    goal: "unknown",
    channel: "email",
    findings: null,
    intent: null,
    trail: [],
    next: "research",
    draftText: null,
    draftSubject: null,
    error: null,
    budget: 6,
    ...overrides,
  } as AgentStateType;
}

describe("Supervisor 路由", () => {
  test("目标不明且无材料 → 先调研", () => {
    const d = decideNext(state({ goal: "unknown" }));
    expect(d.next).toBe("research");
  });

  test("首次触达：无材料先调研，有材料直接起草", () => {
    expect(decideNext(state({ goal: "first_touch" })).next).toBe("research");
    expect(decideNext(state({ goal: "first_touch", findings: "材料" })).next).toBe("draft");
  });

  test("回复客户：缺意向判断时先去评估", () => {
    const d = decideNext(state({ goal: "draft_reply", findings: "材料" }));
    expect(d.next).toBe("assess_intent");
  });

  test("回复客户：负面意向 → 关闭，不起草", () => {
    const d = decideNext(state({
      goal: "draft_reply",
      findings: "材料",
      intent: { category: "not_interested", confidence: 0.9, reasoning: "客户说不需要" },
    }));
    expect(d.next).toBe("close");
  });

  test("回复客户：正面意向 → 起草", () => {
    const d = decideNext(state({
      goal: "draft_reply",
      findings: "材料",
      intent: { category: "interested", confidence: 0.8, reasoning: "客户要资料" },
    }));
    expect(d.next).toBe("draft");
  });

  test("已有草稿 → 收尾，不重复劳动", () => {
    expect(decideNext(state({ goal: "draft_reply", draftText: "草稿" })).next).toBe("finish");
  });

  test("出错 → 立即收尾，不在错误状态上继续", () => {
    const d = decideNext(state({ goal: "first_touch", error: "调研失败" }));
    expect(d.next).toBe("finish");
  });

  test("预算耗尽 → 无论缺什么都收尾", () => {
    const d = decideNext(state({
      goal: "first_touch",
      trail: ["a", "b", "c", "d", "e", "f"],
      budget: 6,
    }));
    expect(d.next).toBe("finish");
  });

  test("每次路由都带理由（便于排查为什么没起草）", () => {
    const d = decideNext(state({ goal: "first_touch" }));
    expect(d.reason.length).toBeGreaterThan(0);
  });
});

describe("负面意向判定", () => {
  test("三个负面 key 都识别", () => {
    expect(isNegativeIntent("not_interested")).toBe(true);
    expect(isNegativeIntent("do_not_contact")).toBe(true);
    expect(isNegativeIntent("already_using_a_tool_not_required")).toBe(true);
  });

  test("不是负面意向的判断", () => {
    expect(isNegativeIntent("interested")).toBe(false);
    expect(isNegativeIntent(null)).toBe(false);
    expect(isNegativeIntent("")).toBe(false);
  });

  test("大小写与空格容错", () => {
    expect(isNegativeIntent("NOT_INTERESTED")).toBe(true);
    expect(isNegativeIntent(" not_interested ")).toBe(true);
  });
});

describe("人工审批触发条件", () => {
  test("有草稿就必须人审（业务红线）", () => {
    expect(needsHumanReview(state({ draftText: "草稿" }))).toBe(true);
  });

  test("没草稿不需要人审", () => {
    expect(needsHumanReview(state())).toBe(false);
  });
});

describe("图的编译", () => {
  test("基础图能编译且节点齐全", () => {
    const graph = buildAgentGraph();
    const nodes = Object.keys(graph.getGraph().nodes);
    for (const name of ["supervisor", "research", "assess_intent", "draft", "close", "finish"]) {
      expect(nodes).toContain(name);
    }
  });

  test("可中断图含 human_review 节点", () => {
    const graph = buildInterruptibleGraph();
    const nodes = Object.keys(graph.getGraph().nodes);
    expect(nodes).toContain("human_review");
  });

  test("close 是终态：不再连回 supervisor（否则会无限循环）", () => {
    const graph = buildAgentGraph();
    const edges = (graph.getGraph().edges ?? []) as Array<{ source: string; target: string }>;
    const fromClose = edges.filter((edge) => edge.source === "close").map((edge) => edge.target);
    // 实测踩过：close → supervisor 会导致「close → supervisor → close」的无效循环
    expect(fromClose).not.toContain("supervisor");
    expect(fromClose).toContain("finish");
  });
});
