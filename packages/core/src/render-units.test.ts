import { describe, it, expect } from "vitest";
import { toRenderUnits } from "./render-units.js";
import type { BookSource, Page } from "./types/book.js";

function page(id: string, chapterId: string, text: string): Page {
  return { id, index: 0, chapterId, paragraphs: [{ id: `${id}-0`, index: 0, text }] };
}

/** c0 has 3 pages, c1 has 1 page. */
function book(): BookSource {
  return {
    id: "b1",
    title: "T",
    chapters: [
      { id: "c0", index: 0, title: "One" },
      { id: "c1", index: 1, title: "Two" },
    ],
    pages: [
      page("p0", "c0", "A"),
      page("p1", "c0", "B"),
      page("p2", "c0", "C"),
      page("p3", "c1", "D"),
    ],
  };
}

describe("toRenderUnits", () => {
  it("1 page per image is identity", () => {
    const b = book();
    const units = toRenderUnits(b, 1);
    expect(units.book).toBe(b);
    expect(units.pageToUnit).toEqual([0, 1, 2, 3]);
    expect(units.unitCount).toBe(4);
    expect(units.unitPageCount).toEqual([1, 1, 1, 1]);
  });

  it("groups N pages within a chapter, with a short tail group of its own", () => {
    const units = toRenderUnits(book(), 2);
    // c0 (3 pages) → [p0,p1] + [p2 tail]; c1 (1 page) → [p3]. Never crosses chapters.
    expect(units.unitCount).toBe(3);
    expect(units.pageToUnit).toEqual([0, 0, 1, 2]);
    expect(units.unitPageCount).toEqual([2, 1, 1]);
    const u0 = units.book.pages[0]!;
    expect(u0.chapterId).toBe("c0");
    expect(u0.paragraphs.map((p) => p.text)).toEqual(["A", "B"]);
  });

  it("whole-chapter groups each chapter into one unit", () => {
    const units = toRenderUnits(book(), "chapter");
    expect(units.unitCount).toBe(2);
    expect(units.pageToUnit).toEqual([0, 0, 0, 1]);
    expect(units.unitPageCount).toEqual([3, 1]);
    expect(units.book.pages.map((p) => p.id)).toEqual(["chapter-c0", "chapter-c1"]);
  });

  it("encodes the cadence in unit ids so different cadences cache independently", () => {
    expect(toRenderUnits(book(), 2).book.pages[0]!.id).toBe("u2-p0");
    expect(toRenderUnits(book(), "chapter").book.pages[0]!.id).toBe("chapter-c0");
  });
});
