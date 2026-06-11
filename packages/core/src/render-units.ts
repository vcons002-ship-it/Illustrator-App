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
/**
 * The render-unit indices that share one comic-page "view" with `unitIndex`, for the
 * reader's multi-panel grid. Chapter-aware: a view only ever contains units from the
 * SAME chapter, chunked in groups of `perView` from the chapter's first unit — so a
 * chapter's last view shows fewer panels and a grid never crosses a chapter boundary.
 *
 * `unitChapterIds[i]` is unit i's chapter id (units of a chapter are contiguous, the way
 * `toRenderUnits` builds them). Returns the contiguous ascending unit indices of the
 * group (reading order); the UI reverses the visual order for right-to-left manga.
 */
export function panelGroup(
  unitChapterIds: (string | undefined)[],
  unitIndex: number,
  perView: number,
): number[] {
  const n = unitChapterIds.length;
  if (n === 0 || unitIndex < 0 || unitIndex >= n) return [];
  const size = Math.max(1, Math.floor(perView));
  const chapter = unitChapterIds[unitIndex];
  // The chapter's contiguous unit range [first, last].
  let first = unitIndex;
  while (first - 1 >= 0 && unitChapterIds[first - 1] === chapter) first--;
  let last = unitIndex;
  while (last + 1 < n && unitChapterIds[last + 1] === chapter) last++;
  // Chunk that range in groups of `size`, starting at the chapter's first unit.
  const posInChapter = unitIndex - first;
  const groupStart = first + Math.floor(posInChapter / size) * size;
  const groupEnd = Math.min(last, groupStart + size - 1);
  const out: number[] = [];
  for (let u = groupStart; u <= groupEnd; u++) out.push(u);
  return out;
}

export function toRenderUnits(book: BookSource, grouping: PagesPerImage): RenderUnits {
  const perUnit = grouping === "chapter" ? Infinity : Math.max(1, Math.floor(grouping));

  if (perUnit === 1) {
    return {
      // Each unit IS one source page → its range is [i, i].
      book: { ...book, pages: book.pages.map((p, i) => ({ ...p, pageRange: [i, i] as [number, number] })) },
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
      // pageRange starts at this page; the end grows as more source pages join.
      unitPages.push({ id, index: curUnit, chapterId: page.chapterId, paragraphs: [], pageRange: [i, i] });
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
    unitPage.pageRange![1] = i; // extend the unit's range to include this source page
    unitPageCount[curUnit]! += 1;
    pageToUnit[i] = curUnit;
  });

  return { book: { ...book, pages: unitPages }, pageToUnit, unitCount: unitPages.length, unitPageCount };
}
