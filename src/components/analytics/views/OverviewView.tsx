"use client";

import {
  RiAlarmWarningLine,
  RiArrowRightSLine,
  RiCalendarEventLine,
  RiCheckboxCircleLine,
  RiDraftLine,
  RiInboxLine,
  RiMailForbidLine,
  RiReplyLine,
  RiThumbUpLine,
  RiTimerLine,
  RiTrophyLine,
} from "@remixicon/react";
import * as Table from "@/components/alignui/table";
import type { AnalyticsView, OverviewAnalytics } from "@/lib/analytics/contract";
import { cn } from "@/utils/cn";
import { ChartCard } from "../kit/ChartCard";
import { Frame, FrameHeader, FramePanel } from "../kit/Frame";
import { FunnelChart } from "../kit/FunnelChart";
import { KpiCell, KpiStrip } from "../kit/KpiStrip";
import { ProgressList, type ProgressTone } from "../kit/ProgressList";
import { SectionHeading } from "../kit/SectionHeading";
import { CHANNEL_META, formatCompact, formatMinutes, formatPercent } from "../theme";
import { AiAssistantCard, PipelineCard, SentimentCard, StageMovesCard, WorkflowCard } from "./CrmCards";
import type { ViewProps } from "./types";

/**
 * 总览：先看 CRM——回复量、情绪、待处理、商机、阶段流转、AI 助手；
 * 再看是什么在喂养它——渠道表现与本期漏斗。
 *
 * 改造：全部中文化，并去掉 LinkedIn / WhatsApp 两条「账号掉线」提醒——那两个频道
 * 已经删除，指向的设置页也不存在了。
 */

const HINTS = {
  replies: "本期 CRM 会话里收到的入站消息，所有渠道合计。",
  positive: "本期被推进到「有意向」或「已成交客户」的记录数。",
  meetings: "本期被推进到约见、见面类阶段的记录数（含索样）。爽约不计。",
  customers: "本期被推进到「已成交客户」的记录数。",
  response: "从对方发来消息，到我们回过去，中间耗时的中位数。",
};

export function OverviewView({ data, loading, onSelectView }: ViewProps<"overview">) {
  const { kpis, range, crm } = data;
  const vsPrevious = (m: { previous: number | null }) => (m.previous === null ? undefined : `上期 ${formatCompact(m.previous)}`);
  const replySpark = crm.repliesByCategory.points.map((p) => crm.repliesByCategory.keys.reduce((sum, k) => sum + p[k], 0));
  const response = crm.kpis.medianFirstResponseMinutes;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
      <KpiStrip className="lg:col-span-12" columns={5}>
        <KpiCell icon={RiReplyLine} label="回复数" value={formatCompact(crm.kpis.replies.value)} metric={crm.kpis.replies} hint={HINTS.replies} context={`来自 ${formatCompact(kpis.replied.value)} 位客户`} spark={replySpark} />
        <KpiCell icon={RiThumbUpLine} label="有意向" value={formatCompact(kpis.positive.value)} metric={kpis.positive} hint={HINTS.positive} context={kpis.replied.value > 0 ? `占有回复客户的 ${formatPercent(kpis.positive.value / kpis.replied.value)}` : vsPrevious(kpis.positive)} />
        <KpiCell icon={RiCalendarEventLine} label="约见 / 见面" value={formatCompact(kpis.meetings.value)} metric={kpis.meetings} hint={HINTS.meetings} context={vsPrevious(kpis.meetings)} />
        <KpiCell icon={RiTrophyLine} label="成交客户" value={formatCompact(kpis.customers.value)} metric={kpis.customers} hint={HINTS.customers} context={vsPrevious(kpis.customers)} />
        <KpiCell icon={RiTimerLine} label="首次响应中位数" value={formatMinutes(response.value)} metric={response} upIsGood={false} hint={HINTS.response} context={response.previous === null ? undefined : `上期 ${formatMinutes(response.previous)}`} />
      </KpiStrip>

      <SentimentCard className="lg:col-span-8" series={crm.repliesByCategory} bucket={range.bucket} loading={loading} />
      <AttentionCard attention={data.attention} loading={loading} />

      <PipelineCard className="lg:col-span-6 lg:self-start" value={crm.pipeline} loading={loading} />
      {/* 商机环比较高，右边两张短卡叠放。 */}
      <div className="flex flex-col gap-4 lg:col-span-6 lg:gap-5">
        <StageMovesCard value={crm.stageEntries} loading={loading} />
        <WorkflowCard value={crm.workflow} loading={loading} />
      </div>

      <AiAssistantCard className="lg:col-span-12" crm={crm} loading={loading} />

      <SectionHeading className="mt-2 lg:col-span-12" title="触达情况" description="上面这些对话是从哪来的。点一行进入该渠道的明细。" />
      <ChannelTable data={data} loading={loading} onSelectView={onSelectView} />
      <ChartCard className="lg:col-span-4" title="转化漏斗" description="从第一次触达到成交。" loading={loading} footer="这是本期发生的次数，不是一批客户的完整旅程。">
        <FunnelChart stages={data.funnel} />
      </ChartCard>
    </div>
  );
}

