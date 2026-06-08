import type {
  Character,
  Creature,
  Environment,
  GlossaryEntry,
  Outfit,
  SpoilerEntity,
  ChapterScene,
  VisualBible,
} from "../types/bible.js";
import { emptyAppearance } from "../types/bible.js";
import { BIBLE_VERSION, createEmptyBible } from "./bible.js";
import { consolidateCharacters, slug } from "../providers/llm/extraction.js";
import { deterministicSeed } from "../providers/llm/mock-llm-provider.js";

/**
 * Visual-Bible export / import.
 *
 * Export produces a single JSON object — `{ _exportMeta, rules, data }` — where
 * `rules` is an AI-facing spec so any external chat (Claude/GPT/Gemini) can read a
 * book and emit a matching `data` payload, and `data` is the current bible. Import
 * validates the schema version, coerces the payload into a full `VisualBible`
 * (filling defaults, generating identity seeds), de-duplicates characters and
 * accumulates locations, and keys the result to the currently-open book.
 */

export interface ExportMeta {
  app: "Illustrator-App";
  schemaVersion: number;
}

/** AI-facing schema + instructions embedded in every export (current = v5). */
export const BIBLE_EXPORT_RULES = {
  instructions:
    "Read the provided book text and extract a Visual Bible as strict JSON matching the " +
    "schema below. Output ONLY the `data` object (no markdown, no preamble).",
  schemaVersion: BIBLE_VERSION,
  types: {
    Character: {
      name: "string — exact name from the text",
      aliases: "string[] — other names/nicknames/titles for the SAME person (one entry per person)",
      appearance: {
        hair: "string ('' if unknown)",
        eyes: "string ('' if unknown)",
        gender: "string ('' if unknown)",
        build: "string — physique ('' if unknown)",
        height: "string ('' if unknown)",
        skinTone: "string ('' if unknown)",
        age: "string ('' if unknown)",
        distinguishingMarks: "string — scars/tattoos/etc. ('' if unknown)",
        notes: "string — any other visual detail ('' if unknown)",
      },
      persistentTraits: "string[] — recurring non-appearance details (habits, accessories)",
      outfits:
        "{ label: string; description: string; context: string }[] — each DISTINCT outfit, " +
        "with 'context' = when it's worn (e.g. 'flying, battle'). The illustrator picks the one " +
        "fitting each scene; never merge outfits.",
    },
    Environment: { name: "string", description: "string[] — distinct visual observations" },
    Creature: {
      name: "string — a named/notable non-human beast (dragon, etc.), NOT a person",
      aliases: "string[]",
      kind: "string — e.g. 'dragon'",
      description: "string[] — size, colour, features",
    },
    SpoilerEntity: { label: "string", revealHint: "string — when it's safe to show" },
    GlossaryEntry: { term: "string", definition: "string — how it manifests visually" },
    ChapterScene: {
      chapterIndex: "number — 0-based STORY chapter",
      summary: "string",
      keyMoment: "string — one concrete, visual sentence",
      location: "string — primary setting (use the established environment name)",
      locationChange: "string — where/when the setting shifts, or '' if it stays put",
    },
  },
  constraints: [
    "Output valid JSON only; use '' for unknown string fields (never invent).",
    "A capitalized word used as a person's name is a CHARACTER (human), even if it's also a common/animal word ('Cat', 'Hawk').",
    "One entry per person — fold first name / full name / nickname into 'aliases'.",
    "Put literal animals/beasts in 'creatures', never people.",
    "Merge repeated location/creature descriptions into one entry; add new detail over time.",
    "Cover EVERY story chapter in 'storyboard' (skip front/back matter).",
  ],
} as const;

/** Serialize a bible to the export JSON (rules + data). `data` may be empty `{}`. */
export function exportBible(bible: VisualBible | undefined): string {
  const meta: ExportMeta = { app: "Illustrator-App", schemaVersion: BIBLE_VERSION };
  return JSON.stringify({ _exportMeta: meta, rules: BIBLE_EXPORT_RULES, data: bible ?? {} }, null, 2);
}

export interface ImportStats {
  characters: number;
  creatures: number;
  environments: number;
  spoilers: number;
  glossary: number;
  storyboard: number;
}

export interface ImportResult {
  bible?: VisualBible;
  stats?: ImportStats;
  error?: string;
}

/**
 * Parse + coerce an exported (or hand-authored) bible payload for `bookId`.
 * Accepts either the full export (`{ _exportMeta, rules, data }`) or just the bible
 * data object. Rejects a mismatched schema version.
 */
