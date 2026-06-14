import { percentile } from "../charts/stats.js";
import {
  columnIndexByName,
  type CellValue,
  type DataTable,
} from "./data-table.js";

/**
 * Grounded data analysis over a real `DataTable` — the deterministic engine behind
 * the chat's `analyze_data` tool. The model picks WHAT to compute (a structured
 * spec); this computes it over actual cells, so the numbers are never guessed. Pure
 * and unit-tested; no LLM, no IO. Output is itself a `DataTable` so it can render as
 * a table or chart, plus a short text summary the model narrates.
 */

export type Aggregation = "sum" | "mean" | "median" | "min" | "max" | "count" | "countDistinct" | "stdev";

export type FilterOp = "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains";

export interface DataFilter {
  column: string;
  op: FilterOp;
  value: string | number;
}

export interface AnalyzeSpec {
  /** describe = per-column stats; aggregate = one number; groupby = one agg per group;
   *  pivot = group × pivot matrix of an aggregate. */
  op: "describe" | "aggregate" | "groupby" | "pivot";
  /** Row grouping column (groupby/pivot). */
  groupBy?: string;
  /** Column whose values become output columns (pivot). */
  pivotColumn?: string;
  /** Numeric column to aggregate (aggregate/groupby/pivot). */
  valueColumn?: string;
  agg?: Aggregation;
  filters?: DataFilter[];
  /** Cap output rows (groupby), sorted by the aggregate descending. */
  limit?: number;
}

export interface AnalyzeResult {
  table: DataTable;
  /** A short, plain-language summary of the result for the model to cite. */
  summary: string;
}

const num = (v: CellValue | undefined): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function aggregate(values: number[], agg: Aggregation): number {
  if (agg === "count") return values.length;
  if (values.length === 0) return NaN;
  switch (agg) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "mean":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "median":
      return percentile([...values].sort((a, b) => a - b), 50);
    case "stdev": {
      if (values.length < 2) return 0;
      const m = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.sqrt(values.reduce((a, b) => a + (b - m) * (b - m), 0) / (values.length - 1));
    }
    default:
      return NaN;
  }
}

/** Resolve a column name to its index, or throw a readable, recoverable error. */
function col(table: DataTable, name: string | undefined, role: string): number {
  if (!name) throw new Error(`analyze_data needs a ${role} column.`);
  const i = columnIndexByName(table, name);
  if (i < 0) throw new Error(`no column named "${name}" (have: ${table.columns.map((c) => c.name).join(", ")}).`);
  return i;
}

function passesFilter(cell: CellValue, op: FilterOp, value: string | number): boolean {
  if (op === "contains") return String(cell ?? "").toLowerCase().includes(String(value).toLowerCase());
  if (typeof cell === "number" && typeof value === "number") {
    switch (op) {
      case "=": return cell === value;
      case "!=": return cell !== value;
      case ">": return cell > value;
      case "<": return cell < value;
      case ">=": return cell >= value;
      case "<=": return cell <= value;
    }
  }
  const a = String(cell ?? "").toLowerCase();
  const b = String(value).toLowerCase();
  return op === "!=" ? a !== b : a === b; // string columns only support =/!= meaningfully
}

function applyFilters(table: DataTable, filters: DataFilter[] | undefined): CellValue[][] {
  if (!filters?.length) return table.rows;
  const idx = filters.map((f) => ({ c: col(table, f.column, "filter"), f }));
  return table.rows.filter((row) => idx.every(({ c, f }) => passesFilter(row[c]!, f.op, f.value)));
}

export function analyzeData(table: DataTable, spec: AnalyzeSpec): AnalyzeResult {
  const rows = applyFilters(table, spec.filters);
  if (spec.op === "describe") return describe(table, rows);
  if (spec.op === "aggregate") return aggregateAll(table, rows, spec);
  if (spec.op === "groupby") return groupBy(table, rows, spec);
  return pivot(table, rows, spec);
}

function describe(table: DataTable, rows: CellValue[][]): AnalyzeResult {
  const columns = [
    { name: "column", type: "string" as const },
    { name: "type", type: "string" as const },
    { name: "count", type: "number" as const },
    { name: "missing", type: "number" as const },
    { name: "min", type: "number" as const },
    { name: "max", type: "number" as const },
    { name: "mean", type: "number" as const },
    { name: "median", type: "number" as const },
    { name: "stdev", type: "number" as const },
    { name: "distinct", type: "number" as const },
  ];
  const out: CellValue[][] = table.columns.map((c, ci) => {
    const cells = rows.map((r) => r[ci]!);
    const present = cells.filter((v) => v !== null);
    const distinct = new Set(present.map((v) => String(v))).size;
    if (c.type === "number") {
      const vs = present.map((v) => num(v)!).filter((v) => v !== undefined);
      const sorted = [...vs].sort((a, b) => a - b);
      const mean = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
      return [
        c.name, c.type, vs.length, cells.length - present.length,
        vs.length ? sorted[0]! : null, vs.length ? sorted[sorted.length - 1]! : null,
        mean, vs.length ? percentile(sorted, 50) : null, aggregate(vs, "stdev"), distinct,
      ];
    }
    return [c.name, c.type, present.length, cells.length - present.length, null, null, null, null, null, distinct];
  });
  return { table: { columns, rows: out }, summary: `Described ${table.columns.length} columns over ${rows.length} rows.` };
}

