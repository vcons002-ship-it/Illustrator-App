import { unzipSync, strFromU8 } from "fflate";
import type { BookSource } from "@visual-reader/core";
import { segmentBook, type BookMeta, type RawChapter, type SegmentOptions } from "./segment.js";

/**
 * Parse an EPUB (a zip of XHTML) into a BookSource.
 *
 * Reads the container → OPF → spine to get reading order, extracts prose from
 * each spine document, then defers to `segmentBook` for paging. HTML→text uses
 * a tag-stripping pass rather than a DOM parser, so this works unchanged in
 * Node (tests), browser, and Web Worker contexts.
 */
export function parseEpub(
  data: Uint8Array,
  id: string,
  options: SegmentOptions = {},
): BookSource {
  const files = unzipSync(data);
  const opfPath = findOpfPath(files);
  const opfXml = readFile(files, opfPath);
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const meta = readMeta(opfXml, id);
  const manifest = readManifest(opfXml);
  const spine = readSpine(opfXml);

  // Prefer the EPUB's own table of contents (nav/NCX) to define chapters — it
  // splits a giant single document and merges per-scene fragments into the real
  // chapters, with the author's titles. Fall back to one-chapter-per-spine-doc.
  const toc = readToc(files, opfXml, manifest, opfDir);
  const rawChapters =
    (toc.length > 0 && buildChaptersFromToc(files, spine, manifest, opfDir, toc)) ||
    spineChapters(files, spine, manifest, opfDir);

  return segmentBook(meta, rawChapters, options);
}

/** Fallback: one chapter per spine document (the original behaviour). */
function spineChapters(
  files: Record<string, Uint8Array>,
  spine: SpineItem[],
  manifest: Map<string, ManifestItem>,
  opfDir: string,
): RawChapter[] {
  const rawChapters: RawChapter[] = [];
  spine.forEach((item, i) => {
    const props = manifest.get(item.idref);
    if (!props) return;
    const html = readFileOptional(files, opfDir + props.href);
    if (html === undefined) return;
    const text = htmlToText(html);
    if (text.trim().length === 0) return;
    const title = extractTitle(html) ?? `Chapter ${i + 1}`;
    const isStory = isStoryDocument({
      title,
      linear: item.linear,
      properties: `${item.properties} ${props.properties}`,
      html,
    });
    rawChapters.push({ title, text, ...(isStory ? {} : { isStory: false }) });
  });
  return rawChapters;
}

function findOpfPath(files: Record<string, Uint8Array>): string {
  const container = readFile(files, "META-INF/container.xml");
  const m = container.match(/full-path="([^"]+)"/);
  if (!m) throw new Error("EPUB is missing an OPF rootfile reference");
  return m[1]!;
}

function readMeta(opfXml: string, id: string): BookMeta {
  const title = matchTag(opfXml, "dc:title") ?? "Untitled";
  const author = matchTag(opfXml, "dc:creator");
  return { id, title, ...(author ? { author } : {}) };
}

interface ManifestItem {
  href: string;
  /** epub3 manifest `properties` (e.g. "nav", "cover-image"). */
  properties: string;
}

function readManifest(opfXml: string): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>();
  const itemRe = /<item\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(opfXml)) !== null) {
    const tag = m[0];
    const id = attr(tag, "id");
    const href = attr(tag, "href");
    if (id && href) {
      manifest.set(id, { href: decodeEntities(href), properties: attr(tag, "properties") ?? "" });
    }
  }
  return manifest;
}

interface SpineItem {
  idref: string;
  /** itemref `linear`: "no" marks auxiliary/front-matter content. */
  linear: string;
  /** itemref `properties` (rare). */
  properties: string;
}

function readSpine(opfXml: string): SpineItem[] {
  const order: SpineItem[] = [];
  const refRe = /<itemref\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(opfXml)) !== null) {
    const idref = attr(m[0], "idref");
    if (idref) {
      order.push({
        idref,
        linear: attr(m[0], "linear") ?? "",
        properties: attr(m[0], "properties") ?? "",
      });
    }
  }
  return order;
}

/** Titles of non-story front/back matter (never matches Prologue/Epilogue). */
const NON_STORY_TITLE_RE =
  /^\s*(cover|title\s*page|copyright|colophon|contents|table of contents|dedication|epigraph|acknowledge?ments?|acknowledgements?|about the author|about the publisher|also by|by the same author|praise for|front\s*matter|back\s*matter|half\s*title|frontispiece|index|bibliography|notes|appendix|glossary|map of)\b/i;

/** epub3 semantic types (in epub:type / properties) that mark non-story matter. */
const NON_STORY_EPUB_TYPE_RE =
  /\b(cover|titlepage|frontmatter|backmatter|toc|landmarks|copyright-page|dedication|epigraph|acknowledgments|colophon|index|bibliography|glossary|appendix)\b/i;

