import { unzipSync, strFromU8 } from "fflate";

/**
 * Convert common document & data files to plain text for import — the "upload
 * any data" path. Word and Excel are ZIP-of-XML (read with the same `fflate`
 * the EPUB importer uses); CSV and RTF are text. All pure (bytes/string → text),
 * so they're host-agnostic and unit-tested. Spreadsheets/CSV are best read in
 * TECHNICAL mode, where the extraction turns their numbers into charts.
 */

const MAX_TABLE_ROWS = 5000;
const MAX_TABLE_COLS = 64;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" → "&lt;" not "<"
}

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/** Read a named entry from an unzipped archive (case-exact), or "" when absent. */
function entryText(files: Record<string, Uint8Array>, name: string): string {
  const data = files[name];
  return data ? strFromU8(data) : "";
}

/**
 * Word `.docx` → text. Pulls `word/document.xml`, turns each `<w:p>` paragraph
 * into a line and each `<w:tab/>` into a tab, then strips the remaining tags.
 */
export function docxToText(input: ArrayBuffer | Uint8Array): string {
  const files = unzipSync(toBytes(input));
  const xml = entryText(files, "word/document.xml");
  if (!xml) throw new Error("This .docx has no readable document body.");
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br\b[^>]*\/?>/g, "\n");
  const text = decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, ""));
  return text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

/** "A1" / "BC12" → zero-based column index of the letters. */
function columnIndex(cellRef: string): number {
  const letters = /^([A-Z]+)/.exec(cellRef.toUpperCase())?.[1] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

/** Render a grid of cells as a " | "-separated, newline-joined table. */
function gridToText(rows: string[][]): string {
  return rows
    .map((cells) => cells.map((c) => c.trim()).join(" | ").replace(/(?: \| )+$/, ""))
    .filter((line) => line.trim())
    .join("\n");
}

/**
 * Excel `.xlsx` → a text table of the FIRST worksheet. Resolves shared strings,
 * inline strings, and numeric cells; lays them out by column so the technical
 * extraction can read the columns as datasets. One sheet (the common case).
 */
export function xlsxToText(input: ArrayBuffer | Uint8Array): string {
  const files = unzipSync(toBytes(input));
  // Shared strings: each <si> is one string (possibly several <t> runs).
  const shared: string[] = [];
  const sst = entryText(files, "xl/sharedStrings.xml");
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      const runs = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1]!));
      shared.push(runs.join(""));
    }
  }
  const sheet = strFromU8(firstWorksheet(files));
  if (!sheet) {
    throw new Error("Couldn't read this .xlsx (unusual structure). Tip: in Excel, Save As → CSV.");
  }
  const rows: string[][] = [];
  // Both real cells (<c …>…</c>) and self-closing empty cells (<c r="B1"/>) — the
  // latter keep column alignment when a row skips a column.
  for (const rowXml of (sheet.match(/<row[\s\S]*?<\/row>/g) ?? []).slice(0, MAX_TABLE_ROWS)) {
    const cells: string[] = [];
    for (const c of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const inner = c[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = "";
      if (type === "s") {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
        value = shared[idx] ?? "";
      } else if (type === "inlineStr" || type === "str") {
        value = decodeXmlEntities([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]!).join("")) ||
          decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      } else {
        value = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      }
      const col = ref ? columnIndex(ref) : cells.length;
      if (col < MAX_TABLE_COLS) cells[col] = value;
    }
    for (let i = 0; i < cells.length; i++) cells[i] ??= "";
    rows.push(cells);
  }
  const text = gridToText(rows);
  if (!text) throw new Error("This spreadsheet's first sheet has no data.");
  return text;
}

/**
 * The bytes of the workbook's FIRST worksheet. Resolves the real sheet order via
 * workbook.xml + its rels (the first sheet isn't always sheet1.xml); falls back to
 * sheet1.xml, then the lowest-numbered sheet, then any worksheet at all.
 */
function firstWorksheet(files: Record<string, Uint8Array>): Uint8Array {
  const workbook = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const rels = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  const firstRid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
  if (firstRid && rels) {
    const target = new RegExp(`<Relationship\\b[^>]*Id="${firstRid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
    if (target) {
      const key = `xl/${target.replace(/^\.?\//, "").replace(/^\/+/, "")}`;
      if (files[key]) return files[key]!;
    }
  }
  const sheetKeys = Object.keys(files)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    .sort((a, b) => (Number(/(\d+)\.xml$/.exec(a)?.[1]) || 0) - (Number(/(\d+)\.xml$/.exec(b)?.[1]) || 0));
  const key = files["xl/worksheets/sheet1.xml"] ? "xl/worksheets/sheet1.xml" : sheetKeys[0];
  return key && files[key] ? files[key]! : new Uint8Array(0);
}

/** Split one CSV/TSV line, honouring quoted fields ("" → literal quote). */
function splitDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV/TSV → a " | "-separated text table (auto-detects tab vs comma). */
export function csvToText(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, ""); // strip a leading byte-order mark
  // Tab wins when the first line has more tabs than commas (a TSV export).
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows = splitDelimited(trimmed, delimiter).slice(0, MAX_TABLE_ROWS).map((r) => r.slice(0, MAX_TABLE_COLS));
  const out = gridToText(rows);
  if (!out) throw new Error("This file has no rows to read.");
  return out;
}

/**
 * Minimal RTF → text: drop the font/colour/stylesheet groups, turn `\par`/`\line`
 * into newlines, decode `\'xx` hex and unicode `\uN` escapes, and strip the rest
 * of the control words. Good enough for plain documents (not full layout).
 */
export function rtfToText(rtf: string): string {
  let s = rtf
    // Drop whole groups we never want as text (font tables, colour tables, info…).
    .replace(/\{\\\*?(?:fonttbl|colortbl|stylesheet|info|pict|themedata|datastore)[\s\S]*?\}/g, "")
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\line\b/g, "\n")
    .replace(/\\tab\b/g, "\t")
    // \'hh → byte (Latin-1-ish), \uN → unicode code point (with its skip char).
    .replace(/\\'([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\s?\??/g, (_, n: string) => String.fromCodePoint((Number(n) + 65536) % 65536))
    // Remaining control words and the group braces.
    .replace(/\\[a-z]+-?\d*\s?/gi, "")
    .replace(/[{}]/g, "");
  s = s.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
