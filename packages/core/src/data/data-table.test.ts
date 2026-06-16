import { describe, expect, it } from "vitest";
import {
  addColumn,
  addRow,
  createDataTable,
  dataTableFromGrid,
  parseA1,
  removeColumn,
  removeRow,
  renameColumn,
  setColumnFormula,
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

describe("formulas", () => {
  const withF: DataTable = { ...base, formulas: { "1,1": "B2*2" } }; // a formula on row 1, col 1

  it("imports formulas aligned to the surviving data rows", () => {
    // grid has a blank row that gets filtered — formulas must still line up.
    const grid = [
      ["City", "Pop"],
      ["Oslo", "700000"],
      ["", ""],
      ["Bergen", "280000"],
    ];
    const formulaGrid = [[], [], [], [undefined, "B2+B3"]];
    const t = dataTableFromGrid(grid, formulaGrid)!;
    expect(t.rows).toHaveLength(2);
    expect(t.formulas).toEqual({ "1,1": "B2+B3" }); // Bergen's row is data-row 1
  });

  it("stores an =formula edit and clears it when a literal is typed", () => {
    const f = setTableCell(base, 0, 1, "=A2*2");
    expect(f.formulas).toEqual({ "0,1": "A2*2" });
    expect(f.rows[0]![1]).toBeNull(); // value unknown until Excel recalcs
    expect(setTableCell(f, 0, 1, "42").formulas).toBeUndefined(); // literal clears the formula
  });

  it("remaps formula coordinates across row/column edits (and drops deleted cells)", () => {
    expect(addRow(withF, 0).formulas).toEqual({ "2,1": "B2*2" }); // pushed down
    expect(removeRow(withF, 0).formulas).toEqual({ "0,1": "B2*2" }); // shifted up
    expect(removeRow(withF, 1).formulas).toBeUndefined(); // the formula row itself removed
    expect(addColumn(withF, "X", 0).formulas).toEqual({ "1,2": "B2*2" }); // pushed right
    expect(removeColumn(withF, 1).formulas).toBeUndefined(); // the formula column removed
  });
});

describe("A1 references + fill-down formulas", () => {
  it("parses A1 refs to data coords and rejects the header / out-of-range", () => {
    expect(parseA1(base, "A2")).toEqual({ row: 0, col: 0 }); // first data cell
    expect(parseA1(base, "B3")).toEqual({ row: 1, col: 1 });
    expect(parseA1(base, "$B$2")).toEqual({ row: 0, col: 1 }); // absolute refs ok
    expect(parseA1(base, "B1")).toBeUndefined(); // header row
    expect(parseA1(base, "C2")).toBeUndefined(); // no column C
    expect(parseA1(base, "A9")).toBeUndefined(); // beyond the data
    expect(parseA1(base, "nope")).toBeUndefined();
  });

  it("fills a {r}-templated formula down a column with each row's Excel row", () => {
    const t = setColumnFormula(addColumn(base, "Double"), 2, "B{r}*2");
    expect(t.formulas).toEqual({ "0,2": "B2*2", "1,2": "B3*2" });
    expect(setColumnFormula(base, 9, "x")).toBe(base); // out-of-range column: no-op
  });
});

describe("createDataTable (from scratch)", () => {
  it("builds typed columns + rows, inferring types and parsing =formulas", () => {
    const t = createDataTable(
      [{ name: "Category" }, { name: "Budget" }, { name: "Spent", type: "number" }, { name: "Remaining" }],
      [
        ["Rent", 1500, 1500, "=B2-C2"],
        ["Food", "400", 380, "=B3-C3"],
      ],
    );
    expect(t.columns).toEqual([
      { name: "Category", type: "string" },
      { name: "Budget", type: "number" }, // inferred (1500 / "400")
      { name: "Spent", type: "number" }, // explicit
      { name: "Remaining", type: "string" }, // only formula cells → no literal values to infer number
    ]);
    expect(t.rows[0]).toEqual(["Rent", 1500, 1500, null]); // formula cell value blank
    expect(t.formulas).toEqual({ "0,3": "B2-C2", "1,3": "B3-C3" });
  });

  it("de-dupes names, caps nothing weird, and always yields a column", () => {
    const t = createDataTable([{ name: "A" }, { name: "A" }]);
    expect(t.columns.map((c) => c.name)).toEqual(["A", "A (2)"]);
    expect(createDataTable([]).columns).toHaveLength(1);
  });
});
