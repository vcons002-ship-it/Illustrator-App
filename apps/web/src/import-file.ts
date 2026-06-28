import {
  classifyJson,
  dataTableFromGrid,
  parseJsonValue,
  recalcTable,
  tableToText,
  type BookSource,
  type DataTable,
  type JsonValue,
} from "@visual-reader/core";
import { csvToGrid, docxToText, htmlToText, parseEpub, rtfToText, xlsxToWorkbook } from "@visual-reader/epub";

/** Render a parsed cell grid as the " | "-separated text the reader/extraction reads. */
function gridText(grid: string[][]): string {
  return grid
    .map((cells) => cells.map((c) => (c ?? "").trim()).join(" | ").replace(/(?: \| )+$/, ""))
    .filter((line) => line.trim())
    .join("\n");
}

/**
 * Universal book import (browser side): turn any supported file — EPUB, plain text,
 * Markdown, HTML, PDF — into either a ready book or extracted text the user confirms
 * in the paste modal. The text→book conversion itself (`bookFromText`, chapter
 * detection, stable content-hash ids) lives in `@visual-reader/epub`; this module only
 * handles the File/extension/pdf.js parts that need a browser.
 */

/** File extensions the importer understands (a hint for the picker). The picker also accepts ANY
 * file — an unknown type opens in the plain-text reader, and "Open as…" can re-route it. */
export const IMPORT_ACCEPT =
  ".epub,.txt,.md,.markdown,.html,.htm,.pdf,.docx,.rtf,.csv,.tsv,.json,.xlsx," +
  ".png,.jpg,.jpeg,.webp,.gif";

/** How to interpret a file. "auto" follows the extension; the rest are explicit "Open as…" choices
 * the reader can pick on open or afterward, re-routing the SAME bytes through a different reader. */
export type FileHandler = "auto" | "reader" | "data" | "text" | "image";

/** The "Open as…" menu options (excludes "auto" — that's the default route). */
export const FILE_HANDLER_OPTIONS: { id: Exclude<FileHandler, "auto">; label: string }[] = [
  { id: "reader", label: "📖 Reader (book / article)" },
  { id: "data", label: "📊 Spreadsheet / data grid" },
  { id: "text", label: "📝 Plain text" },
  { id: "image", label: "🖼 Image / photo" },
];

/** The handler an extension maps to by default — drives the auto route and the picker's pre-selection. */
export function handlerForExt(ext: string): Exclude<FileHandler, "auto"> {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS[e]) return "image";
  if (e === "xlsx" || e === "csv" || e === "tsv" || e === "json") return "data";
  if (e === "epub" || e === "pdf" || e === "docx" || e === "rtf" || e === "html" || e === "htm" || e === "md" || e === "markdown")
    return "reader";
  return "text"; // txt and any UNKNOWN type → the plain-text reader (never a dead end)
}

/** Image extensions routed to the photo-transform (img2img) path, not the book importer. */
const IMAGE_EXTS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * An EPUB parses straight to a ready book; documents yield extracted TEXT the caller
 * confirms in the paste modal (title + fiction/technical choice); an image opens the
 * photo-transform panel. `mode` pre-selects the text choice — data files (CSV/Excel)
 * default to technical, where the extraction turns their numbers into charts.
 */
export type ImportedFile =
  | { kind: "book"; book: BookSource }
  | {
      kind: "text";
      title: string;
      text: string;
      mode?: "fiction" | "technical";
      /** Tabular import (spreadsheet/CSV, or tabular JSON) → the table view. */
      data?: DataTable;
      /** Every tabular sheet of a multi-sheet workbook (data aliases the first). */
      dataSheets?: { name: string; table: DataTable }[];
      /** Nested/irregular JSON that doesn't tabularise → the tree view. */
      tree?: JsonValue;
    }
  | { kind: "image"; name: string; bytes: ArrayBuffer; mimeType: string };

/** Extensions that parse to a real data grid (so a "data" handler uses the structured parse). */
const DATA_EXTS = new Set(["xlsx", "csv", "tsv", "json"]);

