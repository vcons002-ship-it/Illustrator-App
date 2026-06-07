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
}

export class Engine {
  private readonly store: VisualReaderStore;
  private readonly tier: TierConfig;
  private book?: BookSource;
  private bible?: VisualBible;
  private pipeline?: RenderPipeline;
  private buffer?: RenderBuffer;

  constructor(private opts: EngineOptions) {
    this.store = opts.store ?? new InMemoryStore();
    this.tier = opts.tier ?? DEFAULT_TIER_CONFIG;
  }

  /**
   * Load a book: restore or build its Visual Bible, then stand up the pipeline
   * and buffer. Returns once the Bible is ready (extraction runs chapter by
   * chapter and is cached, so re-opening a book is instant).
   */
  async openBook(book: BookSource): Promise<void> {
    this.book = book;
    this.bible = (await this.store.getBible(book.id)) ?? createEmptyBible(book.id);
    await this.ensureBible();

    this.pipeline = new RenderPipeline({
      book,
      bible: this.bible,
      llm: this.opts.llm,
      image: this.opts.image,
      store: this.store,
      tier: this.tier,
    });
    this.buffer = new RenderBuffer({
      totalPages: book.pages.length,
      render: (pageIndex) => this.pipeline!.renderPage(pageIndex),
      ...(this.opts.onUpdate ? { onUpdate: this.opts.onUpdate } : {}),
    });
  }

  /** Extract any chapters not yet in the Bible, persisting as we go. */
  private async ensureBible(): Promise<void> {
    if (!this.book || !this.bible) return;
    const textByChapter = chapterText(this.book);
    for (const [chapterIndex, text] of textByChapter) {
      if (this.bible.processedChapters.includes(chapterIndex)) continue;
      this.bible = await this.opts.llm.extractEntities({
        bookId: this.book.id,
        chapterIndex,
        chapterText: text,
        existing: this.bible,
      });
      await this.store.putBible(this.bible);
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

  resultFor(pageIndex: number): ImageResult | undefined {
    return this.buffer?.resultOf(pageIndex);
  }
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
