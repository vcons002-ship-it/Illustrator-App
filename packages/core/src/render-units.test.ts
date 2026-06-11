import { describe, it, expect } from "vitest";
import { panelGroup, toRenderUnits } from "./render-units.js";
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
  it("1 page per image keeps the identity mapping and tags each unit's page range", () => {
    const b = book();
    const units = toRenderUnits(b, 1);
    expect(units.pageToUnit).toEqual([0, 1, 2, 3]);
    expect(units.unitCount).toBe(4);
    expect(units.unitPageCount).toEqual([1, 1, 1, 1]);
    expect(units.book.pages.map((p) => p.id)).toEqual(["p0", "p1", "p2", "p3"]);
    // Each unit is one source page → pageRange [i, i].
    expect(units.book.pages.map((p) => p.pageRange)).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
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
    // Original page ranges each unit covers.
    expect(units.book.pages.map((p) => p.pageRange)).toEqual([[0, 1], [2, 2], [3, 3]]);
  });

  it("whole-chapter groups each chapter into one unit", () => {
    const units = toRenderUnits(book(), "chapter");
    expect(units.unitCount).toBe(2);
    expect(units.pageToUnit).toEqual([0, 0, 0, 1]);
    expect(units.unitPageCount).toEqual([3, 1]);
    expect(units.book.pages.map((p) => p.id)).toEqual(["chapter-c0", "chapter-c1"]);
    expect(units.book.pages.map((p) => p.pageRange)).toEqual([[0, 2], [3, 3]]);
  });

  it("encodes the cadence in unit ids so different cadences cache independently", () => {
    expect(toRenderUnits(book(), 2).book.pages[0]!.id).toBe("u2-p0");
    expect(toRenderUnits(book(), "chapter").book.pages[0]!.id).toBe("chapter-c0");
  });
});

describe("panelGroup", () => {
  // 7 units: chapter A has 5 (0..4), chapter B has 2 (5..6).
  const ids = ["a", "a", "a", "a", "a", "b", "b"];

  it("chunks a chapter into fixed groups, aligned to the chapter's first unit", () => {
    // perView 4 → A: [0,1,2,3] then [4] (short tail); never mixes in chapter B.
    expect(panelGroup(ids, 0, 4)).toEqual([0, 1, 2, 3]);
    expect(panelGroup(ids, 3, 4)).toEqual([0, 1, 2, 3]);
    expect(panelGroup(ids, 4, 4)).toEqual([4]); // chapter's last view is shorter
  });

  it("never crosses a chapter boundary", () => {
    // Unit 5 starts chapter B; even with room for 4, the group is only B's units.
    expect(panelGroup(ids, 5, 4)).toEqual([5, 6]);
    expect(panelGroup(ids, 6, 4)).toEqual([5, 6]);
  });

  it("perView 1 is one unit per view (today's single-image behaviour)", () => {
    expect(panelGroup(ids, 2, 1)).toEqual([2]);
  });

  it("guards out-of-range and empty input", () => {
    expect(panelGroup([], 0, 4)).toEqual([]);
    expect(panelGroup(ids, 99, 4)).toEqual([]);
  });
});
