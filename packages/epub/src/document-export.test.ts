import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { PDFDocument } from "pdf-lib";
import {
  markdownToBlocks,
  parseInline,
  blocksToDocx,
  blocksToPdf,
  markdownToDocx,
  type DocBlock,
} from "./document-export.js";

const SAMPLE = `# Quarterly Report

This is the **intro** with some *emphasis* and \`inline code\`.

## Findings

- First point
- Second point with **bold**

1. Step one
2. Step two

---

\`\`\`
const x = 1;
console.log(x);
\`\`\`

A closing paragraph.`;

describe("parseInline", () => {
  it("splits bold / italic / code runs", () => {
    expect(parseInline("plain **b** and *i* and `c`")).toEqual([
      { text: "plain " },
      { text: "b", bold: true },
      { text: " and " },
      { text: "i", italic: true },
      { text: " and " },
      { text: "c", code: true },
    ]);
  });
  it("returns a single plain run when there's no markup", () => {
    expect(parseInline("nothing here")).toEqual([{ text: "nothing here" }]);
  });
});

describe("markdownToBlocks", () => {
  const blocks = markdownToBlocks(SAMPLE);
  const types = blocks.map((b) => b.type);

  it("recognises headings with levels", () => {
    const h1 = blocks.find((b): b is Extract<DocBlock, { type: "heading" }> => b.type === "heading" && b.level === 1);
    expect(h1?.runs.map((r) => r.text).join("")).toBe("Quarterly Report");
    expect(blocks.some((b) => b.type === "heading" && b.level === 2)).toBe(true);
  });
  it("groups bullet and numbered lists", () => {
    const lists = blocks.filter((b): b is Extract<DocBlock, { type: "list" }> => b.type === "list");
    expect(lists).toHaveLength(2);
    expect(lists[0]!.ordered).toBe(false);
    expect(lists[0]!.items).toHaveLength(2);
    expect(lists[1]!.ordered).toBe(true);
    expect(lists[1]!.items).toHaveLength(2);
  });
  it("captures a fenced code block verbatim and a rule", () => {
    const code = blocks.find((b): b is Extract<DocBlock, { type: "code" }> => b.type === "code");
    expect(code?.text).toBe("const x = 1;\nconsole.log(x);");
    expect(types).toContain("rule");
  });
  it("keeps inline styling inside paragraphs", () => {
    const intro = blocks.find(
      (b): b is Extract<DocBlock, { type: "paragraph" }> => b.type === "paragraph" && b.runs.some((r) => r.bold),
    );
    expect(intro?.runs.find((r) => r.bold)?.text).toBe("intro");
  });
});

describe("blocksToDocx", () => {
  it("produces a real OOXML package whose document.xml carries the content", () => {
    const bytes = blocksToDocx("Quarterly Report", markdownToBlocks(SAMPLE));
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]),
    );
    const doc = strFromU8(files["word/document.xml"]!);
    expect(doc).toContain("<w:document");
    expect(doc).toContain("Quarterly Report");
    expect(doc).toContain("Findings");
    expect(doc).toContain("<w:b/>"); // bold runs present
    expect(doc).toContain("• "); // bullet marker
    expect(doc).toContain("1. "); // ordered marker
    expect(doc).toContain("Courier New"); // code run font
  });

  it("XML-escapes user text (no injection)", () => {
    const doc = strFromU8(unzipSync(markdownToDocx("T", "A & B <tag> \"q\""))["word/document.xml"]!);
    expect(doc).toContain("A &amp; B &lt;tag&gt;");
    expect(doc).not.toContain("<tag>");
  });
});

describe("blocksToPdf", () => {
  it("produces a valid, re-loadable PDF carrying the title", async () => {
    const bytes = await blocksToPdf("Quarterly Report", markdownToBlocks(SAMPLE));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getTitle()).toBe("Quarterly Report");
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("paginates a long document onto multiple pages", async () => {
    const long: DocBlock[] = Array.from({ length: 120 }, (_, i) => ({
      type: "paragraph" as const,
      runs: [{ text: `Paragraph number ${i} with enough words to take a full line of body text on the page.` }],
    }));
    const reloaded = await PDFDocument.load(await blocksToPdf("Long", long));
    expect(reloaded.getPageCount()).toBeGreaterThan(1);
  });
});
