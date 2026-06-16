import { zipSync, strToU8 } from "fflate";
import { formulaKey, type DataTable } from "@visual-reader/core";

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

/**
 * An embedded NATIVE Excel chart on a sheet (a real, editable chart — not an image).
 * Columns are 0-based indices into the sheet's columns; the header is row 1 and the
 * data spans rows 2..N, matching `sheetFromDataTable` output.
 */
export interface XlsxChartSpec {
  kind: "bar" | "line" | "pie";
  title?: string;
  /** Column whose data cells label the categories (x-axis / pie slices). */
  categoriesCol: number;
  /** Column(s) supplying the value series (pie uses the first only). */
  valueCols: number[];
  /** Excel row of the last DATA row (excludes a trailing totals row). Defaults to the
   * sheet's row count when unset. */
  lastDataRow?: number;
}

export interface XlsxSheet {
  /** Tab name (sanitised to Excel's rules: ≤31 chars, no []:*?/\\). */
  name: string;
  /** Row-major cells. A `null` (or undefined) cell is left empty. */
  rows: XlsxCellInput[][];
  /** Optional embedded native chart over this sheet's data. */
  chart?: XlsxChartSpec;
}

const NS_CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_DRAW = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_SS_DRAW = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";

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
  // A charted sheet references its drawing part (and needs the relationships ns).
  const ns = sheet.chart ? `xmlns="${NS_MAIN}" xmlns:r="${NS_R}"` : `xmlns="${NS_MAIN}"`;
  const drawing = sheet.chart ? `<drawing r:id="rId1"/>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet ${ns}><sheetData>${rows}</sheetData>${drawing}</worksheet>`
  );
}

/** Absolute range ref on a named sheet, e.g. `'Data'!$B$2:$B$11`. */
function absRange(name: string, col: number, r1: number, r2: number): string {
  const L = columnLetter(col);
  return `'${name.replace(/'/g, "''")}'!$${L}$${r1}:$${L}$${r2}`;
}
/** Absolute single-cell ref, e.g. `'Data'!$B$1` (a series-name header). */
function absCell(name: string, col: number, row: number): string {
  return `'${name.replace(/'/g, "''")}'!$${columnLetter(col)}$${row}`;
}

