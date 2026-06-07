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

  const rawChapters: RawChapter[] = [];
  spine.forEach((idref, i) => {
    const href = manifest.get(idref);
    if (!href) return;
    const html = readFileOptional(files, opfDir + href);
    if (html === undefined) return;
    const text = htmlToText(html);
    if (text.trim().length === 0) return;
    rawChapters.push({ title: extractTitle(html) ?? `Chapter ${i + 1}`, text });
  });

  return segmentBook(meta, rawChapters, options);
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

function readManifest(opfXml: string): Map<string, string> {
  const manifest = new Map<string, string>();
  const itemRe = /<item\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(opfXml)) !== null) {
    const tag = m[0];
    const id = attr(tag, "id");
    const href = attr(tag, "href");
    if (id && href) manifest.set(id, decodeEntities(href));
  }
  return manifest;
}

function readSpine(opfXml: string): string[] {
  const order: string[] = [];
  const refRe = /<itemref\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(opfXml)) !== null) {
    const idref = attr(m[0], "idref");
    if (idref) order.push(idref);
  }
  return order;
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
