import { RiAlertLine, RiErrorWarningLine } from "@remixicon/react";
import { ACCENT, formatPercent, STATUS } from "../theme";
import { DeltaPill } from "./DeltaPill";

/**
 * Big-number capacity meter: a large percentage (optionally with a delta), then
 * a row of thin vertical ticks — filled in the accent, unfilled in soft gray.
 * The fill turns warning at 80% and critical at 100%, and the state is also
 * written out with an icon and label. Use for account-level capacity ("120 of
 * 3,000 sent today"); use CapacityMeter for the compact per-row version.
 *
 * Props: `label`, `used`, `limit`, `caption` (default "used of limit"), `ticks`
 * (default 48), `delta` { value, previous } (optional).
 */
export function TickMeter({ label, used, limit, caption, ticks = 48, delta }: { label: string; used: number; limit: number; caption?: string; ticks?: number; delta?: { value: number | null; previous: number | null } }) {
  const fraction = limit > 0 ? used / limit : 0;
  const state = fraction >= 1 ? "critical" : fraction >= 0.8 ? "warning" : "ok";
  const color = state === "critical" ? STATUS.critical : state === "warning" ? STATUS.warning : ACCENT;
  const filled = used <= 0 ? 0 : Math.min(ticks, Math.max(1, Math.round(fraction * ticks)));
  return (
    <div>
      <p className="text-paragraph-sm text-text-sub-600">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-title-h4 font-semibold leading-none tracking-tight text-text-strong-950">{formatPercent(fraction, 0)}</span>
        {delta && <DeltaPill metric={delta} />}
        {state !== "ok" && (
          <span className="flex items-center gap-1 text-label-xs text-text-sub-600">
            {state === "critical" ? <RiErrorWarningLine className="size-4" style={{ color }} aria-hidden="true" /> : <RiAlertLine className="size-4" style={{ color }} aria-hidden="true" />}
            {state === "critical" ? "已达上限" : "接近上限"}
          </span>
        )}
      </div>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} className="mt-4 flex h-5 items-end gap-0.5">
        {Array.from({ length: ticks }, (_, i) => (
          <span key={i} className="h-full min-w-0 flex-1 rounded-full" style={{ backgroundColor: i < filled ? color : "var(--color-bg-soft-200)", maxWidth: 3 }} />
        ))}
      </div>
      <p className="mt-2 text-paragraph-xs text-text-sub-600">{caption ?? `${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")}`}</p>
    </div>
  );
}
