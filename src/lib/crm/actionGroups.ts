/**
 * What a person has to do about a record in the Action required queue, in the
 * five groups the queue filters by. Each row still names its exact action
 * ("Follow-up review", "Due follow-up", …); the filter used to list all nine
 * of those, several of which never occur or repeat another filter.
 *
 * Client-safe: the SQL that assigns a record its group is the `.server`
 * sibling, so a client component can import the labels.
 */
export const CRM_ACTION_GROUPS = ["reply", "follow_up", "classification", "next_step", "problem"] as const;

export type CrmActionGroup = typeof CRM_ACTION_GROUPS[number];

/** 中文化：分组名给销售看的，key 仍然是英文（筛选、接口参数都用 key）。 */
export const CRM_ACTION_GROUP_LABELS: Readonly<Record<CrmActionGroup, string>> = {
  reply: "待回复",
  follow_up: "待跟进",
  classification: "待确认分类",
  next_step: "待定下一步",
  problem: "出错或失败",
};

export function isCrmActionGroup(value: string): value is CrmActionGroup {
  return (CRM_ACTION_GROUPS as readonly string[]).includes(value);
}
