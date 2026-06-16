import { describe, expect, it } from "vitest";
import { buildAnalysisTable } from "./formula-analysis.js";
import type { DataTable } from "./data-table.js";

const table: DataTable = {
  columns: [
    { name: "City", type: "string" },
    { name: "Pop", type: "number" },
    { name: "Area", type: "number" },
  ],
  rows: [
    ["Oslo", 700000, 454],
    ["Bergen", 280000, 465],
    ["Trondheim", 200000, 342],
  ],
};

describe("buildAnalysisTable", () => {
  it("emits descriptive-stat formulas per numeric column over the data ranges", () => {
    const a = buildAnalysisTable(table, "Data")!;
    expect(a.columns.map((c) => c.name)).toEqual(["Statistic", "Pop", "Area"]);
    expect(a.rows[0]![0]).toBe("Count");
    // 3 data rows → range rows 2..4; Pop is column B, Area is column C.
    expect(a.formulas!["0,1"]).toBe("COUNT('Data'!B2:B4)");
    expect(a.formulas!["2,1"]).toBe("AVERAGE('Data'!B2:B4)");
    expect(a.formulas!["6,2"]).toBe("STDEV('Data'!C2:C4)");
  });

  it("adds a correlation + regression block across the first two numeric columns", () => {
    const a = buildAnalysisTable(table, "Data")!;
    const labels = a.rows.map((r) => r[0]);
    expect(labels).toContain("Correlation (Pop vs Area)");
    expect(labels).toContain("R² (Pop vs Area)");
    const corrRow = a.rows.findIndex((r) => r[0] === "Correlation (Pop vs Area)");
    expect(a.formulas![`${corrRow},1`]).toBe("CORREL('Data'!B2:B4,'Data'!C2:C4)");
    const slopeRow = a.rows.findIndex((r) => r[0] === "Slope (Pop vs Area)");
    expect(a.formulas![`${slopeRow},1`]).toBe("SLOPE('Data'!C2:C4,'Data'!B2:B4)");
  });

  it("quotes/escapes the sheet name and skips when there's nothing numeric", () => {
    expect(buildAnalysisTable(table, "Q1 'Sales'")!.formulas!["0,1"]).toBe("COUNT('Q1 ''Sales'''!B2:B4)");
    const noNums: DataTable = { columns: [{ name: "Name", type: "string" }], rows: [["a"]] };
    expect(buildAnalysisTable(noNums, "Data")).toBeUndefined();
  });
});
