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

/**
 * One context-tagged outfit a character is known to wear. The image-prompt builder
 * picks the single outfit that fits the current scene rather than mashing them
 * all together — e.g. "flight leathers" for flying/battle vs. a "court gown" for
 * formal scenes.
 */
export interface Outfit {
  /** Short label, e.g. "flight leathers". */
  label: string;
  /** Detailed look: garments, fabric, colour, accessories. */
  description: string;
  /** When the character wears it (context cue), e.g. "flying, battle"; "" if general. */
  context: string;
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  /** Structured, user-editable physical appearance. */
  appearance: CharacterAppearance;
  /** Traits that persist across the whole book (build, hair, eyes, scars…). */
  persistentTraits: string[];
  /** @deprecated Legacy single clothing list; kept for back-compat + as a fallback
   * when `outfits` is empty. New extractions populate `outfits` instead. */
  clothing: string[];
  /** Context-tagged outfits the prompt builder picks from per scene. */
  outfits?: Outfit[];
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
 * A named or notable non-human creature/beast (dragon, griffin, direwolf…). Kept
 * separate from `Character` (which is people, with structured human appearance):
 * a creature is matched by name/kind in the page text and its accumulated
 * description is injected so a recurring beast renders consistently. E.g.
 * "Tairn" / kind "dragon" / description "massive, midnight black, …".
 */
export interface Creature {
  id: string;
  name: string;
  aliases: string[];
  /** Species/kind, e.g. "dragon", "griffin". */
  kind: string;
  /** Visual description (size, colour, features), accumulated across the book. */
  description: string[];
  /** Deterministic seed so a recurring creature renders consistently. */
  anchor: IdentityAnchor;
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
/**
 * Layer-1 image prompt for one scene: clean natural language (no model syntax). An
 * external AI fills the five structured fields; the app's own precompute fills `text`
 * with a ready paragraph. The pipeline flattens either into the base prompt, then
 * applies Layer-2 model formatting (quality tags + identity emphasis + IP-Adapter).
 */
export interface ScenePrompt {
  /** Who/what is the focus. */
  subject?: string;
  /** What they are doing. */
  action?: string;
  /** Where/how it looks. */
  environment?: string;
  /** Emotional/atmospheric tone. */
  mood?: string;
  /** Camera angle, framing, depth of field. */
  composition?: string;
  /** A pre-composed natural-language prompt (the app's own precompute path). */
  text?: string;
}

/**
 * A precomputed/imported illustration prompt covering an inclusive range of ORIGINAL
 * book pages, so it can be matched to a render unit regardless of the page-grouping.
 */
export interface KeyEvent {
  /** Inclusive [start, end] original page indices this prompt covers. */
  pageRange: [number, number];
  /** Layer-1 scene prompt. */
  imagePrompt: ScenePrompt;
  /** Optional stable render seed for reproducibility. */
  seed?: number;
}

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
  /**
   * Precomputed/imported Layer-1 prompts for this chapter's page ranges. When a unit
   * resolves to one, the pipeline renders from it WITHOUT calling the LLM (stored-first,
   * LLM fallback). Optional/absent for chapters not yet prompt-built.
   */
  keyEvents?: KeyEvent[];
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
  /** Named/notable non-human creatures (dragons, beasts…), kept consistent. */
  creatures: Creature[];
  spoilers: SpoilerEntity[];
  /** Per-chapter storyboard (events + key moment), keyed by chapterIndex. */
  storyboard: ChapterScene[];
  /** Recurring world facts applied as defaults in every image prompt. */
  glossary: GlossaryEntry[];
  /**
   * One concise genre/art-style line for the whole book (e.g. "high-fantasy military
   * academy, dark, painterly"), auto-derived during analysis and applied to EVERY image
   * prompt so a scene with no stated clothing/setting still renders in-genre. "" until
   * derived. Refined across chapters (keep the most specific).
   */
  worldStyle?: string;
  /** Chapters already processed by the extraction pass. */
  processedChapters: number[];
}
