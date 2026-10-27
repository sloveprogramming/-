"use client";

import { RiCheckDoubleLine, RiDraftLine } from "@remixicon/react";
import type { CrmCategory, CrmSummary } from "@/lib/analytics/contract";
import { crmCategoryLabel, crmWorkflowStateLabel } from "@/lib/crm/labels";
import { cn } from "@/utils/cn";
import { BarList, type BarListItem } from "../kit/BarList";
import { ChartCard } from "../kit/ChartCard";
import { DeltaPill } from "../kit/DeltaPill";
import { DonutChart, type DonutItem } from "../kit/DonutChart";
import { EmptyChart } from "../kit/EmptyChart";
import { Frame, FrameHeader, FramePanel } from "../kit/Frame";
import { SegmentedBar, type SegmentItem } from "../kit/SegmentedBar";
import { SeriesStats } from "../kit/SeriesStats";
import { seriesTotal, TimeSeriesChart, TimeSeriesTable, type SeriesKeys } from "../kit/TimeSeriesChart";
import { formatCompact, formatPercent, MUTED, ORDINAL_BLUE, ordinalRamp } from "../theme";

/**
 * 总览页里的 CRM 卡片：回复情绪、商机形状、阶段流转、AI 助手、处理状态。
 *
 * 颜色：CRM 分类在全站共用一套身份色（情绪图、商机环、阶段环、头部阶段条都用
 * 同一组），都不占用渠道色。漏斗阶段用蓝色阶梯，按阶段顺序由浅到深。
 *
 * 改造：全部中文化。分类与处理状态的文案直接取 lib/crm/labels，跟 CRM 页面
 * 用同一份词表，避免"这里叫有意向、那里叫感兴趣"。
 */

export const CATEGORY_LABEL: Record<CrmCategory, string> = {
  interested: crmCategoryLabel("interested"),
  customer: crmCategoryLabel("customer"),
  not_interested: crmCategoryLabel("not_interested"),
  other: crmCategoryLabel("other"),
  unclassified: crmCategoryLabel(null),
};

const SENTIMENT_KEYS: SeriesKeys<CrmCategory> = {
  interested: { label: CATEGORY_LABEL.interested, color: "#1daf9c" },
  customer: { label: CATEGORY_LABEL.customer, color: "#7d52f4" },
  not_interested: { label: CATEGORY_LABEL.not_interested, color: "#fb3748" },
  other: { label: CATEGORY_LABEL.other, color: "#e5930a" },
  unclassified: { label: CATEGORY_LABEL.unclassified, color: MUTED },
};

type CardProps<K extends keyof CrmSummary> = { value: CrmSummary[K]; loading: boolean; className?: string };

export function SentimentCard({ series, bucket, loading, className }: { series: CrmSummary["repliesByCategory"]; bucket: "day" | "week"; loading: boolean; className?: string }) {
  const stats = (Object.keys(SENTIMENT_KEYS) as CrmCategory[]).map((k) => ({ label: SENTIMENT_KEYS[k].label, color: SENTIMENT_KEYS[k].color, value: formatCompact(seriesTotal(series, k)) }));
  const unit = bucket === "week" ? "每周" : "每天";
  return (
    <ChartCard
      className={className}
      title="回复情绪"
      description={`${unit}收到的入站回复，按 AI 分到的类别统计。`}
      legend={<SeriesStats items={stats} />}
      loading={loading}
      table={<TimeSeriesTable series={series} keys={SENTIMENT_KEYS} bucket={bucket} caption="按情绪统计的回复" />}
    >
      <TimeSeriesChart series={series} keys={SENTIMENT_KEYS} type="stackedBar" bucket={bucket} />
    </ChartCard>
  );
}

/** Category order for every CRM donut: validated adjacent-pair palette, gray last. */
const CATEGORY_ORDER: CrmCategory[] = ["interested", "customer", "not_interested", "other", "unclassified"];

