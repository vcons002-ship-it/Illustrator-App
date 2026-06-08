import type { BookSource, Page } from "./types/book.js";
import type { PagesPerImage } from "./quality.js";

export interface RenderUnits {
  /**
   * The book to feed the engine, where each "page" is one render unit (the thing
   * that gets a single illustration).
   */
  book: BookSource;
  /** Original page (array position in `book.pages`) → render-unit index. */
  pageToUnit: number[];
  /** Number of render units. */
  unitCount: number;
  /** Original-page count per unit (index = unit index), for quality scaling. */
  unitPageCount: number[];
}

/**
 * Re-segment a book into render units at the chosen cadence.
 *
 * - `1`: identity — units are the original pages.
 * - `N` (2/3/5): group up to N consecutive pages **within a chapter** into one
 *   unit (a new unit starts at a chapter change or when the unit is full, so a
 *   short tail group at a chapter's end is its own unit). Groups never cross a
 *   chapter boundary.
 * - `"chapter"`: one unit per chapter.
 *
 * Unit page ids encode the cadence (`u<N>-<firstPageId>` / `chapter-<chapterId>`)
 * so different cadences cache independently. Pure and deterministic, so the worker
 * (rendering) and the UI (mapping) can never drift.
 */
export function toRenderUnits(book: BookSource, grouping: PagesPerImage): RenderUnits {
  const perUnit = grouping === "chapter" ? Infinity : Math.max(1, Math.floor(grouping));

  if (perUnit === 1) {
    return {
      book,
      pageToUnit: book.pages.map((_, i) => i),
      unitCount: book.pages.length,
      unitPageCount: book.pages.map(() => 1),
    };
  }

  const unitPages: Page[] = [];
  const pageToUnit: number[] = [];
  const unitPageCount: number[] = [];
  let curChapter: string | undefined;
  let curUnit = -1;

  book.pages.forEach((page, i) => {
    const full = perUnit !== Infinity && curUnit >= 0 && unitPageCount[curUnit]! >= perUnit;
    if (page.chapterId !== curChapter || full) {
      curUnit = unitPages.length;
      curChapter = page.chapterId;
      const id = grouping === "chapter" ? `chapter-${page.chapterId}` : `u${perUnit}-${page.id}`;
      unitPages.push({ id, index: curUnit, chapterId: page.chapterId, paragraphs: [] });
      unitPageCount[curUnit] = 0;
    }
    const unitPage = unitPages[curUnit]!;
    for (const para of page.paragraphs) {
      unitPage.paragraphs.push({
        id: `${unitPage.id}-${unitPage.paragraphs.length}`,
        index: unitPage.paragraphs.length,
        text: para.text,
      });
    }
    unitPageCount[curUnit]! += 1;
    pageToUnit[i] = curUnit;
  });

  return { book: { ...book, pages: unitPages }, pageToUnit, unitCount: unitPages.length, unitPageCount };
}
