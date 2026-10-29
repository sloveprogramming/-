/**
 * 通话结果的**客户端安全**常量与校验。
 *
 * 与服务端 crm/calls.ts 拆开的原因和之前几次一样：client 组件要显示标签、
 * 要在提交前做本地校验，但不能 import 带 server-only 的模块。
 *
 * 校验在这里做一遍、服务端再做一遍：本地是为了即时反馈（按钮为什么灰），
 * 服务端是为了安全（请求可以被绕过）。
 */

export type CallOutcome = "connected" | "unreachable" | "transferred" | "gatekeeper" | "rejected";
export type CallIntent = "interested" | "needs_follow_up" | "not_interested" | "unknown";

export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  connected: "接通",
  unreachable: "未接通",
  transferred: "已转对接人",
  gatekeeper: "前台挡下",
  rejected: "明确拒绝",
};

export const CALL_INTENT_LABEL: Record<CallIntent, string> = {
  interested: "有意向",
  needs_follow_up: "需要再跟",
  not_interested: "无意向",
  unknown: "说不清",
};

/** 每个结果允许选哪些意向——「没接通」不能有意向，「拒绝」只能是无意向。 */
export const ALLOWED_INTENTS: Record<CallOutcome, CallIntent[]> = {
  connected: ["interested", "needs_follow_up", "not_interested", "unknown"],
  unreachable: ["unknown"],
  transferred: ["interested", "needs_follow_up", "not_interested", "unknown"],
  gatekeeper: ["unknown", "needs_follow_up"],
  rejected: ["not_interested"],
};

export const CALL_OUTCOMES: CallOutcome[] = ["connected", "unreachable", "transferred", "gatekeeper", "rejected"];

export function intentsFor(outcome: CallOutcome): CallIntent[] {
  return ALLOWED_INTENTS[outcome];
}

/** 换了结果之后，原来选的意向还合法吗？不合法就退回第一个允许的。 */
export function coerceIntent(outcome: CallOutcome, current: CallIntent): CallIntent {
  const allowed = ALLOWED_INTENTS[outcome];
  return allowed.includes(current) ? current : allowed[0];
}

export const MAX_CALL_NOTES = 2_000;

/** 提交前的本地校验，返回错误文案或 null。 */
export function validateCallLog(input: {
  outcome: CallOutcome;
  intent: CallIntent;
  notes: string;
}): string | null {
  if (!ALLOWED_INTENTS[input.outcome].includes(input.intent)) {
    return `「${CALL_OUTCOME_LABEL[input.outcome]}」不能选「${CALL_INTENT_LABEL[input.intent]}」`;
  }
  if (input.notes.length > MAX_CALL_NOTES) return `要点最多 ${MAX_CALL_NOTES} 字`;
  return null;
}