function byCategory(rows: Array<{ categoryKey: CrmCategory; value: number }>): DonutItem[] {
  const totals = new Map<CrmCategory, number>();
  for (const r of rows) totals.set(r.categoryKey, (totals.get(r.categoryKey) ?? 0) + r.value);
  return CATEGORY_ORDER.map((k) => ({ key: k, label: CATEGORY_LABEL[k], value: totals.get(k) ?? 0, color: SENTIMENT_KEYS[k].color }));
}

/** A small label between a card's donut and its list. */
function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 mt-5 border-t border-stroke-soft-200 pt-4 text-subheading-2xs text-text-soft-400">{children}</h3>;
}

export function PipelineCard({ value: pipeline, loading, className }: CardProps<"pipeline">) {
  const ranked = pipeline.filter((p) => p.stageRank !== null);
  const ramp = ordinalRamp(Math.max(ranked.length, 1));
  const stages: BarListItem[] = ranked.map((p, i) => ({ key: `r-${p.subcategoryId ?? i}`, label: `${p.name} · ${CATEGORY_LABEL[p.categoryKey]}`, value: p.count, color: ramp[i] }));
  return (
    <Frame className={className} aria-busy={loading || undefined}>
      <FrameHeader title="当前商机" description="此刻处于各个阶段的在谈记录，以及它们在漏斗里走了多远。" />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        <DonutChart items={byCategory(pipeline.map((p) => ({ categoryKey: p.categoryKey, value: p.count })))} centerLabel="在谈记录" emptyLabel="还没有在谈记录" emptyDescription="客户回复之后，这里会出现记录。" />
        {stages.length > 0 && (
          <>
            <SubHeading>漏斗阶段 · 越往后颜色越深</SubHeading>
            <BarList items={stages} />
          </>
        )}
      </FramePanel>
    </Frame>
  );
}

export function StageMovesCard({ value: entries, loading, className }: CardProps<"stageEntries">) {
  const moved = entries.filter((e) => e.entered > 0);
  const top: BarListItem[] = [...moved]
    .sort((a, b) => b.entered - a.entered)
    .slice(0, 5)
    .map((e) => ({ key: e.subcategoryId, label: `${e.name} · ${CATEGORY_LABEL[e.categoryKey]}`, value: e.entered, color: SENTIMENT_KEYS[e.categoryKey].color }));
  return (
    <Frame className={className} aria-busy={loading || undefined}>
      <FrameHeader title="本期阶段流转" description="这一段时间里被推进到新阶段的记录，按推进到的类别统计。" />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        <DonutChart items={byCategory(moved.map((e) => ({ categoryKey: e.categoryKey, value: e.entered })))} centerLabel="次流转" emptyLabel="本期没有阶段流转" />
        {top.length > 0 && (
          <>
            <SubHeading>流转最多的阶段</SubHeading>
            <BarList items={top} />
          </>
        )}
      </FramePanel>
    </Frame>
  );
}

/**
 * 处理状态的固定顺序与固定颜色：相邻两色已通过色盲可辨性校验。
 * 「待处理」用琥珀、「出错」用红——这两个是销售最需要一眼看到的。
 */
const WORKFLOW_COLOR: Record<string, string> = {
  paused: "#fb4ba3",
  action_required: "#e5930a",
  error: "#fb3748",
  waiting: "#7d52f4",
  closed: "#1daf9c",
  unclassified: "var(--chart-muted-strong)",
  classifying: "var(--chart-muted-strong)",
  idle: MUTED,
};

export function WorkflowCard({ value: workflow, loading, className }: CardProps<"workflow">) {
  const order = Object.keys(WORKFLOW_COLOR);
  const items: DonutItem[] = [...workflow]
    .sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99))
    .map((w) => ({ key: w.key, label: crmWorkflowStateLabel(w.key) || w.label, value: w.value, color: WORKFLOW_COLOR[w.key] ?? MUTED }));
  return (
    <Frame className={className} aria-busy={loading || undefined}>
      <FrameHeader title="处理状态" description="此刻每条记录停在哪个处理状态。" />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        <DonutChart items={items} centerLabel="条记录" emptyLabel="还没有记录" emptyDescription="客户第一次回复后，记录才会出现。" />
      </FramePanel>
    </Frame>
  );
}

