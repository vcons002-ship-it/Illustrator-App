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
