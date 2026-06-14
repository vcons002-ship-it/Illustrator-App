/**
 * A structured, typed data table — the in-memory form of an uploaded spreadsheet /
 * CSV. The importer flattens a workbook to text for the reader; this keeps the REAL
 * grid (columns + per-column type) so the chat's `analyze_data` tool can compute
 * over actual cells (group-by, pivots, aggregates, stats) instead of a model guessing
 * from flattened text. Rides on `BookSource.data` so it survives reloads.
 */

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

/** Case-insensitive column lookup; returns -1 when absent. */
export function columnIndexByName(table: DataTable, name: string): number {
  const key = name.trim().toLowerCase();
  return table.columns.findIndex((c) => c.name.toLowerCase() === key);
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
