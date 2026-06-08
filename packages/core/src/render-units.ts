import type { BookSource, Page } from "./types/book.js";

/**
 * Illustration granularity: one image per page, or one (richer) image per chapter.
 *
 * "chapter" produces fewer but more relevant/detailed images — the whole chapter's
 * text and entities drive a single illustration that the reader reveals gradually
 * as they read through the chapter (full reveal at the chapter's end).
 */
export type IllustrationScope = "page" | "chapter";

export interface RenderUnits {
  /**
   * The book to feed the engine, where each "page" is one render unit (the thing
   * that gets a single illustration). In "page" scope this is the original book;
   * in "chapter" scope each unit merges all of a chapter's pages.
   */
  book: BookSource;
  /** Original page (array position in `book.pages`) → render-unit index. */
  pageToUnit: number[];
  /** Number of render units (pages in "page" scope, chapters in "chapter" scope). */
  unitCount: number;
}

/**
 * Re-segment a book into render units for the chosen illustration scope.
 *
 * - "page": identity — units are the original pages.
 * - "chapter": one unit per chapter (grouped by `chapterId`, in order of first
 *   appearance). Each unit page concatenates the chapter's paragraphs, so the
 *   prompt/entity context is the whole chapter. Unit pages get stable ids
 *   (`chapter-<chapterId>`) distinct from page ids, so the two scopes cache
 *   independently and switching modes never collides.
 *
 * Pure and deterministic: the worker uses `book` to render and the UI uses
 * `pageToUnit` to map the reader's position to a unit, so they can never drift.
 */
export function toRenderUnits(book: BookSource, scope: IllustrationScope): RenderUnits {
  if (scope !== "chapter") {
    return { book, pageToUnit: book.pages.map((_, i) => i), unitCount: book.pages.length };
  }

  const unitByChapterId = new Map<string, number>();
  const unitPages: Page[] = [];
  const pageToUnit: number[] = [];

  book.pages.forEach((page, i) => {
    let unit = unitByChapterId.get(page.chapterId);
    if (unit === undefined) {
      unit = unitPages.length;
      unitByChapterId.set(page.chapterId, unit);
      unitPages.push({
        id: `chapter-${page.chapterId}`,
        index: unit,
        chapterId: page.chapterId,
        paragraphs: [],
      });
    }
    const unitPage = unitPages[unit]!;
    for (const para of page.paragraphs) {
      unitPage.paragraphs.push({
        id: `${unitPage.id}-${unitPage.paragraphs.length}`,
        index: unitPage.paragraphs.length,
        text: para.text,
      });
    }
    pageToUnit[i] = unit;
  });

  return { book: { ...book, pages: unitPages }, pageToUnit, unitCount: unitPages.length };
}
