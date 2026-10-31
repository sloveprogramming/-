"use client";

import {
  RiAddLine,
  RiArrowDownSLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiLoader4Line,
  RiPlayLine,
  RiTimeLine,
} from "@remixicon/react";
import type { ICellRendererParams, IHeaderParams } from "ag-grid-community";
import * as Checkbox from "@/components/alignui/checkbox";
import { getIntegration } from "@/lib/integrations/catalog";
import type { CellMeta, ColumnType } from "@/lib/grid/types";
import { displayHref } from "@/lib/grid/value-types";
import IntegrationIcon from "./IntegrationIcon";
import { columnTypeMeta } from "./columnTypes";
import type { RowData } from "./grid-model";

/** Type icon + name, matching Clay's "T New Column". */
export function ColumnHeader(props: IHeaderParams & {
  colType: ColumnType;
  valueType?: ColumnType;
  integrationKey?: string;
  active?: boolean;
  onSelect: (extend: boolean) => void;
  onOpen: (rect: DOMRect) => void;
  onRun?: (rect: DOMRect) => void;
}) {
  const meta = columnTypeMeta(props.valueType ?? props.colType);
  const integration = props.integrationKey ? getIntegration(props.integrationKey) : null;
  const iconClass = props.active ? "text-white" : "text-text-sub-600";
  const icon = integration && props.colType === "enrichment" ? (
    <IntegrationIcon integration={integration} size={17} className="rounded" />
  ) : integration && props.colType === "integration_output" ? (
    <span className="flex shrink-0 items-center gap-1">
      <IntegrationIcon integration={integration} size={14} className="rounded" />
      <meta.icon className={`size-[14px] ${iconClass}`} />
    </span>
  ) : props.colType === "formula" ? (
    <span className={`w-[15px] shrink-0 text-center font-serif text-[18px] italic leading-none ${iconClass}`}>ƒ</span>
  ) : (
    <meta.icon className={`size-[15px] shrink-0 ${iconClass}`} />
  );
  return (
    <div className={`-mx-3 flex h-full w-[calc(100%+24px)] items-center overflow-hidden transition ${props.active ? "bg-blue-600 text-white" : "hover:bg-bg-weak-50"}`}>
      <button
        type="button"
        title="Select column (Shift-click to extend)"
        onClick={(event) => props.onSelect(event.shiftKey)}
        onDoubleClick={(event) => {
          event.preventDefault();
          props.onOpen(event.currentTarget.getBoundingClientRect());
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-3 text-left"
      >
        {icon}
        <span className={`truncate font-semibold ${props.active ? "text-white" : "text-text-strong-950"}`}>{props.displayName}</span>
      </button>
      <button
        type="button"
        title={`Configure ${props.displayName}`}
        aria-label={`Configure ${props.displayName}`}
        onClick={(event) => {
          event.stopPropagation();
          props.onOpen(event.currentTarget.getBoundingClientRect());
        }}
        className={`rounded-md p-1 ${props.active ? "text-white hover:bg-blue-500" : "text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-strong-950"}`}
      >
        <RiArrowDownSLine className="size-4" />
      </button>
      {props.onRun && (
        <button type="button" title="Run column" aria-label={`Run ${props.displayName}`} onClick={(event) => { event.stopPropagation(); props.onRun?.(event.currentTarget.getBoundingClientRect()); }} className={`mr-1 rounded-md border p-1.5 ${props.active ? "border-blue-400 text-white hover:bg-blue-500" : "border-stroke-soft-200 bg-bg-white-0 text-text-strong-950 hover:bg-bg-weak-50"}`}>
          <RiPlayLine className="size-4" />
        </button>
      )}
    </div>
  );
}

/** The trailing "+ Add column" header cell. */
export function AddColumnHeader(props: IHeaderParams & { onOpen: (rect: DOMRect) => void }) {
  return (
    <button
      type="button"
      onClick={(event) => props.onOpen(event.currentTarget.getBoundingClientRect())}
      className="-mx-3 flex h-full w-[calc(100%+24px)] items-center gap-1.5 px-3 text-text-sub-600 transition hover:bg-bg-weak-50"
    >
      <RiAddLine className="size-[15px] shrink-0" />
      <span className="font-medium">Add column</span>
    </button>
  );
}

/** Selection gutter: keep row numbers visible until hover, then reveal selection. */
export function GutterHeader(props: IHeaderParams & {
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex size-full items-center justify-center">
      <Checkbox.Root
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(checked !== false)}
        aria-label="Select all rows on this page"
      />
    </div>
  );
}

export function GutterCell(props: ICellRendererParams<RowData> & {
  isSelected: (rowId: string) => boolean;
  onToggle: (rowId: string) => void;
}) {
  if (props.node.rowPinned === "top") {
    return <span className="text-[11px] font-medium text-text-soft-400">%</span>;
  }
  const rowOffset = Number((props as ICellRendererParams<RowData> & { rowOffset?: number }).rowOffset ?? 0);
  const selected = props.isSelected(props.data!.__id);
  return (
    <div className="group relative flex size-full items-center justify-center">
      <span className={`text-[11px] tabular-nums text-text-soft-400 ${selected ? "hidden" : "group-hover:hidden group-focus-within:hidden"}`}>
        {rowOffset + (props.node.rowIndex ?? 0) + 1}
      </span>
      <Checkbox.Root
        checked={selected}
        onCheckedChange={() => props.onToggle(props.data!.__id)}
        aria-label={`${selected ? "Deselect" : "Select"} row ${rowOffset + (props.node.rowIndex ?? 0) + 1}`}
        className={`absolute inset-0 m-auto ${selected ? "" : "invisible group-hover:visible group-focus-within:visible"}`}
      />
    </div>
  );
}

/** A run that finished without finding anything (the server marks it outcome "miss"). */
function isMiss(meta: CellMeta | undefined): boolean {
  return (meta as { outcome?: string } | undefined)?.outcome === "miss";
}

/** A run that finished without finding anything, as opposed to one that has not run. */
const NO_RESULT = <span className="italic text-text-soft-400">No result</span>;

export function IntegrationActionCell(props: ICellRendererParams<RowData> & { onRun?: (rowId: string) => void; disabled?: boolean }) {
  if (props.node.rowPinned === "top") return props.value ?? "";
  const meta = props.data?.__meta?.[props.colDef?.field ?? ""] as CellMeta | undefined;
  const inProgress = meta?.status === "queued" || meta?.status === "running" || meta?.status === "processing";

  let content: React.ReactNode;
  if (meta?.status === "queued") {
    content = <span className="flex items-center gap-1.5 text-text-sub-600"><RiTimeLine className="size-4" />Queued…</span>;
  } else if (meta?.status === "running") {
    content = <span className="flex items-center gap-1.5 text-text-sub-600"><RiLoader4Line className="size-4 animate-spin" />Running…</span>;
  } else if (meta?.status === "processing") {
    content = <span className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400"><RiLoader4Line className="size-4 animate-spin" />Waiting for provider…</span>;
  } else if (meta?.status === "error") {
    content = <span title={meta.error} className="flex items-center gap-1.5 truncate font-medium text-red-700 dark:text-red-400"><RiCloseCircleLine className="size-4 shrink-0" /><span className="truncate">{meta.error || "API call failed"}</span></span>;
  } else if (meta?.status === "success" && isMiss(meta) && (props.value === undefined || props.value === null || props.value === "")) {
    content = NO_RESULT;
  } else if (meta?.status === "success") {
    content = <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400"><RiCheckboxCircleLine className="size-4" />{String(props.value ?? "Completed")}</span>;
  } else {
    content = <span className="text-text-soft-400">Not run</span>;
  }

  return (
    <div className="group/action flex size-full min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1 truncate">{content}</div>
      {!inProgress && props.data && props.onRun && (
        <button
          type="button"
          disabled={props.disabled}
          title="Run this row"
          aria-label="Run this row"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onRun?.(props.data!.__id);
          }}
          className="shrink-0 rounded-md bg-blue-600 p-1 text-white opacity-0 shadow-sm transition hover:bg-blue-700 focus:opacity-100 disabled:cursor-not-allowed disabled:bg-blue-300 group-hover/action:opacity-100"
        >
          <RiPlayLine className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** Result cell for HTTP and formula columns: the value, or why there isn't one yet. */
export function RunnerValueCell(props: ICellRendererParams<RowData> & { onRun?: (rowId: string) => void; disabled?: boolean }) {
  if (props.node.rowPinned === "top") return props.valueFormatted ?? props.value ?? "";
  const meta = props.data?.__meta?.[props.colDef?.field ?? ""] as CellMeta | undefined;
  const inProgress = meta?.status === "queued" || meta?.status === "running" || meta?.status === "processing";
  const text = props.valueFormatted ?? (props.value === undefined || props.value === null ? "" : String(props.value));

  let content: React.ReactNode;
  if (meta?.status === "queued") {
    content = <span className="flex items-center gap-1.5 text-text-sub-600"><RiTimeLine className="size-4" />Queued…</span>;
  } else if (meta?.status === "running" || meta?.status === "processing") {
    content = <span className="flex items-center gap-1.5 text-text-sub-600"><RiLoader4Line className="size-4 animate-spin" />Running…</span>;
  } else if (meta?.status === "error") {
    content = <span title={meta.error} className="flex items-center gap-1.5 truncate font-medium text-red-700 dark:text-red-400"><RiCloseCircleLine className="size-4 shrink-0" /><span className="truncate">{meta.error || "Run failed"}</span></span>;
  } else if (isMiss(meta) && text === "") {
    content = NO_RESULT;
  } else {
    content = <span title={text}>{text}</span>;
  }

  return (
    <div className="group/action flex size-full min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1 truncate">{content}</div>
      {!inProgress && props.data && props.onRun && (
        <button
          type="button"
          disabled={props.disabled}
          title="Run this row"
          aria-label="Run this row"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onRun?.(props.data!.__id);
          }}
          className="shrink-0 rounded-md bg-blue-600 p-1 text-white opacity-0 shadow-sm transition hover:bg-blue-700 focus:opacity-100 disabled:cursor-not-allowed disabled:bg-blue-300 group-hover/action:opacity-100"
        >
          <RiPlayLine className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function IntegrationOutputCell(props: ICellRendererParams<RowData> & { sourceColumnKey?: string; valueType?: ColumnType; ungrouped?: boolean }) {
  if (props.node.rowPinned === "top") return props.value ?? "";
  if (props.value !== undefined && props.value !== null && props.value !== "") {
    const type = props.valueType ?? "text";
    if (type === "image" && typeof props.value === "string") {
      const src = props.value.trim();
      if (/^(?:https?:\/\/|data:image\/)/i.test(src)) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={src} alt="Generated result" className="h-8 max-w-full rounded object-cover" />;
      }
    }
    const href = displayHref(props.value, type);
    if (href) {
      return <a href={href} target={type === "email" ? undefined : "_blank"} rel={type === "email" ? undefined : "noreferrer"} onClick={(event) => event.stopPropagation()} className="truncate text-blue-600 dark:text-blue-400 hover:underline">{String(props.value)}</a>;
    }
    if (type === "date") {
      const raw = String(props.value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
    }
    if (type === "number" && Number.isFinite(Number(props.value))) return Number(props.value).toLocaleString(undefined, props.ungrouped ? { useGrouping: false } : undefined);
    if (type === "boolean") {
      const checked = props.value === true || props.value === 1 || String(props.value).toLowerCase() === "true";
      return <span className="flex items-center gap-1.5"><RiCheckboxCircleLine className={`size-4 ${checked ? "text-emerald-600 dark:text-emerald-400" : "text-text-disabled-300"}`} />{checked ? "True" : "False"}</span>;
    }
    if (type === "json" || typeof props.value === "object") {
      const json = JSON.stringify(props.value);
      return <span title={json} className="block truncate font-mono text-[11px] text-text-sub-600">{json}</span>;
    }
    return String(props.value);
  }
  const sourceMeta = props.sourceColumnKey
    ? props.data?.__meta?.[props.sourceColumnKey] as CellMeta | undefined
    : undefined;
  if (sourceMeta?.status === "queued" || sourceMeta?.status === "running" || sourceMeta?.status === "processing") {
    return <span className="flex items-center gap-1.5 italic text-text-soft-400"><RiTimeLine className="size-4" />Waiting for result…</span>;
  }
  if (sourceMeta?.status === "error") {
    return <span className="italic text-text-soft-400">Action failed</span>;
  }
  if (isMiss(sourceMeta)) return NO_RESULT;
  return "";
}
