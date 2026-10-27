"use client";

import { useState } from "react";
import {
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiForbid2Line,
  RiLoader4Line,
  RiMailCheckLine,
  RiMailSendLine,
  RiReplyLine,
  RiTeamLine,
  RiTimeLine,
} from "@remixicon/react";

import * as SegmentedControl from "@/components/alignui/segmented-control";
import { ChartCard } from "@/components/analytics/kit/ChartCard";
import { DonutChart, type DonutItem } from "@/components/analytics/kit/DonutChart";
import { EmptyChart } from "@/components/analytics/kit/EmptyChart";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { FunnelChart } from "@/components/analytics/kit/FunnelChart";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { SeriesStats } from "@/components/analytics/kit/SeriesStats";
import { seriesTotal, TimeSeriesChart, TimeSeriesTable, type SeriesKeys } from "@/components/analytics/kit/TimeSeriesChart";
import { CHANNEL_META, formatCompact, formatPercent, MUTED, STATUS } from "@/components/analytics/theme";
import type { DailySends } from "@/lib/outreach/campaigns";

type Stats = {
  totalLeads: number;
  pending: number;
  inSequence: number;
  replied: number;
  completed: number;
  bounced: number;
  suppressed: number;
  emailsSent: number;
  emailsScheduled: number;
  emailsFailed: number;
  emailsTotal: number;
  contacted: number;
};
type StepBreakdown = { stepNumber: number; sent: number }[];

/**
 * A send campaign's analytics, in the Analytics kit: headline numbers, where
 * every lead stands (a donut — the states are exclusive and sum to the
 * leads), daily send volume, and how many leads each step reached.
 *
 * Colour: sent wears the email channel colour, as on the Analytics Email
 * view; scheduled is the de-emphasis gray (it hasn't happened); failed is the
 * critical status colour, labelled. Lead states are ordered so adjacent
 * slices, and the ring's seam, pass the colour-blind check.
 */

const EMAIL = CHANNEL_META.email.color;

type SendKey = "sent" | "scheduled" | "failed";
const SEND_KEYS: SeriesKeys<SendKey> = {
  sent: { label: "已发送", color: EMAIL },
  scheduled: { label: "定时发送", color: MUTED },
  failed: { label: "发送失败", color: STATUS.critical },
};

const RANGES = [7, 14, 30] as const;
type Range = (typeof RANGES)[number];

function pct(part: number, whole: number, digits?: number): string | undefined {
  return whole > 0 ? formatPercent(part / whole, digits) : undefined;
}

