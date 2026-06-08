import type { Character, CharacterAppearance, Creature, Outfit, VisualBible } from "../../types/bible.js";
import { emptyAppearance } from "../../types/bible.js";
import type { EntityExtractionInput } from "./llm-provider.js";
import type { VisualRequest } from "../../types/content.js";
import { deterministicSeed } from "./mock-llm-provider.js";

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
    /** Context-tagged outfits the character is described wearing. */
    outfits?: { label: string; description: string; context: string }[];
  }[];
  environments: { name: string; description: string[] }[];
  /** Named/notable non-human creatures (dragons, beasts…). Optional for back-compat. */
  creatures?: { name: string; aliases: string[]; kind: string; description: string[] }[];
  spoilers: { label: string; revealHint: string }[];
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
}

export const EXTRACTION_SYSTEM =
  "You are building a 'Visual Bible' and storyboard for illustrating a novel as you " +
  "read it chapter by chapter. Capture EVERY named character who is given any physical " +
  "or appearance description in this chapter — including minor and one-off characters. " +
  "Do NOT limit yourself to the main cast; only skip bare name-drops that carry no " +
  "description at all. A capitalized word used as a person's NAME or nickname is a character " +
  "(a human), even when it is also a common noun or animal word — e.g. a person called 'Cat', " +
  "'Hawk', 'Wren', or 'Fox' is a human character, NOT an animal. For each character fill the structured 'appearance' fields " +
  "(hair, eyes, gender, build/physique, height, skinTone, age, distinguishingMarks; use " +
  "an empty string for anything the text doesn't state) and put extra persistent details " +
  "in persistentTraits. Capture each DISTINCT outfit a character is described wearing as a " +
  "separate entry in 'outfits' — a short 'label', a detailed 'description' (garments, fabric, " +
  "colour, accessories, era/style), and 'context' = when they wear it (e.g. label 'flight " +
  "leathers', context 'flying, battle'; label 'court gown', context 'formal events'). Add new " +
  "outfits as they appear across chapters; do NOT merge different outfits into one. " +
  "Reuse a character's ESTABLISHED name across chapters: if " +
  "the same person is referred to by a first name, full name, title, or nickname, keep ONE " +
  "entry and put the other forms in 'aliases' — never create a second character for the same " +
  "person (e.g. 'Violet' and 'Violet Sorrengail' are one character). " +
  "Capture EVERY named location with a detailed visual " +
  "description (architecture, materials, layout, lighting, palette, mood) AND its world's " +
  "fashion and aesthetic; when a location you already know recurs, ADD any new detail, and " +
  "always refer to it by its established name. " +
  "Capture notable non-human 'creatures' — dragons, beasts, monsters, mounts — separately " +
  "from human characters (do NOT put them in 'characters'). For each give its name (or a " +
  "descriptive label if unnamed, e.g. 'the black dragon'), any aliases, its 'kind' (dragon, " +
  "griffin…), and a detailed visual 'description' (size, colour, scales/fur, wings, horns, " +
  "eyes, distinguishing marks). When a creature you already know recurs, ADD new detail and " +
  "reuse its established name (e.g. 'Tairn' is a massive midnight-black dragon). NEVER create a " +
  "creature from a person's name or nickname — only from a LITERAL animal/beast in the text (a " +
  "character nicknamed 'Cat' is a person, not an animal). " +
  "Build a 'glossary' of recurring world facts / defining context that should be assumed " +
  "by default unless a passage says otherwise — e.g. customary attire ('dragon riders wear " +
  "fitted black flight leathers'), technology level, materials, or social norms; each entry " +
  "is a short term and its definition. Flag spoilers that would spoil the plot if shown " +
  "before the reader reaches them. Also write a 'summary' of what happens in THIS chapter, " +
  "and a single 'keyMoment': the most important, most visual action of the chapter to " +
  "illustrate (one concrete sentence). Determine WHERE the chapter takes place: set " +
  "'location' to the primary setting (use the established environment name), and keep the " +
  "keyMoment's place explicit. If the setting moves during the chapter, set 'locationChange' " +
  "to a short note of where/when it shifts (otherwise an empty string).";

