import type { VisualBible } from "../types/bible.js";
import type { Page } from "../types/book.js";

// v2 adds the per-chapter storyboard; v3 adds the world glossary and structured
// character appearance; v4 adds per-chapter location tracking; v5 adds creatures
// (named non-human beasts); v6 adds storyboard `keyEvents` (precomputed/imported
// Layer-1 image prompts). Bibles cached at an older version are rebuilt (see
// Engine.openBook) so the new fields are always present — EXCEPT v5, which is
// migrated forward in place (see `migrateBible`) so existing analysis isn't lost.
export const BIBLE_VERSION = 6;

/**
 * Bring a cached bible up to the current schema WITHOUT losing data, where possible.
 * v5 → v6 is purely additive (`keyEvents` are optional), so we just re-stamp the
 * version and keep every character/environment/creature/storyboard entry. Returns
 * `undefined` for versions too old to migrate cleanly (the caller rebuilds).
 */
export function migrateBible(stored: VisualBible): VisualBible | undefined {
  if (stored.version === BIBLE_VERSION) return stored;
  if (stored.version === 5) return { ...stored, version: BIBLE_VERSION };
  return undefined; // older schemas predate fields we can't backfill → rebuild
}

export function createEmptyBible(bookId: string): VisualBible {
  return {
    bookId,
    version: BIBLE_VERSION,
    characters: [],
    environments: [],
    creatures: [],
    spoilers: [],
    storyboard: [],
    glossary: [],
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
): { characterIds: string[]; environmentIds: string[]; creatureIds: string[]; spoilerIds: string[] } {
  const haystack = pageHaystack(page);
  const matches = (names: string[]): boolean =>
    names.some((n) => n.length > 0 && haystack.includes(n.toLowerCase()));

  const characterIds = bible.characters
    .filter((c) => matches([c.name, ...c.aliases]))
    .map((c) => c.id);
  const environmentIds = bible.environments
    .filter((e) => matches([e.name]))
    .map((e) => e.id);
  const creatureIds = (bible.creatures ?? [])
    .filter((cr) => matches([cr.name, ...cr.aliases]))
    .map((cr) => cr.id);
  const spoilerIds = bible.spoilers
    .filter((s) => matches([s.label]))
    .map((s) => s.id);

  return { characterIds, environmentIds, creatureIds, spoilerIds };
}
