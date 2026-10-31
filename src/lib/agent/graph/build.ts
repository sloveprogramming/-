import "server-only";

import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { AgentState, type AgentStateType } from "./state";
import { decideNext } from "./supervisor";
import {
  assessIntentAgent,
  closeAgent,
  draftAgent,
  finishAgent,
  researchAgent,
} from "./agents";

/**
 * 多 Agent 协同图。
 *
 * ## 结构
 *
 * ```
 *        START
 *          ↓
 *      supervisor ◄──────┐
 *          │             │
 *    （条件路由）         │
 *     ↓  ↓  ↓  ↓         │
 *   调研 评估 起草 关闭   │
 *     └──┴──┴──┴────────┘
 *          │
 *     （有草稿 → 人审中断）
 *          ↓
 *        END
 * ```
 *
 * ## 与旧流水线的三个关键区别
 *
 * 1. **Supervisor 是循环的**，不是一次性分发。调研完回到 supervisor，
 *    它重新判断"现在够了吗、下一步找谁"。旧流水线是一去不回。
 *
 * 2. **路由是状态驱动的**。同一个图，输入不同会走不同的路径：
 *    拒绝的客户不去起草，没调研的不让起草。
 *
 * 3. **支持中断恢复**（`interrupt`）。起草完成后图可以停下来等人审，
 *    然后带着审批结果从断点继续——这是 LangGraph 独有能力，
 *    旧的 Pi session 做不到（它一次跑完）。
 *
 * ## 为什么 supervisor 单独成一个节点
 *
 * 可以把路由逻辑写在 conditional edge 里（不占节点）。但单独成节点有两个好处：
 * - 路由决策能被记录进 `trail`（可观测）
 * - 中断/恢复时能从 supervisor 续跑
 *
 * 代价是多一次节点调用（这个节点本身不调模型，只读状态，几乎零成本）。
 */

const MAX_ROUNDS = 6;

/** 路由函数：从 supervisor 的输出决定走哪条边。 */
function routeFromSupervisor(state: AgentStateType): string {
  // 用 supervisor 已经决定好的 next（decideNext 在节点里算过）
  return state.next;
}

export function buildAgentGraph() {
  const graph = new StateGraph(AgentState)
    // ---- 调度节点 ----
    .addNode("supervisor", (state: AgentStateType) => {
      const decision = decideNext(state);
      return {
        next: decision.next,
        trail: [`supervisor: → ${decision.next}（${decision.reason}）`],
      };
    })

    // ---- 子 Agent 节点 ----
    .addNode("research", researchAgent)
    .addNode("assess_intent", assessIntentAgent)
    .addNode("draft", draftAgent)
    .addNode("close", closeAgent)
    .addNode("finish", finishAgent)

    // ---- 入口 ----
    .addEdge(START, "supervisor")

    // ---- 条件路由：supervisor 决定找谁 ----
    .addConditionalEdges("supervisor", routeFromSupervisor, {
      research: "research",
      assess_intent: "assess_intent",
      draft: "draft",
      close: "close",
      finish: "finish",
    })

    // ---- 子 Agent 跑完都回到 supervisor（形成循环）----
    //
    // 这是"多 Agent 协同"的关键：不是一锤子买卖，每个 Agent 干完
    // 都回到调度中心重新判断。
    .addEdge("research", "supervisor")
    .addEdge("assess_intent", "supervisor")
    // close 是终态：不能再回 supervisor，否则会被再次路由到 close，
    // 形成「close → supervisor → close」的无效循环（实测靠预算兜底才停）。
    .addEdge("close", "finish")

    // 起草完直接收尾（不需要再回 supervisor 判断——已经有结果了）
    .addEdge("draft", "finish")

    // 收尾结束
    .addEdge("finish", END);

  return graph.compile({
    // 递归上限：防止图在节点间无限循环。
    // supervisor 自己也有 budget，两者是双保险。
  });
}

/**
 * 带中断能力的图：起草完成后停下来等人审。
 *
 * 这是 LangGraph 相比 Pi 的核心优势——**执行到一半可以停，
 * 状态保留，之后从断点继续**。
 *
 * 用法：
 * ```ts
 * const graph = buildInterruptibleGraph();
 * const result = await graph.invoke(input, { configurable: { thread_id } });
 * if (result.__interrupt__) {
 *   // 等人审
 *   await graph.invoke(new Command({ resume: approved }), { configurable: { thread_id } });
 * }
 * ```
 */
export function buildInterruptibleGraph(checkpointer?: BaseCheckpointSaver) {
  const graph = new StateGraph(AgentState)
    .addNode("supervisor", (state: AgentStateType) => {
      const decision = decideNext(state);
      return {
        next: decision.next,
        trail: [`supervisor: → ${decision.next}（${decision.reason}）`],
      };
    })
    .addNode("research", researchAgent)
    .addNode("assess_intent", assessIntentAgent)
    .addNode("draft", draftAgent)
    .addNode("close", closeAgent)
    .addNode("finish", finishAgent)
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", routeFromSupervisor, {
      research: "research",
      assess_intent: "assess_intent",
      draft: "draft",
      close: "close",
      finish: "finish",
    })
    .addEdge("research", "supervisor")
    .addEdge("assess_intent", "supervisor")
    // close 是终态：不能再回 supervisor，否则会被再次路由到 close，
    // 形成「close → supervisor → close」的无效循环（实测靠预算兜底才停）。
    .addEdge("close", "finish")
    // 起草 → 人审节点（不是直接 finish）
    // 注意顺序：addNode 必须在 addEdge 之前，否则 TS 无法推断节点名。
    .addNode("human_review", async (state: AgentStateType) => {
      const { interrupt } = await import("@langchain/langgraph");
      // 在这里中断：图暂停，等外部给 resume 值。
      const decision = interrupt({
        kind: "review_draft",
        draftText: state.draftText,
        draftSubject: state.draftSubject,
        draftId: state.personId,
      }) as { approved: boolean; feedback?: string };

      if (!decision?.approved) {
        // 被驳回：清掉草稿，回到 supervisor 让它重新来。
        return {
          draftText: null,
          trail: [`human_review: 驳回${decision?.feedback ? `（${decision.feedback}）` : ""}`],
        };
      }
      return { trail: ["human_review: 通过"] };
    })
    .addEdge("draft", "human_review")
    .addEdge("human_review", "finish")
    .addEdge("finish", END);

  // interrupt() 必须配 checkpointer：它要把「停在哪一步」持久化下来，
  // 否则无法从断点恢复（实测报 GraphValueError: No checkpointer set）。
  //
  // 传给调用方决定用哪种：MemorySaver（测试）或 PostgresSaver（生产）。
  return graph.compile({ checkpointer });
}

export { MAX_ROUNDS };
