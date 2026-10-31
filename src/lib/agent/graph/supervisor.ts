import "server-only";

import type { AgentStateType } from "./state";

/**
 * Supervisor：读状态，决定下一步找谁。
 *
 * ## 这是"多 Agent"和"流水线"的分界线
 *
 * 流水线：每一段都必然执行，顺序写死。
 * Supervisor：**看当前状态缺什么，才决定谁上场**。
 *
 * 具体差在：
 *
 *   客户是明确拒绝的 → 不走去起草（浪费一次模型调用），直接关闭
 *   已经有草稿     → 不再重复调研，直接收尾
 *   调研材料为空   → 先去调研，否则起草是"无米之炊"
 *
 * ## 路由策略：规则优先，模糊才问模型
 *
 * 清晰的状态用确定性规则判断（便宜、可预测、可测）。
 * 只有"信息够不够"这类需要判断的，才值得花一次模型调用。
 *
 * 这里刻意**没有一上来就用 LLM 决策**——因为：
 * 1. 大部分情况规则就够了（缺 findings 就去调研，这没什么可判的）
 * 2. 每次路由都调模型，一个客户要 5 次路由 = 5 次额外调用
 * 3. 规则可测，模型不可测
 *
 * 什么时候该用模型判断：客户回复模糊、意图不明（比如"你们这个价格有点意思"）。
 * 那种情况交给 `assess_intent` 子 Agent 处理，而不是让 Supervisor 自己猜。
 */

export type RouteDecision = {
  next: AgentStateType["next"];
  reason: string;
};

/**
 * 决定下一个子 Agent。
 *
 * 返回 `reason` 是为了可观测——每次路由都记一句为什么，
 * 排查时能看出"它为什么没去起草"。
 */
export function decideNext(state: AgentStateType): RouteDecision {
  // 预算耗尽：无论缺什么，都收尾。这是硬保护，优先级最高。
  if (state.trail.length >= state.budget) {
    return { next: "finish", reason: `已执行 ${state.trail.length} 步，达到预算上限` };
  }

  // 出错就停：不要让后面的 Agent 在错误状态上继续。
  if (state.error) {
    return { next: "finish", reason: `前一步失败：${state.error}` };
  }

  // 已有草稿 → 收尾。不重复劳动。
  if (state.draftText) {
    return { next: "finish", reason: "草稿已产出，结束协同" };
  }

  // 目标不明 → 先去调研，调研结果会告诉我们这是什么情况。
  if (state.goal === "unknown") {
    if (!state.findings) {
      return { next: "research", reason: "目标不明，先调研客户现状" };
    }
    // 调研完了还不明，就收尾并让调用方决定。
    return { next: "finish", reason: "调研完成但目标仍未明确" };
  }

  // ---- 按目标走 ----
  switch (state.goal) {
    case "first_touch": {
      // 首次触达：不需要判断意向（还没聊过），但需要调研（要知道对方是谁）。
      if (!state.findings) {
        return { next: "research", reason: "首次触达前需要了解客户" };
      }
      return { next: "draft", reason: "材料齐备，起草首触话术" };
    }

    case "draft_reply": {
      // 回复客户：必须先判断意向，因为拒绝的客户不该起草。
      if (!state.findings) {
        return { next: "research", reason: "回复前先调研上下文" };
      }
      if (!state.intent) {
        return { next: "assess_intent", reason: "需要判断客户意向" };
      }
      if (isNegativeIntent(state.intent.category)) {
        return { next: "close", reason: `客户意向为「${state.intent.category}」，不再跟进` };
      }
      return { next: "draft", reason: "意向可跟进，起草回复" };
    }

    case "follow_up": {
      // 跟进：意向已知，只要材料够了就能起草。
      if (!state.findings) {
        return { next: "research", reason: "跟进前先回顾历史" };
      }
      if (state.intent && isNegativeIntent(state.intent.category)) {
        return { next: "close", reason: `意向为「${state.intent.category}」，停止跟进` };
      }
      return { next: "draft", reason: "起草跟进话术" };
    }

    default:
      return { next: "finish", reason: "没有匹配的目标" };
  }
}

/**
 * 判断是否为「负面意向」——这类客户不该继续起草。
 *
 * 注意这里用的是**分类 key**，不是中文文案。项目里意向分类有固定的 key：
 *   not_interested / do_not_contact / already_using_a_tool_not_required
 *
 * 为什么用 key 而不是匹配中文：文案会改，key 不会。
 */
export function isNegativeIntent(categoryKey: string | null | undefined): boolean {
  if (!categoryKey) return false;
  return ["not_interested", "do_not_contact", "already_using_a_tool_not_required"].includes(
    categoryKey.trim().toLowerCase(),
  );
}

/**
 * 判断是否需要人工审批。
 *
 * 这是给 LangGraph 的 `interrupt()` 用的：起草完成后，
 * **图停下来等人审，然后从断点继续**。
 *
 * 为什么这个能力值得单独做：Pi 的 session 是一次性跑完的，
 * 中途停下再恢复要自己管状态。LangGraph 原生支持这一点。
 */
export function needsHumanReview(state: AgentStateType): boolean {
  // 有草稿就必须人审——这是业务红线，不是可选项。
  return Boolean(state.draftText);
}
