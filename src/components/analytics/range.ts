import { addDays, ANALYTICS_VIEWS, type AnalyticsView } from "@/lib/analytics/contract";

/** Date-range and view URL helpers. Pure (no "use client") so the server page can use them too. */

export const RANGE_PRESETS = [
  { key: "7d", label: "最近 7 天" },
  { key: "30d", label: "最近 30 天" },
  { key: "90d", label: "最近 90 天" },
  { key: "this-month", label: "本月" },
  { key: "last-month", label: "上个月" },
] as const;
export type PresetKey = (typeof RANGE_PRESETS)[number]["key"];
export type RangeSelection = { kind: "preset"; key: PresetKey } | { kind: "custom"; from: string; to: string };

export const DEFAULT_RANGE: RangeSelection = { kind: "preset", key: "30d" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseView(value: string | undefined): AnalyticsView {
  return (ANALYTICS_VIEWS as readonly string[]).includes(value ?? "") ? (value as AnalyticsView) : "overview";
}

export function parseRange(value: string | undefined): RangeSelection {
  if (!value) return DEFAULT_RANGE;
  const preset = RANGE_PRESETS.find((p) => p.key === value);
  if (preset) return { kind: "preset", key: preset.key };
  const [from, to] = value.split("..");
  if (from && to && DATE_RE.test(from) && DATE_RE.test(to) && from <= to) return { kind: "custom", from, to };
  return DEFAULT_RANGE;
}

export function serializeRange(selection: RangeSelection): string {
  return selection.kind === "preset" ? selection.key : `${selection.from}..${selection.to}`;
}

export function resolveRange(selection: RangeSelection, today: string): { from: string; to: string } {
  if (selection.kind === "custom") return { from: selection.from, to: selection.to };
  switch (selection.key) {
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "this-month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "last-month": {
      const firstOfThis = `${today.slice(0, 8)}01`;
      const to = addDays(firstOfThis, -1);
      return { from: `${to.slice(0, 8)}01`, to };
    }
    default:
      return { from: addDays(today, -29), to: today };
  }
}

