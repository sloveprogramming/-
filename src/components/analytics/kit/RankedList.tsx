import Link from "next/link";
import { cn } from "@/utils/cn";
import { ACCENT } from "../theme";
import { DeltaPill } from "./DeltaPill";

/**
 * Ranked rows for "top X" breakdowns (campaigns, mailboxes, pipeline stages):
 * a leading icon chip, name with a muted subline, right-aligned value with a
 * sub-value, an optional trend pill, and an optional thin bar showing share.
 * Hairline dividers between rows.
 *
 * Props: `items` [{ key, label, sublabel?, value (string), subvalue?, icon?,
 * trend? { metric, upIsGood? }, share? 0..1, color?, href? }].
 */
export type RankedItem = {
  key: string;
  label: string;
  sublabel?: string;
  value: string;
  subvalue?: string;
  icon?: React.ComponentType<{ className?: string }>;
  trend?: { metric: { value: number | null; previous: number | null }; upIsGood?: boolean };
  share?: number;
  color?: string;
  href?: string;
};

export function RankedList({ items, emptyLabel = "没有可显示的数据。" }: { items: RankedItem[]; emptyLabel?: string }) {
  if (items.length === 0) return <p className="rounded-xl bg-bg-weak-50 px-4 py-6 text-center text-paragraph-sm text-text-sub-600">{emptyLabel}</p>;
  return (
    <ul className="divide-y divide-stroke-soft-200">
      {items.map((item) => {
        const Icon = item.icon;
        const body = (
          <>
            <div className="flex items-center gap-3">
              {Icon && (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200">
                  <Icon className="size-4 text-text-sub-600" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-label-sm text-text-strong-950">{item.label}</p>
                {item.sublabel && <p className="truncate text-paragraph-xs text-text-sub-600">{item.sublabel}</p>}
              </div>
              {item.trend && <DeltaPill metric={item.trend.metric} upIsGood={item.trend.upIsGood} />}
              <div className="shrink-0 text-right">
                <p className="text-label-sm tabular-nums text-text-strong-950">{item.value}</p>
                {item.subvalue && <p className="text-paragraph-xs tabular-nums text-text-sub-600">{item.subvalue}</p>}
              </div>
            </div>
            {item.share !== undefined && (
              <div className={cn("mt-2 h-1 rounded-full bg-bg-weak-50", Icon && "ml-11")}>
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, item.share * 100))}%`, backgroundColor: item.color ?? ACCENT }} />
              </div>
            )}
          </>
        );
        return (
          <li key={item.key} className="py-3 first:pt-0 last:pb-0">
            {item.href ? (
              <Link href={item.href} className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary-base">
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
