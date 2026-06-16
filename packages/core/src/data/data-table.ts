/**
 * A structured, typed data table — the in-memory form of an uploaded spreadsheet /
 * CSV. The importer flattens a workbook to text for the reader; this keeps the REAL
 * grid (columns + per-column type) so the chat's `analyze_data` tool can compute
 * over actual cells (group-by, pivots, aggregates, stats) instead of a model guessing
 * from flattened text. Rides on `BookSource.data` so it survives reloads.
 */

import type { ChapterDataset } from "../types/bible.js";

export type CellValue = number | string | null;
export type ColumnType = "number" | "string";

export interface DataColumn {
  name: string;
  type: ColumnType;
}

export interface DataTable {
  columns: DataColumn[];
  /** Row-major: `rows[r][c]` aligns with `columns[c]`. Numbers in number columns. */
  rows: CellValue[][];
}

/** Caps so a giant sheet can't blow memory / context (mirrors the text importer). */
export const MAX_TABLE_ROWS = 5000;
export const MAX_TABLE_COLS = 64;

/** Parse a numeric cell, tolerating thousands separators, %, and currency symbols. */
export function parseNumericCell(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const cleaned = s.replace(/[,$£€\s]/g, "").replace(/%$/, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build a typed `DataTable` from a parsed grid (header row + string data rows). A
 * column is "number" when EVERY non-empty cell parses as a number; otherwise it's
 * "string". Empty cells become `null`. Returns undefined when there's no usable grid.
 */
export function dataTableFromGrid(grid: string[][]): DataTable | undefined {
  const rowsRaw = grid.filter((r) => r.some((c) => (c ?? "").trim() !== ""));
  if (rowsRaw.length < 2) return undefined; // need a header + at least one data row
  const header = rowsRaw[0]!.slice(0, MAX_TABLE_COLS);
  const ncols = header.length;
  if (ncols === 0) return undefined;
  // Unique, trimmed, non-empty column names.
  const seen = new Map<string, number>();
  const names = header.map((h, i) => {
    let name = (h ?? "").trim() || `Column ${i + 1}`;
    const count = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), count + 1);
    if (count > 0) name = `${name} (${count + 1})`;
    return name;
  });
  const dataRows = rowsRaw.slice(1, 1 + MAX_TABLE_ROWS);
  // Infer each column's type from its data cells.
  const types: ColumnType[] = names.map((_, c) => {
    let sawValue = false;
    for (const row of dataRows) {
      const cell = (row[c] ?? "").trim();
      if (!cell) continue;
      sawValue = true;
      if (parseNumericCell(cell) === undefined) return "string";
    }
    return sawValue ? "number" : "string";
  });
  const rows: CellValue[][] = dataRows.map((row) =>
    names.map((_, c) => {
      const cell = (row[c] ?? "").trim();
      if (!cell) return null;
      if (types[c] === "number") return parseNumericCell(cell) ?? null;
      return cell;
    }),
  );
  return { columns: names.map((name, c) => ({ name, type: types[c]! })), rows };
}

/**
 * Set one cell from a raw (edited) string, returning a NEW table (immutable). The
 * value is coerced to the column's type: a number column parses the input (blank →
 * null); if a number column gets non-numeric text, that column is downgraded to
 * "string" so the edit is kept faithfully rather than silently dropped. Out-of-range
 * indices return the table unchanged.
 */
export function setTableCell(table: DataTable, rowIndex: number, colIndex: number, raw: string): DataTable {
  if (rowIndex < 0 || rowIndex >= table.rows.length || colIndex < 0 || colIndex >= table.columns.length) {
    return table;
  }
  const trimmed = raw.trim();
  const col = table.columns[colIndex]!;
  let columns = table.columns;
  let value: CellValue;
  if (col.type === "number") {
    if (trimmed === "") {
      value = null;
    } else {
      const n = parseNumericCell(trimmed);
      if (n === undefined) {
        // Non-numeric input into a number column: keep it, demote the column to text.
        value = trimmed;
        columns = table.columns.map((c, i) => (i === colIndex ? { ...c, type: "string" as const } : c));
      } else {
        value = n;
      }
    }
  } else {
    value = trimmed === "" ? null : trimmed;
  }
  const rows = table.rows.map((r, ri) =>
    ri === rowIndex ? r.map((v, ci) => (ci === colIndex ? value : v)) : r,
  );
  return { columns, rows };
}

