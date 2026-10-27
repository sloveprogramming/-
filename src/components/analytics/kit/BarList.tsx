import Link from "next/link";
import { cn } from "@/utils/cn";
import { ACCENT, formatCompact } from "../theme";

/**
 * Ranked horizontal bars for breakdowns (pipeline, stage entries). One hue
 * (slot 1) unless an item carries its own colour, because the categories have
 * no order worth encoding in colour. Bar length is relative to the largest
 * value; the value sits at the bar's end in a text token.
 *
 * Props: `items` [{ key, label, value, color?, href? }], `valueFormat`,
 * `max` (override the scale, e.g. a shared max across two lists),
 * `emptyLabel` shown when there are no items.
 */
export type BarListItem = { key: string; label: string; value: number; color?: string; href?: string };

export function BarList({ items, valueFormat = formatCompact, max, emptyLabel = "没有可显示的数据。" }: { items: BarListItem[]; valueFormat?: (value: number) => string; max?: number; emptyLabel?: string }) {
  if (items.length === 0) return <p className="rounded-xl bg-bg-weak-50 px-4 py-6 text-center text-paragraph-sm text-text-sub-600">{emptyLabel}</p>;
  const scale = max ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const content = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-paragraph-sm text-text-sub-600">{item.label}</span>
              <span className="shrink-0 text-label-sm text-text-strong-950">{valueFormat(item.value)}</span>
            </div>
            <div className="mt-1.5 h-2 w-full rounded-full bg-bg-weak-50">
              <div className="h-full rounded-r-[4px] rounded-l-full" style={{ width: `${Math.max((item.value / scale) * 100, item.value > 0 ? 1.5 : 0)}%`, backgroundColor: item.color ?? ACCENT }} />
            </div>
          </>
        );
        return (
          <li key={item.key}>
            {item.href ? (
              <Link href={item.href} className={cn("block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary-base")}>
                {content}
              </Link>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ul>
  );
}
