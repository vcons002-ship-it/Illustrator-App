import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { csvToText, docxToText, rtfToText, xlsxToText } from "./data-import.js";

describe("docxToText", () => {
  it("extracts paragraph text, tabs, and decoded entities", () => {
    const doc =
      '<?xml version="1.0"?><w:document><w:body>' +
      "<w:p><w:r><w:t>Heat &amp; Mass Transfer</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>Row A</w:t></w:r><w:tab/><w:r><w:t>Row B</w:t></w:r></w:p>" +
      "</w:body></w:document>";
    const bytes = zipSync({ "word/document.xml": strToU8(doc) });
    const text = docxToText(bytes);
    expect(text).toContain("Heat & Mass Transfer");
    expect(text).toContain("Row A\tRow B");
    expect(text.split("\n")[0]).toBe("Heat & Mass Transfer");
  });

  it("throws when there's no document body", () => {
    expect(() => docxToText(zipSync({ "other.xml": strToU8("x") }))).toThrow(/no readable document/);
  });
});

describe("xlsxToText", () => {
  it("resolves shared strings + numbers into a table of the first sheet", () => {
    const sst =
      '<sst><si><t>Year</t></si><si><t>Output</t></si></sst>';
    const sheet =
      "<worksheet><sheetData>" +
      '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row><c r="A2"><v>2020</v></c><c r="B2"><v>42</v></c></row>' +
      '<row><c r="A3"><v>2021</v></c><c r="B3"><v>55</v></c></row>' +
      "</sheetData></worksheet>";
    const bytes = zipSync({
      "xl/sharedStrings.xml": strToU8(sst),
      "xl/worksheets/sheet1.xml": strToU8(sheet),
    });
    const text = xlsxToText(bytes);
    expect(text.split("\n")).toEqual(["Year | Output", "2020 | 42", "2021 | 55"]);
  });

  it("handles gaps (a missing B cell) by column position", () => {
    const sheet =
      "<worksheet><sheetData>" +
      '<row><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>' +
      "</sheetData></worksheet>";
    const text = xlsxToText(zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet) }));
    expect(text).toBe("1 |  | 3");
  });
});

describe("csvToText", () => {
  it("renders a CSV as a pipe table, honouring quoted commas", () => {
    const csv = 'name,score\n"Doe, John",90\nJane,85';
    expect(csvToText(csv).split("\n")).toEqual(["name | score", "Doe, John | 90", "Jane | 85"]);
  });

  it("auto-detects TSV", () => {
    expect(csvToText("a\tb\tc\n1\t2\t3").split("\n")).toEqual(["a | b | c", "1 | 2 | 3"]);
  });

  it("handles quoted fields with embedded quotes and newlines", () => {
    const csv = 'q\n"she said ""hi""\nthen left"';
    expect(csvToText(csv)).toBe('q\nshe said "hi"\nthen left');
  });
});

describe("rtfToText", () => {
  it("strips control words and groups, keeping paragraph text", () => {
    const rtf =
      "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Hello world.\\par Second line.\\par}";
    const text = rtfToText(rtf);
    expect(text).toContain("Hello world.");
    expect(text).toContain("Second line.");
    expect(text).not.toContain("fonttbl");
    expect(text).not.toContain("\\par");
  });

  it("decodes hex and unicode escapes", () => {
    expect(rtfToText("\\rtf1 caf\\'e9 \\u8212 dash")).toContain("café");
    expect(rtfToText("\\rtf1 \\u8212 ")).toContain("—");
  });
});
