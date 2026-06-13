import { zipSync, strToU8, type Zippable } from "fflate";
import type { BookSource } from "@visual-reader/core";

/**
 * Export an illustrated book — the reader's text interleaved with the
 * illustrations the app rendered — as a portable artifact the reader can keep.
 *
 * Two formats, both self-contained (images embedded, nothing external to lose):
 *  - `buildIllustratedHtml` → one HTML file that opens in any browser;
 *  - `buildIllustratedEpub` → an EPUB3 ebook for e-readers / Apple Books.
 *
 * Pure functions over the in-memory book + a page→image map, so they're host-
 * agnostic and unit-testable: the caller (web or desktop) gathers the rendered
 * image bytes and decides how to write the result to disk. Exporting BEFORE a
 * re-style preserves the current art — the "keep this version, then try a new
 * style" workflow — because re-rendering overwrites the cached images.
 */

export interface ExportImage {
  bytes: ArrayBuffer;
  mimeType: string;
  /** Caption / source attribution shown under the figure ("" to omit). */
  caption?: string;
}

export interface ExportOptions {
  /** Overrides BookSource.title for the document title. */
  title?: string;
  author?: string;
  /** A short note recorded in the export (e.g. the art style used). */
  styleNote?: string;
}

/** Images keyed by the ORIGINAL page index where the figure should appear (a
 * render unit's first page) — so a multi-page unit shows its one image once. */
export type ExportImages = ReadonlyMap<number, ExportImage>;

interface Grouped {
  chapters: { chapter: BookSource["chapters"][number]; pages: BookSource["pages"] }[];
}

/** Group the book's pages under their chapters, in reading order, story chapters
 * only (front/back matter carries no illustrations and clutters an export). */
