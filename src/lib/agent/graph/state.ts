import "server-only";

import { Annotation } from "@langchain/langgraph";

/**
 * 多 Agent 协同的状态定义。
 *
 * ## 为什么用 LangGraph 而不是继续写流水线
 *
 * 原来的 `pipeline.ts` 是**固定四段**：产品解析 → 检索 → 评估 → 联系方式。
 * 每一步都必然执行，没有"跳步"的可能。
 *
 * 真实的拓客不是这样。同一个客户在不同阶段，需要的动作完全不同：
 *
 *   新线索       → 先调研（查档案、查历史）
 *   调研过了     → 直接起草
 *   客户拒绝了   → 不该起草，该标记关闭
 *   信息缺失     → 先补数据再继续
 *
 * 这些判断**依赖运行时状态**，写死 if/else 会变成一坨难以维护的分支。
 * LangGraph 的价值就在这里：**状态驱动路由**。
 *
 * ## 状态设计的三条原则
 *
 * 1. **只放 Agent 之间要传的东西**。不是把所有上下文都塞进 state——
 *    客户档案、知识库这些该现查就现查（子 Agent 自己会调工具）。
 * 2. **每一步都可撤销**。状态是纯数据，图可以在任意节点中断、恢复。
 * 3. **必填字段有默认值**。LangGraph 要求每个 Annotation 有默认，
 *    这样图可以从任意入口启动。
 */

/** 一个客户在本次协同里的完整旅程。 */
export const AgentState = Annotation.Root({
  /** 谁在协同。所有子 Agent 都以它为输入。 */
  personId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  /** 所在组织（多租户必须显式传，不能依赖隐式作用域）。 */
  organizationId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  /** 产品名（首触场景要用它推买家画像与话术）。 */
  product: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  /** 公司名（话术里要称呼对方）。 */
  companyName: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  /** 这次协同要干什么：起草回复 / 首触 / 复盘。 */
  goal: Annotation<"draft_reply" | "first_touch" | "follow_up" | "unknown">({
    reducer: (_prev, next) => next,
    default: () => "unknown",
  }),

  /** 渠道：决定话术形态（邮件长文 vs 微信短句 vs 电话要点）。 */
  channel: Annotation<"email" | "wecom" | "sms" | "call">({
    reducer: (_prev, next) => next,
    default: () => "email",
  }),

  /**
   * 调研子 Agent 产出的材料摘要。
   *
   * 为什么单独存：起草 Agent 需要它，但它不该自己去查一遍——
   * 那样会重复调用工具、浪费 token。
   */
  findings: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** 意向判断结果。决定能不能起草、该写什么语气。 */
  intent: Annotation<{
    category: string;
    confidence: number;
    reasoning: string;
  } | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * 已经执行过的步骤。
   *
   * reducer 用 concat：每走一个节点就追加，不会覆盖。
   * 这是 LangGraph 里"累积型状态"的标准写法。
   */
  trail: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  /**
   * Supervisor 决定下一个找谁。
   *
   * 这是路由的依据——`routeAfterSupervisor` 读它来决定走哪条边。
   */
  next: Annotation<
    "research" | "assess_intent" | "draft" | "close" | "finish"
  >({
    reducer: (_prev, next) => next,
    default: () => "research",
  }),

  /** 起草子 Agent 产出的正文（可直接给销售用）。 */
  draftText: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** 草稿主题（仅邮件渠道有）。 */
  draftSubject: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** 失败原因。有值时不继续往下走。 */
  error: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** 最多允许多少次子 Agent 往返（防死循环）。 */
  budget: Annotation<number>({
    reducer: (prev, next) => (next > 0 ? next : prev),
    default: () => 6,
  }),
});

export type AgentStateType = typeof AgentState.State;

/** 渠道类型别名（供 channel.ts 等模块引用）。 */
export type AgentChannel = AgentStateType["channel"];

/** 子 Agent 名字，与 state.next 的取值对应。 */
export const SUB_AGENTS = ["research", "assess_intent", "draft", "close"] as const;
export type SubAgent = (typeof SUB_AGENTS)[number];
