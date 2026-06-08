import type { Character, CharacterAppearance, VisualBible } from "../../types/bible.js";
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
    clothing: string[];
  }[];
  environments: { name: string; description: string[] }[];
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
  "description at all. For each character fill the structured 'appearance' fields " +
  "(hair, eyes, gender, build/physique, height, skinTone, age, distinguishingMarks; use " +
  "an empty string for anything the text doesn't state) and put extra persistent details " +
  "in persistentTraits, plus their clothing/outfits/fashion in detail (garments, fabric, " +
  "colour, accessories, era/style). Capture EVERY named location with a detailed visual " +
  "description (architecture, materials, layout, lighting, palette, mood) AND its world's " +
  "fashion and aesthetic; when a location you already know recurs, ADD any new detail, and " +
  "always refer to it by its established name. " +
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
  "then the setting, then mood/lighting. Depict the most important action of the supplied " +
  "passage, framed by the chapter's key moment. Set the image in ONE coherent location — the " +
  "place where the passage's action occurs; if the chapter or passage moves between places, " +
  "choose the single location of the depicted moment and NEVER combine two settings into one " +
  "picture. Keep every character's appearance and OUTFIT, and the setting's look and fashion, " +
  "consistent with the supplied Visual Bible, and consistent with the story so far. " +
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
          clothing: { type: "array", items: { type: "string" } },
        },
        required: ["name", "aliases", "appearance", "persistentTraits", "clothing"],
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
export function extractionUserContent(input: EntityExtractionInput): string {
  const priorSummaries = [...input.existing.storyboard]
    .filter((s) => s.chapterIndex < input.chapterIndex)
    .sort((a, b) => a.chapterIndex - b.chapterIndex)
    .map((s) => `Chapter ${s.chapterIndex}: ${s.summary}`)
    .join("\n");
  const soFar = priorSummaries ? `Story so far:\n${priorSummaries}\n\n` : "";
  // Feed back the glossary built so far so the model EXTENDS it (adds new world
  // facts) rather than repeating ones already captured.
  const known = (input.existing.glossary ?? [])
    .map((g) => `- ${g.term}: ${g.definition}`)
    .join("\n");
  const glossarySoFar = known ? `Known world facts so far:\n${known}\n\n` : "";
  // Feed back known locations so the model reuses their names and ADDS detail
  // instead of re-introducing a place under a slightly different name.
  const places = input.existing.environments
    .map((e) => `- ${e.name}: ${e.description.join(", ")}`)
    .join("\n");
  const placesSoFar = places ? `Known locations so far:\n${places}\n\n` : "";
  return `${placesSoFar}${glossarySoFar}${soFar}Chapter ${input.chapterIndex} text:\n\n${input.chapterText}`;
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
    spoilers: [...existing.spoilers],
    storyboard: [...(existing.storyboard ?? [])],
    glossary: [...(existing.glossary ?? [])],
    processedChapters: [...existing.processedChapters],
  };
  const knownChars = new Set(bible.characters.map((c) => c.name.toLowerCase()));
  const knownEnvs = new Set(bible.environments.map((e) => e.name.toLowerCase()));
  const knownTerms = new Set(bible.glossary.map((g) => g.term.toLowerCase()));

  for (const c of raw.characters) {
    if (knownChars.has(c.name.toLowerCase())) continue;
    knownChars.add(c.name.toLowerCase());
    const character: Character = {
      id: `char-${slug(c.name)}`,
      name: c.name,
      aliases: c.aliases,
      appearance: { ...emptyAppearance(), ...(c.appearance ?? {}) },
      persistentTraits: c.persistentTraits,
      clothing: c.clothing,
      anchor: { seed: deterministicSeed(c.name) },
      firstSeenChapter: chapterIndex,
    };
    bible.characters.push(character);
  }
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
    scene?.summary ? `This chapter:\n${scene.summary}` : "",
    scene?.keyMoment ? `Key moment to illustrate:\n${scene.keyMoment}` : "",
    settingLine(scene, envs, request.sourceText),
    chars.length
      ? `Characters present (keep appearance + outfit consistent):\n${chars
          .map((c) => `- ${describeCharacter(c)}`)
          .join("\n")}`
      : "",
    envs.length
      ? `Location details (look + world fashion):\n${envs.map((e) => `- ${e.name}: ${e.description.join(", ")}`).join("\n")}`
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
  return `${c.name}: ${appearance}; wearing ${c.clothing.join(", ") || "unspecified"}`;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
