import type {
  Character,
  Creature,
  Environment,
  GlossaryEntry,
  KeyEvent,
  Outfit,
  ScenePrompt,
  SpoilerEntity,
  ChapterScene,
  VisualBible,
} from "../types/bible.js";
import { emptyAppearance } from "../types/bible.js";
import { referenceIdsOf } from "../types/bible.js";
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
        "{ label: string; description: string }[] — each DISTINCT outfit (the illustrator " +
        "picks the label that fits each scene); never merge outfits.",
    },
    Environment: { name: "string", description: "string[] — distinct visual observations" },
    Creature: {
      name: "string — a named/notable non-human beast (dragon, etc.), NOT a person",
      aliases: "string[]",
      kind: "string — e.g. 'dragon'",
      description: "string[] — size, colour, features",
    },
    SpoilerEntity: { label: "string — a thing whose imagery would spoil the plot if shown early" },
    GlossaryEntry: { term: "string", definition: "string — how it manifests visually" },
    ScenePrompt: {
      subject: "string — who/what is the focus",
      action: "string — what they are doing",
      environment: "string — where/how it looks",
      mood: "string — emotional/atmospheric tone",
      composition: "string — camera angle, framing, depth of field",
    },
    KeyEvent: {
      pageRange: "[number, number] — inclusive [start,end] ORIGINAL page indices this prompt covers",
      imagePrompt: "ScenePrompt — natural language only; describe a SCENE (not a portrait)",
      location:
        "string? — the ONE established location NAME where THIS scene happens (beat-level: " +
        "when the chapter moves, consecutive events change location with it)",
      seed: "number? — optional stable render seed",
    },
    ChapterScene: {
      chapterIndex: "number — 0-based STORY chapter",
      summary: "string",
      keyMoment: "string — one concrete, visual sentence",
      location: "string — primary setting (use the established environment name)",
      locationChange: "string — where/when the setting shifts, or '' if it stays put",
      keyEvents:
        "KeyEvent[] — one per notable beat, covering a page range (~5 pages). The app renders " +
        "each directly (no further LLM), so write a complete scene. Reference every character/" +
        "creature by their EXACT bible name, clothing by its outfit LABEL, and a place by its " +
        "location NAME — the app expands each into its visual description automatically, so do " +
        "NOT describe looks, garments, or architecture; just name them and describe the action.",
    },
    worldStyle:
      "string — one concise genre + art-direction line for the WHOLE book, applied to every " +
      "illustration (e.g. 'high-fantasy military academy, dark, painterly'). Top-level field.",
  },
  constraints: [
    "Output valid JSON only; use '' for unknown string fields (never invent).",
    "A capitalized word used as a person's name is a CHARACTER (human), even if it's also a common/animal word ('Cat', 'Hawk').",
    "One entry per person — fold first name / full name / nickname into 'aliases'.",
    "Put literal animals/beasts in 'creatures', never people.",
    "Merge repeated location/creature descriptions into one entry; add new detail over time.",
    "Cover EVERY story chapter in 'storyboard' (skip front/back matter).",
    "keyEvents: pure natural language — NO weighting syntax or booru tags; describe a scene with " +
      "subject, action, environment, mood, composition; each imagePrompt under ~120 words.",
  ],
} as const;

/** Serialize a bible to the export JSON (rules + data). `data` may be empty `{}`.
 * Reference-image ids are stripped: they key into THIS device's store (the bytes
 * don't travel with the file), so they'd be meaningless noise to the importer. */
export function exportBible(bible: VisualBible | undefined): string {
  const meta: ExportMeta = { app: "Illustrator-App", schemaVersion: BIBLE_VERSION };
  const data = bible
    ? {
        ...bible,
        characters: bible.characters.map((c) => {
          const { referenceImageId: _a, referenceImageIds: _b, ...anchor } = c.anchor;
          return { ...c, anchor };
        }),
      }
    : {};
  return JSON.stringify({ _exportMeta: meta, rules: BIBLE_EXPORT_RULES, data }, null, 2);
}

/**
 * Re-attach the device-stored reference images after an import replaces the bible:
 * an imported file never carries them (the bytes live only in this device's store),
 * so without this every uploaded likeness would be silently dropped. Characters are
 * matched by id, name, or alias (case-insensitive).
 */
export function carryReferenceImages(prev: VisualBible, next: VisualBible): VisualBible {
  const byKey = new Map<string, string[]>();
  for (const c of prev.characters) {
    const ids = referenceIdsOf(c.anchor);
    if (ids.length === 0) continue;
    for (const k of [c.id, c.name, ...c.aliases]) {
      const key = k.trim().toLowerCase();
      if (key && !byKey.has(key)) byKey.set(key, ids);
    }
  }
  if (byKey.size === 0) return next;
  return {
    ...next,
    characters: next.characters.map((c) => {
      const ids = [c.id, c.name, ...c.aliases]
        .map((k) => byKey.get(k.trim().toLowerCase()))
        .find(Boolean);
      return ids ? { ...c, anchor: { ...c.anchor, referenceImageIds: ids } } : c;
    }),
  };
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
  // Accept the current schema, or one version back (migrate-on-import): a v6 export still
  // loads, with its inline-style prompts cleared so the prompt pass rewrites them.
  if (version !== BIBLE_VERSION && version !== BIBLE_VERSION - 1) {
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
  bible.worldStyle = str(data.worldStyle);
  bible.storyboard = arr(data.storyboard)
    .map((s) => toScene(s))
    .sort((a, b) => a.chapterIndex - b.chapterIndex);
  bible.processedChapters = arr(data.processedChapters)
    .map((n) => num(n))
    .filter((n) => Number.isFinite(n));
  // A one-version-back import: clear any imported (old-style) prompts so they're rewritten.
  if (version === BIBLE_VERSION - 1) {
    bible.storyboard = bible.storyboard.map(({ keyEvents: _drop, ...scene }) => scene);
  }

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
    // A series shares one world style — carry the prior book's when this one has none yet.
    worldStyle: (base.worldStyle ?? "").trim() || prior.worldStyle || "",
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
  const scene: ChapterScene = {
    chapterIndex: num(o.chapterIndex),
    summary: str(o.summary),
    keyMoment: str(o.keyMoment),
    location: str(o.location),
    locationChange: str(o.locationChange),
  };
  const keyEvents = arr(o.keyEvents).map((e) => toKeyEvent(e));
  if (keyEvents.length > 0) scene.keyEvents = keyEvents;
  return scene;
}

function toKeyEvent(v: unknown): KeyEvent {
  const o = obj(v);
  const range = arr(o.pageRange).map((n) => Math.round(num(n)));
  const start = range[0] ?? 0;
  const end = range[1] ?? start;
  const ip = obj(o.imagePrompt);
  const imagePrompt: ScenePrompt = {};
  for (const k of ["subject", "action", "environment", "mood", "composition", "text"] as const) {
    const val = str(ip[k]);
    if (val) imagePrompt[k] = val;
  }
  const ev: KeyEvent = { pageRange: [Math.min(start, end), Math.max(start, end)], imagePrompt };
  const location = str(o.location).trim();
  if (location) ev.location = location;
  if (typeof o.seed === "number") ev.seed = o.seed;
  return ev;
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
