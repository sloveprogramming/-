import {
  RiBookOpenLine,
  RiBuilding2Line,
  RiCpuLine,
  RiEqualizerLine,
  RiGroupLine,
  RiTeamLine,
  RiLayoutColumnLine,
  RiMailLine,
  RiPlugLine,
  RiPaletteLine,
  RiPriceTag3Line,
  RiQuillPenLine,
  type RemixiconComponentType,
} from "@remixicon/react";

export type SettingsTab = { href: string; label: string; icon: RemixiconComponentType };

/** A row in the settings rail. With `tabs`, it opens the first and stays active on any of them. */
export type SettingsNavItem = SettingsTab & { tabs?: SettingsTab[] };

/** Every page a row covers: itself, or its tabs. */
export function itemPages(item: SettingsNavItem): SettingsTab[] {
  return item.tabs ?? [item];
}

/**
 * Every settings screen in the app. Each is its own route under /settings;
 * the pages they replaced redirect here (next.config.ts).
 *
 * 改造（国内化）：LinkedIn / WhatsApp 两行随渠道删除一起移除；企业微信、短信、
 * 外呼在模块接入时加回。标签全部中文化。
 */
export const SETTINGS_NAV: { label: string; items: SettingsNavItem[] }[] = [
  {
    label: "组织",
    items: [
      { href: "/settings/organization", label: "基本设置", icon: RiBuilding2Line },
      { href: "/settings/members", label: "成员", icon: RiGroupLine },
      { href: "/settings/teams", label: "团队", icon: RiTeamLine },
    ],
  },
  // Each channel is one row here; its pages — the connected accounts, the
  // integration it runs on, its sending rules (src/lib/channels/rules.ts) —
  // are tabs across the top of the section (SettingsShell).
  {
    label: "渠道",
    items: [
      {
        href: "/settings/email-accounts",
        label: "邮件",
        icon: RiMailLine,
        tabs: [
          { href: "/settings/email-accounts", label: "发信邮箱", icon: RiMailLine },
          { href: "/settings/email-connection", label: "连接配置", icon: RiPlugLine },
          { href: "/settings/email-rules", label: "发送规则", icon: RiEqualizerLine },
        ],
      },
    ],
  },
  {
    label: "AI",
    items: [
      { href: "/settings/instructions", label: "运营指令", icon: RiQuillPenLine },
      { href: "/settings/knowledge", label: "知识库", icon: RiBookOpenLine },
      { href: "/settings/ai", label: "AI 模型", icon: RiCpuLine },
    ],
  },
  {
    label: "CRM 与线索",
    items: [
      { href: "/settings/lead-categories", label: "线索分类", icon: RiPriceTag3Line },
      { href: "/settings/columns", label: "线索字段", icon: RiLayoutColumnLine },
    ],
  },
  {
    label: "偏好",
    items: [{ href: "/settings/appearance", label: "外观", icon: RiPaletteLine }],
  },
];

/** Where "Settings" opens. */
export const SETTINGS_HOME = SETTINGS_NAV[0].items[0].href;