/** One figure in the AI card's stat row. */
function AiStat({ label, value, metric, upIsGood, note }: { label: string; value: string; metric?: { value: number | null; previous: number | null }; upIsGood?: boolean; note: string }) {
  return (
    <div className="min-w-0 bg-bg-white-0 px-4 py-3 first:pl-0 last:pr-0">
      <p className="truncate text-paragraph-xs text-text-sub-600">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-title-h6 font-semibold leading-none tracking-tight text-text-strong-950">{value}</p>
        {metric && <DeltaPill metric={metric} upIsGood={upIsGood} />}
      </div>
      <p className="mt-1.5 truncate text-paragraph-xs text-text-soft-400">{note}</p>
    </div>
  );
}

/** Drafts and classification: how much of the AI's work goes out as written. */
export function AiAssistantCard({ crm, loading, className }: { crm: CrmSummary; loading: boolean; className?: string }) {
  const { drafts, kpis } = crm;
  const sent = drafts.sentAsIs + drafts.sentEdited;
  const items: SegmentItem[] = [
    { key: "asIs", label: "原样发出", value: drafts.sentAsIs, color: ORDINAL_BLUE[5] },
    { key: "edited", label: "改过再发", value: drafts.sentEdited, color: ORDINAL_BLUE[0] },
    { key: "discarded", label: "丢弃", value: drafts.discarded, color: MUTED },
  ];
  const empty = items.every((i) => i.value === 0);
  return (
    <Frame className={className} aria-busy={loading || undefined}>
      <FrameHeader
        title="AI 助手"
        description={`本期生成了 ${drafts.generated.toLocaleString("zh-CN")} 封草稿。`}
        actions={
          drafts.awaitingReview > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-bg-white-0 px-2 py-1 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
              <RiDraftLine className="size-3.5" aria-hidden="true" />
              {drafts.awaitingReview.toLocaleString("zh-CN")} 封待复核
            </span>
          ) : undefined
        }
      />
      <FramePanel className={cn("grid gap-4 transition-opacity lg:grid-cols-2 lg:gap-8", loading && "opacity-60")}>
        <div className="grid grid-cols-3 gap-px self-start bg-stroke-soft-200">
          <AiStat label="已发出草稿" value={formatCompact(kpis.draftsSent.value)} metric={kpis.draftsSent} note="AI 起草并已发出的" />
          <AiStat label="已分类回复" value={formatCompact(kpis.classified.value)} metric={kpis.classified} note="AI 打过标签的回复" />
          <AiStat label="改判率" value={formatPercent(kpis.overrideRate.value)} metric={kpis.overrideRate} upIsGood={false} note="人工改过标签的比例" />
        </div>
        <div className="border-t border-stroke-soft-200 pt-4 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          {empty ? (
            <EmptyChart height={120} title="还没有处理过的草稿" description="本期既没有发出的，也没有丢弃的草稿。" />
          ) : (
            <div>
              {sent > 0 && (
                <p className="mb-4 flex items-center gap-2 text-paragraph-sm text-text-strong-950">
                  <RiCheckDoubleLine className="size-4 shrink-0 text-text-sub-600" aria-hidden="true" />
                  <span>
                    发出的草稿里有 <span className="text-label-sm">{formatPercent(drafts.sentAsIs / sent)}</span> 是原样发出的
                    <span className="text-text-sub-600">（{drafts.sentAsIs.toLocaleString("zh-CN")} / {sent.toLocaleString("zh-CN")}）</span>
                  </span>
                </p>
              )}
              <SegmentedBar items={items} />
            </div>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
}
