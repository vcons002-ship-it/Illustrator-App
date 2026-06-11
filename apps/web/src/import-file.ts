import type { BookSource } from "@visual-reader/core";
import { htmlToText, parseEpub } from "@visual-reader/epub";

/**
 * Universal book import (browser side): turn any supported file — EPUB, plain text,
 * Markdown, HTML, PDF — into either a ready book or extracted text the user confirms
 * in the paste modal. The text→book conversion itself (`bookFromText`, chapter
 * detection, stable content-hash ids) lives in `@visual-reader/epub`; this module only
 * handles the File/extension/pdf.js parts that need a browser.
 */

/** File extensions the importer understands (used for the input's `accept`). */
export const IMPORT_ACCEPT = ".epub,.txt,.md,.markdown,.html,.htm,.pdf";

/**
 * An EPUB parses straight to a ready book; everything else yields extracted TEXT that
 * the caller confirms in the paste modal first (title fix-up + fiction/technical choice).
 */
export type ImportedFile =
  | { kind: "book"; book: BookSource }
  | { kind: "text"; title: string; text: string };

export async function importBookFile(file: File): Promise<ImportedFile> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const title = file.name.replace(/\.[^.]+$/, "");
  switch (ext) {
    case "epub": {
      const data = new Uint8Array(await file.arrayBuffer());
      return { kind: "book", book: parseEpub(data, `epub-${file.name}-${file.size}`) };
    }
    case "txt":
    case "md":
    case "markdown":
      return { kind: "text", title, text: await file.text() };
    case "html":
    case "htm":
      return { kind: "text", title, text: htmlToText(await file.text()) };
    case "pdf": {
      const data = new Uint8Array(await file.arrayBuffer());
      return { kind: "text", title, text: await pdfToText(data) };
    }
    default:
      throw new Error(
        `Unsupported file type ".${ext}" — supported: EPUB, TXT, Markdown, HTML, PDF (or paste text directly).`,
      );
  }
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
