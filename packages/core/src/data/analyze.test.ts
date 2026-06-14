import { describe, expect, it } from "vitest";
import { dataTableFromGrid, columnIndexByName } from "./data-table.js";
import { analyzeData } from "./analyze.js";

const grid = [
  ["Region", "Product", "Units", "Revenue"],
  ["North", "Widget", "10", "100"],
  ["North", "Gadget", "5", "75"],
  ["South", "Widget", "20", "200"],
  ["South", "Gadget", "8", "120"],
  ["South", "Widget", "2", "20"],
];
const table = dataTableFromGrid(grid)!;

describe("dataTableFromGrid", () => {
  it("infers numeric vs string columns and parses numbers", () => {
    expect(table.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      "Region:string",
      "Product:string",
      "Units:number",
      "Revenue:number",
    ]);
    expect(table.rows[0]).toEqual(["North", "Widget", 10, 100]);
  });

  it("handles thousands separators / currency and finds columns case-insensitively", () => {
    const t = dataTableFromGrid([["price"], ["$1,250"], ["2,000"]])!;
    expect(t.columns[0]!.type).toBe("number");
    expect(t.rows.map((r) => r[0])).toEqual([1250, 2000]);
    expect(columnIndexByName(table, "revenue")).toBe(3);
    expect(columnIndexByName(table, "nope")).toBe(-1);
  });

  it("returns undefined without a header + a data row", () => {
    expect(dataTableFromGrid([["only headers"]])).toBeUndefined();
    expect(dataTableFromGrid([])).toBeUndefined();
  });
});

describe("analyzeData", () => {
  it("describe reports per-column stats", () => {
    const { table: out } = analyzeData(table, { op: "describe" });
    const units = out.rows.find((r) => r[0] === "Units")!;
    // columns: column,type,count,missing,min,max,mean,median,stdev,distinct
    expect(units[2]).toBe(5); // count
    expect(units[4]).toBe(2); // min
    expect(units[5]).toBe(20); // max
    expect(units[6]).toBe(9); // mean (45/5)
  });

  it("aggregate sums a numeric column", () => {
    const { table: out, summary } = analyzeData(table, { op: "aggregate", agg: "sum", valueColumn: "Revenue" });
    expect(out.rows[0]).toEqual(["sum of Revenue", 515]);
    expect(summary).toMatch(/515/);
  });

  it("groupby aggregates per group, sorted by value desc", () => {
    const { table: out } = analyzeData(table, {
      op: "groupby",
      groupBy: "Region",
      agg: "sum",
      valueColumn: "Revenue",
    });
    expect(out.columns.map((c) => c.name)).toEqual(["Region", "sum(Revenue)"]);
    expect(out.rows).toEqual([
      ["South", 340],
      ["North", 175],
    ]);
  });

  it("applies filters before aggregating", () => {
    const { table: out } = analyzeData(table, {
      op: "aggregate",
      agg: "sum",
      valueColumn: "Units",
      filters: [{ column: "Product", op: "=", value: "Widget" }],
    });
    expect(out.rows[0]![1]).toBe(32); // 10 + 20 + 2
  });

  it("numeric filters compare as numbers", () => {
    const { table: out } = analyzeData(table, {
      op: "aggregate",
      agg: "count",
      filters: [{ column: "Units", op: ">=", value: 10 }],
    });
    expect(out.rows[0]![1]).toBe(2); // Units 10 and 20
  });

  it("pivot builds a group × pivot matrix", () => {
    const { table: out } = analyzeData(table, {
      op: "pivot",
      groupBy: "Region",
      pivotColumn: "Product",
      agg: "sum",
      valueColumn: "Units",
    });
    expect(out.columns.map((c) => c.name)).toEqual(["Region", "Gadget", "Widget"]);
    const south = out.rows.find((r) => r[0] === "South")!;
    expect(south).toEqual(["South", 8, 22]); // Gadget 8, Widget 20+2
  });

  it("throws a readable error for an unknown column", () => {
    expect(() => analyzeData(table, { op: "groupby", groupBy: "Nope", agg: "count" })).toThrow(/no column named/);
  });
});
