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
// v10 adds the `gantt` info-graphic kind (timelines/schedules) — a new variant inside the
// existing `infographics` array, so the bump only forces a re-extraction to pick it up.
export const BIBLE_VERSION = 10;

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
  if (stored.version === 9) return migrateTo10(stored);
  if (stored.version === 8) return migrateTo10(migrateTo9(stored));
  if (stored.version === 7) return migrateTo10(migrateTo9(migrateTo8(stored)));
  if (stored.version === 5 || stored.version === 6) return migrateTo10(migrateTo9(migrateTo8(migrateTo7(stored))));
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
  return { ...stored, version: 9, infographics: stored.infographics ?? [] };
}

/** v9 → v10 is purely additive: the `gantt` kind is a new variant inside the existing
 * `infographics` array, so nothing is backfilled — re-analysing a chapter can add one. */
function migrateTo10(stored: VisualBible): VisualBible {
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
  // LONGEST name first, and each occurrence belongs to the longest name covering it. Without that, a
  // place named after someone ("Rell's Tavern") counted as a mention of the character — so they were
  // resolved as present on the page, and their look went into the illustration for a scene they're
  // not in. Claimed spans are blanked out so a shorter name can't re-use the same text.
  const claimed = new Set<string>();
  const every = [
    ...bible.characters.flatMap((c) => [c.name, ...c.aliases]),
    ...bible.environments.map((e) => e.name),
    ...(bible.creatures ?? []).flatMap((cr) => [cr.name, ...cr.aliases]),
    ...bible.spoilers.map((sp) => sp.label),
  ];
  let rest = haystack;
  for (const name of [...new Set(every.map((n) => n.toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length)) {
    if (!rest.includes(name)) continue;
    claimed.add(name);
    rest = rest.split(name).join(" "); // a space, not nothing — never fuse the neighbours into a new match
  }
  // The place usually ISN'T in the bible yet on the page that first walks into it (extraction runs
  // behind the render), so longest-first can't rule it out there. A possessive followed by a proper
  // noun — "in Rell's Tavern" — has that shape regardless: it names somewhere, not someone. Tested
  // against the ORIGINAL text, since the capitalisation is the whole signal and `haystack` is
  // lower-cased. Only suppresses those occurrences: named anywhere else, the character is present.
  const original = page.paragraphs.map((p) => p.text).join(" ");
  const onlyNamesSomewhere = (name: string): boolean => {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    let seen = false;
    for (const m of original.matchAll(re)) {
      seen = true;
      if (!/^['’]s\s+\p{Lu}/u.test(original.slice((m.index ?? 0) + m[0].length))) return false;
    }
    return seen;
  };
  const matches = (names: string[], asPerson = false): boolean =>
    names.some((n) => n.length > 0 && claimed.has(n.toLowerCase()) && !(asPerson && onlyNamesSomewhere(n)));

  const characterIds = bible.characters
    .filter((c) => matches([c.name, ...c.aliases], true))
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