export const PROMPT_SYSTEM =
  "You write one vivid, concrete image-generation prompt for a single illustration of a " +
  "book chapter. Write it as a single paragraph of natural, descriptive language (NOT a " +
  "list of tags, no weighting syntax, no markdown) — lead with the subject and action, " +
  "then the setting, then mood/lighting. Depict the single most important action shown in " +
  "THIS passage specifically — each illustration covers a different stretch of the chapter, " +
  "so describe what happens in THIS passage and do NOT just repeat the chapter's overall key " +
  "moment unless this passage is where it occurs. Set the image in ONE coherent location — the " +
  "place where the passage's action occurs; if the chapter or passage moves between places, " +
  "choose the single location of the depicted moment and NEVER combine two settings into one " +
  "picture. Keep every character's appearance consistent with the supplied Visual Bible and " +
  "the story so far. The listed characters are PEOPLE — depict them as humans; NEVER render a " +
  "character as an animal even if their name is also a common word (a person named 'Cat' is a " +
  "woman, not a cat). For each character, choose the SINGLE outfit from their listed options " +
  "that best fits THIS scene's context (what the passage describes them doing/wearing); depict " +
  "only that outfit and never combine outfits. For action scenes, convey dynamic movement — a " +
  "dynamic pose, motion, energy, a sense of speed or impact. " +
  "Output only the prompt text, no preamble.";

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
                context: { type: "string" },
              },
              required: ["label", "description", "context"],
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
          revealHint: { type: "string" },
        },
        required: ["label", "revealHint"],
      },
    },
    summary: { type: "string" },
    keyMoment: { type: "string" },
    location: { type: "string" },
    locationChange: { type: "string" },
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
    ? `Known characters so far (reuse these exact names; record other forms as aliases; do NOT add a second entry for the same person):\n${cast}\n\n`
    : "";
  // Glossary terms only — definitions are already stored; we just need the model to
  // reuse the term and not re-add it.
  const known = cap(input.existing.glossary ?? [], MAX_CONTEXT_ENTRIES, (g) => `- ${g.term}`);
  const glossarySoFar = known ? `Known world facts so far (terms — extend, don't repeat):\n${known}\n\n` : "";
  // Known location NAMES so the model reuses them and adds detail instead of
  // re-introducing a place under a slightly different name.
  const places = cap(input.existing.environments, MAX_CONTEXT_ENTRIES, (e) => `- ${e.name}`);
  const placesSoFar = places ? `Known locations so far (names):\n${places}\n\n` : "";
  // Known creature NAMES (+ kind) so a recurring beast keeps one name.
  const beasts = cap(input.existing.creatures ?? [], MAX_CONTEXT_ENTRIES, (c) => `- ${c.name} (${c.kind})`);
  const beastsSoFar = beasts ? `Known creatures so far (names):\n${beasts}\n\n` : "";
  return `${castSoFar}${beastsSoFar}${placesSoFar}${glossarySoFar}${soFar}Chapter ${input.chapterIndex} text:\n\n${input.chapterText}`;
}

/**
 * Merge a raw extraction into the existing Bible, deduplicating by (lowercased)
 * name and assigning each new character a deterministic identity seed. Idempotent
 * per chapter, so re-running a chapter never duplicates entities.
 */
export function mergeExtraction(
  existing: VisualBible,
  raw: RawExtraction,
  chapterIndex: number,
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
      // The pipeline resolves the hint to a concrete paragraph id later.
      revealParagraphId: s.revealHint,
    });
  }

  // Upsert this chapter's storyboard scene (idempotent re-run replaces it).
  if (raw.summary || raw.keyMoment || raw.location) {
    const scene = {
      chapterIndex,
      summary: raw.summary ?? "",
      keyMoment: raw.keyMoment ?? "",
      location: raw.location ?? "",
      locationChange: raw.locationChange ?? "",
    };
    const at = bible.storyboard.findIndex((s) => s.chapterIndex === chapterIndex);
    if (at >= 0) bible.storyboard[at] = scene;
    else bible.storyboard.push(scene);
    bible.storyboard.sort((a, b) => a.chapterIndex - b.chapterIndex);
  }

  if (!bible.processedChapters.includes(chapterIndex)) {
    bible.processedChapters.push(chapterIndex);
  }
  return bible;
}

