import type { BookSource, Chapter, Page, Paragraph } from "@visual-reader/core";

/** Raw chapter input: a title and its prose, before segmentation. */
export interface RawChapter {
  title: string;
  /** Plain text; paragraphs separated by blank lines. */
  text: string;
  /** Whether this is story prose (vs. front/back matter). Default true. */
  isStory?: boolean;
}

export interface BookMeta {
  id: string;
  title: string;
  author?: string;
}

export interface SegmentOptions {
  /** Approximate words per page — drives the JIT buffer's pacing. Default 250. */
  wordsPerPage?: number;
}

/**
 * Turn raw chapters into the BookSource model the engine consumes: each chapter
 * is split into pages of ~`wordsPerPage` words, and each page into paragraphs.
 * Pure and deterministic, so it's unit-testable and produces stable ids the
 * Visual Bible and caches can key on.
 */
export function segmentBook(
  meta: BookMeta,
  rawChapters: RawChapter[],
  options: SegmentOptions = {},
): BookSource {
  const wordsPerPage = options.wordsPerPage ?? 250;
  const chapters: Chapter[] = [];
  const pages: Page[] = [];
  let pageCounter = 0;

  rawChapters.forEach((raw, chapterIndex) => {
    const chapterId = `ch-${chapterIndex}`;
    chapters.push({
      id: chapterId,
      index: chapterIndex,
      title: raw.title,
      ...(raw.isStory === false ? { isStory: false } : {}),
    });

    const paragraphs = splitParagraphs(raw.text);
    for (const group of groupByWordBudget(paragraphs, wordsPerPage)) {
      const pageId = `pg-${pageCounter}`;
      const pageParas: Paragraph[] = group.map((text, i) => ({
        id: `${pageId}-${i}`,
        index: i,
        text,
      }));
      pages.push({ id: pageId, index: pageCounter, chapterId, paragraphs: pageParas });
      pageCounter++;
    }
  });

  return {
    id: meta.id,
    title: meta.title,
    ...(meta.author !== undefined ? { author: meta.author } : {}),
    chapters,
    pages,
  };
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

/** Greedily pack paragraphs into pages, keeping paragraphs whole. */
function groupByWordBudget(paragraphs: string[], wordsPerPage: number): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  let count = 0;
  for (const para of paragraphs) {
    const words = countWords(para);
    if (current.length > 0 && count + words > wordsPerPage) {
      pages.push(current);
      current = [];
      count = 0;
    }
    current.push(para);
    count += words;
  }
  if (current.length > 0) pages.push(current);
  return pages.length > 0 ? pages : [[""]];
}

function countWords(s: string): number {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}
