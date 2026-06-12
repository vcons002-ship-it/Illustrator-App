import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";

/**
 * LLM provider interface. Two responsibilities:
 *  1. `extractEntities` — the Visual Bible pre-pass (characters, traits,
 *     clothing, environments, spoilers) for a chapter's text.
 *  2. `buildImagePrompt` — turn a page + relevant Bible slice into a concrete
 *     image-generation prompt with continuity context injected.
 *
 * Implementations: ClaudeProvider (default cloud), plus Gemini/OpenAI/WebLLM
 * stubs. All are interchangeable behind this interface.
 */

export interface EntityExtractionInput {
  bookId: string;
  chapterIndex: number;
  /** Full text of the chapter being processed. */
  chapterText: string;
  /** Existing Bible to merge into (entities may span chapters). */
  existing: VisualBible;
  /**
   * The chapter's render-unit page ranges, in reading order. Lets extraction ALSO emit
   * one Layer-1 scene prompt per illustration (folded in — no extra LLM call); the merge
   * maps `keyEvents[i]` onto `unitRanges[i]`. `sceneCount` is `unitRanges.length`.
   */
  unitRanges?: [number, number][];
  sceneCount?: number;
  /**
   * The book's content mode: "technical" routes extraction through the Visual-Atlas
   * system prompt (structures/data/visualization plan) instead of the fiction Visual
   * Bible (characters/outfits/scenes). Absent = fiction.
   */
  contentMode?: "fiction" | "technical";
  /**
   * Provider-agnostic grounding (technical books): web-search reference snippets for this
   * chapter's topic, injected into the prompt so ANY reader — local LLM included — grounds
   * its definitions/quantities in real sources. The Gemini in-call `google_search` tool is
   * the alternative path (used when Gemini is the reader); only one is ever set.
   */
  groundingContext?: string;
  /** Mature mode: describe explicit/adult content faithfully (see TierConfig.allowMature). */
  allowMature?: boolean;
  /** Aborts the in-flight extraction (e.g. when the user pauses the bible build). */
  signal?: AbortSignal;
}

export interface LLMProvider {
  /** Stable provider key, e.g. "claude". */
  readonly id: string;
  /**
   * Extract/merge entities for one chapter, returning the updated Bible.
   * Must be idempotent per chapter so re-runs do not duplicate entities.
   */
  extractEntities(input: EntityExtractionInput): Promise<VisualBible>;
  /**
   * Build the final image prompt for a page, injecting Bible continuity.
   * `signal` aborts the in-flight call (e.g. when the user pauses image generation).
   */
  buildImagePrompt(request: VisualRequest, bible: VisualBible, signal?: AbortSignal): Promise<string>;
}
