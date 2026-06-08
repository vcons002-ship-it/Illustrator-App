import { describe, it, expect } from "vitest";
import { toRenderUnits } from "./render-units.js";
import type { BookSource } from "./types/book.js";

function book(): BookSource {
  return {
    id: "b1",
    title: "T",
    chapters: [
      { id: "c0", index: 0, title: "One" },
      { id: "c1", index: 1, title: "Two" },
    ],
    pages: [
      { id: "p0", index: 0, chapterId: "c0", paragraphs: [{ id: "p0-0", index: 0, text: "A" }] },
      { id: "p1", index: 1, chapterId: "c0", paragraphs: [{ id: "p1-0", index: 0, text: "B" }] },
      { id: "p2", index: 2, chapterId: "c1", paragraphs: [{ id: "p2-0", index: 0, text: "C" }] },
    ],
  };
}

describe("toRenderUnits", () => {
  it("page scope is identity", () => {
    const b = book();
    const units = toRenderUnits(b, "page");
    expect(units.book).toBe(b);
    expect(units.pageToUnit).toEqual([0, 1, 2]);
    expect(units.unitCount).toBe(3);
  });

  it("chapter scope merges each chapter's pages into one unit", () => {
    const units = toRenderUnits(book(), "chapter");
    // Two chapters → two units; pages 0,1 → unit 0, page 2 → unit 1.
    expect(units.unitCount).toBe(2);
    expect(units.pageToUnit).toEqual([0, 0, 1]);
    expect(units.book.pages).toHaveLength(2);

    // Unit 0 concatenates chapter c0's paragraphs (A, B), re-indexed.
    const u0 = units.book.pages[0]!;
    expect(u0.id).toBe("chapter-c0");
    expect(u0.chapterId).toBe("c0");
    expect(u0.paragraphs.map((p) => p.text)).toEqual(["A", "B"]);
    expect(u0.paragraphs.map((p) => p.id)).toEqual(["chapter-c0-0", "chapter-c0-1"]);

    // Chapters are untouched, so bible extraction keys are unchanged.
    expect(units.book.chapters).toEqual(book().chapters);
  });

  it("uses chapter-scoped ids distinct from page ids (caches don't collide)", () => {
    const units = toRenderUnits(book(), "chapter");
    const ids = units.book.pages.map((p) => p.id);
    expect(ids).toEqual(["chapter-c0", "chapter-c1"]);
    expect(ids).not.toContain("p0");
  });
});
