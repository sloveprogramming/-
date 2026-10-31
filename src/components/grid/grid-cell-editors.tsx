"use client";

import type { ColDef } from "ag-grid-community";
import type { CustomCellEditorProps } from "ag-grid-react";
import { coerceClipboardValue } from "@/lib/grid/clipboard";
import type { GridColumn } from "@/lib/grid/schema";
import { isStaticColumnType } from "@/lib/grid/types";
import { selectOptions, type RowData } from "./grid-model";

/** Popup editor for multiselect cells: a checkbox per option, plus any stored value the list lacks. */
function MultiSelectEditor(props: CustomCellEditorProps<RowData, unknown> & { options: string[] }) {
  const current = Array.isArray(props.value) ? props.value.map(String) : [];
  const choices = [...props.options, ...current.filter((value) => !props.options.includes(value))];
  const toggle = (value: string) => {
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    props.onValueChange(next);
  };
  return (
    <div className="max-h-64 min-w-[200px] overflow-auto rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-1.5 shadow-lg">
      {choices.length === 0 && <p className="px-2 py-1.5 text-[12px] text-text-sub-600">This column has no options.</p>}
      {choices.map((value) => (
        <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-strong-950 hover:bg-bg-weak-50">
          <input type="checkbox" checked={current.includes(value)} onChange={() => toggle(value)} />
          <span className="truncate">{value}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Editing behaviour per static column type. Every editor result goes through
 * the same coercion as paste and import, so a typed "42" is the number 42 and
 * JSON is edited as JSON text instead of "[object Object]". Booleans have no
 * editor: a click or Space toggles them (see onCellClicked).
 */
export function editorFor(
  column: GridColumn,
): Pick<ColDef<RowData>, "cellEditor" | "cellEditorParams" | "cellEditorPopup" | "valueParser"> {
  const type = column.type;
  if (!isStaticColumnType(type)) return {};
  const base = {
    valueParser: (params: { newValue: unknown }) =>
      coerceClipboardValue(params.newValue === undefined || params.newValue === null ? "" : String(params.newValue), type),
  };
  if (type === "select") {
    const values = selectOptions(column).map((option) => option.value);
    if (values.length) {
      return {
        ...base,
        cellEditor: "agSelectCellEditor",
        // A value the options lack stays selectable only while the cell holds it.
        cellEditorParams: (params: { value?: unknown }) => {
          const held = typeof params.value === "string" && params.value !== "" && !values.includes(params.value) ? [params.value] : [];
          return { values: ["", ...values, ...held] };
        },
      };
    }
  }
  if (type === "multiselect") {
    return {
      ...base,
      cellEditor: MultiSelectEditor,
      cellEditorParams: { options: selectOptions(column).map((option) => option.value) },
      cellEditorPopup: true,
    };
  }
  if (type === "json") return { ...base, cellEditorParams: { useFormatter: true } };
  return base;
}
