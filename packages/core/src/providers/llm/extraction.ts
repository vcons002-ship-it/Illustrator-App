import type {
  Character,
  CharacterAppearance,
  ChapterScene,
  Creature,
  KeyEvent,
  Outfit,
  ScenePrompt,
  VisualBible,
} from "../../types/bible.js";
import { emptyAppearance } from "../../types/bible.js";
import type { EntityExtractionInput } from "./llm-provider.js";
import type { VisualRequest } from "../../types/content.js";
import { deterministicSeed } from "./mock-llm-provider.js";
import { resolveKeyEvent } from "../../visual-bible/key-events.js";

/**
 * Shared building blocks for the cloud LLM providers (Claude / Gemini / OpenAI).
 *
 * Every provider does the same two jobs — Visual-Bible extraction and image-prompt
 * building — differing only in transport/SDK. Keeping the prompt text, the JSON
 * shape, the merge logic, and the prompt-context builder here means the providers
 * stay thin and behave identically, so swapping providers never changes results.
 */

/** Provider-neutral shape returned by every extraction call before merging. */
export interface RawExtraction {
  characters: {
    name: string;
    aliases: string[];
    /** Structured physical appearance; optional for back-compat with older mocks. */
    appearance?: Partial<CharacterAppearance>;
    persistentTraits: string[];
    /** @deprecated legacy single clothing list; still accepted from old fixtures. */
    clothing?: string[];
    /** Distinct outfits the character is described wearing. */
    outfits?: { label: string; description: string }[];
  }[];
  environments: { name: string; description: string[] }[];
  /** Named/notable non-human creatures (dragons, beasts…). Optional for back-compat. */
  creatures?: { name: string; aliases: string[]; kind: string; description: string[] }[];
  spoilers: { label: string }[];
  /** Recurring world facts/defining context to apply by default in every prompt. */
  glossary?: { term: string; definition: string }[];
  /** What occurs in this chapter (the storyboard summary). Optional for back-compat. */
  summary?: string;
  /** The single most important action/moment to illustrate this chapter. */
  keyMoment?: string;
  /** Where the chapter takes place (by environment name). */
  location?: string;
  /** "" if the chapter stays in one place, else where/when the setting shifts. */
  locationChange?: string;
  /**
   * Ordered Layer-1 scene prompts — one per illustration the chapter is split into,
   * in reading order. Produced WITH the extraction (no extra LLM call); the engine
   * maps them onto the chapter's render units by position. Optional for back-compat.
   */
  keyEvents?: {
    subject: string;
    action: string;
    environment: string;
    mood: string;
    composition: string;
    /** Beat-level setting: the ONE location name where this scene happens. */
    location?: string;
  }[];
  /** One concise genre/art-direction line for the whole book, applied to every prompt. */
  worldStyle?: string;
}