function aggregateAll(table: DataTable, rows: CellValue[][], spec: AnalyzeSpec): AnalyzeResult {
  const agg = spec.agg ?? "count";
  if (agg === "countDistinct") {
    const ci = col(table, spec.valueColumn, "value");
    const distinct = new Set(rows.map((r) => r[ci]).filter((v) => v !== null).map(String)).size;
    return {
      table: { columns: [{ name: "metric", type: "string" }, { name: "value", type: "number" }], rows: [[`countDistinct of ${spec.valueColumn}`, distinct]] },
      summary: `${spec.valueColumn} has ${distinct} distinct values across ${rows.length} rows.`,
    };
  }
  const ci = agg === "count" ? -1 : col(table, spec.valueColumn, "value");
  const values = ci < 0 ? rows.map(() => 0) : rows.map((r) => num(r[ci])).filter((v): v is number => v !== undefined);
  const result = aggregate(agg === "count" ? rows.map(() => 0) : values, agg);
  const label = agg === "count" ? "count" : `${agg} of ${spec.valueColumn}`;
  return {
    table: { columns: [{ name: "metric", type: "string" }, { name: "value", type: "number" }], rows: [[label, result]] },
    summary: `${label} = ${formatNum(result)} (over ${rows.length} rows).`,
  };
}

function groupBy(table: DataTable, rows: CellValue[][], spec: AnalyzeSpec): AnalyzeResult {
  const gi = col(table, spec.groupBy, "groupBy");
  const agg = spec.agg ?? "count";
  const vi = agg === "count" ? -1 : col(table, spec.valueColumn, "value");
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const key = String(row[gi] ?? "(blank)");
    const v = vi < 0 ? 0 : num(row[vi]);
    if (vi >= 0 && v === undefined) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(v ?? 0);
  }
  let entries = [...groups.entries()].map(([k, vs]) => [k, aggregate(vs, agg)] as [string, number]);
  entries.sort((a, b) => b[1] - a[1]);
  if (spec.limit && spec.limit > 0) entries = entries.slice(0, spec.limit);
  const aggLabel = agg === "count" ? "count" : `${agg}(${spec.valueColumn})`;
  return {
    table: {
      columns: [{ name: spec.groupBy!, type: "string" }, { name: aggLabel, type: "number" }],
      rows: entries.map(([k, v]) => [k, v]),
    },
    summary: `${aggLabel} by ${spec.groupBy}: ${entries.length} group${entries.length === 1 ? "" : "s"}` +
      (entries[0] ? `, top "${entries[0][0]}" = ${formatNum(entries[0][1])}.` : "."),
  };
}

function pivot(table: DataTable, rows: CellValue[][], spec: AnalyzeSpec): AnalyzeResult {
  const gi = col(table, spec.groupBy, "groupBy (rows)");
  const pi = col(table, spec.pivotColumn, "pivot (columns)");
  const agg = spec.agg ?? "count";
  const vi = agg === "count" ? -1 : col(table, spec.valueColumn, "value");
  const rowKeys: string[] = [];
  const colKeys: string[] = [];
  const buckets = new Map<string, number[]>(); // `${rowKey} ${colKey}` → values
  for (const row of rows) {
    const rk = String(row[gi] ?? "(blank)");
    const ck = String(row[pi] ?? "(blank)");
    if (!rowKeys.includes(rk)) rowKeys.push(rk);
    if (!colKeys.includes(ck)) colKeys.push(ck);
    const v = vi < 0 ? 0 : num(row[vi]);
    if (vi >= 0 && v === undefined) continue;
    const key = `${rk} ${ck}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(v ?? 0);
  }
  colKeys.sort();
  const columns = [{ name: spec.groupBy!, type: "string" as const }, ...colKeys.map((c) => ({ name: c, type: "number" as const }))];
  const outRows: CellValue[][] = rowKeys.map((rk) => [
    rk,
    ...colKeys.map((ck) => {
      const vs = buckets.get(`${rk} ${ck}`);
      return vs ? aggregate(vs, agg) : null;
    }),
  ]);
  return {
    table: { columns, rows: outRows },
    summary: `Pivot of ${agg}${vi >= 0 ? `(${spec.valueColumn})` : ""}: ${rowKeys.length} × ${colKeys.length} (${spec.groupBy} × ${spec.pivotColumn}).`,
  };
}

function formatNum(v: number): string {
  if (!Number.isFinite(v)) return "–";
  return v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });
}
