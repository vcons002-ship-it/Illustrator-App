import type { BookSource } from "@visual-reader/core";
import { segmentBook, type RawChapter } from "./segment.js";

/**
 * Build a `BookSource` from a title + raw text (a pasted article, an imported .txt/.md/
 * .html/.pdf's extracted text…). Reuses the EPUB pipeline's `segmentBook`, so the result
 * reads, illustrates, and caches exactly like a parsed EPUB.
 *
 * The id is a STABLE hash of the content, so importing the same text again reopens the
 * same book — with its Visual Bible and rendered images intact. `contentMode` marks
 * non-fiction so illustration prompts use the technical (concept/diagram) template.
 */
export function bookFromText(
  title: string,
  text: string,
  contentMode?: "fiction" | "technical",
): BookSource {
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new Error("There's no text to import.");
  const id = `text-${contentHash(`${title}\n${body}`)}`;
  const book = segmentBook({ id, title: title.trim() || "Pasted text" }, splitChapters(title, body));
  return contentMode === "technical" ? { ...book, contentMode } : book;
}

/** A line that starts a new chapter: a Markdown heading or a "Chapter/Part N" line. */
const CHAPTER_LINE =
  /^(?:#{1,3}\s+\S.*|(?:chapter|part|book)\s+(?:[0-9]+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\b.{0,60})$/i;

/** Split raw text into chapters at heading lines; single chapter when none found. */
function splitChapters(bookTitle: string, body: string): RawChapter[] {
  const lines = body.split("\n");
  const chapters: RawChapter[] = [];
  let currentTitle: string | undefined;
  let buf: string[] = [];
  const flush = (): void => {
    const text = buf.join("\n").trim();
    if (text) chapters.push({ title: currentTitle ?? bookTitle, text });
    buf = [];
  };
  for (const line of lines) {
    if (CHAPTER_LINE.test(line.trim())) {
      flush();
      currentTitle = line.replace(/^#{1,3}\s+/, "").trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  // A lone heading with no body, or no headings at all → the whole text as one chapter.
  return chapters.length > 0 ? chapters : [{ title: bookTitle, text: body }];
}

/** FNV-1a 32-bit content hash (hex) — stable across sessions for cache identity. */
function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
