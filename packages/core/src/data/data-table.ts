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
  /**
   * Sparse map of cell FORMULAS (Excel expressions WITHOUT the leading "="), keyed by
   * `"row,col"` over the same indices as `rows`. Carried from an .xlsx import and
   * written back on export so formulas survive a round-trip; the cached computed value
   * lives in `rows` (what the chat/charts read). Absent when the table has no formulas.
   */
  formulas?: Record<string, string>;
}

/** The `formulas` map key for a cell at data-row `r`, column `c`. */
export function formulaKey(r: number, c: number): string {
  return `${r},${c}`;
}

/** Attach a non-empty formula map to a table (omitted entirely when empty). */
function withFormulas(table: DataTable, formulas: Record<string, string>): DataTable {
  return Object.keys(formulas).length > 0 ? { ...table, formulas } : { columns: table.columns, rows: table.rows };
}

/** Remap a formula map's coordinates through `move` (return null to drop a cell). */
function remapFormulas(
  formulas: Record<string, string> | undefined,
  move: (r: number, c: number) => [number, number] | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, expr] of Object.entries(formulas ?? {})) {
    const [r, c] = key.split(",").map(Number) as [number, number];
    const moved = move(r, c);
    if (moved) out[formulaKey(moved[0], moved[1])] = expr;
  }
  return out;
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
export function dataTableFromGrid(grid: string[][], formulaGrid?: (string | undefined)[][]): DataTable | undefined {
  // Keep the ORIGINAL grid indices of the non-empty rows so an aligned formula grid
  // can be filtered in lockstep (formulas map to the surviving data rows).
  const keptIdx = grid.map((_, i) => i).filter((i) => grid[i]!.some((c) => (c ?? "").trim() !== ""));
  if (keptIdx.length < 2) return undefined; // need a header + at least one data row
  const header = grid[keptIdx[0]!]!.slice(0, MAX_TABLE_COLS);
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
  const dataIdx = keptIdx.slice(1, 1 + MAX_TABLE_ROWS);
  const dataRows = dataIdx.map((i) => grid[i]!);
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
  const table: DataTable = { columns: names.map((name, c) => ({ name, type: types[c]! })), rows };
  // Carry any imported formulas, keyed by the FINAL data-row/col indices.
  if (formulaGrid) {
    const formulas: Record<string, string> = {};
    dataIdx.forEach((gridRow, r) => {
      const fr = formulaGrid[gridRow];
      if (!fr) return;
      for (let c = 0; c < ncols; c++) {
        const expr = fr[c];
        if (expr) formulas[formulaKey(r, c)] = expr;
      }
    });
    return withFormulas(table, formulas);
  }
  return table;
}

/**
 * Set one cell from a raw (edited) string, returning a NEW table (immutable). The
 * value is coerced to the column's type: a number column parses the input (blank →
 * null); if a number column gets non-numeric text, that column is downgraded to
 * "string" so the edit is kept faithfully rather than silently dropped. An input that
 * starts with "=" is stored as a FORMULA (computed by Excel on export; the cell shows
 * blank until then); editing a former formula cell with a literal clears its formula.
 * Out-of-range indices return the table unchanged.
 */
export function setTableCell(table: DataTable, rowIndex: number, colIndex: number, raw: string): DataTable {
  if (rowIndex < 0 || rowIndex >= table.rows.length || colIndex < 0 || colIndex >= table.columns.length) {
    return table;
  }
  const trimmed = raw.trim();
  const col = table.columns[colIndex]!;
  const key = formulaKey(rowIndex, colIndex);
  const formulas = { ...(table.formulas ?? {}) };
  let columns = table.columns;
  let value: CellValue;
  if (trimmed.startsWith("=") && trimmed.length > 1) {
    // A formula: store the expression; the cached value is unknown until Excel recalcs.
    formulas[key] = trimmed.slice(1);
    value = null;
  } else {
    delete formulas[key]; // a literal now (or cleared) — no formula on this cell
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
  }
  const rows = table.rows.map((r, ri) =>
    ri === rowIndex ? r.map((v, ci) => (ci === colIndex ? value : v)) : r,
  );
  return withFormulas({ columns, rows }, formulas);
}

/** A column for a from-scratch table: a name and (optionally) an explicit type. */
export interface NewColumnSpec {
  name: string;
  type?: ColumnType;
}

/**
 * Build a DataTable FROM SCRATCH (the "generate a spreadsheet" path) from a column
 * spec and optional seed rows. A cell string that starts with "=" becomes a FORMULA
 * (stored in the formulas map; cached value left blank for Excel to compute). Column
 * types are taken from the spec, else inferred from the non-formula cells. Bounded by
 * the table caps. Always returns at least one column.
 */
