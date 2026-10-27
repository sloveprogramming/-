import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import { change as changeOf } from "@/lib/analytics/contract";
import { deltaTone, formatPercent } from "../theme";

/**
 * Change vs the previous period as a pill: "↑ 63.7%" in green when good, red
 * when bad (`upIsGood` flips it), gray when flat. When there is no base to
 * compare with it says "New" (previous was 0) or "—" (unknown), never ∞.
 *
 * Props: `metric` { value, previous } (nulls allowed), `upIsGood` (default true).
 */
export function DeltaPill({ metric, upIsGood = true }: { metric: { value: number | null; previous: number | null }; upIsGood?: boolean }) {
  const c = changeOf(metric.value, metric.previous);
  if (c === null) {
    const isNew = metric.previous === 0 && (metric.value ?? 0) > 0;
    return (
      <Badge.Root variant="lighter" color="gray" size="medium" title={isNew ? "上期没有数据" : "没有上期数据可对比"}>
        {isNew ? "New" : "—"}
      </Badge.Root>
    );
  }
  const tone = deltaTone(c, upIsGood);
  const Icon = c >= 0 ? RiArrowUpLine : RiArrowDownLine;
  const word = tone === "good" ? "improved" : tone === "bad" ? "worsened" : "unchanged";
  return (
    <Badge.Root variant="lighter" color={tone === "good" ? "green" : tone === "bad" ? "red" : "gray"} size="medium">
      <Badge.Icon as={Icon} />
      {Math.abs(c) >= 10 ? ">999%" : formatPercent(Math.abs(c), 1)}
      <span className="sr-only"> {word} versus the previous period</span>
    </Badge.Root>
  );
}
