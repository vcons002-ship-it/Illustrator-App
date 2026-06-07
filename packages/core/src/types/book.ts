/**
 * Source text model. A book is parsed into chapters → pages → paragraphs.
 * The paragraph is the atomic unit the Gaze-Sync UI tracks and the unit a
 * "spoiler entity" is anchored to.
 */

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
}

export interface Chapter {
  id: string;
  index: number;
  title: string;
}

export interface BookSource {
  /** Stable id derived from the EPUB (used to key the Visual Bible + caches). */
  id: string;
  title: string;
  author?: string;
  chapters: Chapter[];
  pages: Page[];
}
