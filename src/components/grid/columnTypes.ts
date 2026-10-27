import {
  RiAtLine,
  RiBracesLine,
  RiCalendar2Line,
  RiChat1Line,
  RiCheckboxCircleLine,
  RiCheckboxLine,
  RiCornerRightDownLine,
  RiCpuLine,
  RiFlashlightLine,
  RiFunctions,
  RiGitMergeLine,
  RiGlobalLine,
  RiHashtag,
  RiImageLine,
  RiLinkM,
  RiListCheck,
  RiMagicLine,
  RiMoneyDollarCircleLine,
  RiText,
} from "@remixicon/react";
import type { RemixiconComponentType } from "@remixicon/react";
import type { ColumnType } from "@/lib/grid/types";

export type ColumnTypeMeta = {
  type: ColumnType;
  label: string;
  icon: RemixiconComponentType;
  /** false while the runner behind it is unimplemented — see the plan doc. */
  available: boolean;
};

/**
 * The "Add column" menu, in Clay's order and grouping. Groups are rendered
 * with a divider between them.
 *
 * Runner types that do not have an end-to-end configuration flow yet stay
 * visible but disabled. This keeps the shape of the roadmap visible without
 * allowing users to create columns that cannot be configured or executed.
 */
export const COLUMN_TYPE_GROUPS: ColumnTypeMeta[][] = [
  [{ type: "enrichment", label: "添加补全", icon: RiFlashlightLine, available: true }],
  [
    { type: "http", label: "HTTP API", icon: RiGlobalLine, available: true },
    { type: "ai", label: "用 AI 生成", icon: RiMagicLine, available: true },
    { type: "functions", label: "函数", icon: RiCpuLine, available: false },
    { type: "message", label: "消息", icon: RiChat1Line, available: false },
    { type: "waterfall", label: "瀑布流", icon: RiCornerRightDownLine, available: false },
    { type: "formula", label: "公式", icon: RiFunctions, available: true },
    { type: "merge", label: "合并列", icon: RiGitMergeLine, available: false },
  ],
  [
    { type: "text", label: "文本", icon: RiText, available: true },
    { type: "number", label: "数字", icon: RiHashtag, available: true },
    { type: "currency", label: "金额", icon: RiMoneyDollarCircleLine, available: true },
    { type: "date", label: "日期", icon: RiCalendar2Line, available: true },
    { type: "url", label: "网址", icon: RiLinkM, available: true },
    { type: "email", label: "邮箱", icon: RiAtLine, available: true },
    { type: "image", label: "图片链接", icon: RiImageLine, available: true },
  ],
  [
    { type: "boolean", label: "复选框", icon: RiCheckboxLine, available: true },
    { type: "select", label: "单选", icon: RiCheckboxCircleLine, available: true },
    { type: "multiselect", label: "多选", icon: RiListCheck, available: true },
    { type: "json", label: "JSON", icon: RiBracesLine, available: true },
  ],
];

const BY_TYPE = new Map<ColumnType, ColumnTypeMeta>(
  [
    ...COLUMN_TYPE_GROUPS.flat(),
    { type: "integration_output" as const, label: "Integration output", icon: RiFlashlightLine, available: false },
    { type: "ai_output" as const, label: "AI output", icon: RiMagicLine, available: false },
  ].map((m) => [m.type, m]),
);

/** Falls back to the text metadata so an unknown type still renders. */
export function columnTypeMeta(type: ColumnType): ColumnTypeMeta {
  return BY_TYPE.get(type) ?? { type, label: type, icon: RiText, available: true };
}
