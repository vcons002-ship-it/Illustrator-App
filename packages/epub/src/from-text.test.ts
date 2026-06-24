import { describe, it, expect } from "vitest";
import { appendStoryChapter, bookFromCode, bookFromText, storyBook } from "./from-text.js";

describe("bookFromCode", () => {
  const SRC = [
    "import { x } from './x';",
    "",
    "export function parse(input: string): number {",
    "  return input.length;",
    "}",
    "",
    "class Widget {",
    "  render() {",
    "    return null;",
    "  }",
    "}",
  ].join("\n");

  it("opens code as a `code` book, splitting at top-level definitions", () => {
    const book = bookFromCode("auth.ts", SRC, "ts");
    expect(book.contentMode).toBe("code");
    expect(book.language).toBe("ts");
    expect(book.id).toMatch(/^code-/);
    // imports, the function, and the class → at least 3 sections (chapters).
    expect(book.chapters.length).toBeGreaterThanOrEqual(3);
    // code whitespace is preserved (a paragraph keeps its indentation/newlines).
    const allText = book.pages.flatMap((p) => p.paragraphs.map((q) => q.text)).join("\n");
    expect(allText).toContain("  return input.length;");
  });

  it("is stable by content hash and rejects empty input", () => {
    expect(bookFromCode("a", SRC).id).toBe(bookFromCode("a", SRC).id);
    expect(() => bookFromCode("a", "   \n  ")).toThrow();
  });
});

describe("bookFromText", () => {
  it("builds a readable book from plain text (single chapter, paged)", () => {
    const book = bookFromText("My Article", "First paragraph.\n\nSecond paragraph.");
    expect(book.title).toBe("My Article");
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0]!.title).toBe("My Article");
    expect(book.pages.length).toBeGreaterThan(0);
    expect(book.pages[0]!.paragraphs[0]!.text).toBe("First paragraph.");
  });

  it("ids are stable content hashes: same text → same book (cache reuse)", () => {
    const a = bookFromText("T", "Same text.");
    const b = bookFromText("T", "Same text.");
    const c = bookFromText("T", "Different text.");
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
    expect(a.id).toMatch(/^text-[0-9a-f]+$/);
  });

  it("detects Markdown headings and Chapter N lines as chapter breaks", () => {
    const book = bookFromText(
      "Book",
      "# Intro\nWelcome text.\n\nChapter 2\nThe second part.\n\n## Appendix\nExtra notes.",
    );
    expect(book.chapters.map((c) => c.title)).toEqual(["Intro", "Chapter 2", "Appendix"]);
  });

  it("doesn't break chapters on ordinary prose mentioning 'chapter'", () => {
    const book = bookFromText(
      "Book",
      "She remembered the chapter of her life spent at sea, every day of it vividly.",
    );
    expect(book.chapters).toHaveLength(1);
  });

  it("marks technical content for the concept-prompt template", () => {
    expect(bookFromText("Paper", "Abstract.", "technical").contentMode).toBe("technical");
    expect(bookFromText("Novel", "Prose.").contentMode).toBeUndefined();
  });

  it("rejects empty input with a clear error", () => {
    expect(() => bookFromText("T", "   \n  ")).toThrow(/no text/i);
  });
});

describe("storyBook / appendStoryChapter (as-you-go id stability)", () => {
  it("uses the caller's stable id and marks the book as a story", () => {
    const book = storyBook("story-abc", "Our Tale", "You + Buddy", ["The dragon woke."]);
    expect(book.id).toBe("story-abc");
    expect(book.kind).toBe("story");
    expect(book.contentMode).toBe("fiction");
    expect(book.author).toBe("You + Buddy");
    expect(book.chapters).toHaveLength(1);
    expect(book.pages[0]!.paragraphs[0]!.text).toBe("The dragon woke.");
  });

  it("appending a beat keeps EVERY prior chapter/page/paragraph id byte-identical", () => {
    // This is the linchpin: a stable id + positional segmentation means the image cache
    // (`${id}:${pageId}`) and `processedChapters` stay valid across appends.
    const beats = ["Beat one, a long opening paragraph about the keep.", "Beat two arrives."];
    const before = storyBook("story-1", "Tale", undefined, beats);
    const after = appendStoryChapter(before, beats, "Beat three, the journey onward.");

    expect(after.id).toBe(before.id);
    // Prior chapters unchanged (same count + ids), with exactly one new chapter at the end.
    expect(after.chapters.length).toBe(before.chapters.length + 1);
    for (let i = 0; i < before.chapters.length; i++) {
      expect(after.chapters[i]!.id).toBe(before.chapters[i]!.id);
    }
    // Every prior page id + paragraph id is identical (nothing before the new beat reflows).
    for (let i = 0; i < before.pages.length; i++) {
      expect(after.pages[i]!.id).toBe(before.pages[i]!.id);
      expect(after.pages[i]!.paragraphs.map((p) => p.id)).toEqual(
        before.pages[i]!.paragraphs.map((p) => p.id),
      );
    }
    // The new beat added pages at the END only.
    expect(after.pages.length).toBeGreaterThan(before.pages.length);
  });

  it("each beat is its own chapter (one beat → one extraction unit)", () => {
    const book = storyBook("story-2", "Tale", undefined, ["One.", "Two.", "Three."]);
    expect(book.chapters).toHaveLength(3);
    expect(book.chapters.map((c) => c.id)).toEqual(["ch-0", "ch-1", "ch-2"]);
  });
});
