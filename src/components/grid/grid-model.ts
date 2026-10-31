import { isFilterGroup, VALUELESS_OPERATORS, type FilterGroup } from "@/lib/grid/query";
import type { GridColumn, GridRow } from "@/lib/grid/schema";
import type {
  AiConfig,
  AiOutputConfig,
  CellMeta,
  CellMetaMap,
  ColumnType,
  IntegrationOutputConfig,
} from "@/lib/grid/types";

export type RowData = Record<string, unknown> & {
  __id: string;
  __meta: CellMetaMap;
};

export type CellCoordinate = { rowIndex: number; columnKey: string };
export type CellRange = { anchor: CellCoordinate; focus: CellCoordinate };
export type NormalizedCellRange = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};
export type CellUpdate = { rowId: string; columnKey: string; value: unknown };
export type CellEditCommand = { undo: CellUpdate[]; redo: CellUpdate[] };

export function normalizeCellRange(
  range: CellRange | null,
  columnKeys: string[],
  rowCount: number,
): NormalizedCellRange | null {
  if (!range || rowCount === 0) return null;
  const anchorColumn = columnKeys.indexOf(range.anchor.columnKey);
  const focusColumn = columnKeys.indexOf(range.focus.columnKey);
  if (anchorColumn < 0 || focusColumn < 0) return null;
  return {
    startRow: Math.max(0, Math.min(range.anchor.rowIndex, range.focus.rowIndex)),
    endRow: Math.min(rowCount - 1, Math.max(range.anchor.rowIndex, range.focus.rowIndex)),
    startColumn: Math.min(anchorColumn, focusColumn),
    endColumn: Math.max(anchorColumn, focusColumn),
  };
}

export function isEditingClipboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest("input, textarea, [contenteditable='true'], .ag-cell-inline-editing"),
  );
}

export function gridRowIndexAtPoint(clientX: number, clientY: number, rowCount: number): number | null {
  const element = document.elementFromPoint(clientX, clientY);
  const rowElement = element instanceof Element ? element.closest<HTMLElement>(".ag-row[row-index]") : null;
  const rowIndex = Number(rowElement?.getAttribute("row-index"));
  return Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < rowCount ? rowIndex : null;
}

export function fillSourceRowIndex(
  range: NormalizedCellRange,
  targetRow: number,
  destinationRow: number,
): number {
  const sourceHeight = range.endRow - range.startRow + 1;
  return targetRow < range.startRow
    ? range.endRow - ((range.startRow - 1 - destinationRow) % sourceHeight)
    : range.startRow + ((destinationRow - range.endRow - 1) % sourceHeight);
}

export function fillPreviewText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function selectOptions(column: GridColumn): { value: string; label: string }[] {
  const options = (column.config as { options?: unknown } | null)?.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) => {
    if (typeof option === "string") return [{ value: option, label: option }];
    const candidate = option as { value?: unknown; label?: unknown } | null;
    if (candidate && typeof candidate.value === "string") {
      return [{ value: candidate.value, label: typeof candidate.label === "string" ? candidate.label : candidate.value }];
    }
    return [];
  });
}

export function isPendingMeta(meta: CellMeta | undefined): boolean {
  return meta?.status === "queued" || meta?.status === "running" || meta?.status === "processing";
}

/** True while any of these rows still has a cell waiting on a run. */
export function hasPendingCells(rows: RowData[]): boolean {
  return rows.some((row) =>
    Object.values(row.__meta ?? {}).some((meta) => isPendingMeta(meta as CellMeta | undefined)),
  );
}

/** Years and similar identifiers read as "2010", not "2,010". */
export const UNGROUPED_NUMBER_NAME = /year|founded/i;

export function toRowData(rows: GridRow[]): RowData[] {
  return rows.map((row) => ({ ...(row.cells ?? {}), __id: row.id, __meta: row.cellMeta ?? {} }));
}

/** Column types whose cells are produced by running something, not typed. */
export const RUNNABLE_SOURCE_TYPES: ReadonlySet<ColumnType> = new Set(["enrichment", "ai", "http", "formula"]);

/** A run column's own result columns, so deleting the source can take them along. */
export function outputColumnsOf(source: GridColumn, columns: GridColumn[]): GridColumn[] {
  const outputKeys = new Set<string>();
  if (source.type === "ai") {
    for (const key of Object.values((source.config as AiConfig).outputColumns ?? {})) outputKeys.add(key);
  }
  return columns.filter((candidate) => {
    if (candidate.id === source.id) return false;
    if (outputKeys.has(candidate.key)) return true;
    if (source.type === "enrichment" && candidate.type === "integration_output") {
      return (candidate.config as IntegrationOutputConfig).sourceColumnKey === source.key;
    }
    if (source.type === "ai" && candidate.type === "ai_output") {
      return (candidate.config as AiOutputConfig).sourceColumnKey === source.key;
    }
    return false;
  });
}

/** Filters that actually narrow the rows: enabled, and with a value unless the operator needs none. */
export function countActiveFilters(group: FilterGroup): number {
  let count = 0;
  for (const condition of group.conditions) {
    if (isFilterGroup(condition)) {
      count += countActiveFilters(condition);
    } else if (!condition.disabled && (VALUELESS_OPERATORS.has(condition.operator) || (condition.value ?? "") !== "")) {
      count += 1;
    }
  }
  return count;
}

/** Pinned columns render first, so the display order must start with them. */
export function displayOrderFor(columns: GridColumn[], pinnedKeys: string[]): string[] {
  const pinnedSet = new Set(pinnedKeys);
  return [
    ...columns.filter((column) => pinnedSet.has(column.key)),
    ...columns.filter((column) => !pinnedSet.has(column.key)),
  ].map((column) => column.key);
}

/** What a cell shows as text. Objects and arrays must never fall through to "[object Object]". */
export function formatCellValue(value: unknown, column: GridColumn, valueType: ColumnType): string {
  if (value === undefined || value === null) return "";
  if (valueType === "boolean") return value === true || String(value).toLowerCase() === "true" ? "✓" : "";
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : String(item)))
      .join(", ");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (valueType === "select" && column.type === "select") {
    return selectOptions(column).find((option) => option.value === value)?.label ?? String(value);
  }
  return String(value);
}
