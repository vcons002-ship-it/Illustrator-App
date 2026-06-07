import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { segmentBook } from "./segment.js";
import { parseEpub, htmlToText } from "./load.js";

describe("segmentBook", () => {
  it("splits chapters into pages by word budget, keeping paragraphs whole", () => {
    const para = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const book = segmentBook(
      { id: "b1", title: "T", author: "A" },
      [{ title: "One", text: `${para(200)}\n\n${para(200)}\n\n${para(50)}` }],
      { wordsPerPage: 250 },
    );

    expect(book.chapters).toHaveLength(1);
    // 200 + 200 overflows 250 → page break; 200 + 50 fits → 2 pages.
    expect(book.pages).toHaveLength(2);
    expect(book.pages[0]!.paragraphs).toHaveLength(1);
    expect(book.pages[1]!.paragraphs).toHaveLength(2);
    // Ids are stable and sequential.
    expect(book.pages.map((p) => p.index)).toEqual([0, 1]);
  });

  it("produces at least one page even for empty input", () => {
    const book = segmentBook({ id: "b", title: "T" }, [{ title: "Empty", text: "" }]);
    expect(book.pages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("htmlToText", () => {
  it("strips tags and decodes entities into paragraph-separated text", () => {
    const text = htmlToText(
      "<html><body><h1>Title</h1><p>Hello &amp; welcome.</p><p>Second &lt;para&gt;.</p></body></html>",
    );
    expect(text).toContain("Hello & welcome.");
    expect(text).toContain("Second <para>.");
  });
});

describe("parseEpub", () => {
  it("reads container → OPF → spine and segments the book", () => {
    const epub = zipSync({
      "META-INF/container.xml": strToU8(
        `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      ),
      "OEBPS/content.opf": strToU8(
        `<?xml version="1.0"?><package><metadata><dc:title>My Book</dc:title><dc:creator>Jane</dc:creator></metadata>` +
          `<manifest><item id="c1" href="ch1.xhtml"/><item id="c2" href="ch2.xhtml"/></manifest>` +
          `<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
      ),
      "OEBPS/ch1.xhtml": strToU8(`<html><body><h1>Beginning</h1><p>Aria ran.</p></body></html>`),
      "OEBPS/ch2.xhtml": strToU8(`<html><body><h1>Middle</h1><p>The bridge fell.</p></body></html>`),
    });

    const book = parseEpub(epub, "book-xyz");
    expect(book.id).toBe("book-xyz");
    expect(book.title).toBe("My Book");
    expect(book.author).toBe("Jane");
    expect(book.chapters.map((c) => c.title)).toEqual(["Beginning", "Middle"]);
    expect(book.pages.length).toBeGreaterThanOrEqual(2);
    expect(book.pages.some((p) => p.paragraphs.some((x) => x.text.includes("Aria")))).toBe(true);
  });
});
