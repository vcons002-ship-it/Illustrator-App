import { splitHtmlBlocks, type BookSource, type ContentMode } from "@visual-reader/core";
import { segmentBook, type ParagraphInput, type RawChapter } from "./segment.js";

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
  contentMode?: ContentMode,
  /** Shown in the library as provenance (e.g. "Pasted text", "Imported file"). */
  author?: string,
): BookSource {
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new Error("There's no text to import.");
  const id = `text-${contentHash(`${title}\n${body}`)}`;
  const book = segmentBook(
    { id, title: title.trim() || "Pasted text", ...(author ? { author } : {}) },
    splitChapters(title, body),
  );
  return contentMode && contentMode !== "fiction" ? { ...book, contentMode } : book;
}

/**
 * Build a `BookSource` from a web article that ALSO carries sanitized HTML per paragraph (for the
 * optional "original layout" view). Uses the SAME content-hash id as `bookFromText(title, text)`,
 * so an article has one stable identity whether or not the layout HTML is present. Chapters split
 * at heading (`<h1>`/`<h2>`) blocks; paragraphs carry both `.text` (analysis/anchoring) and `.html`.
 */
export function bookFromHtml(
  title: string,
  text: string,
  html: string,
  contentMode?: ContentMode,
  author?: string,
): BookSource {
  const body = text.replace(/\r\n?/g, "\n").trim();
  const blocks = splitHtmlBlocks(html);
  if (!body || blocks.length === 0) return bookFromText(title, text, contentMode, author);
  const id = `text-${contentHash(`${title}\n${body}`)}`;
  const chapters: RawChapter[] = [];
  let cur: ParagraphInput[] = [];
  let curTitle: string | undefined;
  const flush = (): void => {
    if (cur.length) chapters.push({ title: curTitle ?? title, text: cur.map((p) => p.text).join("\n\n"), paragraphs: cur });
    cur = [];
  };
  for (const b of blocks) {
    if (/^<h[12]\b/i.test(b.html)) {
      flush();
      curTitle = b.text;
    }
    cur.push(b);
  }
  flush();
  const book = segmentBook(
    { id, title: title.trim() || "Web article", ...(author ? { author } : {}) },
    chapters.length > 0 ? chapters : [{ title, text: body, paragraphs: blocks }],
  );
  return contentMode && contentMode !== "fiction" ? { ...book, contentMode } : book;
}

/**
 * Build a `code` BookSource from a source file: open it as a readable, illustrate-able document
 * with its own (code) analysis path. Sections split at TOP-LEVEL definitions (not Markdown
 * headings — `#` is a comment in many languages), and paragraphs are blank-line-separated code
 * blocks (whitespace preserved) so diagrams anchor to real lines. Stable content-hash id.
 */
export function bookFromCode(title: string, code: string, language?: string, author?: string): BookSource {
  const body = code.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  if (!body.trim()) throw new Error("There's no code to open.");
  const id = `code-${contentHash(`${title}\n${body}`)}`;
  const book = segmentBook(
    { id, title: title.trim() || "Code", ...(author ? { author } : {}) },
    splitCodeSections(title.trim() || "Code", body),
  );
  return { ...book, contentMode: "code", code: body, ...(language ? { language } : {}) };
}

/**
 * Build a "story as you go" `BookSource` under a STABLE, caller-supplied id — NOT a
 * content hash. This is the linchpin of the as-you-go append: `segmentBook` assigns ids
 * positionally (`ch-N`/`pg-N`), so re-segmenting the accumulated beats with the SAME id
 * leaves every PRIOR id byte-identical and only appends the new beat's units at the end.
 * That keeps the `${book.id}:${pageId}` image cache + `bible.processedChapters` valid, so
 * earlier spans are never re-extracted or re-rendered. A content-hash id (which changes
 * on every beat) would orphan the bible + images — exactly what must not happen.
 *
 * Each beat is one internal chapter (the engine's incremental extraction unit); the story
 * reads as continuous prose (no visible chapter structure), so the chapters carry the
 * story title rather than per-beat headings. `beats` is every beat so far, in order.
 */
export function storyBook(
  id: string,
  title: string,
  author: string | undefined,
  beats: string[],
): BookSource {
  const clean = (s: string): string => s.replace(/\r\n?/g, "\n").trim();
  const name = title.trim() || "Story";
  const chapters: RawChapter[] = beats
    .map((text) => ({ title: name, text: clean(text) }))
    .filter((c) => c.text.length > 0);
  const book = segmentBook(
    { id, title: name, ...(author ? { author } : {}) },
    chapters.length > 0 ? chapters : [{ title: name, text: "" }],
  );
  return { ...book, contentMode: "fiction", kind: "story" };
}

/**
 * Append one beat to a story, returning the GROWN book (the stable id is preserved). A
 * thin wrapper over `storyBook` that re-segments the accumulated beats + the new one — so
 * the host can keep a `string[]` of beats and call this per turn (O(text), but the only
 * heavy work, extraction + render, stays O(one beat) via `Engine.appendChapter`).
 */
export function appendStoryChapter(book: BookSource, priorBeats: string[], newBeat: string): BookSource {
  return storyBook(book.id, book.title, book.author, [...priorBeats, newBeat]);
}

/** A top-level (column-0) definition that starts a new code section. */
const CODE_SECTION =
  /^(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|impl|trait|def|fn|module|namespace|component|service)\b/;

/** Blank-line-separated code blocks → paragraphs (code whitespace preserved). */
function codeParagraphs(text: string): ParagraphInput[] {
  return text
    .split(/\n{2,}/)
    .map((b) => b.replace(/\s+$/, ""))
    .filter((b) => b.trim().length > 0)
    .map((b) => ({ text: b }));
}

/** Split source into sections at top-level definitions; one section when none are found. */
function splitCodeSections(title: string, body: string): RawChapter[] {
  const lines = body.split("\n");
  const chapters: RawChapter[] = [];
  let curTitle: string | undefined;
  let buf: string[] = [];
  const flush = (): void => {
    const text = buf.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.trim()) chapters.push({ title: curTitle ?? title, text, paragraphs: codeParagraphs(text) });
    buf = [];
  };
  for (const line of lines) {
    if (CODE_SECTION.test(line) && buf.some((l) => l.trim().length > 0)) {
      flush();
      curTitle = line.trim().slice(0, 80);
    }
    buf.push(line);
  }
  flush();
  return chapters.length > 0 ? chapters : [{ title, text: body, paragraphs: codeParagraphs(body) }];
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