export function createDataTable(cols: NewColumnSpec[], rows: (string | number | null)[][] = []): DataTable {
  const specs = cols.slice(0, MAX_TABLE_COLS);
  const columns: DataColumn[] = [];
  for (const c of specs) {
    columns.push({ name: uniqueColumnName(columns, c.name), type: c.type ?? "string" });
  }
  if (columns.length === 0) return { columns: [{ name: "Column 1", type: "string" }], rows: [] };
  const boundedRows = rows.slice(0, MAX_TABLE_ROWS);
  // Infer a type for columns without an explicit one (number when every non-empty,
  // non-formula cell is numeric).
  specs.forEach((spec, c) => {
    if (spec.type) return;
    let sawValue = false;
    let allNumeric = true;
    for (const row of boundedRows) {
      const cell = row[c];
      if (cell === null || cell === undefined || cell === "" || (typeof cell === "string" && cell.startsWith("="))) continue;
      sawValue = true;
      const n = typeof cell === "number" ? cell : parseNumericCell(String(cell));
      if (n === undefined) {
        allNumeric = false;
        break;
      }
    }
    columns[c]!.type = sawValue && allNumeric ? "number" : "string";
  });
  const formulas: Record<string, string> = {};
  const outRows: CellValue[][] = boundedRows.map((row, r) =>
    columns.map((col, c) => {
      const cell = row[c] ?? null;
      if (typeof cell === "string" && cell.trim().startsWith("=") && cell.trim().length > 1) {
        formulas[formulaKey(r, c)] = cell.trim().slice(1);
        return null;
      }
      if (cell === null || cell === "") return null;
      if (col.type === "number") return typeof cell === "number" ? cell : (parseNumericCell(String(cell)) ?? null);
      return String(cell);
    }),
  );
  return withFormulas({ columns, rows: outRows }, formulas);
}

/** Case-insensitive column lookup; returns -1 when absent. */
export function columnIndexByName(table: DataTable, name: string): number {
  const key = name.trim().toLowerCase();
  return table.columns.findIndex((c) => c.name.toLowerCase() === key);
}

/** "A"/"BC" → 0-based column index. */
function lettersToColumn(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Parse an Excel A1 reference into 0-based DATA-table coordinates. The header is Excel
 * row 1, so data row `r` is Excel row `r + 2`. Returns undefined for the header row,
 * out-of-range cells, or malformed input — so a chat-authored cell edit can't land
 * outside the table.
 */
export function parseA1(table: DataTable, ref: string): { row: number; col: number } | undefined {
  const m = /^([A-Za-z]+)\$?(\d+)$/.exec(ref.trim().replace(/\$/g, ""));
  if (!m) return undefined;
  const col = lettersToColumn(m[1]!);
  const excelRow = Number(m[2]);
  if (excelRow < 2) return undefined; // header or above — not a data cell
  const row = excelRow - 2;
  if (col < 0 || col >= table.columns.length || row >= table.rows.length) return undefined;
  return { row, col };
}

/**
 * Set a `{r}`-templated formula on EVERY data row of a column — Excel "fill down": the
 * `{r}` placeholder becomes each row's Excel row number (data row 0 → row 2). E.g.
 * `"B{r}*C{r}"` yields `=B2*C2`, `=B3*C3`, … Reuses setTableCell, so the formula map
 * is maintained. Out-of-range column returns the table unchanged.
 */
export function setColumnFormula(table: DataTable, colIndex: number, template: string): DataTable {
  if (colIndex < 0 || colIndex >= table.columns.length) return table;
  let next = table;
  for (let r = 0; r < table.rows.length; r++) {
    next = setTableCell(next, r, colIndex, `=${template.replace(/\{r\}/g, String(r + 2))}`);
  }
  return next;
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
  return withFormulas({ columns: table.columns, rows }, remapFormulas(table.formulas, (r, c) => [r >= at ? r + 1 : r, c]));
}

/** Remove the row at `index` (no-op out of range), returning a NEW table. */
export function removeRow(table: DataTable, index: number): DataTable {
  if (index < 0 || index >= table.rows.length) return table;
  const rows = table.rows.filter((_, i) => i !== index);
  return withFormulas({ columns: table.columns, rows }, remapFormulas(table.formulas, (r, c) => (r === index ? null : [r > index ? r - 1 : r, c])));
}

/** Insert a new (empty, string-typed) column at `atIndex` (default: append). */
export function addColumn(table: DataTable, name?: string, atIndex?: number): DataTable {
  const col: DataColumn = { name: uniqueColumnName(table.columns, name ?? `Column ${table.columns.length + 1}`), type: "string" };
  const at = atIndex === undefined ? table.columns.length : Math.max(0, Math.min(atIndex, table.columns.length));
  const columns = [...table.columns.slice(0, at), col, ...table.columns.slice(at)];
  const rows = table.rows.map((r) => [...r.slice(0, at), null, ...r.slice(at)]);
  return withFormulas({ columns, rows }, remapFormulas(table.formulas, (r, c) => [r, c >= at ? c + 1 : c]));
}

/** Remove the column at `index` and its cells (no-op out of range / last column). */
export function removeColumn(table: DataTable, index: number): DataTable {
  if (index < 0 || index >= table.columns.length || table.columns.length <= 1) return table;
  const columns = table.columns.filter((_, i) => i !== index);
  const rows = table.rows.map((r) => r.filter((_, i) => i !== index));
  return withFormulas({ columns, rows }, remapFormulas(table.formulas, (r, c) => (c === index ? null : [r, c > index ? c - 1 : c])));
}

/** Rename the column at `index` (keeping names unique), returning a NEW table. */
export function renameColumn(table: DataTable, index: number, name: string): DataTable {
  if (index < 0 || index >= table.columns.length) return table;
  const others = table.columns.filter((_, i) => i !== index);
  const unique = uniqueColumnName(others, name);
  return withFormulas(
    { columns: table.columns.map((c, i) => (i === index ? { ...c, name: unique } : c)), rows: table.rows },
    { ...(table.formulas ?? {}) },
  );
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