function ChannelTable({ data, loading, onSelectView }: { data: OverviewAnalytics; loading: boolean; onSelectView?: (view: AnalyticsView) => void }) {
  const maxRate = Math.max(...data.channels.map((c) => c.replyRate ?? 0), 0.0001);
  return (
    <Frame className="lg:col-span-8">
      <FrameHeader title="渠道表现" description="本期各渠道的数据。点一行进入该渠道的明细。" />
      <FramePanel className={cn("p-2 transition-opacity sm:p-3", loading && "opacity-60")}>
      <Table.Root>
        <Table.Caption className="sr-only">渠道对比</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head scope="col">渠道</Table.Head>
            <Table.Head scope="col" className="text-right">触达</Table.Head>
            <Table.Head scope="col" className="text-right">回复</Table.Head>
            <Table.Head scope="col">回复率</Table.Head>
            <Table.Head scope="col" className="text-right">有意向</Table.Head>
            <Table.Head scope="col" className="w-8"><span className="sr-only">打开</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body spacing={4}>
          {data.channels.map((row) => {
            const meta = CHANNEL_META[row.channel];
            const Icon = meta.icon;
            return (
              <Table.Row key={row.channel} className="cursor-pointer" onClick={() => onSelectView?.(row.channel)}>
                <Table.Cell className="h-12">
                  <button type="button" onClick={(e) => { e.stopPropagation(); onSelectView?.(row.channel); }} className="flex items-center gap-2.5 rounded-md text-label-sm text-text-strong-950 outline-none focus-visible:ring-2 focus-visible:ring-primary-base">
                    <span className="flex size-6 items-center justify-center rounded-md" style={{ backgroundColor: meta.color }}>
                      <Icon className="size-4 text-white" />
                    </span>
                    {meta.label}
                  </button>
                </Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.reached)}</Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.replied)}</Table.Cell>
                <Table.Cell className="h-12">
                  <div className="flex items-center gap-3">
                    <span className="w-12 text-paragraph-sm tabular-nums text-text-strong-950">{formatPercent(row.replyRate)}</span>
                    <span aria-hidden="true" className="h-1.5 w-24 rounded-full bg-bg-weak-50">
                      <span className="block h-full rounded-full" style={{ width: `${((row.replyRate ?? 0) / maxRate) * 100}%`, backgroundColor: meta.color }} />
                    </span>
                  </div>
                </Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.positive)}</Table.Cell>
                <Table.Cell className="h-12 w-8 text-text-soft-400"><RiArrowRightSLine className="size-4" aria-hidden="true" /></Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      </FramePanel>
    </Frame>
  );
}

type AttentionItem = { key: keyof OverviewAnalytics["attention"]; label: string; hint: string; href: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; tone: ProgressTone };

const ATTENTION: AttentionItem[] = [
  { key: "actionRequired", label: "待处理", hint: "在等我们回复的对话", href: "/crm/actions", icon: RiInboxLine, tone: "serious" },
  { key: "overdue", label: "逾期跟进", hint: "已起草或已过预定时间的跟进", href: "/crm/actions", icon: RiAlarmWarningLine, tone: "critical" },
  { key: "draftsAwaitingReview", label: "待复核草稿", hint: "AI 写好、等人确认的回复", href: "/crm/actions", icon: RiDraftLine, tone: "warning" },
  { key: "mailboxesFailing", label: "发信邮箱异常", hint: "发不出信的邮箱", href: "/settings/email-accounts", icon: RiMailForbidLine, tone: "critical" },
];

function AttentionCard({ attention, loading }: { attention: OverviewAnalytics["attention"]; loading: boolean }) {
  const anyOpen = ATTENTION.some((item) => attention[item.key] > 0);
  return (
    <Frame className="lg:col-span-4">
      <FrameHeader title="需要关注" description="此刻的状态，与所选时间范围无关。" />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        {anyOpen ? (
          <ProgressList
            items={ATTENTION.map((item) => ({
              key: item.key,
              label: item.label,
              value: attention[item.key],
              subline: item.hint,
              tone: attention[item.key] > 0 ? item.tone : "neutral",
              icon: attention[item.key] > 0 ? item.icon : undefined,
              href: item.href,
            }))}
          />
        ) : (
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
            <RiCheckboxCircleLine className="size-6 text-success-base" aria-hidden="true" />
            <p className="mt-2 text-label-sm text-text-strong-950">都处理完了</p>
            <p className="mt-0.5 text-paragraph-xs text-text-sub-600">没有待回复的对话，也没有异常的账号。</p>
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}
