/**
 * 中文化：CRM 展示层词表。
 *
 * 为什么顶级分类要在这里映射而不是改数据库：`crm_categories` 是系统所有的固定
 * 词表，`crm_categories_protect_system_rows()` 触发器会拒绝任何对系统行的
 * UPDATE（试过，报 "system CRM categories cannot be changed"），而且它的 label
 * 上有唯一约束。所以数据库里永远是 Interested / Customer / Not Interested /
 * Other，中文只在展示层出现，所有地方统一走 `crmCategoryLabel()`。
 *
 * 子分类（crm_subcategories.name）反过来：它是每个组织自己的数据，已经由
 * 迁移脚本写成中文，UI 直接显示 `subcategory.name` 即可，不要再映射一遍。
 *
 * 这个文件必须保持无运行时依赖：服务端页面和客户端组件都会引用它。
 */
import type { CrmCategoryKey, CrmWorkflowState } from "./schema";

const CATEGORY_LABELS: Record<CrmCategoryKey, string> = {
  interested: "有意向",
  customer: "已成交客户",
  not_interested: "无意向",
  other: "其他",
};

/** 顶级分类的中文名。未知 key 原样返回，宁可露出英文也不要显示空白。 */
export function crmCategoryLabel(key: string | null | undefined): string {
  if (!key) return "未分类";
  return CATEGORY_LABELS[key as CrmCategoryKey] ?? key;
}

const WORKFLOW_STATE_LABELS: Record<CrmWorkflowState, string> = {
  unclassified: "未分类",
  classifying: "识别中",
  action_required: "待处理",
  waiting: "等待对方",
  idle: "暂无动作",
  paused: "已暂停",
  closed: "已关闭",
  error: "识别失败",
};

/** 记录处理状态的中文名，用于列表和详情页的状态标签。 */
export function crmWorkflowStateLabel(state: string | null | undefined): string {
  if (!state) return "未分类";
  return WORKFLOW_STATE_LABELS[state as CrmWorkflowState] ?? state;
}
