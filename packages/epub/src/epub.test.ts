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

  it("flags front/back matter as non-story (by linear=no, nav, title, epub:type) but keeps Prologue/Epilogue", () => {
    const epub = zipSync({
      "META-INF/container.xml": strToU8(
        `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      ),
      "OEBPS/content.opf": strToU8(
        `<?xml version="1.0"?><package><metadata><dc:title>My Book</dc:title></metadata>` +
          `<manifest>` +
          `<item id="cp" href="copyright.xhtml"/>` +
          `<item id="toc" href="toc.xhtml" properties="nav"/>` +
          `<item id="pro" href="prologue.xhtml"/>` +
          `<item id="c1" href="ch1.xhtml"/>` +
          `<item id="epi" href="epilogue.xhtml"/>` +
          `<item id="ab" href="about.xhtml"/>` +
          `</manifest>` +
          `<spine>` +
          `<itemref idref="cp" linear="no"/>` +
          `<itemref idref="toc"/>` +
          `<itemref idref="pro"/>` +
          `<itemref idref="c1"/>` +
          `<itemref idref="epi"/>` +
          `<itemref idref="ab"/>` +
          `</spine></package>`,
      ),
      "OEBPS/copyright.xhtml": strToU8(`<html><body><h1>Copyright</h1><p>© 2026.</p></body></html>`),
      "OEBPS/toc.xhtml": strToU8(`<html><body><h1>Contents</h1><p>Chapter list.</p></body></html>`),
      "OEBPS/prologue.xhtml": strToU8(`<html><body><h1>Prologue</h1><p>Long ago.</p></body></html>`),
      "OEBPS/ch1.xhtml": strToU8(`<html><body><h1>Chapter One</h1><p>Aria ran.</p></body></html>`),
      "OEBPS/epilogue.xhtml": strToU8(`<html><body><h1>Epilogue</h1><p>Years later.</p></body></html>`),
      "OEBPS/about.xhtml": strToU8(
        `<html><body epub:type="backmatter"><h1>About the Author</h1><p>Bio.</p></body></html>`,
      ),
    });

    const book = parseEpub(epub, "b");
    const story = (title: string) =>
      book.chapters.find((c) => c.title === title)?.isStory !== false;
    expect(story("Copyright")).toBe(false); // linear="no"
    expect(story("Contents")).toBe(false); // nav property + title
    expect(story("About the Author")).toBe(false); // epub:type backmatter + title
    expect(story("Prologue")).toBe(true); // story
    expect(story("Chapter One")).toBe(true); // story
    expect(story("Epilogue")).toBe(true); // story
  });

  it("EPUB3 nav: splits a single giant document into its TOC chapters", () => {
    const epub = zipSync({
      "META-INF/container.xml": strToU8(
        `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      ),
      "OEBPS/content.opf": strToU8(
        `<?xml version="1.0"?><package><metadata><dc:title>Big Book</dc:title></metadata>` +
          `<manifest>` +
          `<item id="c" href="book.xhtml"/>` +
          `<item id="nav" href="nav.xhtml" properties="nav"/>` +
          `</manifest><spine><itemref idref="c"/></spine></package>`,
      ),
      "OEBPS/book.xhtml": strToU8(
        `<html><body>` +
          `<section id="ch1"><h1>Chapter One</h1><p>Aria ran.</p></section>` +
          `<section id="ch2"><h1>Chapter Two</h1><p>The bridge fell.</p></section>` +
          `</body></html>`,
      ),
      "OEBPS/nav.xhtml": strToU8(
        `<html><body><nav epub:type="toc"><ol>` +
          `<li><a href="book.xhtml#ch1">Chapter One</a></li>` +
          `<li><a href="book.xhtml#ch2">Chapter Two</a></li>` +
          `</ol></nav></body></html>`,
      ),
    });
    const book = parseEpub(epub, "b");
    expect(book.chapters.map((c) => c.title)).toEqual(["Chapter One", "Chapter Two"]);
    const text = (chId: string) =>
      book.pages.filter((p) => p.chapterId === chId).flatMap((p) => p.paragraphs.map((x) => x.text)).join(" ");
    expect(text("ch-0")).toContain("Aria");
    expect(text("ch-1")).toContain("bridge");
  });

  it("EPUB2 NCX: merges un-listed spine docs into the TOC chapter", () => {
    const epub = zipSync({
      "META-INF/container.xml": strToU8(
        `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      ),
      "OEBPS/content.opf": strToU8(
        `<?xml version="1.0"?><package><metadata><dc:title>NCX Book</dc:title></metadata>` +
          `<manifest>` +
          `<item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/><item id="c" href="c.xhtml"/>` +
          `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` +
          `</manifest>` +
          `<spine toc="ncx"><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/></spine></package>`,
      ),
      "OEBPS/a.xhtml": strToU8(`<html><body><p>Aria walked.</p></body></html>`),
      "OEBPS/b.xhtml": strToU8(`<html><body><p>The corridor stretched.</p></body></html>`),
      "OEBPS/c.xhtml": strToU8(`<html><body><p>The bridge fell.</p></body></html>`),
      "OEBPS/toc.ncx": strToU8(
        `<?xml version="1.0"?><ncx><navMap>` +
          `<navPoint><navLabel><text>Part One</text></navLabel><content src="a.xhtml"/></navPoint>` +
          `<navPoint><navLabel><text>Part Two</text></navLabel><content src="c.xhtml"/></navPoint>` +
          `</navMap></ncx>`,
      ),
    });
    const book = parseEpub(epub, "b");
    expect(book.chapters.map((c) => c.title)).toEqual(["Part One", "Part Two"]);
    const text = (chId: string) =>
      book.pages.filter((p) => p.chapterId === chId).flatMap((p) => p.paragraphs.map((x) => x.text)).join(" ");
    // b.xhtml (no TOC entry) merged into Part One; c.xhtml is Part Two.
    expect(text("ch-0")).toContain("Aria walked");
    expect(text("ch-0")).toContain("corridor");
    expect(text("ch-1")).toContain("bridge");
  });
});
