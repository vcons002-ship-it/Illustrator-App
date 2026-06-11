import { describe, it, expect } from "vitest";
import { bookFromText } from "./from-text.js";

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
