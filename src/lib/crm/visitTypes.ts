/**
 * 拜访的常量与类型——**客户端安全**，不含任何数据库导入。
 *
 * 为什么要拆出来：`crm/visits.ts` 里有 `tenancy/scope`（`server-only`），
 * 客户端组件 import 它会把整个 DB 模块拖进浏览器包，Next 编译直接失败。
 * 类型和文案是纯数据，单独放这里，两边都能用。
 */

export const VISIT_EVENTS = ["visit.planned", "visit.checked_in", "visit.completed", "visit.cancelled"] as const;
export type VisitEventType = (typeof VISIT_EVENTS)[number];

export type VisitStatus = "planned" | "checked_in" | "completed" | "cancelled";

export type VisitOutcome = "advanced" | "follow_up_needed" | "no_progress";

export type Visit = {
  id: string;
  recordId: string;
  personId: string;
  personName: string | null;
  companyName: string | null;
  status: VisitStatus;
  scheduledAt: string | null;
  checkedInAt: string | null;
  completedAt: string | null;
  location: string | null;
  purpose: string | null;
  notes: string | null;
  nextStep: string | null;
  outcome: VisitOutcome | null;
  cancelledReason: string | null;
  updatedAt: string;
};

export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = {
  planned: "已安排",
  checked_in: "已到场",
  completed: "已结束",
  cancelled: "已取消",
};

export const VISIT_OUTCOME_LABEL: Record<VisitOutcome, string> = {
  advanced: "有推进",
  follow_up_needed: "需再谈",
  no_progress: "无进展",
};

/** 状态流转规则：终态不能再变。服务端校验用它，客户端也能提前禁按钮。 */
export const VISIT_ALLOWED_NEXT: Record<VisitStatus, VisitEventType[]> = {
  planned: ["visit.checked_in", "visit.completed", "visit.cancelled"],
  checked_in: ["visit.completed", "visit.cancelled"],
  completed: [],
  cancelled: [],
};

export function visitEventToStatus(type: VisitEventType): VisitStatus {
  switch (type) {
    case "visit.planned":
      return "planned";
    case "visit.checked_in":
      return "checked_in";
    case "visit.completed":
      return "completed";
    case "visit.cancelled":
      return "cancelled";
  }
}
