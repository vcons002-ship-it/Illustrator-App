import type { DataTable } from "./data-table.js";

/**
 * Build an "Analysis" sheet of LIVE Excel formulas over a data table — the Excel
 * counterpart of the app's own statistics (`computeStats`): per-numeric-column
 * descriptive stats (count/sum/average/median/min/max/stdev/variance) plus, when
 * there are two or more numeric columns, a correlation + linear-regression block
 * across the first pair. Every value cell is a real formula (`=AVERAGE('Data'!B2:B11)`,
 * `=CORREL(...)`, `=SLOPE/INTERCEPT/RSQ(...)`) that references the data sheet by name,
 * so the exported workbook recomputes natively and stays correct if the data changes.
 *
 * Returns a `DataTable` whose value cells carry their formula via the `formulas` map —
 * the same structure the .xlsx writer already emits — so it exports as a second sheet
 * with no special handling. Returns `undefined` when there's nothing numeric to analyse.
 */

/** 0 → "A", 25 → "Z", 26 → "AA" (Excel column letters). */
function colLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Single-quote + escape a sheet name for a cross-sheet reference. */
function sheetRef(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/** Descriptive metrics → their Excel function (sample stdev/variance, as Excel's classic names). */
const METRICS: { label: string; fn: string }[] = [
  { label: "Count", fn: "COUNT" },
  { label: "Sum", fn: "SUM" },
  { label: "Average", fn: "AVERAGE" },
  { label: "Median", fn: "MEDIAN" },
  { label: "Min", fn: "MIN" },
  { label: "Max", fn: "MAX" },
  { label: "Std Dev", fn: "STDEV" },
  { label: "Variance", fn: "VAR" },
];

export function buildAnalysisTable(table: DataTable, dataSheetName: string): DataTable | undefined {
  const numeric = table.columns.map((col, i) => ({ col, i })).filter((x) => x.col.type === "number");
  const nData = table.rows.length;
  if (numeric.length === 0 || nData === 0) return undefined;

  const sheet = sheetRef(dataSheetName);
  // Data sits under a header (row 1), so the values span rows 2..nData+1.
  const range = (dataColIndex: number) => `${sheet}!${colLetter(dataColIndex)}2:${colLetter(dataColIndex)}${nData + 1}`;

  const columns = [{ name: "Statistic", type: "string" as const }, ...numeric.map((n) => ({ name: n.col.name, type: "number" as const }))];
  const rows: (string | number | null)[][] = [];
  const formulas: Record<string, string> = {};

  // Descriptive stats: one row per metric, one formula per numeric column.
  METRICS.forEach((m, r) => {
    rows.push([m.label, ...numeric.map(() => null)]);
    numeric.forEach((n, j) => {
      formulas[`${r},${j + 1}`] = `${m.fn}(${range(n.i)})`;
    });
  });

  // Correlation + regression across the first two numeric columns (the value goes in
  // the first numeric column's cell; the label names the pair).
  if (numeric.length >= 2) {
    const x = numeric[0]!;
    const y = numeric[1]!;
    const xr = range(x.i);
    const yr = range(y.i);
    const pair = `${x.col.name} vs ${y.col.name}`;
    const extra: { label: string; f: string }[] = [
      { label: `Correlation (${pair})`, f: `CORREL(${xr},${yr})` },
      { label: `Slope (${pair})`, f: `SLOPE(${yr},${xr})` },
      { label: `Intercept (${pair})`, f: `INTERCEPT(${yr},${xr})` },
      { label: `R² (${pair})`, f: `RSQ(${yr},${xr})` },
    ];
    for (const e of extra) {
      const r = rows.length;
      rows.push([e.label, ...numeric.map(() => null)]);
      formulas[`${r},1`] = e.f;
    }
  }

  return { columns, rows, formulas };
}