/** Case-insensitive column lookup; returns -1 when absent. */
export function columnIndexByName(table: DataTable, name: string): number {
  const key = name.trim().toLowerCase();
  return table.columns.findIndex((c) => c.name.toLowerCase() === key);
}

/** A unique, trimmed column name (appends " (2)", " (3)" on collision). */
function uniqueColumnName(existing: readonly DataColumn[], desired: string): string {
  const base = desired.trim() || `Column ${existing.length + 1}`;
  const taken = new Set(existing.map((c) => c.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Insert a blank row at `atIndex` (default: append), returning a NEW table. */
export function addRow(table: DataTable, atIndex?: number): DataTable {
  const blank: CellValue[] = table.columns.map(() => null);
  const at = atIndex === undefined ? table.rows.length : Math.max(0, Math.min(atIndex, table.rows.length));
  const rows = [...table.rows.slice(0, at), blank, ...table.rows.slice(at)];
  return { columns: table.columns, rows };
}

/** Remove the row at `index` (no-op out of range), returning a NEW table. */
export function removeRow(table: DataTable, index: number): DataTable {
  if (index < 0 || index >= table.rows.length) return table;
  return { columns: table.columns, rows: table.rows.filter((_, i) => i !== index) };
}

/** Insert a new (empty, string-typed) column at `atIndex` (default: append). */
export function addColumn(table: DataTable, name?: string, atIndex?: number): DataTable {
  const col: DataColumn = { name: uniqueColumnName(table.columns, name ?? `Column ${table.columns.length + 1}`), type: "string" };
  const at = atIndex === undefined ? table.columns.length : Math.max(0, Math.min(atIndex, table.columns.length));
  const columns = [...table.columns.slice(0, at), col, ...table.columns.slice(at)];
  const rows = table.rows.map((r) => [...r.slice(0, at), null, ...r.slice(at)]);
  return { columns, rows };
}

/** Remove the column at `index` and its cells (no-op out of range / last column). */
export function removeColumn(table: DataTable, index: number): DataTable {
  if (index < 0 || index >= table.columns.length || table.columns.length <= 1) return table;
  return {
    columns: table.columns.filter((_, i) => i !== index),
    rows: table.rows.map((r) => r.filter((_, i) => i !== index)),
  };
}

/** Rename the column at `index` (keeping names unique), returning a NEW table. */
export function renameColumn(table: DataTable, index: number, name: string): DataTable {
  if (index < 0 || index >= table.columns.length) return table;
  const others = table.columns.filter((_, i) => i !== index);
  const unique = uniqueColumnName(others, name);
  return {
    columns: table.columns.map((c, i) => (i === index ? { ...c, name: unique } : c)),
    rows: table.rows,
  };
}

/** A compact text preview of a table (header + first `maxRows`) for a model/summary. */
export function tableToText(table: DataTable, maxRows = 20): string {
  const head = table.columns.map((c) => c.name).join(" | ");
  const body = table.rows
    .slice(0, maxRows)
    .map((r) => r.map((v) => (v === null ? "" : String(v))).join(" | "))
    .join("\n");
  const more = table.rows.length > maxRows ? `\n… (${table.rows.length - maxRows} more rows)` : "";
  return `${head}\n${body}${more}`;
}

/**
 * Build a chartable series from a table: its first text column labels the points and
 * its first numeric column supplies the values. Returns `undefined` when the table
 * has no numeric column (nothing honest to chart). Shared by the chat's analysis
 * result and the reader's data card so the "what's chartable" rule lives in one place.
 */
export function chartDatasetFromTable(
  table: DataTable,
  kind: "bar" | "line" | "scatter" = "bar",
  maxPoints = 60,
): ChapterDataset | undefined {
  const labelCol = table.columns.findIndex((c) => c.type === "string");
  const valueCol = table.columns.findIndex((c) => c.type === "number");
  if (valueCol < 0) return undefined;
  const points = table.rows
    .slice(0, maxPoints)
    .map((r, i) => ({
      label: labelCol >= 0 ? String(r[labelCol] ?? `#${i + 1}`) : `#${i + 1}`,
      y: Number(r[valueCol]),
    }))
    .filter((p) => Number.isFinite(p.y));
  if (points.length === 0) return undefined;
  return {
    id: "table-chart",
    chapterIndex: 0,
    title: table.columns[valueCol]?.name ?? "value",
    unit: "",
    xLabel: labelCol >= 0 ? (table.columns[labelCol]?.name ?? "") : "",
    yLabel: table.columns[valueCol]?.name ?? "",
    kind,
    points,
    source: "",
  };
}
