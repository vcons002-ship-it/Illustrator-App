import type { Character, Environment, VisualBible } from "../../types/bible.js";
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
}

export const EXTRACTION_SYSTEM =
  "You are building a 'Visual Bible' for illustrating a novel. Extract only " +
  "entities that recur or are visually significant. For characters, capture " +
  "traits that persist across the book (build, hair, eyes, distinguishing marks) " +
  "and current clothing. For spoilers, flag reveals that would spoil the plot if " +
  "shown in an illustration before the reader reaches them.";

export const PROMPT_SYSTEM =
  "You write vivid, concrete image-generation prompts for a single illustration " +
  "of the given book passage. Keep character and setting descriptions consistent " +
  "with the supplied Visual Bible. Output only the prompt text, no preamble.";

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
  },
  required: ["characters", "environments", "spoilers"],
} as const;

/** The user message text for one chapter's extraction. */
export function extractionUserContent(chapterIndex: number, chapterText: string): string {
  return `Chapter ${chapterIndex} text:\n\n${chapterText}`;
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

  if (!bible.processedChapters.includes(chapterIndex)) {
    bible.processedChapters.push(chapterIndex);
  }
  return bible;
}

/** The user message text for building one page's image prompt. */
export function promptUserContent(request: VisualRequest, bible: VisualBible): string {
  const chars = bible.characters.filter((c) => request.characterIds.includes(c.id));
  const envs = bible.environments.filter((e) => request.environmentIds.includes(e.id));
  return [
    chars.length
      ? `Characters present:\n${chars
          .map(
            (c) =>
              `- ${c.name}: ${c.persistentTraits.join(", ")}; wearing ${c.clothing.join(", ") || "unspecified"}`,
          )
          .join("\n")}`
      : "",
    envs.length
      ? `Setting:\n${envs.map((e) => `- ${e.name}: ${e.description.join(", ")}`).join("\n")}`
      : "",
    `Passage:\n${request.sourceText}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
