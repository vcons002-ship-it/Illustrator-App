import type { VisualBible } from "../types/bible.js";
import type { Page } from "../types/book.js";

export const BIBLE_VERSION = 1;

export function createEmptyBible(bookId: string): VisualBible {
  return {
    bookId,
    version: BIBLE_VERSION,
    characters: [],
    environments: [],
    spoilers: [],
    processedChapters: [],
  };
}

/** Lower-cased page text plus the names to match against, for entity resolution. */
function pageHaystack(page: Page): string {
  return page.paragraphs.map((p) => p.text).join(" ").toLowerCase();
}

/**
 * Determine which Bible entities appear on a page, by matching names/aliases
 * against the page text. Used to build a VisualRequest with the right
 * continuity context (and to decide which spoilers gate the image).
 */
export function resolvePageEntities(
  bible: VisualBible,
  page: Page,
): { characterIds: string[]; environmentIds: string[]; spoilerIds: string[] } {
  const haystack = pageHaystack(page);
  const matches = (names: string[]): boolean =>
    names.some((n) => n.length > 0 && haystack.includes(n.toLowerCase()));

  const characterIds = bible.characters
    .filter((c) => matches([c.name, ...c.aliases]))
    .map((c) => c.id);
  const environmentIds = bible.environments
    .filter((e) => matches([e.name]))
    .map((e) => e.id);
  const spoilerIds = bible.spoilers
    .filter((s) => matches([s.label]))
    .map((s) => s.id);

  return { characterIds, environmentIds, spoilerIds };
}
