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

/**
 * A character's physical appearance broken into easy-to-read, individually
 * editable fields. The LLM fills these in; the user can correct any of them in
 * the Character Bible UI. Every field is a plain string ("" when unknown) so the
 * strict provider schemas (OpenAI/Gemini) can mark them all required.
 */
export interface CharacterAppearance {
  hair: string;
  eyes: string;
  gender: string;
  /** Physique/body type, e.g. "slender, athletic". */
  build: string;
  height: string;
  skinTone: string;
  age: string;
  /** Scars, tattoos, marks, or other distinguishing features. */
  distinguishingMarks: string;
  /** Free-text extras that don't fit the structured fields. */
  notes: string;
}

/** A character appearance with no known details (all fields blank). */
export function emptyAppearance(): CharacterAppearance {
  return {
    hair: "",
    eyes: "",
    gender: "",
    build: "",
    height: "",
    skinTone: "",
    age: "",
    distinguishingMarks: "",
    notes: "",
  };
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  /** Structured, user-editable physical appearance. */
  appearance: CharacterAppearance;
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
  /**
   * @deprecated Unused by the current reveal model. Reveal timing is derived from
   * where the spoiler's `label` appears on the page (see `visual-bible/reveal.ts`),
   * not from a precomputed paragraph id. Retained for back-compat with cached
   * Bibles; safe to ignore.
   */
  revealParagraphId: string;
}

/**
 * One chapter's entry in the whole-book storyboard: what happens and the single
 * most important visual moment to illustrate. Built as the LLM reads the book
 * (each entry is informed by the "story so far"), then used to drive the image
 * prompt so illustrations capture the chapter's key action.
 */
export interface ChapterScene {
  chapterIndex: number;
  /** What occurs in this chapter (a few sentences). */
  summary: string;
  /** The single most important action/moment to depict in an illustration. */
  keyMoment: string;
  /** Where the chapter (and its key moment) takes place, by environment name. */
  location: string;
  /** "" if the chapter stays in one place, else a note of where/when it shifts. */
  locationChange: string;
}

/**
 * A recurring world fact / defining context the illustrator should assume by
 * default — e.g. term "dragon riders", definition "wear fitted black flight
 * leathers with buckled straps". Injected into every image prompt unless the
 * passage explicitly contradicts it, keeping the world visually consistent.
 */
export interface GlossaryEntry {
  term: string;
  definition: string;
}

export interface VisualBible {
  bookId: string;
  /** Schema version, so cached Bibles can be migrated. */
  version: number;
  characters: Character[];
  environments: Environment[];
  spoilers: SpoilerEntity[];
  /** Per-chapter storyboard (events + key moment), keyed by chapterIndex. */
  storyboard: ChapterScene[];
  /** Recurring world facts applied as defaults in every image prompt. */
  glossary: GlossaryEntry[];
  /** Chapters already processed by the extraction pass. */
  processedChapters: number[];
}