function groupByChapter(book: BookSource): Grouped {
  const byId = new Map(book.chapters.map((c) => [c.id, c]));
  const order: string[] = [];
  const pagesByChapter = new Map<string, BookSource["pages"]>();
  for (const page of book.pages) {
    const list = pagesByChapter.get(page.chapterId);
    if (list) list.push(page);
    else {
      pagesByChapter.set(page.chapterId, [page]);
      order.push(page.chapterId);
    }
  }
  const chapters = order
    .map((id) => ({ chapter: byId.get(id), pages: pagesByChapter.get(id)! }))
    .filter((c): c is Grouped["chapters"][number] => !!c.chapter && c.chapter.isStory !== false);
  return { chapters };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Base64 of image bytes (chunked so a multi-MB image can't blow the call stack). */
function bytesToBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  // btoa exists in browsers and workers; Node test env provides it too (v16+).
  return btoa(binary);
}

function extForMime(mimeType: string): string {
  if (/png/i.test(mimeType)) return "png";
  if (/jpe?g/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  if (/gif/i.test(mimeType)) return "gif";
  return "img";
}

/** How many of the book's units actually have an illustration (for a count/empty check). */
export function countExportImages(images: ExportImages): number {
  return images.size;
}

/**
 * A single self-contained HTML document: chapter headings, the prose, and each
 * unit's illustration embedded inline as a data URI. No external files, no
 * scripts — opens anywhere and survives being moved or emailed.
 */
export function buildIllustratedHtml(
  book: BookSource,
  images: ExportImages,
  opts: ExportOptions = {},
): string {
  const title = opts.title ?? book.title;
  const author = opts.author ?? book.author;
  const grouped = groupByChapter(book);
  const body: string[] = [];
  for (const { chapter, pages } of grouped.chapters) {
    body.push(`<h2>${escapeHtml(chapter.title || `Chapter ${chapter.index + 1}`)}</h2>`);
    for (const page of pages) {
      const image = images.get(page.index);
      if (image) {
        const src = `data:${image.mimeType};base64,${bytesToBase64(image.bytes)}`;
        const cap = image.caption ? `<figcaption>${escapeHtml(image.caption)}</figcaption>` : "";
        body.push(`<figure><img alt="Illustration" src="${src}"/>${cap}</figure>`);
      }
      for (const para of page.paragraphs) {
        if (para.text.trim()) body.push(`<p>${escapeHtml(para.text)}</p>`);
      }
    }
  }
  const meta = [
    author ? `<p class="byline">by ${escapeHtml(author)}</p>` : "",
    opts.styleNote ? `<p class="note">${escapeHtml(opts.styleNote)}</p>` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; font: 18px/1.6 Georgia, serif; color: #1c1c1c; background: #fbfaf7; }
  h1 { font-size: 2rem; } h2 { margin-top: 2.4rem; border-bottom: 1px solid #ddd; padding-bottom: .3rem; }
  p { margin: 0 0 1rem; } .byline { color: #666; font-style: italic; } .note { color: #888; font-size: .85rem; }
  figure { margin: 1.6rem 0; text-align: center; } img { max-width: 100%; height: auto; border-radius: 8px; }
  figcaption { font-size: .8rem; color: #777; margin-top: .4rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${meta}
${body.join("\n")}
</body>
</html>`;
}

const XHTML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';

/**
 * An EPUB3 ebook: a ZIP with the required `mimetype` (stored, uncompressed,
 * first), an OCF container, an OPF package (manifest + spine), a nav document,
 * one XHTML file per chapter, and the embedded images. Built with fflate's
 * `zipSync` — the same library the importer already uses to READ EPUBs.
 */
export function buildIllustratedEpub(
  book: BookSource,
  images: ExportImages,
  opts: ExportOptions = {},
): Uint8Array {
  const title = opts.title ?? book.title;
  const author = opts.author ?? book.author ?? "Visual Reader";
  const grouped = groupByChapter(book);
  const bookUid = `urn:visual-reader:${book.id}`;

  // Collect images once (dedup by page index) → manifest entries + file blobs.
  const imageFiles: { href: string; id: string; mimeType: string; data: Uint8Array }[] = [];
  const imageHrefByPage = new Map<number, string>();
  let imgN = 0;
  for (const [pageIndex, img] of images) {
    const id = `img${imgN}`;
    const href = `images/${id}.${extForMime(img.mimeType)}`;
    imageFiles.push({ href, id, mimeType: img.mimeType, data: new Uint8Array(img.bytes) });
    imageHrefByPage.set(pageIndex, href);
    imgN++;
  }

  // One XHTML per chapter, with images inlined before the page they illustrate.
  const chapterFiles = grouped.chapters.map(({ chapter, pages }, i) => {
    const parts: string[] = [`<h1>${escapeHtml(chapter.title || `Chapter ${chapter.index + 1}`)}</h1>`];
    for (const page of pages) {
      const href = imageHrefByPage.get(page.index);
      if (href) {
        const cap = images.get(page.index)?.caption;
        parts.push(
          `<figure><img alt="Illustration" src="${href}"/>${
            cap ? `<figcaption>${escapeHtml(cap)}</figcaption>` : ""
          }</figure>`,
        );
      }
      for (const para of page.paragraphs) {
        if (para.text.trim()) parts.push(`<p>${escapeHtml(para.text)}</p>`);
      }
    }
    const href = `chapter${i}.xhtml`;
    const xhtml = `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><meta charset="utf-8"/><title>${escapeHtml(chapter.title || `Chapter ${chapter.index + 1}`)}</title></head>
<body>
${parts.join("\n")}
</body>
</html>`;
    return { href, id: `chap${i}`, title: chapter.title || `Chapter ${chapter.index + 1}`, xhtml };
  });

  const manifestItems = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...chapterFiles.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`),
    ...imageFiles.map((f) => `<item id="${f.id}" href="${f.href}" media-type="${f.mimeType}"/>`),
  ].join("\n    ");
  const spineItems = chapterFiles.map((c) => `<itemref idref="${c.id}"/>`).join("\n    ");

  const opf = `${XHTML_HEAD}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeHtml(bookUid)}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title>
    <dc:creator>${escapeHtml(author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;

  const navLis = chapterFiles
    .map((c) => `      <li><a href="${c.href}">${escapeHtml(c.title)}</a></li>`)
    .join("\n");
  const nav = `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${navLis}
    </ol>
  </nav>
</body>
</html>`;

  const container = `${XHTML_HEAD}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const files: Zippable = {
    // The mimetype entry MUST be first and STORED (level 0) per the EPUB OCF spec.
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": [strToU8(container), { level: 6 }],
    "OEBPS/content.opf": [strToU8(opf), { level: 6 }],
    "OEBPS/nav.xhtml": [strToU8(nav), { level: 6 }],
  };
  for (const c of chapterFiles) files[`OEBPS/${c.href}`] = [strToU8(c.xhtml), { level: 6 }];
  for (const f of imageFiles) files[`OEBPS/${f.href}`] = [f.data, { level: 0 }]; // already compressed
  return zipSync(files);
}
