export type InboxSectionKey = "inbox" | "sent" | "replied" | "scheduled" | "important" | "outOfOffice" | "pendingApproval";

export const INBOX_SECTIONS: { key: InboxSectionKey; label: string; parent?: InboxSectionKey }[] = [
  { key: "inbox", label: "收件箱" },
  { key: "replied", label: "已回复", parent: "inbox" },
  { key: "outOfOffice", label: "自动回复", parent: "inbox" },
  { key: "pendingApproval", label: "待审批" },
  { key: "sent", label: "已发送" },
  { key: "important", label: "重要" },
  { key: "scheduled", label: "定时发送" },
];

/** What each folder's count means, for its tooltip. `/api/outreach/inbox/counts` only reports these three. */
export const SECTION_COUNT_HINT: Partial<Record<InboxSectionKey, string>> = {
  inbox: "未读",
  important: "已标星",
  scheduled: "等待发送",
};
