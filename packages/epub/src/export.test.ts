import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import type { BookSource } from "@visual-reader/core";
import { bookFromText } from "./from-text.js";
import {
  buildIllustratedEpub,
  buildIllustratedHtml,
  countExportImages,
  type ExportImage,
  type ExportImages,
} from "./export.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).buffer;
function img(caption?: string): ExportImage {
  return { bytes: PNG, mimeType: "image/png", ...(caption ? { caption } : {}) };
}

/** A two-chapter book whose first page of each chapter carries an illustration. */
function sampleBook(): { book: BookSource; images: ExportImages } {
  const book = bookFromText(
    "Test Tale",
    "# Chapter One\n\nThe knight rode east.\n\nDusk fell over the hills.\n\n# Chapter Two\n\nThe dragon woke.",
    "fiction",
    "A. Author",
  );
  // First page of each chapter → an image (the unit-first-page convention).
  const images = new Map<number, ExportImage>();
  const firstOfChapter = new Set<string>();
  for (const page of book.pages) {
    if (!firstOfChapter.has(page.chapterId)) {
      firstOfChapter.add(page.chapterId);
      images.set(page.index, img(`figure for ${page.chapterId}`));
    }
  }
  return { book, images };
}

describe("buildIllustratedHtml", () => {
  it("interleaves prose with embedded data-URI images and escapes text", () => {
    const { book, images } = sampleBook();
    const html = buildIllustratedHtml(book, images, { styleNote: "oil painting" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Test Tale</title>");
    expect(html).toContain("by A. Author");
    expect(html).toContain("oil painting");
    expect(html).toContain("Chapter One");
    expect(html).toContain("The knight rode east.");
    // Every image embedded inline (no external refs).
    expect(html).toContain("data:image/png;base64,");
    expect((html.match(/<img /g) ?? []).length).toBe(images.size);
  });

  it("escapes HTML metacharacters in the text", () => {
    const book = bookFromText("T", "# C\n\na < b && c > d \"quote\"", "fiction");
    const html = buildIllustratedHtml(book, new Map());
    expect(html).toContain("a &lt; b &amp;&amp; c &gt; d &quot;quote&quot;");
    expect(html).not.toContain("a < b && c");
  });

  it("renders with no images at all", () => {
    const book = bookFromText("Plain", "# C\n\nJust words.", "fiction");
    const html = buildIllustratedHtml(book, new Map());
    expect(html).toContain("Just words.");
    expect(html).not.toContain("<img ");
  });
});

describe("buildIllustratedEpub", () => {
  it("produces a valid EPUB OCF zip (mimetype first + stored) that unzips to the content", () => {
    const { book, images } = sampleBook();
    const epub = buildIllustratedEpub(book, images, { author: "A. Author" });
    const entries = unzipSync(epub);

    // Required OCF structure.
    expect(strFromU8(entries["mimetype"]!)).toBe("application/epub+zip");
    expect(entries["META-INF/container.xml"]).toBeDefined();
    expect(entries["OEBPS/content.opf"]).toBeDefined();
    expect(entries["OEBPS/nav.xhtml"]).toBeDefined();

    const opf = strFromU8(entries["OEBPS/content.opf"]!);
    expect(opf).toContain("<dc:title>Test Tale</dc:title>");
    expect(opf).toContain("<dc:creator>A. Author</dc:creator>");
    expect(opf).toContain('properties="nav"');

    // One xhtml per (story) chapter, each in the spine and on disk.
    expect(entries["OEBPS/chapter0.xhtml"]).toBeDefined();
    expect(entries["OEBPS/chapter1.xhtml"]).toBeDefined();
    expect(strFromU8(entries["OEBPS/chapter0.xhtml"]!)).toContain("The knight rode east.");

    // Images embedded as files and referenced from the chapter xhtml.
    const imageEntries = Object.keys(entries).filter((k) => k.startsWith("OEBPS/images/"));
    expect(imageEntries.length).toBe(images.size);
    expect(strFromU8(entries["OEBPS/chapter0.xhtml"]!)).toMatch(/<img alt="Illustration" src="images\//);
  });

  it("mimetype is stored uncompressed (byte-identical round-trip)", () => {
    const { book, images } = sampleBook();
    const entries = unzipSync(buildIllustratedEpub(book, images));
    expect(strFromU8(entries["mimetype"]!)).toBe("application/epub+zip");
  });

  it("handles a book with no illustrations", () => {
    const book = bookFromText("Bare", "# C\n\nNothing drawn here.", "fiction");
    const entries = unzipSync(buildIllustratedEpub(book, new Map()));
    expect(Object.keys(entries).some((k) => k.startsWith("OEBPS/images/"))).toBe(false);
    expect(strFromU8(entries["OEBPS/chapter0.xhtml"]!)).toContain("Nothing drawn here.");
  });
});

describe("countExportImages", () => {
  it("counts the placed illustrations", () => {
    const { images } = sampleBook();
    expect(countExportImages(images)).toBe(2);
    expect(countExportImages(new Map())).toBe(0);
  });
});
