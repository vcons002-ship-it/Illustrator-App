import { describe, expect, it } from "vitest";
import {
  addColumn,
  addRow,
  removeColumn,
  removeRow,
  renameColumn,
  setTableCell,
  type DataTable,
} from "./data-table.js";

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

describe("row/column structure edits", () => {
  it("adds and removes rows (immutably, with bounds)", () => {
    const added = addRow(base);
    expect(added.rows).toHaveLength(3);
    expect(added.rows[2]).toEqual([null, null]);
    expect(base.rows).toHaveLength(2); // original untouched
    expect(addRow(base, 0).rows[0]).toEqual([null, null]);
    expect(removeRow(base, 0).rows).toEqual([["Bergen", 280000]]);
    expect(removeRow(base, 9)).toBe(base);
  });

  it("adds a uniquely-named empty column and removes one (with cells)", () => {
    const withCol = addColumn(base, "City");
    expect(withCol.columns.map((c) => c.name)).toEqual(["City", "Pop", "City (2)"]); // de-duped
    expect(withCol.columns[2]).toEqual({ name: "City (2)", type: "string" });
    expect(withCol.rows[0]).toEqual(["Oslo", 700000, null]);
    const dropped = removeColumn(base, 1);
    expect(dropped.columns.map((c) => c.name)).toEqual(["City"]);
    expect(dropped.rows).toEqual([["Oslo"], ["Bergen"]]);
    expect(removeColumn(dropped, 0)).toBe(dropped); // never remove the last column
  });

  it("renames a column, keeping names unique", () => {
    expect(renameColumn(base, 1, "Population").columns[1]!.name).toBe("Population");
    expect(renameColumn(base, 1, "City").columns[1]!.name).toBe("City (2)"); // collides with col 0
  });
});