/**
 * Decide whether a spine document is story prose. Non-story when the spine marks
 * it auxiliary (`linear="no"`), the manifest/spine `properties` or the document's
 * `epub:type` flag front/back matter, or the title matches a front/back-matter
 * name — but Prologue/Epilogue and ordinary chapters always count as story.
 */
function isStoryDocument(input: {
  title: string;
  linear: string;
  properties: string;
  html: string;
}): boolean {
  if (input.linear.toLowerCase() === "no") return false;
  if (NON_STORY_EPUB_TYPE_RE.test(input.properties)) return false;
  // epub:type lives on the body or section elements of the content document.
  const typeMatch = input.html.match(/epub:type\s*=\s*"([^"]*)"/i);
  if (typeMatch && NON_STORY_EPUB_TYPE_RE.test(typeMatch[1]!)) return false;
  if (NON_STORY_TITLE_RE.test(input.title)) return false;
  return true;
}

// --- Table of contents → chapters --------------------------------------------

/** A resolved TOC entry: title + the spine file it points at (+ optional anchor). */
interface TocRef {
  title: string;
  /** Absolute zip path of the target document (fragment stripped). */
  path: string;
  /** Anchor id within the document, or "" for the whole document. */
  fragment: string;
}

/** Read the EPUB's table of contents (EPUB3 nav, else EPUB2 NCX). [] if none. */
export function readToc(
  files: Record<string, Uint8Array>,
  opfXml: string,
  manifest: Map<string, ManifestItem>,
  opfDir: string,
): TocRef[] {
  // EPUB3: a manifest item with properties containing "nav".
  for (const item of manifest.values()) {
    if (/\bnav\b/.test(item.properties)) {
      const navPath = resolvePath(opfDir, item.href);
      const html = readFileOptional(files, navPath);
      if (html) {
        const entries = parseNavToc(html, dirOf(navPath));
        if (entries.length) return entries;
      }
      break;
    }
  }
  // EPUB2: the NCX referenced by the spine `toc` attr or a manifest ncx item.
  const ncxHref = findNcxHref(opfXml, manifest);
  if (ncxHref) {
    const ncxPath = resolvePath(opfDir, ncxHref);
    const xml = readFileOptional(files, ncxPath);
    if (xml) {
      const entries = parseNcxToc(xml, dirOf(ncxPath));
      if (entries.length) return entries;
    }
  }
  return [];
}

/** Parse an EPUB3 nav document's `<nav epub:type="toc">` <a href> list, in order. */
function parseNavToc(html: string, navDir: string): TocRef[] {
  const navBlock =
    html.match(/<nav\b[^>]*epub:type="[^"]*\btoc\b[^"]*"[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ??
    html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ??
    html;
  const out: TocRef[] = [];
  const aRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(navBlock)) !== null) {
    const href = decodeEntities(m[1]!);
    const title = decodeEntities(m[2]!.replace(/<[^>]+>/g, "")).trim();
    out.push({ title, path: resolvePath(navDir, href), fragment: fragmentOf(href) });
  }
  return out;
}

/** Parse an EPUB2 NCX `<navPoint>` list (navLabel text + content src), in order. */
function parseNcxToc(xml: string, ncxDir: string): TocRef[] {
  const out: TocRef[] = [];
  const re = /<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\bsrc="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const title = decodeEntities(m[1]!.replace(/<[^>]+>/g, "")).trim();
    const href = decodeEntities(m[2]!);
    out.push({ title, path: resolvePath(ncxDir, href), fragment: fragmentOf(href) });
  }
  return out;
}