export const EXTRACTION_SYSTEM =
  "You are building a 'Visual Bible' and storyboard for illustrating a novel as you " +
  "read it chapter by chapter. You are given the characters, creatures, and locations " +
  "already recorded from earlier chapters. Work INCREMENTALLY: capture what THIS chapter " +
  "adds, and do NOT repeat what is already recorded. " +
  "Capture EVERY named character who is given a physical or appearance description here " +
  "that is NOT already recorded — including minor and one-off characters. " +
  "Do NOT limit yourself to the main cast; only skip bare name-drops that carry no " +
  "description at all. A capitalized word used as a person's NAME or nickname is a character " +
  "(a human), even when it is also a common noun or animal word — e.g. a person called 'Cat', " +
  "'Hawk', 'Wren', or 'Fox' is a human character, NOT an animal. For each character fill the structured 'appearance' fields " +
  "(hair, eyes, gender, build/physique, height, skinTone, age, distinguishingMarks; use " +
  "an empty string for anything the text doesn't state) and put extra persistent details " +
  "in persistentTraits. Capture each DISTINCT outfit a character is described wearing as a " +
  "separate entry in 'outfits' — a short 'label' and a detailed 'description' (garments, fabric, " +
  "colour, accessories, era/style), e.g. label 'flight leathers', description 'fitted black hide " +
  "with buckled straps'. Add new outfits as they appear across chapters; do NOT merge different " +
  "outfits into one. " +
  "Reuse a character's ESTABLISHED name across chapters: if " +
  "the same person is referred to by a first name, full name, title, or nickname, keep ONE " +
  "entry and put the other forms in 'aliases' — never create a second character for the same " +
  "person (e.g. 'Violet' and 'Violet Sorrengail' are one character). " +
  "Capture EVERY named location with a detailed visual " +
  "description (architecture, materials, layout, lighting, palette, mood) AND its world's " +
  "fashion and aesthetic; always refer to a location you already know by its established name. " +
  "Capture notable non-human 'creatures' — dragons, beasts, monsters, mounts — separately " +
  "from human characters (do NOT put them in 'characters'). For each give its name (or a " +
  "descriptive label if unnamed, e.g. 'the black dragon'), any aliases, its 'kind' (dragon, " +
  "griffin…), and a detailed visual 'description' (size, colour, scales/fur, wings, horns, " +
  "eyes, distinguishing marks). Reuse an established creature's name (e.g. 'Tairn' is a massive " +
  "midnight-black dragon). NEVER create a " +
  "creature from a person's name or nickname — only from a LITERAL animal/beast in the text (a " +
  "character nicknamed 'Cat' is a person, not an animal). " +
  "INCREMENTAL RULE (important — keeps your output small): for a character, creature, or " +
  "location that is ALREADY in the known lists, only include it if THIS chapter reveals " +
  "genuinely NEW visual detail (a newly-described feature, a new outfit, a new aspect of a " +
  "place) — and then include ONLY that new detail. OMIT every already-known entity that this " +
  "chapter adds nothing new about (it is already remembered and will be kept automatically). " +
  "Output brand-NEW entities in full; never repeat an entity just to restate what's known. " +
  "Build a 'glossary' of recurring world facts / defining context that should be assumed " +
  "by default unless a passage says otherwise — e.g. customary attire ('dragon riders wear " +
  "fitted black flight leathers'), technology level, materials, or social norms; each NEW entry " +
  "is a short term and its definition (omit terms already listed). Flag any NEW spoilers that " +
  "would spoil the plot if shown before the reader reaches them (a short label each). " +
  "Also write a 'summary' of what happens in THIS chapter, " +
  "and a single 'keyMoment': the most important, most visual action of the chapter to " +
  "illustrate (one concrete sentence). Determine WHERE the chapter takes place: set " +
  "'location' to the primary setting (use the established environment name), and keep the " +
  "keyMoment's place explicit. If the setting moves during the chapter, set 'locationChange' " +
  "to a short note of where/when it shifts (otherwise an empty string). " +
  "Write 'keyEvents': the chapter is illustrated as a fixed number of images covering " +
  "consecutive stretches of the chapter in READING ORDER — you are told how many. Produce EXACTLY " +
  "that many keyEvents, in order, each describing the single most important visual SCENE of its " +
  "stretch as five natural-language fields: 'subject' (who/what is the focus), 'action' (what they " +
  "are doing), 'environment' (where/how it looks), 'mood' (tone), 'composition' (camera angle/" +
  "framing) — plus 'location': the established location NAME where THAT scene's moment happens. " +
  "Track the setting beat by beat: each keyEvent gets ITS OWN location, so when the chapter moves " +
  "(tavern → road → castle) consecutive keyEvents change location accordingly. EXACTLY one place " +
  "per keyEvent — if a stretch itself moves between places, use the place of the depicted moment " +
  "(empty string only if genuinely unknowable). " +
  "Describe a scene with the characters acting in their setting — NOT a portrait. Refer to " +
  "characters/creatures by their EXACT bible name, to clothing by its outfit LABEL, and to a place " +
  "by its location NAME (the app expands each into its visual description), so do NOT describe their " +
  "permanent looks. No weighting syntax, no tags, just prose; keep each field concise. " +
  "Finally, set 'worldStyle': one concise line capturing the book's overall genre and visual " +
  "art direction to apply to EVERY illustration — e.g. 'high-fantasy military academy, dark, " +
  "painterly, dramatic lighting' or 'cosy contemporary romance, warm, soft watercolour'. Cover " +
  "genre, era/setting, mood, and a rendering style. Refine it as the book reveals more (keep the " +
  "most specific version).";

/**
 * Extraction system prompt for TECHNICAL / non-fiction books (papers, textbooks,
 * articles). Reuses the SAME output schema as fiction, remapped: 'environments' hold
 * recurring STRUCTURES/SYSTEMS (so naming one in a prompt injects its visual
 * description), 'glossary' holds key terms/data/findings, and 'keyEvents' become a
 * per-stretch VISUALIZATION PLAN — the creative pass that decides what's worth
 * drawing and how. Characters/creatures/outfits/spoilers stay empty.
 */
