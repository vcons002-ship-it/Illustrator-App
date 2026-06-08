import type { BookSource } from "./types/book.js";
import type { VisualBible } from "./types/bible.js";
import type { ImageResult } from "./types/content.js";
import type { TierConfig } from "./types/tier.js";
import { DEFAULT_TIER_CONFIG } from "./types/tier.js";
import type { LLMProvider } from "./providers/llm/llm-provider.js";
import type { ImageProvider } from "./providers/image/image-provider.js";
import type { VisualReaderStore } from "./storage/store.js";
import { InMemoryStore } from "./storage/store.js";
import { RenderPipeline } from "./pipeline/pipeline.js";
import { RenderBuffer } from "./render-buffer/render-buffer.js";
import { createEmptyBible } from "./visual-bible/bible.js";

/**
 * Top-level engine — the single object a front-end constructs. It owns the
 * Visual Bible lifecycle, the render pipeline, and the JIT buffer, exposing a
 * tiny surface: open a book, move the reader, read results. All generation
 * logic lives here so `apps/*` are pure platform glue.
 */
export interface EngineOptions {
  llm: LLMProvider;
  image: ImageProvider;
  store?: VisualReaderStore;
  tier?: TierConfig;
  /** Forwarded to the buffer — fired whenever a page's render status changes. */
  onUpdate?: (pageIndex: number, result: ImageResult) => void;
  /**
   * Fired during Visual Bible extraction as each chapter is processed
   * (`done` of `total` chapters). `total` is the count of chapters not already
   * cached, so a fully-cached re-open reports `(0, 0)`.
   */
  onBibleProgress?: (done: number, total: number) => void;
  /**
   * Fired with the latest Visual Bible whenever it grows (initial state, then
   * after each chapter). The bible is built incrementally in the background, so
   * the UI uses this to keep character/spoiler context current as it fills in.
   */
  onBibleUpdate?: (bible: VisualBible) => void;
}

export class Engine {
  private readonly store: VisualReaderStore;
  private readonly tier: TierConfig;
  private book?: BookSource;
  private bible?: VisualBible;
  private pipeline?: RenderPipeline;
  private buffer?: RenderBuffer;
  /** The background bible-extraction run for the current book (awaitable in tests). */
  private biblePromise?: Promise<void>;

  constructor(private opts: EngineOptions) {
    this.store = opts.store ?? new InMemoryStore();
    this.tier = opts.tier ?? DEFAULT_TIER_CONFIG;
  }

  /**
   * Load a book and start rendering immediately. The Visual Bible is built
   * incrementally in the *background* (chapter by chapter, cached), and each page
   * is rendered as soon as its chapter's entities exist — so the first
   * illustration appears after the first chapter instead of after the whole book.
   *
   * Returns once the pipeline/buffer are stood up (near-instant); use
   * `whenBibleReady()` to await full extraction (e.g. in tests).
   */
  async openBook(book: BookSource): Promise<void> {
    this.book = book;
    this.bible = (await this.store.getBible(book.id)) ?? createEmptyBible(book.id);

    this.pipeline = new RenderPipeline({
      book,
      // Getter, not a snapshot: the bible grows as chapters are extracted.
      getBible: () => this.bible!,
      llm: this.opts.llm,
      image: this.opts.image,
      store: this.store,
      tier: this.tier,
    });
    this.buffer = new RenderBuffer({
      totalPages: book.pages.length,
      render: (pageIndex, onProgress) => this.pipeline!.renderPage(pageIndex, onProgress),
      // Hold a page until its chapter has been processed into the bible.
      canRender: (pageIndex) => this.isChapterReady(pageIndex),
      ...(this.opts.onUpdate ? { onUpdate: this.opts.onUpdate } : {}),
    });

    // Build the bible without blocking; poke the buffer as each chapter lands.
    this.biblePromise = this.buildBibleInBackground();
  }

  /** Resolves when background Visual Bible extraction for the current book is done. */
  whenBibleReady(): Promise<void> {
    return this.biblePromise ?? Promise.resolve();
  }

  /** Is the chapter that contains this page already in the bible? */
  private isChapterReady(pageIndex: number): boolean {
    if (!this.book || !this.bible) return false;
    const page = this.book.pages[pageIndex];
    if (!page) return true; // out of range — let renderPage return its own error
    const chapter = this.book.chapters.find((c) => c.id === page.chapterId);
    return this.bible.processedChapters.includes(chapter?.index ?? 0);
  }

  /**
   * Extract any chapters not yet in the bible, persisting as we go and letting the
   * buffer start pages whose chapter just became ready. Per-chapter failures are
   * swallowed (the chapter is still marked processed) so reading never deadlocks
   * on a single bad extraction.
   */
  private async buildBibleInBackground(): Promise<void> {
    if (!this.book || !this.bible) return;
    const textByChapter = chapterText(this.book);
    const pending = [...textByChapter].filter(
      ([chapterIndex]) => !this.bible!.processedChapters.includes(chapterIndex),
    );
    const total = pending.length;
    let done = 0;
    this.opts.onBibleProgress?.(done, total);
    this.opts.onBibleUpdate?.(this.bible);
    // A fully-cached book: nothing pending, but its pages are already renderable.
    if (total === 0) this.buffer?.refresh();
    for (const [chapterIndex, text] of pending) {
      try {
        this.bible = await this.opts.llm.extractEntities({
          bookId: this.book.id,
          chapterIndex,
          chapterText: text,
          existing: this.bible,
        });
      } catch {
        // Extraction failed for this chapter — mark it processed anyway so its
        // pages aren't gated forever; they render with whatever context we have.
        this.bible = markChapterProcessed(this.bible, chapterIndex);
      }
      await this.store.putBible(this.bible);
      this.opts.onBibleProgress?.(++done, total);
      this.opts.onBibleUpdate?.(this.bible);
      // New entities are in the bible → release any pages that were gated on this chapter.
      this.buffer?.refresh();
    }
  }

  getBible(): VisualBible | undefined {
    return this.bible;
  }

  /** Move the reader; refreshes the predictive window. */
  goToPage(pageIndex: number): void {
    this.buffer?.setCurrentPage(pageIndex);
  }

  /** Allow/forbid speculative idle pre-rendering (gate on battery/thermal). */
  setIdleAllowed(allowed: boolean): void {
    this.buffer?.setIdleAllowed(allowed);
  }

  /** Pre-render every page of the book now (optional, user-triggered). */
  prerenderAll(): void {
    this.buffer?.renderAll();
  }

  resultFor(pageIndex: number): ImageResult | undefined {
    return this.buffer?.resultOf(pageIndex);
  }
}

/** Mark a chapter processed without adding entities (used when extraction fails). */
function markChapterProcessed(bible: VisualBible, chapterIndex: number): VisualBible {
  if (bible.processedChapters.includes(chapterIndex)) return bible;
  return { ...bible, processedChapters: [...bible.processedChapters, chapterIndex] };
}

/** Concatenate each chapter's page text, keyed by chapter index. */
function chapterText(book: BookSource): Map<number, string> {
  const byChapter = new Map<number, string[]>();
  for (const page of book.pages) {
    const chapter = book.chapters.find((c) => c.id === page.chapterId);
    const idx = chapter?.index ?? 0;
    const list = byChapter.get(idx) ?? [];
    list.push(...page.paragraphs.map((p) => p.text));
    byChapter.set(idx, list);
  }
  return new Map([...byChapter].map(([idx, parts]) => [idx, parts.join("\n\n")]));
}
