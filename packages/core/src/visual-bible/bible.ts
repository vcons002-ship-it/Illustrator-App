import type { VisualBible } from "../types/bible.js";
import type { Page } from "../types/book.js";

// v2 adds the per-chapter storyboard; v3 adds the world glossary and structured
// character appearance; v4 adds per-chapter location tracking; v5 adds creatures
// (named non-human beasts); v6 adds storyboard `keyEvents` (precomputed/imported
// Layer-1 image prompts); v7 adds `worldStyle` and switches prompts to the
// name-anchored style (so v≤6 prompts are cleared and rewritten); v8 adds `datasets`
// (numeric series from technical chapters, for the computed charts). Bibles cached at
// an older version are rebuilt (see Engine.openBook) so the new fields are always
// present — EXCEPT v5–v7, migrated forward in place (see `migrateBible`) so analysis
// isn't lost.
// v9 adds `infographics` (structured flowchart/diagram/summary from technical chapters).
export const BIBLE_VERSION = 9;

/**
 * Bring a cached bible up to the current schema WITHOUT losing data, where possible.
 * v5/v6 → v7 keeps every extracted entity/summary/glossary but (a) defaults the new
 * `worldStyle`, (b) clears stored `keyEvents` — v≤6 prompts described appearance inline,
 * whereas v7 prompts are name-anchored, so they're rewritten by the per-chapter prompt
 * pass — and (c) drops auto-captured reference images (references are user-only now, and
 * the old auto-captures biased toward portraits). v7 → v8 is purely additive (an empty
 * datasets list; re-analysing a chapter fills it). Returns `undefined` for versions too
 * old to migrate cleanly (the caller rebuilds).
 */
export function migrateBible(stored: VisualBible): VisualBible | undefined {
  if (stored.version === BIBLE_VERSION) return stored;
  if (stored.version === 8) return migrateTo9(stored);
  if (stored.version === 7) return migrateTo9(migrateTo8(stored));
  if (stored.version === 5 || stored.version === 6) return migrateTo9(migrateTo8(migrateTo7(stored)));
  return undefined; // older schemas predate fields we can't backfill → rebuild
}

function migrateTo7(stored: VisualBible): VisualBible {
  return {
    ...stored,
    version: 7,
    worldStyle: stored.worldStyle ?? "",
    storyboard: (stored.storyboard ?? []).map(({ keyEvents: _drop, ...scene }) => scene),
    characters: (stored.characters ?? []).map((c) => {
      const { referenceImageId: _ref, ...anchor } = c.anchor;
      return { ...c, anchor };
    }),
  };
}

function migrateTo8(stored: VisualBible): VisualBible {
  return { ...stored, version: 8, datasets: stored.datasets ?? [] };
}

function migrateTo9(stored: VisualBible): VisualBible {
  return { ...stored, version: BIBLE_VERSION, infographics: stored.infographics ?? [] };
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
    datasets: [],
    infographics: [],
    worldStyle: "",
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