export const TECHNICAL_EXTRACTION_SYSTEM =
  "You are building a 'Visual Atlas' for illustrating a NON-FICTION text (a paper, " +
  "textbook, or article) as it is read, chapter by chapter. You are given what was " +
  "already recorded from earlier chapters. Work INCREMENTALLY: capture what THIS chapter " +
  "adds and do NOT repeat what is already recorded. " +
  "This is not a story: leave 'characters', 'creatures', and 'spoilers' as EMPTY lists " +
  "(do not invent people), and give characters no outfits. Instead: " +
  "Use 'environments' for every recurring STRUCTURE, SYSTEM, APPARATUS, ORGANISM, or " +
  "PLACE the text describes (a mitochondrion, a transformer architecture, a reactor " +
  "core, a trial cohort…) — name it by its established term and give a detailed VISUAL " +
  "description (shape, parts, scale, materials, spatial arrangement, what it connects " +
  "to), so later illustrations of it stay consistent. Reuse established names; only add " +
  "NEW detail for known entries. " +
  "Build the 'glossary' as the chapter's key INFORMATION: definitions of essential " +
  "terms, important quantities/data points with their values and units, named methods, " +
  "and central findings — each as a short term plus a precise definition (omit entries " +
  "already listed). " +
  "Write a 'summary' of what THIS chapter explains, and a 'keyMoment': the single most " +
  "important idea of the chapter stated as one concrete, visualizable sentence. Set " +
  "'location' to the chapter's primary subject system (established environment name) " +
  "and 'locationChange' to '' unless the subject shifts mid-chapter. " +
  "Write 'keyEvents' as the chapter's VISUALIZATION PLAN: the chapter is illustrated as " +
  "a fixed number of images covering consecutive stretches in READING ORDER — you are " +
  "told how many. For each stretch, choose the ONE most illustration-worthy item, in " +
  "this priority: (1) a quantitative result, trend, or comparison — show magnitude and " +
  "relationship visually (relative sizes, before/after, side-by-side); (2) a mechanism " +
  "or process — show its stages flowing left-to-right or top-to-bottom; (3) a structure " +
  "— show a cutaway, cross-section, or exploded view; (4) an abstract concept — invent " +
  "ONE concrete visual metaphor that makes it tangible. Fill the five fields: 'subject' " +
  "(the concept/data/structure being shown), 'action' (what the visual demonstrates — " +
  "the change, flow, comparison, or relationship), 'environment' (the visual FORM: " +
  "cutaway diagram, step-by-step process view, scale comparison, annotated-style " +
  "scene…), 'mood' (palette and clarity, e.g. 'clean, high-contrast, neutral " +
  "background'), 'composition' (layout/viewpoint) — plus 'location': the established " +
  "system/structure name this stretch concerns (empty if none). Never request rendered " +
  "text or labels — image models draw text poorly; the imagery itself must carry the " +
  "meaning. " +
  "Finally set 'worldStyle': one concise art-direction line applied to EVERY " +
  "illustration of this text — e.g. 'clean modern scientific illustration, precise " +
  "linework, soft studio lighting, neutral background, restrained technical palette'. " +
  "Keep it consistent with the field (medicine, astronomy, engineering…).";

/** The entity-extraction system prompt for a book's content mode. */
export function extractionSystemFor(contentMode?: string): string {
  return contentMode === "technical" ? TECHNICAL_EXTRACTION_SYSTEM : EXTRACTION_SYSTEM;
}

export const PROMPT_SYSTEM =
  "You write one vivid, concrete image-generation prompt for a single illustration of a " +
  "book chapter. Write it as a single paragraph of natural, descriptive language (NOT a " +
  "list of tags, no weighting syntax, no markdown) — lead with the subject and action, " +
  "then the setting, then mood/lighting. Depict the single most important action shown in " +
  "THIS passage specifically — each illustration covers a different stretch of the chapter, " +
  "so describe what happens in THIS passage and never reuse another illustration's moment or " +
  "fall back on the chapter's overall climax. Frame it as a SCENE that shows the action and the " +
  "setting around the characters — a wide or medium shot of the moment, NOT a tight close-up, " +
  "headshot, or centered character portrait, unless the passage is deliberately intimate. Show " +
  "what the characters are DOING, with their environment visible. Set the image in ONE coherent " +
  "location — the place where the passage's action occurs; if the chapter or passage moves " +
  "between places, choose the single location of the depicted moment and NEVER combine two " +
  "settings into one picture. " +
  "IMPORTANT — refer to each character and creature by their EXACT name from the supplied " +
  "Visual Bible, to clothing by its exact outfit LABEL, and to a place by its exact location " +
  "NAME; the app expands each of those into the correct visual description automatically, so do " +
  "NOT describe a character's permanent physical features (hair, eyes, build, face, scars), the " +
  "full details of a garment, or a location's architecture yourself — just name them and " +
  "describe what is happening, their pose, expression, and the composition. The listed characters " +
  "are PEOPLE — depict them as humans; NEVER render a character as an animal even if their name " +
  "is also a common word (a person named 'Cat' is a woman, not a cat). For each character, pick " +
  "the SINGLE outfit LABEL from their listed options that best fits this scene and name only that " +
  "label (never combine outfits). For action scenes, convey dynamic movement — a dynamic pose, " +
  "motion, energy, a sense of speed or impact. Output only the prompt text, no preamble.";

/**
 * Image-prompt system prompt for TECHNICAL / non-fiction content (papers, textbooks,
 * articles): illustrate the passage's central CONCEPT, mechanism, or process as a clean
 * explanatory visual instead of a story scene. Experimental — entity extraction still
 * runs the fiction pass (its character/outfit fields are simply sparse for non-fiction).
 */
export const TECHNICAL_PROMPT_SYSTEM =
  "You write one clear, concrete image-generation prompt for a single EXPLANATORY " +
  "illustration of a non-fiction passage (a paper, textbook, or article). Write a single " +
  "paragraph of natural, descriptive language (NOT a list of tags, no weighting syntax, no " +
  "markdown). Depict the single most important concept, mechanism, structure, or process " +
  "in THIS passage — each illustration covers a different stretch of the text, so depict " +
  "what THIS passage explains, never repeating another illustration's subject. Prefer a " +
  "clean scientific/technical illustration: a clear focal subject, simple uncluttered " +
  "composition, neutral background, accurate proportions and spatial relationships — like " +
  "a high-quality textbook figure or museum exhibit visual. For a process, show its stages " +
  "or flow visually (left to right or top to bottom); for a structure, show a clear " +
  "cutaway, cross-section, or labeled-style view (but do NOT ask for rendered text or " +
  "labels — image models draw text poorly; convey meaning through the imagery itself). " +
  "No people unless the passage is about people. Output only the prompt text, no preamble.";

