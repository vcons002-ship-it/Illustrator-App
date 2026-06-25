/**
 * Source text model. A book is parsed into chapters → pages → paragraphs.
 * The paragraph is the atomic unit the Gaze-Sync UI tracks and the unit a
 * "spoiler entity" is anchored to.
 */
import type { DataTable } from "../data/data-table.js";
import type { JsonValue } from "../data/json-shape.js";

/**
 * What kind of writing a book is, chosen at import — it selects the analysis + illustration path.
 * "fiction" illustrates story scenes; "technical" (papers, non-fiction) and "code" (source files)
 * are the FACTUAL modes (see `isNonFiction`) that use the concept/diagram path instead, with code
 * getting its own extraction prompt + reader view.
 */
export type ContentMode = "fiction" | "technical" | "code";

/** The factual modes (technical + code) — they share the non-story analysis, chat, and UI gates. */
export function isNonFiction(mode?: ContentMode): boolean {
  return mode === "technical" || mode === "code";
}

export interface Paragraph {
  /** Stable id, unique within the book. */
  id: string;
  /** Zero-based index of this paragraph within its page. */
  index: number;
  text: string;
  /** Sanitized HTML for the optional "original layout" view (web articles). Absent → render text. */
  html?: string;
}

export interface Page {
  /** Stable id, unique within the book. */
  id: string;
  /** Zero-based index across the whole book (used by the JIT buffer window). */
  index: number;
  chapterId: string;
  paragraphs: Paragraph[];
  /**
   * Inclusive [start, end] ORIGINAL page indices this entry covers. Set on render
   * units (a unit groups several source pages) so a stored keyEvent prompt can be
   * matched to it by page-range overlap. Absent on raw source pages.
   */
  pageRange?: [number, number];
}

export interface Chapter {
  id: string;
  index: number;
  title: string;
  /**
   * Whether this chapter is story prose (vs. front/back matter such as the title
   * page, copyright, table of contents, dedication, index…). `undefined` is
   * treated as `true`. Non-story chapters are not analysed or illustrated.
   */
  isStory?: boolean;
}

export interface BookSource {
  /** Stable id derived from the EPUB (used to key the Visual Bible + caches). */
  id: string;
  title: string;
  author?: string;
  chapters: Chapter[];
  pages: Page[];
  /** What kind of writing this is, chosen at import (default "fiction"). See `ContentMode`. */
  contentMode?: ContentMode;
  /**
   * Marks a book co-written live with the chat buddy ("story as you go") rather than
   * imported. A story grows one beat at a time (`Engine.appendChapter`), reads as
   * continuous prose, and keeps the buddy chat mounted BESIDE the reader so the next
   * beat can be written. Absent for ordinary imported/created books.
   */
  kind?: "story";
  /**
   * Story "as you go" session settings, persisted WITH the book so a reopen resumes the
   * role-play contract + image cadence (the cast/looks themselves rebuild from the Visual
   * Bible). Absent for non-story books.
   */
  storyConfig?: {
    /** The played characters (e.g. a "me and you" pair) — assumed present each beat. */
    roleplay?: { playedCharacterNames: string[] };
    /** The story workflow: "roleplay" (reader steers a character) or "direct" (reader directs). */
    mode?: "direct" | "roleplay";
    /** Roleplay only: the played character NAMES (me = reader, you = assistant) for narration labels. */
    play?: { me?: string; you?: string };
    /** How often a beat auto-illustrates. */
    cadence?: { mode: "per-response" | "every-n" | "manual"; n: number };
    /**
     * Per-beat active-scene SNAPSHOTS (index = beat/chapter): the exact tracked present cast
     * + location at each beat, so a reopen resumes the precise scene AND re-illustrating a
     * past beat (render_scene) uses that beat's cast/setting — not a re-derivation. (Inlined
     * to avoid importing the StoryScene type into the book model.)
     */
    scenes?: { presentCharacterIds: string[]; locationId?: string }[];
  };
  /** For a `code` book: the source language (e.g. "ts", "python"), for the reader's code view. */
  language?: string;
  /** For a `code` book: the EXACT source text. This is what the full-screen code editor edits and
   * what `run_command` runs (kept byte-accurate, unlike the segmented `pages` reading view, which is
   * derived from it). Absent on legacy code books — reconstruct from `pages` when missing. */
  code?: string;
  /** Structured grid for a spreadsheet/CSV import — powers the chat's `analyze_data`
   * tool (group-by / pivots / aggregates over real cells). Absent for prose. For a
   * multi-sheet workbook this is the FIRST sheet (`dataSheets` holds them all). */
  data?: DataTable;
  /** Every worksheet of a multi-sheet `.xlsx` (tab name + table), in workbook order.
   * Present only when an import yielded more than one tabular sheet; `data` aliases
   * the first. Lets the reader view/download any sheet and re-export the workbook. */
  dataSheets?: { name: string; table: DataTable }[];
  /** Parsed value for a NESTED/irregular JSON import (one that doesn't normalise to a
   * table) — the reader shows it as a collapsible tree. Absent otherwise. */
  tree?: JsonValue;
}