export default function AnalyticsTab({ stats, stepBreakdown, dailySends }: { stats: Stats; stepBreakdown: StepBreakdown; dailySends: DailySends }) {
  const [range, setRange] = useState<Range>(14);
  const blocked = stats.bounced + stats.suppressed;
  const progress = stats.emailsTotal > 0 ? stats.emailsSent / stats.emailsTotal : 0;

  const series = { keys: ["sent", "scheduled", "failed"] as const, points: dailySends.slice(-range) };
  const sendStats = (Object.keys(SEND_KEYS) as SendKey[]).map((k) => ({ label: SEND_KEYS[k].label, color: SEND_KEYS[k].color, value: formatCompact(seriesTotal(series, k)) }));

  const leadStates: DonutItem[] = [
    { key: "inSequence", label: "进行中", value: stats.inSequence, color: "#e5930a", icon: RiLoader4Line },
    { key: "pending", label: "尚未开始", value: stats.pending, color: MUTED, icon: RiTimeLine },
    { key: "completed", label: "已完成", value: stats.completed, color: STATUS.good, icon: RiCheckboxCircleLine },
    { key: "replied", label: "已回复", value: stats.replied, color: "#7d52f4", icon: RiReplyLine },
    { key: "blocked", label: "退信或已退订", value: blocked, color: STATUS.critical, icon: RiForbid2Line },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
      <KpiStrip className="lg:col-span-12" columns={6}>
        <KpiCell icon={RiTeamLine} label="联系人" value={formatCompact(stats.totalLeads)} context="本活动内" />
        <KpiCell icon={RiMailCheckLine} label="已触达" value={formatCompact(stats.contacted)} context={pct(stats.contacted, stats.totalLeads) ? `占全部 ${pct(stats.contacted, stats.totalLeads)}` : undefined} />
        <KpiCell icon={RiMailSendLine} label="已发邮件" value={formatCompact(stats.emailsSent)} context={stats.emailsScheduled > 0 ? `${stats.emailsScheduled.toLocaleString("zh-CN")} 封待发` : "没有待发邮件"} />
        <KpiCell icon={RiReplyLine} label="已回复" value={formatCompact(stats.replied)} context={pct(stats.replied, stats.contacted, 2) ? `占已触达 ${pct(stats.replied, stats.contacted, 2)}` : undefined} hint="回复过任意一步的联系人。回复不归属到具体某一步。" />
        <KpiCell icon={RiForbid2Line} label="退信" value={formatCompact(stats.bounced)} context={pct(stats.bounced, stats.contacted, 1) ? `占已触达 ${pct(stats.bounced, stats.contacted, 1)}` : undefined} />
        <KpiCell icon={RiErrorWarningLine} label="发送失败" value={formatCompact(stats.emailsFailed)} context={stats.emailsFailed > 0 ? "检查对应的发信邮箱" : "无"} />
      </KpiStrip>

      <Frame className="lg:col-span-5">
        <FrameHeader title="联系人分布" description="活动内的全部联系人，按他们在序列中的位置分布。" />
        <FramePanel>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-paragraph-sm text-text-sub-600">
              <span className="text-title-h5 font-semibold tracking-tight text-text-strong-950">{formatPercent(progress, 1)}</span> 已完成发送
            </p>
            <p className="text-paragraph-xs tabular-nums text-text-sub-600">
              {stats.emailsSent.toLocaleString("zh-CN")} / {stats.emailsTotal.toLocaleString("zh-CN")}
            </p>
          </div>
          <div className="mb-5 mt-2 h-2 overflow-hidden rounded-full bg-bg-weak-50" role="progressbar" aria-label="已完成发送" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${progress * 100}%`, backgroundColor: EMAIL }} />
          </div>
          <DonutChart items={leadStates} centerLabel="联系人" emptyLabel="还没有联系人" emptyDescription="添加联系人后就能看到分布。" />
        </FramePanel>
      </Frame>

      <ChartCard
        className="lg:col-span-7"
        title="发送活动"
        description="每天已发送、待发送与发送失败的邮件数量。"
        actions={
          <SegmentedControl.Root value={String(range)} onValueChange={(v) => setRange(Number(v) as Range)}>
            <SegmentedControl.List className="w-auto">
              {RANGES.map((r) => (
                <SegmentedControl.Trigger key={r} value={String(r)} className="px-3">{r}d</SegmentedControl.Trigger>
              ))}
            </SegmentedControl.List>
          </SegmentedControl.Root>
        }
        legend={<SeriesStats items={sendStats} />}
        table={<TimeSeriesTable series={series} keys={SEND_KEYS} bucket="day" caption="每日发送量" />}
      >
        <TimeSeriesChart series={series} keys={SEND_KEYS} type="stackedBar" bucket="day" />
      </ChartCard>

      <Frame className="lg:col-span-12">
        <FrameHeader title="各步骤发送量" description="每一步触达了多少联系人。回复按整个活动统计，不归属到具体步骤。" />
        <FramePanel>
          {stepBreakdown.length === 0 ? (
            <EmptyChart height={140} title="还没有发送记录" description="活动开始发送后，这里会按步骤填充数据。" />
          ) : (
            <FunnelChart layout="tiles" stages={stepBreakdown.map((s) => ({ key: String(s.stepNumber), label: `第 ${s.stepNumber} 步`, value: s.sent }))} />
          )}
        </FramePanel>
      </Frame>
    </div>
  );
}
