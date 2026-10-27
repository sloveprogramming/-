import type { ComponentType } from "react";
import type { AnalyticsView } from "@/lib/analytics/contract";
import { EmailView } from "./EmailView";
import { OverviewView } from "./OverviewView";
import type { ViewProps } from "./types";

/**
 * The view registry. One entry per view. Each component receives
 * `{ data, loading, onSelectView? }` typed to its own response.
 *
 * 改造：LinkedIn / WhatsApp 两个视图随频道删除，只剩总览与邮件。企业微信、短信、
 * 外呼接入后，在 contract.ts 的 ANALYTICS_VIEWS 里加一项，这里加一行即可——
 * 泛型会强制每个 view 都有组件。
 */
export const views: { [V in AnalyticsView]: ComponentType<ViewProps<V>> } = {
  overview: OverviewView,
  email: EmailView,
};

export type { ViewProps } from "./types";
