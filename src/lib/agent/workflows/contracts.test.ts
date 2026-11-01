import { describe, expect, test } from "bun:test";
import {
  AGENT_CONTRACTS,
  AGENT_NODE_IDS,
  contractsForWorkflow,
} from "./contracts";

describe("Agent 角色契约", () => {
  test("五个业务角色都有且只有一份契约", () => {
    expect(Object.keys(AGENT_CONTRACTS).sort()).toEqual([...AGENT_NODE_IDS].sort());
  });

  test("拓客三角色与 CRM 双角色分属两张业务图", () => {
    expect(contractsForWorkflow("prospect").map((item) => item.id)).toEqual([
      "product_intent",
      "sourcing",
      "scoring",
    ]);
    expect(contractsForWorkflow("crm_reply").map((item) => item.id)).toEqual([
      "reply_intent",
      "drafting",
    ]);
  });

  test("Agent 不允许写业务数据，只能无副作用或只读", () => {
    for (const contract of Object.values(AGENT_CONTRACTS)) {
      expect(["none", "read"]).toContain(contract.sideEffects);
    }
  });

  test("草稿必须人工审核，产品画像和评分可以条件审核", () => {
    expect(AGENT_CONTRACTS.drafting.humanReview).toBe("always");
    expect(AGENT_CONTRACTS.product_intent.humanReview).toBe("conditional");
    expect(AGENT_CONTRACTS.scoring.humanReview).toBe("conditional");
  });

  test("单次判断与工具循环 Agent 不混称", () => {
    expect(AGENT_CONTRACTS.product_intent.kind).toBe("single_ai");
    expect(AGENT_CONTRACTS.reply_intent.kind).toBe("single_ai");
    expect(AGENT_CONTRACTS.drafting.kind).toBe("single_ai");
    expect(AGENT_CONTRACTS.sourcing.kind).toBe("agent");
    expect(AGENT_CONTRACTS.scoring.kind).toBe("agent");
  });

  test("有工具的角色必须给出正数工具预算", () => {
    for (const contract of Object.values(AGENT_CONTRACTS)) {
      if (contract.tools.length > 0) {
        expect(contract.budget.maxToolCalls).toBeGreaterThan(0);
      }
      expect(contract.budget.timeoutMs).toBeGreaterThan(0);
      expect(contract.budget.maxRounds).toBeGreaterThan(0);
    }
  });
});
