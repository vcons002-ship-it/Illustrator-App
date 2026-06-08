import type { Character, Environment, VisualBible } from "../../types/bible.js";
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
  characters: { name: string; aliases: string[]; persistentTraits: string[]; clothing: string[] }[];
  environments: { name: string; description: string[] }[];
  spoilers: { label: string; revealHint: string }[];
  /** What occurs in this chapter (the storyboard summary). Optional for back-compat. */
  summary?: string;
  /** The single most important action/moment to illustrate this chapter. */
  keyMoment?: string;
}

export const EXTRACTION_SYSTEM =
  "You are building a 'Visual Bible' and storyboard for illustrating a novel as you " +
  "read it chapter by chapter. Extract only entities that recur or are visually " +
  "significant. For each character capture traits that persist across the book " +
  "(build, hair, eyes, distinguishing marks) and — importantly — their clothing, " +
  "outfits, and fashion in detail (garments, fabric, colour, accessories, era/style). " +
  "For each environment/location capture its look AND its world's fashion and aesthetic " +
  "(architecture, era, materials, palette) in the description. Flag spoilers that would " +
  "spoil the plot if shown before the reader reaches them. Also write a 'summary' of " +
  "what happens in THIS chapter, and a single 'keyMoment': the most important, most " +
  "visual action of the chapter to illustrate (one concrete sentence).";

export const PROMPT_SYSTEM =
  "You write one vivid, concrete image-generation prompt for a single illustration of a " +
  "book chapter. Depict the chapter's single most important action (the 'key moment'). " +
  "Keep every character's appearance and OUTFIT, and the setting's look and fashion, " +
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
          persistentTraits: { type: "array", items: { type: "string" } },
          clothing: { type: "array", items: { type: "string" } },
        },
        required: ["name", "aliases", "persistentTraits", "clothing"],
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
  },
  required: ["characters", "environments", "spoilers", "summary", "keyMoment"],
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
  return `${soFar}Chapter ${input.chapterIndex} text:\n\n${input.chapterText}`;
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
    processedChapters: [...existing.processedChapters],
  };
  const knownChars = new Set(bible.characters.map((c) => c.name.toLowerCase()));
  const knownEnvs = new Set(bible.environments.map((e) => e.name.toLowerCase()));

  for (const c of raw.characters) {
    if (knownChars.has(c.name.toLowerCase())) continue;
    knownChars.add(c.name.toLowerCase());
    const character: Character = {
      id: `char-${slug(c.name)}`,
      name: c.name,
      aliases: c.aliases,
      persistentTraits: c.persistentTraits,
      clothing: c.clothing,
      anchor: { seed: deterministicSeed(c.name) },
      firstSeenChapter: chapterIndex,
    };
    bible.characters.push(character);
  }
  for (const e of raw.environments) {
    if (knownEnvs.has(e.name.toLowerCase())) continue;
    knownEnvs.add(e.name.toLowerCase());
    const env: Environment = {
      id: `env-${slug(e.name)}`,
      name: e.name,
      description: e.description,
      firstSeenChapter: chapterIndex,
    };
    bible.environments.push(env);
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
  if (raw.summary || raw.keyMoment) {
    const scene = {
      chapterIndex,
      summary: raw.summary ?? "",
      keyMoment: raw.keyMoment ?? "",
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
  return [
    soFar ? `Story so far:\n${soFar}` : "",
    scene?.summary ? `This chapter:\n${scene.summary}` : "",
    scene?.keyMoment ? `Key moment to illustrate:\n${scene.keyMoment}` : "",
    chars.length
      ? `Characters present (keep appearance + outfit consistent):\n${chars
          .map(
            (c) =>
              `- ${c.name}: ${c.persistentTraits.join(", ")}; wearing ${c.clothing.join(", ") || "unspecified"}`,
          )
          .join("\n")}`
      : "",
    envs.length
      ? `Setting (look + world fashion):\n${envs.map((e) => `- ${e.name}: ${e.description.join(", ")}`).join("\n")}`
      : "",
    `Passage:\n${request.sourceText}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