export function parseImportedBible(json: string, bookId: string): ImportResult {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { error: "Not valid JSON." };
  }
  const meta = raw._exportMeta as ExportMeta | undefined;
  const data = (isObject(raw.data) ? raw.data : raw) as Record<string, unknown>;
  const version = num(meta?.schemaVersion ?? data.schemaVersion ?? data.version);
  if (version !== BIBLE_VERSION) {
    return {
      error: `This file is schema v${version || "?"}, but the app uses v${BIBLE_VERSION}. Re-export from the current version or update the file.`,
    };
  }

  const bible = createEmptyBible(bookId);
  bible.characters = consolidateCharacters(arr(data.characters).map((c) => toCharacter(c)));
  bible.creatures = dedupeByName(arr(data.creatures).map((c) => toCreature(c)));
  bible.environments = dedupeByName(arr(data.environments).map((e) => toEnvironment(e)));
  bible.spoilers = arr(data.spoilers).map((s, i) => toSpoiler(s, i));
  bible.glossary = dedupeGlossary(arr(data.glossary).map((g) => toGlossary(g)));
  bible.storyboard = arr(data.storyboard)
    .map((s) => toScene(s))
    .sort((a, b) => a.chapterIndex - b.chapterIndex);
  bible.processedChapters = arr(data.processedChapters)
    .map((n) => num(n))
    .filter((n) => Number.isFinite(n));

  const stats: ImportStats = {
    characters: bible.characters.length,
    creatures: bible.creatures.length,
    environments: bible.environments.length,
    spoilers: bible.spoilers.length,
    glossary: bible.glossary.length,
    storyboard: bible.storyboard.length,
  };
  return { bible, stats };
}

/**
 * Carry a prior book's entities forward into `base` (series continuity): merge
 * characters (deduped), creatures/environments (accumulating descriptions), and
 * the glossary. The base book's `storyboard` + `processedChapters` are kept (they
 * are book-specific) so the new book still gets its own per-chapter analysis.
 */
export function mergeCarryOver(base: VisualBible, prior: VisualBible): VisualBible {
  return {
    ...base,
    characters: consolidateCharacters([...prior.characters, ...base.characters]),
    creatures: dedupeByName([...(prior.creatures ?? []), ...(base.creatures ?? [])]),
    environments: dedupeByName([...prior.environments, ...base.environments]),
    glossary: dedupeGlossary([...(prior.glossary ?? []), ...(base.glossary ?? [])]),
  };
}

// --- coercion helpers ---------------------------------------------------------

function toCharacter(v: unknown): Character {
  const o = obj(v);
  const name = str(o.name) || "Unknown";
  const a = obj(o.appearance);
  return {
    id: str(o.id) || `char-${slug(name)}`,
    name,
    aliases: strArr(o.aliases),
    appearance: { ...emptyAppearance(), ...pickStrings(a) },
    persistentTraits: strArr(o.persistentTraits),
    clothing: strArr(o.clothing),
    outfits: arr(o.outfits).map((x) => toOutfit(x)),
    anchor: { seed: num(obj(o.anchor).seed) || deterministicSeed(name) },
    firstSeenChapter: num(o.firstSeenChapter) || 0,
  };
}

function toOutfit(v: unknown): Outfit {
  const o = obj(v);
  return { label: str(o.label), description: str(o.description), context: str(o.context) };
}

function toCreature(v: unknown): Creature {
  const o = obj(v);
  const name = str(o.name) || "Unknown creature";
  return {
    id: str(o.id) || `creature-${slug(name)}`,
    name,
    aliases: strArr(o.aliases),
    kind: str(o.kind),
    description: strArr(o.description),
    anchor: { seed: num(obj(o.anchor).seed) || deterministicSeed(`creature:${name}`) },
    firstSeenChapter: num(o.firstSeenChapter) || 0,
  };
}

function toEnvironment(v: unknown): Environment {
  const o = obj(v);
  const name = str(o.name) || "Unknown location";
  return {
    id: str(o.id) || `env-${slug(name)}`,
    name,
    description: strArr(o.description),
    firstSeenChapter: num(o.firstSeenChapter) || 0,
  };
}

function toSpoiler(v: unknown, i: number): SpoilerEntity {
  const o = obj(v);
  const label = str(o.label);
  return {
    id: str(o.id) || `spoiler-${slug(label) || i}`,
    label,
    revealParagraphId: str(o.revealParagraphId) || str(o.revealHint),
  };
}

function toGlossary(v: unknown): GlossaryEntry {
  const o = obj(v);
  return { term: str(o.term), definition: str(o.definition) };
}

function toScene(v: unknown): ChapterScene {
  const o = obj(v);
  return {
    chapterIndex: num(o.chapterIndex),
    summary: str(o.summary),
    keyMoment: str(o.keyMoment),
    location: str(o.location),
    locationChange: str(o.locationChange),
  };
}

function dedupeByName<T extends { name: string; description: string[] }>(list: T[]): T[] {
  const out: T[] = [];
  const at = new Map<string, number>();
  for (const item of list) {
    const key = item.name.toLowerCase();
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, out.length);
      out.push(item);
    } else {
      const have = new Set(out[i]!.description.map((d) => d.toLowerCase()));
      for (const d of item.description) if (d.trim() && !have.has(d.toLowerCase())) out[i]!.description.push(d);
    }
  }
  return out;
}

function dedupeGlossary(list: GlossaryEntry[]): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const g of list) {
    const t = g.term.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push({ term: t, definition: g.definition });
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function obj(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v) || 0;
}
function strArr(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === "string");
}
function pickStrings(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) if (typeof val === "string") out[k] = val;
  return out;
}
