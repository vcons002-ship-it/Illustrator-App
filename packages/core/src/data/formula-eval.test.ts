import { describe, expect, it } from "vitest";
import { evaluateFormula, recalcTable, recalcWorkbook, type FormulaContext } from "./formula-eval.js";
import type { DataTable } from "./data-table.js";

/** A context backed by a fixed grid: cellAt[excelRow][col]. Row 1 is the header. */
function gridCtx(grid: (number | string | boolean | null)[][]): FormulaContext {
  return { cell: (col, excelRow) => grid[excelRow - 1]?.[col] ?? null };
}

describe("evaluateFormula", () => {
  // Header row + two data rows: A=label, B, C numbers.
  const ctx = gridCtx([
    ["Item", "B", "C"],
    ["x", 10, 4],
    ["y", 20, 5],
  ]);

  it("does arithmetic, operator precedence, and cell refs", () => {
    expect(evaluateFormula("B2-C2", ctx)).toBe(6);
    expect(evaluateFormula("B2+C2*2", ctx)).toBe(18);
    expect(evaluateFormula("(B2+C2)*2", ctx)).toBe(28);
    expect(evaluateFormula("B3/C3", ctx)).toBe(4);
    expect(evaluateFormula("2^3^2", ctx)).toBe(512); // right-associative
    expect(evaluateFormula("-B2", ctx)).toBe(-10);
  });

  it("evaluates ranges through aggregate functions", () => {
    expect(evaluateFormula("SUM(B2:B3)", ctx)).toBe(30);
    expect(evaluateFormula("AVERAGE(B2:C3)", ctx)).toBe((10 + 4 + 20 + 5) / 4);
    expect(evaluateFormula("MIN(B2:C3)", ctx)).toBe(4);
    expect(evaluateFormula("MAX(B2:C3)", ctx)).toBe(20);
    expect(evaluateFormula("COUNT(A2:C3)", ctx)).toBe(4); // labels skipped
    expect(evaluateFormula("MEDIAN(B2:B3)", ctx)).toBe(15);
  });

  it("handles IF, comparisons, text + concat", () => {
    expect(evaluateFormula('IF(B2>15,"hi","lo")', ctx)).toBe("lo");
    expect(evaluateFormula('IF(B3>15,"hi","lo")', ctx)).toBe("hi");
    expect(evaluateFormula('A2&"="&B2', ctx)).toBe("x=10");
    expect(evaluateFormula("ROUND(B3/C3*100,1)", ctx)).toBe(400);
    expect(evaluateFormula("AND(B2>0,C2>0)", ctx)).toBe(true);
  });

  it("does SUMIF/COUNTIF with criteria and SUMPRODUCT", () => {
    const c = gridCtx([
      ["Cat", "Amt"],
      ["food", 10],
      ["rent", 30],
      ["food", 5],
    ]);
    expect(evaluateFormula('SUMIF(A2:A4,"food",B2:B4)', c)).toBe(15);
    expect(evaluateFormula('COUNTIF(A2:A4,"food")', c)).toBe(2);
    expect(evaluateFormula("COUNTIF(B2:B4,\">9\")", c)).toBe(2);
    expect(evaluateFormula("SUMPRODUCT(B2:B4,B2:B4)", c)).toBe(10 * 10 + 30 * 30 + 5 * 5);
  });

  it("throws on divide-by-zero, unknown functions, and bad syntax", () => {
    expect(() => evaluateFormula("1/0", ctx)).toThrow(/DIV/);
    expect(() => evaluateFormula("FOOBAR(1)", ctx)).toThrow(/unsupported/);
    expect(() => evaluateFormula("1 +", ctx)).toThrow();
  });
});