/** The image-prompt system prompt for a request's content kind. */
export function promptSystemFor(kind: string): string {
  return kind === "technical_illustration" ? TECHNICAL_PROMPT_SYSTEM : PROMPT_SYSTEM;
}

/**
 * JSON Schema for the extraction result. Gemini (`responseSchema`) and OpenAI
 * (`response_format: json_schema`) both consume this so the model returns
 * validated JSON; Claude expresses the same shape via its Zod helper.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          appearance: {
            type: "object",
            additionalProperties: false,
            properties: {
              hair: { type: "string" },
              eyes: { type: "string" },
              gender: { type: "string" },
              build: { type: "string" },
              height: { type: "string" },
              skinTone: { type: "string" },
              age: { type: "string" },
              distinguishingMarks: { type: "string" },
              notes: { type: "string" },
            },
            required: [
              "hair",
              "eyes",
              "gender",
              "build",
              "height",
              "skinTone",
              "age",
              "distinguishingMarks",
              "notes",
            ],
          },
          persistentTraits: { type: "array", items: { type: "string" } },
          outfits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["label", "description"],
            },
          },
        },
        required: ["name", "aliases", "appearance", "persistentTraits", "outfits"],
      },
    },
    glossary: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          term: { type: "string" },
          definition: { type: "string" },
        },
        required: ["term", "definition"],
      },
    },
    environments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "array", items: { type: "string" } },
        },
        required: ["name", "description"],
      },
    },
    creatures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          kind: { type: "string" },
          description: { type: "array", items: { type: "string" } },
        },
        required: ["name", "aliases", "kind", "description"],
      },
    },
    spoilers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
        },
        required: ["label"],
      },
    },
    summary: { type: "string" },
    keyMoment: { type: "string" },
    location: { type: "string" },
    locationChange: { type: "string" },
    keyEvents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string" },
          action: { type: "string" },
          environment: { type: "string" },
          mood: { type: "string" },
          composition: { type: "string" },
          location: { type: "string" },
        },
        required: ["subject", "action", "environment", "mood", "composition", "location"],
      },
    },
    worldStyle: { type: "string" },
  },
  required: [
    "characters",
    "glossary",
    "environments",
    "creatures",
    "spoilers",
    "summary",
    "keyMoment",
    "location",
    "locationChange",
    "keyEvents",
    "worldStyle",
  ],
} as const;

/**
 * The user message for one chapter's extraction. Includes the "story so far"
 * (prior chapters' summaries from the bible being built) so the model has the
 * cumulative context when summarising this chapter and picking its key moment.
 */
/**
 * The "known so far" context fed back to the model exists only so it REUSES
 * canonical names (dedup) and EXTENDS detail rather than re-introducing entities.
 * That job needs names, not the full accumulated descriptions — and those
 * descriptions grow every chapter (merge appends), so echoing them back made each
 * chapter's prompt grow ~O(n) → the build crawled on long books. We therefore feed
 * back **names only**, cap the list length, and keep only the most recent summaries.
 * Dedup/accumulation are unaffected (mergeExtraction dedups by name regardless).
 */
const MAX_CONTEXT_ENTRIES = 40; // names per "known so far" block
const MAX_PRIOR_SUMMARIES = 8; // most-recent chapter summaries to echo back
const MAX_SUMMARY_CHARS = 200; // truncate each echoed summary