/** The chart definition part (chartN.xml) for a sheet's chart spec. */
function chartXml(sheetName: string, sheet: XlsxSheet, spec: XlsxChartSpec): string {
  const lastRow = spec.lastDataRow ?? sheet.rows.length; // header = row 1, data = rows 2..lastRow
  const cat = absRange(sheetName, spec.categoriesCol, 2, lastRow);
  const cols = spec.kind === "pie" ? spec.valueCols.slice(0, 1) : spec.valueCols;
  const series = cols
    .map((vc, i) => {
      const tx = `<c:tx><c:strRef><c:f>${escapeXml(absCell(sheetName, vc, 1))}</c:f></c:strRef></c:tx>`;
      const catRef = `<c:cat><c:strRef><c:f>${escapeXml(cat)}</c:f></c:strRef></c:cat>`;
      const valRef = `<c:val><c:numRef><c:f>${escapeXml(absRange(sheetName, vc, 2, lastRow))}</c:f></c:numRef></c:val>`;
      const marker = spec.kind === "line" ? `<c:marker><c:symbol val="circle"/></c:marker>` : "";
      return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${marker}${catRef}${valRef}</c:ser>`;
    })
    .join("");
  const title = spec.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${escapeXml(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : `<c:autoTitleDeleted val="1"/>`;
  const axes =
    `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>` +
    `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>`;
  let plot: string;
  if (spec.kind === "pie") {
    plot = `<c:pieChart><c:varyColors val="1"/>${series}</c:pieChart>`;
  } else if (spec.kind === "line") {
    plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>${axes}`;
  } else {
    plot = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:axId val="1"/><c:axId val="2"/></c:barChart>${axes}`;
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="${NS_CHART}" xmlns:a="${NS_DRAW}" xmlns:r="${NS_R}">` +
    `<c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>` +
    (spec.kind === "pie" ? `<c:legend><c:legendPos val="r"/></c:legend>` : "") +
    `<c:plotVisOnly val="1"/></c:chart></c:chartSpace>`
  );
}

/** The drawing part (drawingN.xml) anchoring one chart on the sheet. */
function drawingXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="${NS_SS_DRAW}" xmlns:a="${NS_DRAW}">` +
    `<xdr:twoCellAnchor>` +
    `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:graphicFrame macro="">` +
    `<xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="${NS_CHART}">` +
    `<c:chart xmlns:c="${NS_CHART}" xmlns:r="${NS_R}" r:id="rId1"/>` +
    `</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`
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
    const n = i + 1;
    files[`xl/worksheets/sheet${n}.xml`] = strToU8(sheetXml(s));
    if (s.chart) {
      // Per-sheet chart + drawing parts, each wired sheet → drawing → chart by rels.
      files[`xl/charts/chart${n}.xml`] = strToU8(chartXml(names[i]!, s, s.chart));
      files[`xl/drawings/drawing${n}.xml`] = strToU8(drawingXml());
      files[`xl/drawings/_rels/drawing${n}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="${NS_REL}">` +
          `<Relationship Id="rId1" Type="${NS_R}/chart" Target="../charts/chart${n}.xml"/></Relationships>`,
      );
      files[`xl/worksheets/_rels/sheet${n}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="${NS_REL}">` +
          `<Relationship Id="rId1" Type="${NS_R}/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`,
      );
    }
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

  const chartOverrides = list
    .map((s, i) =>
      s.chart
        ? `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>` +
          `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
        : "",
    )
    .join("");
  const overrides =
    list.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    chartOverrides;
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
/**
 * A chart spec over a DataTable: the first string column labels the categories (or
 * column 0 when there's none), the numeric columns are the value series (pie uses the
 * first). `undefined` when the table has no numeric column to plot.
 */
export function chartSpecFromTable(table: DataTable, kind: "bar" | "line" | "pie"): XlsxChartSpec | undefined {
  const catCol = table.columns.findIndex((c) => c.type === "string");
  const valueCols = table.columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === "number").map((x) => x.i);
  if (valueCols.length === 0) return undefined;
  return {
    kind,
    categoriesCol: catCol >= 0 ? catCol : 0,
    valueCols: kind === "pie" ? valueCols.slice(0, 1) : valueCols,
    lastDataRow: table.rows.length + 1, // header is row 1; data ends here (before any totals)
  };
}

export function sheetFromDataTable(
  name: string,
  table: DataTable,
  opts: { totals?: XlsxAggregation; totalsLabel?: string; chart?: "bar" | "line" | "pie" } = {},
): XlsxSheet {
  const header: XlsxCellInput[] = table.columns.map((c) => ({ value: c.name, bold: true }));
  // Body cells: emit an imported/edited formula where present (with its cached value),
  // otherwise the literal value. Header is row 1, so data row r sits on sheet row r+2.
  const body: XlsxCellInput[][] = table.rows.map((row, r) =>
    row.map((v, c): XlsxCellInput => {
      const f = table.formulas?.[formulaKey(r, c)];
      return f ? { formula: f, ...(v !== null ? { value: v } : {}) } : v;
    }),
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
  const chart = opts.chart ? chartSpecFromTable(table, opts.chart) : undefined;
  return { name, rows, ...(chart ? { chart } : {}) };
}

/** RFC-4180 CSV for one cell: quote when it contains a comma, quote, or newline. */
function csvCell(v: XlsxCellValue): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A typed DataTable → CSV text (header + rows). Excel opens it directly. */
export function dataTableToCsv(table: DataTable): string {
  const header = table.columns.map((c) => csvCell(c.name)).join(",");
  const rows = table.rows.map((r) => r.map((v) => csvCell(v as XlsxCellValue)).join(","));
  return [header, ...rows].join("\r\n");
}

/** Build a single-sheet `.xlsx` straight from a DataTable (the common case). */
export function dataTableToXlsx(
  table: DataTable,
  opts: { sheetName?: string; totals?: XlsxAggregation; totalsLabel?: string } = {},
): Uint8Array {
  const { sheetName = "Sheet1", ...rest } = opts;
  return buildXlsx([sheetFromDataTable(sheetName, table, rest)]);
}