/** Build chapters from the TOC: split giant docs at anchors, merge un-TOC'd docs. */
function buildChaptersFromToc(
  files: Record<string, Uint8Array>,
  spine: SpineItem[],
  manifest: Map<string, ManifestItem>,
  opfDir: string,
  toc: TocRef[],
): RawChapter[] | undefined {
  const docs = spine.map((item, i) => {
    const mi = manifest.get(item.idref);
    const path = mi ? resolvePath(opfDir, mi.href) : "";
    return { i, path, item, props: mi, html: mi ? readFileOptional(files, path) : undefined };
  });
  const pathToSpine = new Map<string, number>();
  for (const d of docs) if (d.path) pathToSpine.set(d.path, d.i);

  const byDoc = new Map<number, TocRef[]>();
  for (const t of toc) {
    const s = pathToSpine.get(t.path);
    if (s === undefined) continue;
    const list = byDoc.get(s);
    if (list) list.push(t);
    else byDoc.set(s, [t]);
  }
  if (byDoc.size === 0) return undefined; // TOC doesn't map onto the spine → fallback

  // Store TEXT (not html) so merging continuation docs doesn't trip `htmlToText`
  // (which keeps only the first <body>).
  const chapters: { title: string; text: string; isStory: boolean }[] = [];
  const storyOf = (title: string, d: (typeof docs)[number], html: string): boolean =>
    isStoryDocument({
      title,
      linear: d.item.linear,
      properties: `${d.item.properties} ${d.props?.properties ?? ""}`,
      html,
    });

  for (const d of docs) {
    if (d.html === undefined) continue;
    const entries = byDoc.get(d.i) ?? [];
    if (entries.length === 0) {
      // No TOC entry → continuation of the previous chapter (merges tiny docs).
      const text = htmlToText(d.html);
      if (chapters.length > 0) {
        if (text) chapters[chapters.length - 1]!.text += `\n\n${text}`;
      } else {
        const title = extractTitle(d.html) ?? "Section";
        chapters.push({ title, text, isStory: storyOf(title, d, d.html) });
      }
      continue;
    }
    const withOffset = entries
      .map((e) => ({ e, off: e.fragment ? anchorOffset(d.html!, e.fragment) : 0 }))
      .sort((a, b) => a.off - b.off);
    if (withOffset.length === 1 || withOffset.some((x) => x.off < 0)) {
      // Single entry (or unreliable anchors) → the whole document is one chapter.
      const title = withOffset[0]!.e.title || extractTitle(d.html) || "Chapter";
      chapters.push({ title, text: htmlToText(d.html), isStory: storyOf(title, d, d.html) });
    } else {
      const parts = splitAtOffsets(d.html, withOffset.map((x) => x.off));
      withOffset.forEach((x, idx) => {
        const html = parts[idx] ?? "";
        const title = x.e.title || "Chapter";
        chapters.push({ title, text: htmlToText(html), isStory: storyOf(title, d, html) });
      });
    }
  }

  const raw: RawChapter[] = chapters
    .map((c) => ({ title: c.title, text: c.text.trim(), isStory: c.isStory }))
    .filter((c) => c.text.length > 0)
    .map((c) => ({ title: c.title, text: c.text, ...(c.isStory ? {} : { isStory: false }) }));
  return raw.length > 0 ? raw : undefined;
}

/** Resolve `rel` (possibly with ../ and a #fragment) against `baseDir` → zip path. */
function resolvePath(baseDir: string, rel: string): string {
  const cleanRel = rel.split("#")[0]!;
  const out: string[] = [];
  for (const p of `${baseDir}${cleanRel}`.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}
function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}
function fragmentOf(href: string): string {
  const i = href.indexOf("#");
  return i >= 0 ? href.slice(i + 1) : "";
}
function findNcxHref(opfXml: string, manifest: Map<string, ManifestItem>): string | undefined {
  const tocId = opfXml.match(/<spine\b[^>]*\btoc="([^"]+)"/i)?.[1];
  if (tocId && manifest.get(tocId)) return manifest.get(tocId)!.href;
  const ncxItem = opfXml.match(
    /<item\b[^>]*media-type="application\/x-dtbncx\+xml"[^>]*>/i,
  )?.[0];
  return ncxItem ? attr(ncxItem, "href") : undefined;
}
/** Offset of the element bearing `id`/`name="frag"`, or -1 if not found. */
function anchorOffset(html: string, frag: string): number {
  const esc = frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<[^>]*\\b(?:id|name)\\s*=\\s*["']${esc}["']`, "i").exec(html);
  return m ? m.index : -1;
}
/** Slice `html` at the given ascending offsets (backed up to element starts). */
function splitAtOffsets(html: string, offsets: number[]): string[] {
  const starts = offsets.map((o) => {
    const lt = html.lastIndexOf("<", o);
    return lt >= 0 ? lt : Math.max(0, o);
  });
  const parts: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = i === 0 ? 0 : starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : html.length;
    parts.push(html.slice(from, to));
  }
  return parts;
}

/** Strip an XHTML document down to paragraph-separated plain text. */
export function htmlToText(html: string): string {
  const body = html.replace(/[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*/i, "");
  return body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|br)\s*\/?>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => decodeEntities(line).trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html: string): string | undefined {
  return (
    matchTag(html, "h1") ??
    matchTag(html, "h2") ??
    matchTag(html, "title")
  )?.replace(/<[^>]+>/g, "").trim();
}

function matchTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeEntities(m[1]!.replace(/<[^>]+>/g, "")).trim() : undefined;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

function readFile(files: Record<string, Uint8Array>, path: string): string {
  const found = readFileOptional(files, path);
  if (found === undefined) throw new Error(`EPUB is missing required file: ${path}`);
  return found;
}

function readFileOptional(files: Record<string, Uint8Array>, path: string): string | undefined {
  const normalized = path.replace(/^\.\//, "");
  const entry = files[normalized] ?? files[decodeURIComponent(normalized)];
  return entry ? strFromU8(entry) : undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