function cap<T>(list: readonly T[], n: number, render: (item: T) => string): string {
  const shown = list.slice(0, n).map(render);
  const extra = list.length - shown.length;
  if (extra > 0) shown.push(`…(+${extra} more)`);
  return shown.join("\n");
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`;
}

export function extractionUserContent(input: EntityExtractionInput): string {
  // Only the most recent summaries (bounded), each truncated — older context is
  // already captured in the accumulated entities, so the full history isn't needed.
  const priorSummaries = cap(
    [...input.existing.storyboard]
      .filter((s) => s.chapterIndex < input.chapterIndex)
      .sort((a, b) => a.chapterIndex - b.chapterIndex)
      .slice(-MAX_PRIOR_SUMMARIES),
    MAX_PRIOR_SUMMARIES,
    (s) => `Chapter ${s.chapterIndex}: ${truncate(s.summary, MAX_SUMMARY_CHARS)}`,
  );
  const soFar = priorSummaries ? `Story so far:\n${priorSummaries}\n\n` : "";
  // Feed back the known cast (names + aliases) so the model reuses each person's
  // established name instead of creating duplicate characters.
  const cast = cap(
    input.existing.characters,
    MAX_CONTEXT_ENTRIES,
    (c) => `- ${c.name}${c.aliases.length ? ` (aka ${c.aliases.slice(0, 4).join(", ")})` : ""}`,
  );
  const castSoFar = cast
    ? `Known characters (already recorded — reuse these exact names; record other forms as ` +
      `aliases; do NOT re-output one unless this chapter adds NEW visual detail, and never add ` +
      `a second entry for the same person):\n${cast}\n\n`
    : "";
  // Glossary terms only — definitions are already stored; we just need the model to
  // reuse the term and not re-add it.
  const known = cap(input.existing.glossary ?? [], MAX_CONTEXT_ENTRIES, (g) => `- ${g.term}`);
  const glossarySoFar = known ? `Known world facts (terms — add only NEW ones, don't repeat):\n${known}\n\n` : "";
  // Known location NAMES so the model reuses them and adds detail instead of
  // re-introducing a place under a slightly different name.
  const places = cap(input.existing.environments, MAX_CONTEXT_ENTRIES, (e) => `- ${e.name}`);
  const placesSoFar = places
    ? `Known locations (reuse these names; re-output one only with NEW visual detail):\n${places}\n\n`
    : "";
  // Known creature NAMES (+ kind) so a recurring beast keeps one name.
  const beasts = cap(input.existing.creatures ?? [], MAX_CONTEXT_ENTRIES, (c) => `- ${c.name} (${c.kind})`);
  const beastsSoFar = beasts
    ? `Known creatures (reuse these names; re-output one only with NEW visual detail):\n${beasts}\n\n`
    : "";
  // Tell the model how many scene prompts to emit (one per illustration of this chapter).
  const k = input.sceneCount ?? input.unitRanges?.length ?? 0;
  const scenes = k > 0
    ? `This chapter is illustrated as ${k} image${k === 1 ? "" : "s"} in reading order — ` +
      `produce EXACTLY ${k} keyEvents, in order.\n\n`
    : "";
  return `${castSoFar}${beastsSoFar}${placesSoFar}${glossarySoFar}${soFar}${scenes}Chapter ${input.chapterIndex} text:\n\n${input.chapterText}`;
}

/**
 * Merge a raw extraction into the existing Bible, deduplicating by (lowercased)
 * name and assigning each new character a deterministic identity seed. Idempotent
 * per chapter, so re-running a chapter never duplicates entities.
 */
/**
 * Map an ordered list of raw scene prompts onto a chapter's render units by position:
 * `keyEvents[i]` → `unitRanges[i]`. Tolerant of a count mismatch (uses the shorter of
 * the two), and skips a scene whose five fields are all empty (that unit then falls
 * back to the live LLM at render).
 */
function mapKeyEventsToUnits(
  events: RawExtraction["keyEvents"],
  unitRanges: [number, number][] | undefined,
): KeyEvent[] {
  if (!events || !unitRanges || unitRanges.length === 0) return [];
  const out: KeyEvent[] = [];
  const n = Math.min(events.length, unitRanges.length);
  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    const imagePrompt: ScenePrompt = {};
    for (const key of ["subject", "action", "environment", "mood", "composition"] as const) {
      const v = (e[key] ?? "").trim();
      if (v) imagePrompt[key] = v;
    }
    if (Object.keys(imagePrompt).length === 0) continue;
    const location = (e.location ?? "").trim();
    out.push({ pageRange: unitRanges[i]!, imagePrompt, ...(location ? { location } : {}) });
  }
  return out;
}