describe("evaluateFormula — lookups, logic, multi-criteria, math/text", () => {
  // A1:C4 price table (header + 3 rows).
  const grid = gridCtx([
    ["Item", "Qty", "Price"],
    ["apple", 2, 1.5],
    ["pear", 5, 2],
    ["plum", 1, 3],
  ]);

  it("VLOOKUP / HLOOKUP / INDEX / MATCH over 2-D ranges", () => {
    expect(evaluateFormula('VLOOKUP("pear",A2:C4,3,FALSE)', grid)).toBe(2);
    expect(evaluateFormula('VLOOKUP("plum",A2:C4,2,FALSE)', grid)).toBe(1);
    expect(evaluateFormula("INDEX(A2:C4,1,3)", grid)).toBe(1.5);
    expect(evaluateFormula('MATCH("plum",A2:A4,0)', grid)).toBe(3);
    expect(evaluateFormula("HLOOKUP(\"Price\",A1:C4,3,FALSE)", grid)).toBe(2); // 3rd row under Price header
    expect(() => evaluateFormula('VLOOKUP("missing",A2:C4,2,FALSE)', grid)).toThrow(/N\/A/);
  });

  it("lazy IF / IFERROR / IFS — the untaken branch is never evaluated", () => {
    expect(evaluateFormula("IF(B2=0,0,Price/B2)", gridCtx([["", 0], ["x", 0]]))).toBe(0); // no #DIV/0!
    expect(evaluateFormula("IFERROR(1/0,-1)", grid)).toBe(-1);
    expect(evaluateFormula('IFS(B2>4,"hi",B2>1,"mid",TRUE,"lo")', grid)).toBe("mid"); // B2=2
    expect(evaluateFormula("ISERROR(1/0)", grid)).toBe(true);
    expect(evaluateFormula("ISNUMBER(C2)", grid)).toBe(true);
  });

  it("multi-criteria SUMIFS / COUNTIFS / AVERAGEIFS / MAXIFS", () => {
    const g = gridCtx([
      ["Cat", "Region", "Amt"],
      ["food", "N", 10],
      ["food", "S", 30],
      ["rent", "N", 50],
    ]);
    expect(evaluateFormula('SUMIFS(C2:C4,A2:A4,"food")', g)).toBe(40);
    expect(evaluateFormula('SUMIFS(C2:C4,A2:A4,"food",B2:B4,"N")', g)).toBe(10);
    expect(evaluateFormula('COUNTIFS(A2:A4,"food")', g)).toBe(2);
    expect(evaluateFormula('MAXIFS(C2:C4,A2:A4,"food")', g)).toBe(30);
  });

  it("math + stats + text helpers", () => {
    expect(evaluateFormula("ROUNDUP(2.1,0)", grid)).toBe(3);
    expect(evaluateFormula("CEILING(7,5)", grid)).toBe(10);
    expect(evaluateFormula("LARGE(A2:C4,1)", grid)).toBe(5); // biggest number in the block
    expect(evaluateFormula("SMALL(B2:B4,1)", grid)).toBe(1);
    expect(evaluateFormula('LEFT(UPPER("apple"),3)', grid)).toBe("APP");
    expect(evaluateFormula('TEXTJOIN("-",TRUE,A2:A4)', grid)).toBe("apple-pear-plum");
    expect(evaluateFormula("CHOOSE(2,10,20,30)", grid)).toBe(20);
  });
});

describe("recalcTable", () => {
  it("computes formula cells and resolves chained dependencies", () => {
    const t: DataTable = {
      columns: [{ name: "A", type: "number" }, { name: "B", type: "number" }, { name: "C", type: "number" }],
      rows: [
        [2, 3, null],
        [4, 5, null],
      ],
      formulas: { "0,2": "A2+B2", "1,2": "C2*10" }, // C3 depends on C2 (a formula)
    };
    const r = recalcTable(t);
    expect(r.rows[0]![2]).toBe(5); // A2+B2
    expect(r.rows[1]![2]).toBe(50); // (A2+B2)*10
  });

  it("keeps the cached value when a formula can't be evaluated", () => {
    const t: DataTable = {
      columns: [{ name: "A", type: "number" }],
      rows: [[42]],
      formulas: { "0,0": "WEIRDFN(1)" }, // unsupported → keep 42
    };
    expect(recalcTable(t).rows[0]![0]).toBe(42);
  });

  it("leaves a circular reference's cached value intact (no crash)", () => {
    const t: DataTable = {
      columns: [{ name: "A", type: "number" }, { name: "B", type: "number" }],
      rows: [[1, 2]],
      formulas: { "0,0": "B2", "0,1": "A2" }, // A2↔B2 cycle (data row 0 = Excel row 2)
    };
    const r = recalcTable(t);
    expect(r.rows[0]).toEqual([1, 2]); // unchanged, didn't throw
  });

  it("returns the same reference when there are no formulas", () => {
    const t: DataTable = { columns: [{ name: "A", type: "number" }], rows: [[1]] };
    expect(recalcTable(t)).toBe(t);
  });
});

describe("recalcWorkbook (cross-sheet references)", () => {
  it("resolves 'Sheet'!Range formulas on another sheet, live", () => {
    const data: DataTable = {
      columns: [{ name: "City", type: "string" }, { name: "Pop", type: "number" }],
      rows: [["Oslo", 700000], ["Bergen", 280000]],
    };
    const analysis: DataTable = {
      columns: [{ name: "Stat", type: "string" }, { name: "Pop", type: "number" }],
      rows: [["Total", null], ["Average", null]],
      formulas: { "0,1": "SUM('Data'!B2:B3)", "1,1": "AVERAGE('Data'!B2:B3)" },
    };
    const out = recalcWorkbook([{ name: "Data", table: data }, { name: "Analysis", table: analysis }]);
    expect(out[1]!.table.rows[0]![1]).toBe(980000);
    expect(out[1]!.table.rows[1]![1]).toBe(490000);
    expect(out[0]).toEqual({ name: "Data", table: data }); // the data sheet is unchanged
  });

  it("handles a quoted sheet name and a bare name, case-insensitively", () => {
    const a: DataTable = { columns: [{ name: "X", type: "number" }], rows: [[5]] };
    const b: DataTable = {
      columns: [{ name: "Y", type: "number" }],
      rows: [[null], [null]],
      formulas: { "0,0": "data!A2*2", "1,0": "'DATA'!A2+1" }, // bare + quoted, mixed case
    };
    const out = recalcWorkbook([{ name: "Data", table: a }, { name: "Calc", table: b }]);
    expect(out[1]!.table.rows[0]![0]).toBe(10);
    expect(out[1]!.table.rows[1]![0]).toBe(6);
  });
});
