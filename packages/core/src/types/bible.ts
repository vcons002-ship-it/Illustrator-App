/**
 * The "Visual Bible" — persistent state extracted from the book that keeps
 * generated illustrations consistent (no character drift) across pages.
 *
 * Produced by the LLM pre-pass (see providers/llm) chapter-by-chapter and
 * cached in storage keyed by BookSource.id. Every image prompt is built with
 * the relevant slice of this object injected as context.
 */

/**
 * How a character's appearance is pinned for the image model. v1 uses a fixed
 * seed; `referenceImageId` / `loraRef` are reserved for the richer image tiers
 * (IP-Adapter / LoRA) so the schema does not need to change later.
 */
export interface IdentityAnchor {
  /** Deterministic seed so the same character renders consistently. */
  seed: number;
  /** Reserved: id of a stored reference image for IP-Adapter conditioning. */
  referenceImageId?: string;
  /** Reserved: identifier of a per-character LoRA, when the tier supports it. */
  loraRef?: string;
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  /** Traits that persist across the whole book (build, hair, eyes, scars…). */
  persistentTraits: string[];
  /** Default/most-recent clothing description. */
  clothing: string[];
  anchor: IdentityAnchor;
  /** Index of the chapter where this character is first introduced. */
  firstSeenChapter: number;
}

export interface Environment {
  id: string;
  name: string;
  /** Static descriptive details of a recurring location. */
  description: string[];
  firstSeenChapter: number;
}

/**
 * A reveal that would spoil the narrative if shown too early. The UI keeps any
 * image containing this entity blurred until the reader's scroll depth passes
 * `revealParagraphId` ("Fog of War").
 */
export interface SpoilerEntity {
  id: string;
  label: string;
  /** Paragraph after which it is safe to reveal. */
  revealParagraphId: string;
}

export interface VisualBible {
  bookId: string;
  /** Schema version, so cached Bibles can be migrated. */
  version: number;
  characters: Character[];
  environments: Environment[];
  spoilers: SpoilerEntity[];
  /** Chapters already processed by the extraction pass. */
  processedChapters: number[];
}