export function mergeExtraction(
  existing: VisualBible,
  raw: RawExtraction,
  chapterIndex: number,
  unitRanges?: [number, number][],
): VisualBible {
  const bible: VisualBible = {
    ...existing,
    characters: [...existing.characters],
    environments: [...existing.environments],
    creatures: [...(existing.creatures ?? [])],
    spoilers: [...existing.spoilers],
    storyboard: [...(existing.storyboard ?? [])],
    glossary: [...(existing.glossary ?? [])],
    processedChapters: [...existing.processedChapters],
  };
  const knownEnvs = new Set(bible.environments.map((e) => e.name.toLowerCase()));
  const knownTerms = new Set(bible.glossary.map((g) => g.term.toLowerCase()));

  for (const c of raw.characters) {
    // Upsert by exact name (accumulating aliases/appearance on a re-mention); the
    // consolidation pass below collapses alias/partial-name duplicates.
    const at = bible.characters.findIndex((ex) => ex.name.toLowerCase() === c.name.toLowerCase());
    if (at >= 0) {
      bible.characters[at] = mergeRawIntoCharacter(bible.characters[at]!, c);
    } else {
      bible.characters.push({
        id: `char-${slug(c.name)}`,
        name: c.name,
        aliases: c.aliases,
        appearance: { ...emptyAppearance(), ...(c.appearance ?? {}) },
        persistentTraits: c.persistentTraits,
        clothing: c.clothing ?? [],
        outfits: dedupeOutfits(c.outfits ?? []),
        anchor: { seed: deterministicSeed(c.name) },
        firstSeenChapter: chapterIndex,
      });
    }
  }
  bible.characters = consolidateCharacters(bible.characters);
  for (const g of raw.glossary ?? []) {
    const term = g.term.trim();
    if (!term || knownTerms.has(term.toLowerCase())) continue;
    knownTerms.add(term.toLowerCase());
    bible.glossary.push({ term, definition: g.definition });
  }
  for (const e of raw.environments) {
    const key = e.name.toLowerCase();
    const at = bible.environments.findIndex((env) => env.name.toLowerCase() === key);
    if (at >= 0) {
      // Known location → ACCUMULATE new description lines (so a chapter that adds
      // detail enriches it, and a name-only mention later still has the full look).
      const existingEnv = bible.environments[at]!;
      const have = new Set(existingEnv.description.map((d) => d.toLowerCase()));
      const merged = [...existingEnv.description];
      for (const d of e.description) {
        if (d.trim() && !have.has(d.toLowerCase())) {
          merged.push(d);
          have.add(d.toLowerCase());
        }
      }
      bible.environments[at] = { ...existingEnv, description: merged };
    } else {
      knownEnvs.add(key);
      bible.environments.push({
        id: `env-${slug(e.name)}`,
        name: e.name,
        description: e.description,
        firstSeenChapter: chapterIndex,
      });
    }
  }
  for (const cr of raw.creatures ?? []) {
    const name = cr.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const at = bible.creatures.findIndex((x) => x.name.toLowerCase() === key);
    if (at >= 0) {
      // Known creature → ACCUMULATE description (so a beast named once later still
      // has its full look, and recurring detail enriches it).
      const existingCr = bible.creatures[at]!;
      const have = new Set(existingCr.description.map((d) => d.toLowerCase()));
      const merged = [...existingCr.description];
      for (const d of cr.description) {
        if (d.trim() && !have.has(d.toLowerCase())) {
          merged.push(d);
          have.add(d.toLowerCase());
        }
      }
      bible.creatures[at] = {
        ...existingCr,
        description: merged,
        ...(existingCr.kind ? {} : { kind: cr.kind }),
      };
    } else {
      const creature: Creature = {
        id: `creature-${slug(name)}`,
        name,
        aliases: cr.aliases,
        kind: cr.kind,
        description: cr.description,
        anchor: { seed: deterministicSeed(`creature:${name}`) },
        firstSeenChapter: chapterIndex,
      };
      bible.creatures.push(creature);
    }
  }
  for (const s of raw.spoilers) {
    bible.spoilers.push({
      id: `spoiler-${slug(s.label)}-${chapterIndex}`,
      label: s.label,
      // Deprecated: reveal timing is derived from where the label appears on the page
      // (see visual-bible/reveal.ts), not a precomputed id. Kept "" for the cached shape.
      revealParagraphId: "",
    });
  }

  // Upsert this chapter's storyboard scene (idempotent re-run replaces it). Fold in the
  // per-scene image prompts: map raw.keyEvents[i] → the chapter's unitRanges[i].
  const incoming = mapKeyEventsToUnits(raw.keyEvents, unitRanges);
  if (raw.summary || raw.keyMoment || raw.location || incoming.length > 0) {
    const at = bible.storyboard.findIndex((s) => s.chapterIndex === chapterIndex);
    const prev = at >= 0 ? bible.storyboard[at] : undefined;
    const scene: ChapterScene = {
      chapterIndex,
      summary: raw.summary ?? "",
      keyMoment: raw.keyMoment ?? "",
      location: raw.location ?? "",
      locationChange: raw.locationChange ?? "",
      // Fresh keyEvents win; if none came back this run, keep any prior ones.
      ...(incoming.length > 0
        ? { keyEvents: incoming }
        : prev?.keyEvents
          ? { keyEvents: prev.keyEvents }
          : {}),
    };
    if (at >= 0) bible.storyboard[at] = scene;
    else bible.storyboard.push(scene);
    bible.storyboard.sort((a, b) => a.chapterIndex - b.chapterIndex);
  }

  // World style: adopt it, preferring the most specific (longest) version seen so far so
  // a later chapter can enrich it but a terse mention never overwrites a richer one.
  const newStyle = (raw.worldStyle ?? "").trim();
  if (newStyle && newStyle.length > (bible.worldStyle ?? "").trim().length) {
    bible.worldStyle = newStyle;
  }

  if (!bible.processedChapters.includes(chapterIndex)) {
    bible.processedChapters.push(chapterIndex);
  }
  return bible;
}

/**
 * The user message for building one unit's image prompt. Scoped to THIS chapter: the
 * bible already encodes accumulated state, so prior chapters are not dumped in. Names
 * (not descriptions) are listed — the writer refers to characters/creatures/outfits/
 * locations by name, and the app expands those into visual descriptors at render time.
 */
