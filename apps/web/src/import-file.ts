import type { BookSource } from "@visual-reader/core";
import { csvToText, docxToText, htmlToText, parseEpub, rtfToText, xlsxToText } from "@visual-reader/epub";

/**
 * Universal book import (browser side): turn any supported file — EPUB, plain text,
 * Markdown, HTML, PDF — into either a ready book or extracted text the user confirms
 * in the paste modal. The text→book conversion itself (`bookFromText`, chapter
 * detection, stable content-hash ids) lives in `@visual-reader/epub`; this module only
 * handles the File/extension/pdf.js parts that need a browser.
 */

/** File extensions the importer understands (used for the input's `accept`). */
export const IMPORT_ACCEPT =
  ".epub,.txt,.md,.markdown,.html,.htm,.pdf,.docx,.rtf,.csv,.tsv,.json,.xlsx";

/**
 * An EPUB parses straight to a ready book; everything else yields extracted TEXT that
 * the caller confirms in the paste modal first (title fix-up + fiction/technical choice).
 * `mode` pre-selects that choice — data files (spreadsheets/CSV) default to technical,
 * where the extraction turns their numbers into charts.
 */
export type ImportedFile =
  | { kind: "book"; book: BookSource }
  | { kind: "text"; title: string; text: string; mode?: "fiction" | "technical" };

export async function importBookFile(file: File): Promise<ImportedFile> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const title = file.name.replace(/\.[^.]+$/, "");
  switch (ext) {
    case "epub": {
      const bytes = await file.arrayBuffer();
      return { kind: "book", book: await parseEpubOffMain(bytes, `epub-${file.name}-${file.size}`) };
    }
    case "txt":
    case "md":
    case "markdown":
      return { kind: "text", title, text: await file.text() };
    case "json":
      // Pretty-print so the structure is readable as prose; fall back to raw text.
      return { kind: "text", title, text: prettyJson(await file.text()) };
    case "html":
    case "htm":
      return { kind: "text", title, text: htmlToText(await file.text()) };
    case "rtf":
      return { kind: "text", title, text: rtfToText(await file.text()) };
    case "docx":
      return { kind: "text", title, text: docxToText(await file.arrayBuffer()) };
    case "csv":
    case "tsv":
      // Tabular data → technical mode (the extraction charts the numbers).
      return { kind: "text", title, text: csvToText(await file.text()), mode: "technical" };
    case "xlsx":
      return { kind: "text", title, text: xlsxToText(await file.arrayBuffer()), mode: "technical" };
    case "pdf": {
      const data = new Uint8Array(await file.arrayBuffer());
      return { kind: "text", title, text: await pdfToText(data) };
    }
    default:
      throw new Error(
        `Unsupported file type ".${ext}" — supported: EPUB, PDF, Word (.docx), Excel (.xlsx), ` +
          `CSV/TSV, RTF, JSON, TXT, Markdown, HTML (or paste text directly).`,
      );
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
async function pdfToText(data: Uint8Array): Promise<string> {
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