/** The user message text for building one unit's image prompt. */
export function promptUserContent(request: VisualRequest, bible: VisualBible): string {
  const chars = bible.characters.filter((c) => request.characterIds.includes(c.id));
  const envs = bible.environments.filter((e) => request.environmentIds.includes(e.id));
  const creatures = (bible.creatures ?? []).filter((c) => request.creatureIds.includes(c.id));
  const storyboard = bible.storyboard ?? [];
  const scene = storyboard.find((s) => s.chapterIndex === request.chapterIndex);
  const soFar = storyboard
    .filter((s) => s.chapterIndex < request.chapterIndex)
    .map((s) => `Chapter ${s.chapterIndex}: ${s.summary}`)
    .join("\n");
  const glossary = bible.glossary ?? [];
  return [
    glossary.length
      ? `World facts (apply as defaults unless the passage says otherwise):\n${glossary
          .map((g) => `- ${g.term}: ${g.definition}`)
          .join("\n")}`
      : "",
    soFar ? `Story so far:\n${soFar}` : "",
    scene?.summary ? `This chapter (context):\n${scene.summary}` : "",
    scene?.keyMoment ? `Chapter's overall pivotal moment (context only):\n${scene.keyMoment}` : "",
    settingLine(scene, envs, request.sourceText),
    `Illustrate this specific passage's main action (not necessarily the chapter's pivotal moment).`,
    chars.length
      ? `Characters present (these are PEOPLE — render as humans, even if a name is also a common word like 'Cat'; keep appearance consistent and pick one fitting outfit):\n${chars
          .map((c) => `- ${describeCharacter(c)}`)
          .join("\n")}`
      : "",
    creatures.length
      ? `Creatures present (keep look consistent):\n${creatures
          .map((c) => `- ${c.name} (${c.kind || "creature"}): ${c.description.join(", ") || "as previously established"}`)
          .join("\n")}`
      : "",
    envs.length
      ? `Location details (look + world fashion):\n${envs.map((e) => `- ${e.name}: ${e.description.join(", ")}`).join("\n")}`
      : "",
    request.chapterContext
      ? `Chapter context (surrounding text — for continuity; illustrate the Passage below):\n${request.chapterContext}`
      : "",
    `Passage:\n${request.sourceText}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The single location this image must commit to. Prefers a known environment that
 * the passage actually names (so a unit that has moved on uses ITS place, not the
 * chapter's opening place); otherwise falls back to the chapter scene's primary
 * `location`. `locationChange` is passed as context so the writer knows the
 * chapter moves and must still pick ONE setting.
 */
function settingLine(
  scene: { location?: string; locationChange?: string } | undefined,
  envs: { name: string }[],
  sourceText: string,
): string {
  const haystack = sourceText.toLowerCase();
  const named = envs.find((e) => e.name && haystack.includes(e.name.toLowerCase()));
  const place = named?.name || scene?.location || "";
  if (!place) return "";
  const change = scene?.locationChange ? ` (note: the chapter moves — ${scene.locationChange})` : "";
  return `Setting for this image (use this ONE location, do not blend places): ${place}${change}`;
}

/** One-line character description for an image prompt, preferring the structured
 * appearance fields and falling back to free-form persistentTraits. */
function describeCharacter(c: Character): string {
  const a = c.appearance;
  const fields: string[] = [];
  if (a) {
    const labelled: Array<[string, string]> = [
      ["gender", a.gender],
      ["age", a.age],
      ["hair", a.hair],
      ["eyes", a.eyes],
      ["build", a.build],
      ["height", a.height],
      ["skin", a.skinTone],
      ["marks", a.distinguishingMarks],
    ];
    for (const [label, value] of labelled) {
      if (value && value.trim()) fields.push(`${label}: ${value.trim()}`);
    }
    if (a.notes && a.notes.trim()) fields.push(a.notes.trim());
  }
  // Fold in any extra persistent traits the structured fields didn't capture.
  for (const t of c.persistentTraits) {
    if (t && t.trim()) fields.push(t.trim());
  }
  const appearance = fields.length ? fields.join("; ") : "appearance unspecified";
  const outfits = c.outfits ?? [];
  const outfitText = outfits.length
    ? `; outfits to choose from (pick the ONE that fits this scene, don't combine): ${outfits
        .map((o) => `[${o.label}${o.context ? ` — for ${o.context}` : ""}: ${o.description}]`)
        .join(" ")}`
    : `; wearing ${c.clothing.join(", ") || "unspecified"}`;
  return `${c.name}: ${appearance}${outfitText}`;
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

/** Distinct outfits by (lowercased) label, order preserved, blanks dropped. */
function dedupeOutfits(list: Outfit[]): Outfit[] {
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
function unionOutfits(a: Outfit[] | undefined, b: Outfit[] | undefined): Outfit[] {
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
    outfits: unionOutfits(ex.outfits, (raw.outfits ?? []) as Outfit[]),
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
function keysIntersect(a: Character, b: Character): boolean {
  const kb = charKeys(b);
  for (const k of charKeys(a)) if (kb.has(k)) return true;
  return false;
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
 * Collapse duplicate characters: (1) any whose name/alias sets overlap are the
 * same person; (2) a partial name is merged into its UNIQUE fuller name
 * ("Violet" → "Violet Sorrengail"). Ambiguous partials (a bare "Anne" when both
 * "Anne Boleyn" and "Anne Frank" exist) are left alone. Idempotent.
 */
export function consolidateCharacters(list: Character[]): Character[] {
  let chars = [...list];

  // Pass 1 — overlapping name/alias sets (definitely the same person).
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < chars.length && !again; i++) {
      for (let j = i + 1; j < chars.length; j++) {
        if (keysIntersect(chars[i]!, chars[j]!)) {
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
