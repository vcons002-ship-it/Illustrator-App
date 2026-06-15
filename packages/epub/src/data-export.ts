import { zipSync, strToU8 } from "fflate";
import type { DataTable } from "@visual-reader/core";

/**
 * Write a real Excel `.xlsx` workbook — the counterpart to `data-import.ts`'s
 * reader. Same dependency-light approach: hand-build the minimal OOXML parts and
 * zip them with the `fflate` the rest of the app already uses (no SheetJS/exceljs).
 * Pure (cells → bytes), so it's host-agnostic and unit-tested by reading its own
 * output back through `xlsxToGrid`.
 *
 * Supports what the app actually needs: multiple sheets, typed cells (number /
 * string / boolean), **real Excel formulas** (so an exported sheet has working
 * built-in functions, not just baked values), and bold header/total rows. Inline
 * strings are used (no shared-strings table) to keep the writer simple — Excel,
 * LibreOffice, and our own reader all accept them.
 */

export type XlsxCellValue = number | string | boolean | null;

export interface XlsxCell {
  /** A formula WITHOUT the leading "=" (e.g. "SUM(B2:B10)"). Makes a live Excel cell. */
  formula?: string;
  /** A literal value, or the cached result shown for a formula until Excel recalcs. */
  value?: XlsxCellValue;
  /** Bold styling (header rows, totals). */
  bold?: boolean;
}

/** A cell is either a bare value or the richer {formula,value,bold} form. */
export type XlsxCellInput = XlsxCellValue | XlsxCell;

export interface XlsxSheet {
  /** Tab name (sanitised to Excel's rules: ≤31 chars, no []:*?/\\). */
  name: string;
  /** Row-major cells. A `null` (or undefined) cell is left empty. */
  rows: XlsxCellInput[][];
}

/** Aggregations that map cleanly to an Excel built-in function for a totals row. */
export type XlsxAggregation = "sum" | "average" | "mean" | "min" | "max" | "count" | "median" | "stdev";

const AGG_FN: Record<XlsxAggregation, string> = {
  sum: "SUM",
  average: "AVERAGE",
  mean: "AVERAGE",
  min: "MIN",
  max: "MAX",
  count: "COUNT",
  median: "MEDIAN",
  stdev: "STDEV",
};

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Excel tab-name rules: strip forbidden chars, trim to 31, never empty. */
function sanitizeSheetName(name: string, fallback: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31);
  return cleaned || fallback;
}

function normalizeCell(input: XlsxCellInput): XlsxCell {
  if (input === null || input === undefined) return {};
  if (typeof input === "object") return input;
  return { value: input };
}

/** One `<c>` element (or "" for an empty cell), at column `col`, row `rowNum`. */
function cellXml(input: XlsxCellInput, col: number, rowNum: number): string {
  const cell = normalizeCell(input);
  const ref = `${columnLetter(col)}${rowNum}`;
  const s = cell.bold ? ' s="1"' : "";
  // Formula cell: emit <f> + optional cached <v> (numeric, or t="str" for text).
  if (cell.formula) {
    const f = `<f>${escapeXml(cell.formula)}</f>`;
    if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
      return `<c r="${ref}"${s}>${f}<v>${cell.value}</v></c>`;
    }
    if (typeof cell.value === "string") {
      return `<c r="${ref}"${s} t="str">${f}<v>${escapeXml(cell.value)}</v></c>`;
    }
    return `<c r="${ref}"${s}>${f}</c>`;
  }
  const v = cell.value;
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") {
    return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : "";
  }
  if (typeof v === "boolean") {
    return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const rows = sheet.rows
    .map((cells, r) => {
      const rowNum = r + 1;
      const body = cells.map((c, col) => cellXml(c, col, rowNum)).join("");
      return `<row r="${rowNum}">${body}</row>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${NS_MAIN}"><sheetData>${rows}</sheetData></worksheet>`
  );
}

/** styles.xml with one extra "bold" cell format (index 1) for headers/totals. */
function stylesXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="${NS_MAIN}">` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
    `</styleSheet>`
  );
}

/**
 * Build a complete `.xlsx` workbook from one or more sheets. Returns the raw zip
 * bytes ready for download / save. An empty `sheets` array yields a single blank
 * "Sheet1" (Excel rejects a zero-sheet workbook).
 */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const list = sheets.length ? sheets : [{ name: "Sheet1", rows: [] }];
  const names = list.map((s, i) => sanitizeSheetName(s.name, `Sheet${i + 1}`));

  const files: Record<string, Uint8Array> = {};
  list.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s));
  });
  files["xl/styles.xml"] = strToU8(stylesXml());

  // Sheets take rId1..rIdN; styles gets the next id.
  const sheetRels = list
    .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${NS_R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("");
  const stylesRid = `rId${list.length + 1}`;
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${NS_REL}">${sheetRels}` +
      `<Relationship Id="${stylesRid}" Type="${NS_R}/styles" Target="styles.xml"/></Relationships>`,
  );

  const sheetTags = names
    .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheets>${sheetTags}</sheets></workbook>`,
  );

  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${NS_REL}">` +
      `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );

  const overrides =
    list.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`;
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="${NS_CT}">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `${overrides}</Types>`,
  );

  return zipSync(files);
}

/**
 * Convert a typed `DataTable` into an `XlsxSheet`: a bold header row, then the data
 * rows with numbers kept numeric. Optionally append a **totals row** of real Excel
 * formulas (e.g. `=SUM(B2:B11)`) across the numeric columns, so the saved file
 * carries working built-in functions rather than baked numbers.
 */
export function sheetFromDataTable(
  name: string,
  table: DataTable,
  opts: { totals?: XlsxAggregation; totalsLabel?: string } = {},
): XlsxSheet {
  const header: XlsxCellInput[] = table.columns.map((c) => ({ value: c.name, bold: true }));
  const body: XlsxCellInput[][] = table.rows.map((row) =>
    row.map((v, c) => (table.columns[c]?.type === "number" && typeof v === "number" ? v : v)),
  );
  const rows: XlsxCellInput[][] = [header, ...body];

  if (opts.totals) {
    const fn = AGG_FN[opts.totals];
    const firstDataRow = 2; // header is row 1
    const lastDataRow = table.rows.length + 1;
    const totalRow: XlsxCellInput[] = table.columns.map((col, c) => {
      if (c === 0) return { value: opts.totalsLabel ?? "Total", bold: true };
      if (col.type !== "number" || lastDataRow < firstDataRow) return null;
      const colRef = columnLetter(c);
      return { formula: `${fn}(${colRef}${firstDataRow}:${colRef}${lastDataRow})`, bold: true };
    });
    rows.push(totalRow);
  }
  return { name, rows };
}

/** Build a single-sheet `.xlsx` straight from a DataTable (the common case). */
export function dataTableToXlsx(
  table: DataTable,
  opts: { sheetName?: string; totals?: XlsxAggregation; totalsLabel?: string } = {},
): Uint8Array {
  const { sheetName = "Sheet1", ...rest } = opts;
  return buildXlsx([sheetFromDataTable(sheetName, table, rest)]);
}
