import {
  RiBarChartBoxLine,
  RiGridLine,
  RiInboxLine,
  RiMailFill,
  RiCalendarCheckLine,
  RiPhoneLine,
  RiRobot2Line,
  RiRadarLine,
  RiRouteLine,
  RiSendPlaneLine,
  RiSettings3Line,
  RiTimeLine,
  RiTodoLine,
  RiUserSearchLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import { HUE } from "@/components/analytics/theme";
import { SETTINGS_HOME, SETTINGS_NAV } from "@/components/settings/settingsNav";

/**
 * The app's navigation, shared by the sidebar and the ⌘K palette.
 *
 * Shape: a few labelled sections of links and collapsible groups (one group
 * per outreach channel), plus footer entries pinned to the bottom. A link's
 * `match` lists extra path prefixes that should light it up (a record page
 * belongs to Leads).
 *
 * 改造（国内化）：LinkedIn / WhatsApp / Calling 三组入口连同"开发者"分组一起移除。
 * 企业微信、短信、外呼、找客户（企业库 / 线索池）在对应模块接入时再加回来，
 * 不提前放一个点进去 404 的入口。
 */

/** Live counts from GET /api/nav/badges. */
export type NavBadges = {
  actionRequired: number;
  whatsappUnread: number;
  draftsAwaitingReview: number;
  /** Failing mailboxes + disconnected LinkedIn and WhatsApp accounts. */
  accountsNeedingAttention: number;
};
export type NavBadgeKey = keyof NavBadges;

export type NavLink = {
  kind: "link";
  href: string;
  label: string;
  icon: RemixiconComponentType;
  badge?: NavBadgeKey;
  /** "count" shows the number; "dot" only flags that something needs a look. */
  badgeStyle?: "count" | "dot";
  match?: string[];
};

export type NavGroup = {
  kind: "group";
  id: string;
  label: string;
  icon: RemixiconComponentType;
  /** Channel identity colour for the group's icon (the Analytics channel colours). */
  color?: string;
  children: NavLink[];
  /** Closed until opened, unless it holds the current page. */
  defaultOpen?: boolean;
};

export type NavEntry = NavLink | NavGroup;
export type NavSection = { label?: string; entries: NavEntry[] };

const link = (href: string, label: string, icon: RemixiconComponentType, extra: Partial<NavLink> = {}): NavLink => ({ kind: "link", href, label, icon, ...extra });

export const NAV_SECTIONS: NavSection[] = [
  {
    entries: [
      link("/analytics", "数据分析", RiBarChartBoxLine),
      link("/crm/actions", "待处理", RiTodoLine, { badge: "actionRequired" }),
      link("/prospecting", "找客户", RiRadarLine),
      link("/prospect", "产品拓客", RiRobot2Line),
      link("/phone", "电话名单", RiPhoneLine),
      link("/leads", "客户线索", RiUserSearchLine, { match: ["/crm/records"] }),
    ],
  },
  {
    label: "触达",
    entries: [
      {
        kind: "group",
        id: "email",
        label: "邮件",
        icon: RiMailFill,
        color: HUE.orange,
        defaultOpen: true,
        children: [
          link("/outreach/campaigns", "营销活动", RiSendPlaneLine),
          link("/outreach/inbox", "收件箱", RiInboxLine),
        ],
      },
    ],
  },
  {
    label: "商机",
    entries: [
      link("/crm/pipeline", "商机看板", RiRouteLine),
      link("/visits", "拜访", RiCalendarCheckLine),
      link("/crm/sequences", "跟进序列", RiTimeLine),
    ],
  },
  {
    label: "数据",
    entries: [link("/tables", "数据表", RiGridLine)],
  },
];

export const NAV_FOOTER: NavEntry[] = [
  link(SETTINGS_HOME, "设置", RiSettings3Line, { match: ["/settings"], badge: "accountsNeedingAttention", badgeStyle: "dot" }),
];

export function allLinks(): NavLink[] {
  const entries = [...NAV_SECTIONS.flatMap((s) => s.entries), ...NAV_FOOTER];
  return entries.flatMap((e) => (e.kind === "group" ? e.children : [e]));
}

/** The one link that owns `pathname`: the longest matching href or `match` prefix. */
export function activeHref(pathname: string): string | undefined {
  let best: { href: string; length: number } | undefined;
  for (const l of allLinks()) {
    for (const prefix of [l.href, ...(l.match ?? [])]) {
      const hit = pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
      if (hit && (!best || prefix.length > best.length)) best = { href: l.href, length: prefix.length };
    }
  }
  return best?.href;
}

/** Every destination for the ⌘K palette: nav pages, settings screens, and "create" shortcuts. */
export type PaletteItem = { href: string; label: string; group: string; icon: RemixiconComponentType; keywords?: string; /** Opens in a new tab instead of navigating in the app. */ external?: boolean };

export function paletteItems(): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const section of NAV_SECTIONS) {
    for (const e of section.entries) {
      if (e.kind === "link") items.push({ href: e.href, label: e.label, group: section.label ?? "页面", icon: e.icon });
      else for (const c of e.children) items.push({ href: c.href, label: `${e.label} · ${c.label}`, group: section.label ?? "页面", icon: c.icon });
    }
  }
  for (const e of NAV_FOOTER) {
    if (e.kind === "group") for (const c of e.children) items.push({ href: c.href, label: c.label, group: e.label, icon: c.icon });
  }
  for (const g of SETTINGS_NAV) {
    for (const s of g.items) {
      if (!s.tabs) items.push({ href: s.href, label: s.label, group: "设置", icon: s.icon, keywords: g.label });
      else for (const t of s.tabs) items.push({ href: t.href, label: `${s.label} · ${t.label}`, group: "设置", icon: t.icon, keywords: g.label });
    }
  }
  items.push(
    { href: "/outreach/campaigns/new", label: "新建邮件营销活动", group: "新建", icon: RiMailFill },
    { href: "/prospecting", label: "找客户（搜索企业）", group: "新建", icon: RiRadarLine },
    { href: "/leads", label: "导入客户线索", group: "新建", icon: RiUserSearchLine },
  );
  return items;
}
