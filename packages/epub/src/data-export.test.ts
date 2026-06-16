import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import type { DataTable } from "@visual-reader/core";
import { buildXlsx, columnLetter, dataTableToCsv, dataTableToXlsx, sheetFromDataTable } from "./data-export.js";
import { xlsxToGrid } from "./data-import.js";

const table: DataTable = {
  columns: [
    { name: "Year", type: "string" },
    { name: "Output", type: "number" },
  ],
  rows: [
    ["2024", 10],
    ["2025", 32],
  ],
};

describe("columnLetter", () => {
  it("maps indices to spreadsheet column letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
  });
});

describe("buildXlsx", () => {
  it("produces a valid OOXML package with the required parts", () => {
    const bytes = dataTableToXlsx(table);
    const files = unzipSync(bytes);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml", "xl/styles.xml"]) {
      expect(files[part], `missing ${part}`).toBeTruthy();
    }
  });

  it("round-trips header + typed cells back through the reader", () => {
    const grid = xlsxToGrid(dataTableToXlsx(table));
    expect(grid[0]).toEqual(["Year", "Output"]);
    expect(grid[1]).toEqual(["2024", "10"]);
    expect(grid[2]).toEqual(["2025", "32"]);
  });

  it("writes a real Excel SUM formula in a totals row (with a cached value for readers)", () => {
    const bytes = dataTableToXlsx(table, { totals: "sum" });
    const sheet = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("<f>SUM(B2:B3)</f>");
    // Average maps to AVERAGE, min/max likewise.
    const avg = strFromU8(unzipSync(dataTableToXlsx(table, { totals: "average" }))["xl/worksheets/sheet1.xml"]!);
    expect(avg).toContain("<f>AVERAGE(B2:B3)</f>");
  });

  it("supports multiple sheets with sanitised names", () => {
    const bytes = buildXlsx([
      sheetFromDataTable("Data/2025", table),
      { name: "Notes", rows: [[{ value: "hi", bold: true }], [{ formula: "1+1", value: 2 }]] },
    ]);
    const files = unzipSync(bytes);
    expect(files["xl/worksheets/sheet2.xml"]).toBeTruthy();
    const workbook = strFromU8(files["xl/workbook.xml"]!);
    expect(workbook).toContain('name="Data 2025"'); // "/" stripped from the tab name
    expect(workbook).toContain('name="Notes"');
    expect(strFromU8(files["xl/worksheets/sheet2.xml"]!)).toContain("<f>1+1</f>");
  });

  it("exports CSV with RFC-4180 quoting", () => {
    const t: DataTable = {
      columns: [{ name: "Name", type: "string" }, { name: "Note", type: "string" }],
      rows: [["Acme, Inc.", 'say "hi"'], ["Beta", "line1\nline2"]],
    };
    expect(dataTableToCsv(t)).toBe('Name,Note\r\n"Acme, Inc.","say ""hi"""\r\nBeta,"line1\nline2"');
  });

  it("writes imported cell formulas back out (round-trip)", () => {
    const t: DataTable = {
      columns: [{ name: "A", type: "number" }, { name: "B", type: "number" }],
      rows: [[2, 3], [4, null]],
      formulas: { "1,1": "A3*B2" }, // data-row 1, col 1 → sheet cell B3
    };
    const sheet = strFromU8(unzipSync(dataTableToXlsx(t))["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("<f>A3*B2</f>");
  });

  it("embeds a native chart with its parts, rels, and content-type overrides", () => {
    const t: DataTable = {
      columns: [{ name: "City", type: "string" }, { name: "Pop", type: "number" }],
      rows: [["Oslo", 700000], ["Bergen", 280000]],
    };
    const bytes = buildXlsx([sheetFromDataTable("Data", t, { chart: "bar" })]);
    const files = unzipSync(bytes);
    for (const part of [
      "xl/charts/chart1.xml",
      "xl/drawings/drawing1.xml",
      "xl/drawings/_rels/drawing1.xml.rels",
      "xl/worksheets/_rels/sheet1.xml.rels",
    ]) {
      expect(files[part], `missing ${part}`).toBeTruthy();
    }
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("<drawing r:id=\"rId1\"/>");
    const chart = strFromU8(files["xl/charts/chart1.xml"]!);
    expect(chart).toContain("<c:barChart>");
    // categories = the string column (A2:A3), values = the numeric column (B2:B3)
    expect(chart).toContain("'Data'!$A$2:$A$3");
    expect(chart).toContain("'Data'!$B$2:$B$3");
    expect(chart).toContain("'Data'!$B$1"); // series name from the header
    const ct = strFromU8(files["[Content_Types].xml"]!);
    expect(ct).toContain("/xl/charts/chart1.xml");
    expect(ct).toContain("drawingml.chart+xml");
  });

  it("excludes a totals row from the chart's data range", () => {
    const t: DataTable = {
      columns: [{ name: "City", type: "string" }, { name: "Pop", type: "number" }],
      rows: [["Oslo", 700000], ["Bergen", 280000]],
    };
    const chart = strFromU8(unzipSync(buildXlsx([sheetFromDataTable("Data", t, { totals: "sum", chart: "bar" })]))["xl/charts/chart1.xml"]!);
    expect(chart).toContain("'Data'!$B$2:$B$3"); // rows 2-3 only, not the totals row 4
    expect(chart).not.toContain("$B$4");
  });

  it("escapes XML-special characters in strings", () => {
    const t: DataTable = { columns: [{ name: "A & B", type: "string" }], rows: [["<x>"]] };
    const sheet = strFromU8(unzipSync(dataTableToXlsx(t))["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("A &amp; B");
    expect(sheet).toContain("&lt;x&gt;");
    // And the reader decodes them back.
    expect(xlsxToGrid(dataTableToXlsx(t))).toEqual([["A & B"], ["<x>"]]);
  });
});
