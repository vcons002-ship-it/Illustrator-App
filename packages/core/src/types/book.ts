/**
 * Source text model. A book is parsed into chapters → pages → paragraphs.
 * The paragraph is the atomic unit the Gaze-Sync UI tracks and the unit a
 * "spoiler entity" is anchored to.
 */
import type { DataTable } from "../data/data-table.js";
import type { JsonValue } from "../data/json-shape.js";

export interface Paragraph {
  /** Stable id, unique within the book. */
  id: string;
  /** Zero-based index of this paragraph within its page. */
  index: number;
  text: string;
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
  /**
   * What kind of writing this is, chosen at import. "fiction" (default) illustrates
   * story scenes; "technical" (papers, textbooks, non-fiction) uses the concept/
   * diagram prompt template instead. Experimental.
   */
  contentMode?: "fiction" | "technical";
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
