import { describe, expect, it } from "vitest";
import { evaluateFormula, recalcTable, type FormulaContext } from "./formula-eval.js";
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
