import { describe, expect, it } from "vitest";
import { setTableCell, type DataTable } from "./data-table.js";

const base: DataTable = {
  columns: [
    { name: "City", type: "string" },
    { name: "Pop", type: "number" },
  ],
  rows: [
    ["Oslo", 700000],
    ["Bergen", 280000],
  ],
};

describe("setTableCell", () => {
  it("coerces an edit to the column type and returns a new table (immutable)", () => {
    const next = setTableCell(base, 0, 1, "1,250,000");
    expect(next.rows[0]).toEqual(["Oslo", 1250000]); // thousands separators parsed
    expect(base.rows[0]).toEqual(["Oslo", 700000]); // original untouched
    expect(setTableCell(base, 1, 0, "Trondheim").rows[1]![0]).toBe("Trondheim");
  });

  it("blanks a numeric cell to null on empty input", () => {
    expect(setTableCell(base, 0, 1, "  ").rows[0]![1]).toBeNull();
  });

  it("demotes a number column to text when given non-numeric input (keeps the edit)", () => {
    const next = setTableCell(base, 0, 1, "N/A");
    expect(next.columns[1]!.type).toBe("string");
    expect(next.rows[0]![1]).toBe("N/A");
    expect(next.rows[1]![1]).toBe(280000); // other rows kept as-is
  });

  it("ignores out-of-range indices", () => {
    expect(setTableCell(base, 9, 0, "x")).toBe(base);
    expect(setTableCell(base, 0, 5, "x")).toBe(base);
  });
});
