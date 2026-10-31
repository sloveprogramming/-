"use client";

import { RiBarChartBoxLine, RiTable2 } from "@remixicon/react";
import { useState } from "react";
import { cn } from "@/utils/cn";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "./Frame";

/**
 * A Frame for a chart: header (title, description, actions, table toggle), a
 * white panel holding the series stats / legend and the plot, and an optional
 * footer note.
 *
 * Props:
 * - title, description
 * - actions: header controls (SegmentedControl, Select, badge…), left of the toggle
 * - legend: node at the top of the panel — use <SeriesStats> (values + deltas
 *   double as the legend), or render a custom legend
 * - table: the DataTableView twin; when given, an icon toggle swaps `children`
 *   for it. Every chart should pass one.
 * - footer: note under the panel
 * - loading: refetching — content stays rendered at reduced opacity
 * - className: grid placement, e.g. "lg:col-span-8"
 */
export function ChartCard({
  title,
  description,
  actions,
  legend,
  table,
  footer,
  loading,
  className,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  legend?: React.ReactNode;
  table?: React.ReactNode;
  footer?: React.ReactNode;
  loading?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const toggle = table ? (
    <button
      type="button"
      onClick={() => setShowTable((v) => !v)}
      aria-pressed={showTable}
      aria-label={showTable ? "图表" : "表格"}
      title={showTable ? "图表" : "表格"}
      className={cn("flex size-8 items-center justify-center rounded-lg bg-bg-white-0 text-text-sub-600 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base", showTable && "text-text-strong-950")}
    >
      {showTable ? <RiBarChartBoxLine className="size-4" aria-hidden="true" /> : <RiTable2 className="size-4" aria-hidden="true" />}
    </button>
  ) : null;
  return (
    <Frame className={className} aria-busy={loading || undefined}>
      <FrameHeader
        title={title}
        description={description}
        actions={
          <>
            {actions}
            {toggle}
          </>
        }
      />
      <FramePanel className={cn("transition-opacity duration-200", loading && "opacity-60")}>
        {legend && !showTable && <div className="mb-4">{legend}</div>}
        {showTable && table ? table : children}
      </FramePanel>
      {footer && <FrameFooter>{footer}</FrameFooter>}
    </Frame>
  );
}