export async function importBookFile(file: File, handler: FileHandler = "auto"): Promise<ImportedFile> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const title = file.name.replace(/\.[^.]+$/, "");
  const effective = handler === "auto" ? handlerForExt(ext) : handler;

  // Explicit "Open as…" overrides (and the image-extension auto route) short-circuit the parse below.
  if (effective === "image") {
    return { kind: "image", name: file.name, bytes: await file.arrayBuffer(), mimeType: IMAGE_EXTS[ext] ?? "image/png" };
  }
  if (effective === "text") {
    // Forced "Plain text" AND the unknown-type fallback: show the raw text in the reader, no mode/grid.
    return { kind: "text", title, text: await file.text() };
  }
  if (effective === "data" && !DATA_EXTS.has(ext)) {
    // "Open as data" on a non-tabular file: try to read it as delimited text, else fall back to plain text.
    const grid = csvToGrid(await file.text());
    const data = dataTableFromGrid(grid);
    return data
      ? { kind: "text", title, text: gridText(grid), mode: "technical", data }
      : { kind: "text", title, text: await file.text() };
  }
  switch (ext) {
    case "epub": {
      const bytes = await file.arrayBuffer();
      return { kind: "book", book: await parseEpubOffMain(bytes, `epub-${file.name}-${file.size}`) };
    }
    case "txt":
    case "md":
    case "markdown":
      return { kind: "text", title, text: await file.text() };
    case "json": {
      // Pick the view that fits the JSON's shape: tabular data (arrays of records,
      // lists, a flat object) → the table view + analyze_data; nested/irregular data
      // → the collapsible tree. Invalid JSON falls back to readable prose.
      const raw = await file.text();
      const value = parseJsonValue(raw);
      if (value === undefined) return { kind: "text", title, text: prettyJson(raw) };
      const view = classifyJson(value);
      if (view.kind === "table") {
        return { kind: "text", title, text: tableToText(view.table, view.table.rows.length), mode: "technical", data: view.table };
      }
      return { kind: "text", title, text: JSON.stringify(value, null, 2), tree: value };
    }
    case "html":
    case "htm":
      return { kind: "text", title, text: htmlToText(await file.text()) };
    case "rtf":
      return { kind: "text", title, text: rtfToText(await file.text()) };
    case "docx":
      return { kind: "text", title, text: docxToText(await file.arrayBuffer()) };
    case "csv":
    case "tsv": {
      // Tabular data → technical mode (the extraction charts the numbers), AND keep the
      // structured grid for the chat's grounded analyze_data tool.
      const grid = csvToGrid(await file.text());
      const data = dataTableFromGrid(grid);
      return { kind: "text", title, text: gridText(grid), mode: "technical", ...(data ? { data } : {}) };
    }
    case "xlsx": {
      // Read EVERY worksheet, not just the first. The primary table (`data`) drives
      // the chat's analyze_data; `dataSheets` keeps all tabs for viewing / re-export.
      const sheets = xlsxToWorkbook(await file.arrayBuffer())
        .map((s) => {
          const table = dataTableFromGrid(s.grid, s.formulas);
          // Recompute supported formulas live; unsupported ones keep Excel's cached value.
          return { name: s.name, table: table ? recalcTable(table) : undefined };
        })
        .filter((s): s is { name: string; table: DataTable } => !!s.table);
      const data = sheets[0]?.table;
      // Text the extraction reads: each sheet labelled, so multi-sheet context is kept.
      const text =
        sheets.length > 1
          ? sheets.map((s) => `## ${s.name}\n${tableToText(s.table, s.table.rows.length)}`).join("\n\n")
          : data
            ? tableToText(data, data.rows.length)
            : "";
      return {
        kind: "text",
        title,
        text,
        mode: "technical",
        ...(data ? { data } : {}),
        ...(sheets.length > 1 ? { dataSheets: sheets } : {}),
      };
    }
    case "pdf": {
      const data = new Uint8Array(await file.arrayBuffer());
      return { kind: "text", title, text: await pdfToText(data) };
    }
    default:
      // ANY other / unknown extension → the plain-text reader (never a dead end). The reader can
      // re-route it with "Open as…" if the raw text isn't what they wanted.
      return { kind: "text", title, text: await file.text() };
  }
}

/** Pretty-print JSON for readable import; raw text when it isn't valid JSON. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Parse an EPUB in a dedicated worker (transferred bytes, zero-copy): unzip +
 * HTML→text is synchronous and froze the page for seconds on real books. Falls
 * back to inline parsing where module workers can't be constructed.
 */
function parseEpubOffMain(bytes: ArrayBuffer, id: string): Promise<BookSource> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./epub.worker.ts", import.meta.url), { type: "module" });
    } catch {
      try {
        resolve(parseEpub(new Uint8Array(bytes), id));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
    worker.onmessage = (e: MessageEvent<{ ok: boolean; book?: BookSource; error?: string }>) => {
      worker.terminate();
      if (e.data.ok && e.data.book) resolve(e.data.book);
      else reject(new Error(e.data.error ?? "EPUB parse failed"));
    };
    worker.onerror = (e: ErrorEvent) => {
      worker.terminate();
      reject(new Error(`Couldn't parse the EPUB — ${e.message || "the parser worker failed to load"}`));
    };
    worker.postMessage({ bytes, id }, [bytes]);
  });
}

/**
 * Extract a PDF's text with pdf.js, page by page. Lazy-imported so the (large) pdf.js
 * bundle is only fetched when someone actually imports a PDF.
 */
export async function pdfToText(data: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (line) pages.push(line);
  }
  await task.destroy();
  if (pages.length === 0) {
    throw new Error("No selectable text found in this PDF (it may be a scan — OCR isn't supported).");
  }
  return pages.join("\n\n");
}