export function promptUserContent(request: VisualRequest, bible: VisualBible): string {
  const chars = bible.characters.filter((c) => request.characterIds.includes(c.id));
  const envs = bible.environments.filter((e) => request.environmentIds.includes(e.id));
  const creatures = (bible.creatures ?? []).filter((c) => request.creatureIds.includes(c.id));
  const scene = (bible.storyboard ?? []).find((s) => s.chapterIndex === request.chapterIndex);
  // Beat-level setting: this unit's stored keyEvent (if any) knows where ITS moment
  // happens — more exact than the chapter's single location when the chapter moves.
  const beatLocation = resolveKeyEvent(bible, request.chapterIndex, request.pageRange)?.location;
  return [
    request.bookTitle ? `Book: ${request.bookTitle}.` : "",
    `Illustrate the single most important action in THIS passage (below). Each illustration ` +
      `covers a DIFFERENT stretch of the chapter, so depict ONLY what happens in THIS passage — ` +
      `not the chapter's overall climax, and not a previous illustration's moment.`,
    `Passage:\n${request.sourceText}`,
    settingLine(scene, envs, request.sourceText, beatLocation),
    chars.length
      ? `Characters present — refer to each by their EXACT name; do NOT describe their looks ` +
        `(auto-applied). They are PEOPLE (a name like 'Cat' is a person). Where a character has ` +
        `outfit options, name the ONE label that fits this scene:\n${chars
          .map((c) => `- ${characterNameLine(c)}`)
          .join("\n")}`
      : "",
    creatures.length
      ? `Creatures present — refer to each by their EXACT name (look auto-applied):\n${creatures
          .map((c) => `- ${c.name}${c.kind ? ` (${c.kind})` : ""}`)
          .join("\n")}`
      : "",
    envs.length
      ? `Locations available — refer to a place by its EXACT name (look auto-applied):\n${envs
          .map((e) => `- ${e.name}`)
          .join("\n")}`
      : "",
    (bible.glossary ?? []).length
      ? `World facts (apply as defaults unless the passage says otherwise):\n${(bible.glossary ?? [])
          .map((g) => `- ${g.term}: ${g.definition}`)
          .join("\n")}`
      : "",
    scene?.summary
      ? `This chapter (continuity only — illustrate the passage, not this): ${scene.summary}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A present-character line for the prompt context: name + alias hint + outfit LABELS only. */
function characterNameLine(c: Character): string {
  const aka = c.aliases.length ? ` (aka ${c.aliases.slice(0, 3).join(", ")})` : "";
  const labels = (c.outfits ?? []).map((o) => o.label).filter(Boolean);
  const outfits = labels.length ? ` — outfit labels: ${labels.join(", ")}` : "";
  return `${c.name}${aka}${outfits}`;
}

/**
 * The single location this image must commit to, by preference: (1) the unit's
 * beat-level location from its stored keyEvent (exact, tracked per image even
 * when the chapter moves); (2) a known environment the passage actually names;
 * (3) the chapter scene's primary `location`. `locationChange` is passed as
 * context so the writer knows the chapter moves and must still pick ONE setting.
 */
function settingLine(
  scene: { location?: string; locationChange?: string } | undefined,
  envs: { name: string }[],
  sourceText: string,
  beatLocation?: string,
): string {
  const haystack = sourceText.toLowerCase();
  const named = envs.find((e) => e.name && haystack.includes(e.name.toLowerCase()));
  const place = (beatLocation ?? "").trim() || named?.name || scene?.location || "";
  if (!place) return "";
  const change = scene?.locationChange ? ` (note: the chapter moves — ${scene.locationChange})` : "";
  return `Setting for this image (use this ONE location, do not blend places): ${place}${change}`;
}

// --- Character de-duplication -------------------------------------------------

/** Case-insensitive union of two string lists, trimmed, blanks dropped, order kept. */
function unionStrings(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of [...a, ...b]) {
    const t = s.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/**
 * Accumulate appearance details: keep adding NEW information per field across
 * chapters rather than only filling blanks. If `extra` adds detail not already
 * present, append it ("brown" + "fades to silver at the tips"); if `extra` is a
 * richer superset of `base`, replace; exact/contained repeats are ignored.
 */
function accumulateAppearance(
  base: CharacterAppearance,
  extra: Partial<CharacterAppearance> | undefined,
): CharacterAppearance {
  if (!extra) return base;
  const out = { ...base };
  (Object.keys(out) as (keyof CharacterAppearance)[]).forEach((k) => {
    const cur = out[k].trim();
    const add = (extra[k] ?? "").trim();
    if (!add) return;
    if (!cur) {
      out[k] = add;
      return;
    }
    const lc = cur.toLowerCase();
    const la = add.toLowerCase();
    if (lc.includes(la)) return; // already have this detail
    if (la.includes(lc)) {
      out[k] = add; // new value is a richer superset
      return;
    }
    out[k] = `${cur}; ${add}`; // genuinely new detail → append
  });
  return out;
}

/** An outfit as it may arrive (extraction no longer sends `context`; cached data may). */
type PartialOutfit = { label?: string; description?: string; context?: string };

/** Distinct outfits by (lowercased) label, order preserved, blanks dropped. `context`
 * is no longer extracted (unused at render) but kept on the stored shape for back-compat. */
function dedupeOutfits(list: readonly PartialOutfit[]): Outfit[] {
  const out: Outfit[] = [];
  const seen = new Set<string>();
  for (const o of list) {
    const label = o.label?.trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({ label, description: o.description ?? "", context: o.context ?? "" });
  }
  return out;
}
function unionOutfits(a: readonly PartialOutfit[] | undefined, b: readonly PartialOutfit[] | undefined): Outfit[] {
  return dedupeOutfits([...(a ?? []), ...(b ?? [])]);
}

/** Merge a raw extraction's character into an existing one (same exact name). */
function mergeRawIntoCharacter(ex: Character, raw: RawExtraction["characters"][number]): Character {
  return {
    ...ex,
    aliases: unionStrings(ex.aliases, [raw.name, ...raw.aliases]).filter(
      (a) => a.toLowerCase() !== ex.name.toLowerCase(),
    ),
    appearance: accumulateAppearance(ex.appearance, raw.appearance),
    persistentTraits: unionStrings(ex.persistentTraits, raw.persistentTraits),
    clothing: unionStrings(ex.clothing, raw.clothing ?? []),
    outfits: unionOutfits(ex.outfits, raw.outfits ?? []),
  };
}

/** Merge two known characters into one (keeping `canon` as the canonical entry). */
function mergeCharacters(canon: Character, other: Character): Character {
  return {
    ...canon,
    aliases: unionStrings([...canon.aliases, other.name, ...other.aliases], []).filter(
      (a) => a.toLowerCase() !== canon.name.toLowerCase(),
    ),
    appearance: accumulateAppearance(canon.appearance, other.appearance),
    persistentTraits: unionStrings(canon.persistentTraits, other.persistentTraits),
    clothing: unionStrings(canon.clothing, other.clothing),
    outfits: unionOutfits(canon.outfits, other.outfits),
    firstSeenChapter: Math.min(canon.firstSeenChapter, other.firstSeenChapter),
  };
}

/** Lowercased name + aliases. */
function charKeys(c: Character): Set<string> {
  return new Set([c.name, ...c.aliases].map((s) => s.trim().toLowerCase()).filter(Boolean));
}
/**
 * Same person only when one character's primary NAME appears in the other's
 * name/alias set. A mere alias↔alias overlap is deliberately NOT enough: models
 * hand out the same generic alias ("the rider", "her brother", "the lieutenant")
 * to several people, and treating that as identity chain-merged whole casts into
 * one entry (each merge unions the alias sets, intersecting ever more characters).
 * A primary name is the specific, deliberate form — safe to merge on.
 */
function sameNamedPerson(a: Character, b: Character): boolean {
  const an = a.name.trim().toLowerCase();
  const bn = b.name.trim().toLowerCase();
  if (!an || !bn) return false;
  return charKeys(b).has(an) || charKeys(a).has(bn);
}
function nameTokens(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/\s+/).filter(Boolean));
}
function isStrictSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size >= b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}
/** The fuller name wins (more tokens); ties broken by earliest appearance. */
function pickCanonical(a: Character, b: Character): [Character, Character] {
  const ta = nameTokens(a.name).size;
  const tb = nameTokens(b.name).size;
  if (ta !== tb) return ta > tb ? [a, b] : [b, a];
  return a.firstSeenChapter <= b.firstSeenChapter ? [a, b] : [b, a];
}

/**
 * Collapse duplicate characters: (1) one's primary NAME appears in the other's
 * name/alias set (alias↔alias overlap alone is NOT identity — see
 * `sameNamedPerson`); (2) a partial name is merged into its UNIQUE fuller name
 * ("Violet" → "Violet Sorrengail"). Ambiguous partials (a bare "Anne" when both
 * "Anne Boleyn" and "Anne Frank" exist) are left alone. Idempotent.
 */
export function consolidateCharacters(list: Character[]): Character[] {
  let chars = [...list];

  // Pass 1 — a primary name matching the other's name/alias set (same person).
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < chars.length && !again; i++) {
      for (let j = i + 1; j < chars.length; j++) {
        if (sameNamedPerson(chars[i]!, chars[j]!)) {
          const [canon, other] = pickCanonical(chars[i]!, chars[j]!);
          chars = chars.filter((_, k) => k !== i && k !== j);
          chars.push(mergeCharacters(canon, other));
          again = true;
          break;
        }
      }
    }
  }

  // Pass 2 — a partial name with exactly one fuller-name superset.
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < chars.length && !again; i++) {
      const partial = chars[i]!;
      const ti = nameTokens(partial.name);
      const supers = chars.filter((c) => c !== partial && isStrictSubset(ti, nameTokens(c.name)));
      if (supers.length === 1) {
        const sup = supers[0]!;
        chars = chars.filter((c) => c !== partial && c !== sup);
        chars.push(mergeCharacters(sup, partial));
        again = true;
      }
    }
  }

  return chars;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * True when an extraction carries no signal at all — no entities, no storyboard
 * fields, no scene prompts. A REAL chapter never extracts to this (the schema
 * requires at least a summary/keyMoment/keyEvents even when every entity is
 * already known), so it means the model's response didn't parse (truncated or
 * malformed JSON). Callers treat it as a failure so the chapter is retried
 * instead of silently committed with nothing to render from.
 */
export function isEmptyExtraction(raw: RawExtraction): boolean {
  return (
    raw.characters.length === 0 &&
    raw.environments.length === 0 &&
    (raw.creatures?.length ?? 0) === 0 &&
    raw.spoilers.length === 0 &&
    (raw.glossary?.length ?? 0) === 0 &&
    !(raw.summary ?? "").trim() &&
    !(raw.keyMoment ?? "").trim() &&
    (raw.keyEvents?.length ?? 0) === 0
  );
}

/**
 * Strip a reasoning model's chain-of-thought preamble before parsing its answer.
 * Hybrid "thinking" models (e.g. Qwen 3, with thinking on) emit a `<think>…</think>`
 * (or `<thinking>…</thinking>`) block first; left in, it inflates output, breaks the
 * JSON parse, and can leak reasoning into an image prompt. A non-thinking model has no
 * such tags, so this is a no-op for them. Handles a paired block and the truncated
 * case where the opening tag is missing but a stray `</think>` precedes the answer.
 */
export function stripThink(s: string): string {
  return s
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "") // paired reasoning blocks
    .replace(/^[\s\S]*?<\/think(?:ing)?>/i, "") // opener-omitted leading reasoning, up to its close
    .trim();
}
