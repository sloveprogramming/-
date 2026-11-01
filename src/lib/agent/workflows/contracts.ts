/**
 * Agent 角色契约。
 *
 * 这张表只描述"角色能做什么、能看什么、失败后怎么办"，不包含提示词和实现。
 * 图编排、文档和测试都以它为单一事实来源，避免同一个 Agent 在不同文件里被
 * 描述成互相矛盾的能力边界。
 *
 * 关键约束：
 * - Agent 只能读业务数据，不能直接发送消息或写 CRM。
 * - 最终评分由确定性聚合器计算，模型不能直接返回不可解释的总分。
 * - 草稿永远需要人工审核。
 */

export const AGENT_NODE_IDS = [
  "product_intent",
  "sourcing",
  "scoring",
  "reply_intent",
  "drafting",
] as const;

export type AgentNodeId = (typeof AGENT_NODE_IDS)[number];

export type AgentWorkflow = "prospect" | "crm_reply";
export type AgentExecutionKind = "deterministic" | "single_ai" | "agent";
export type AgentSideEffects = "none" | "read";
export type HumanReviewPolicy = "never" | "conditional" | "always";

export type AgentBudget = {
  maxToolCalls: number;
  timeoutMs: number;
  maxRounds: number;
};

export type AgentNodeContract = {
  id: AgentNodeId;
  name: string;
  workflow: AgentWorkflow;
  purpose: string;
  /** 当前实现层级：单次 AI 与工具循环 Agent 必须明确区分。 */
  kind: AgentExecutionKind;
  tools: readonly string[];
  budget: AgentBudget;
  fallback: string;
  sideEffects: AgentSideEffects;
  humanReview: HumanReviewPolicy;
};

export const AGENT_CONTRACTS: Readonly<Record<AgentNodeId, AgentNodeContract>> = {
  product_intent: {
    id: "product_intent",
    name: "ProductIntentAgent",
    workflow: "prospect",
    purpose: "判断产品卖给谁，并给出有依据的企业搜索词。",
    kind: "single_ai",
    tools: [],
    budget: { maxToolCalls: 0, timeoutMs: 20_000, maxRounds: 1 },
    fallback: "退回本地词典或 fallbackIntent，并标记低置信度。",
    sideEffects: "none",
    humanReview: "conditional",
  },
  sourcing: {
    id: "sourcing",
    name: "SourcingAgent",
    workflow: "prospect",
    purpose: "按搜索词找企业；结果太少时用只读探测工具换词重搜。",
    kind: "agent",
    tools: ["search_companies", "search_history", "probe_search"],
    budget: { maxToolCalls: 5, timeoutMs: 45_000, maxRounds: 1 },
    fallback: "保留第一轮已找到的企业，不因重规划失败中断。",
    sideEffects: "read",
    humanReview: "never",
  },
  scoring: {
    id: "scoring",
    name: "ScoringAgent",
    workflow: "prospect",
    purpose: "综合行业、规模、成立时间、经营状态和渠道能力，给出可解释的合作判断。",
    kind: "agent",
    tools: [
      "lookup_company_profile",
      "lookup_recruitment",
      "lookup_bidding",
      "lookup_qualifications",
      "lookup_food_safety",
    ],
    budget: { maxToolCalls: 5, timeoutMs: 60_000, maxRounds: 1 },
    fallback: "保留确定性基础分；深查失败只标记证据不足，不改分。",
    sideEffects: "read",
    humanReview: "conditional",
  },
  reply_intent: {
    id: "reply_intent",
    name: "ReplyAgent",
    workflow: "crm_reply",
    purpose: "判断客户这条回复表达的是什么态度、需求或异议。",
    kind: "single_ai",
    tools: [],
    budget: { maxToolCalls: 0, timeoutMs: 30_000, maxRounds: 1 },
    fallback: "分类失败时把 CRM 记录标为待人工处理，不猜测客户态度。",
    sideEffects: "none",
    humanReview: "conditional",
  },
  drafting: {
    id: "drafting",
    name: "DraftAgent",
    workflow: "crm_reply",
    purpose: "基于客户画像、历史对话、知识库和销售策略生成受渠道约束的草稿。",
    kind: "single_ai",
    tools: [],
    budget: { maxToolCalls: 0, timeoutMs: 45_000, maxRounds: 1 },
    fallback: "生成失败时落 failed 状态并交给人工，不自动发送旧稿。",
    sideEffects: "none",
    humanReview: "always",
  },
};

export function contractsForWorkflow(workflow: AgentWorkflow): readonly AgentNodeContract[] {
  return Object.values(AGENT_CONTRACTS).filter((contract) => contract.workflow === workflow);
}
