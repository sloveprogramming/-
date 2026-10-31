"use client";

import { RiAddLine, RiCloseLine, RiTableLine } from "@remixicon/react";
import type { ReactNode } from "react";

export function AddRowsControl(props: {
  addRows: number;
  busy: boolean;
  onAdd: () => void;
  onCountChange: (count: number) => void;
}) {
  return (
    <div className="flex h-full items-center gap-2 bg-bg-white-0 px-3">
      <button
        type="button"
        onClick={props.onAdd}
        disabled={props.busy}
        className="flex items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-2.5 py-[7px] text-[13px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50 disabled:opacity-50"
      >
        <RiAddLine className="size-4" />
        Add
      </button>
      <input
        type="number"
        min={1}
        max={1000}
        value={props.addRows}
        onChange={(event) =>
          props.onCountChange(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))
        }
        className="w-[68px] rounded-lg border border-stroke-soft-200 px-2 py-[7px] text-[13px] text-text-strong-950 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
      <span className="text-[13px] text-text-sub-600">more rows at the bottom</span>
    </div>
  );
}

/** Floating message over the grid: it never moves the rows underneath it. */
export function Toast({ tone, onClose, children }: { tone: "error" | "success"; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className={`pointer-events-auto flex max-w-xl items-start gap-2 rounded-lg border px-3 py-2 text-[13px] shadow-lg ${
        tone === "error"
          ? "border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400"
          : "border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-400"
      }`}
    >
      <span className="min-w-0 flex-1 break-words">{children}</span>
      <button type="button" aria-label="Dismiss" onClick={onClose} className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100">
        <RiCloseLine className="size-4" />
      </button>
    </div>
  );
}

export function ToolbarToggle({
  icon: Icon,
  label,
  title,
  active,
  highlight,
  onClick,
}: {
  icon: typeof RiTableLine;
  label?: string;
  title?: string;
  active?: boolean;
  highlight?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition ${
        active
          ? "bg-bg-weak-50 text-text-strong-950"
          : highlight
            ? "bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/15"
            : "text-text-strong-950 hover:bg-bg-weak-50"
      }`}
    >
      <Icon className={`size-4 ${highlight && !active ? "text-blue-500" : "text-text-soft-400"}`} />
      {label}
    </button>
  );
}
