import type { BookSource } from "./types/book.js";
import type { CharacterAppearance, IdentityAnchor, Outfit, VisualBible } from "./types/bible.js";
import type { ImageResult } from "./types/content.js";
import type { TierConfig } from "./types/tier.js";
import { DEFAULT_TIER_CONFIG } from "./types/tier.js";
import type { LLMProvider } from "./providers/llm/llm-provider.js";
import type { ImageProvider } from "./providers/image/image-provider.js";
import type { VisualReaderStore } from "./storage/store.js";
import { InMemoryStore } from "./storage/store.js";
import { RenderPipeline } from "./pipeline/pipeline.js";
import { RenderBuffer } from "./render-buffer/render-buffer.js";
import { BIBLE_VERSION, createEmptyBible } from "./visual-bible/bible.js";
import {
  exportBible,
  mergeCarryOver,
  parseImportedBible,
  type ImportStats,
} from "./visual-bible/bible-export.js";
import { consolidateCharacters } from "./providers/llm/extraction.js";

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
   * Fired during Visual Bible extraction (`done` of `total` **story** chapters).
   * `total` is every story chapter (front/back matter excluded) and `done` is how
   * many are processed, so a fully-cached re-open reports `(total, total)` = 100%.
   */
  onBibleProgress?: (done: number, total: number) => void;
  /**
   * Fired with the latest Visual Bible whenever it grows (initial state, then
   * after each chapter). The bible is built incrementally in the background, so
   * the UI uses this to keep character/spoiler context current as it fills in.
   */
  onBibleUpdate?: (bible: VisualBible) => void;
  /** A transient note during bible building (e.g. a chapter that failed twice). */
  onBibleNote?: (message: string) => void;
  /**
   * When to start illustrating: "chapter" renders a unit as soon as its chapter
   * is analysed (fast first image); "book" waits until the whole book is read so
   * every prompt has full-book context. Default "chapter".
   */
  illustrateAfter?: "book" | "chapter";
}

/** A user correction to a single character (any subset of editable fields). */
export interface CharacterPatch {
  name?: string;
  aliases?: string[];
  persistentTraits?: string[];
  clothing?: string[];
  outfits?: Outfit[];
  appearance?: Partial<CharacterAppearance>;
}

export class Engine {
  private readonly store: VisualReaderStore;
  private readonly tier: TierConfig;
  private book?: BookSource;
  private bible?: VisualBible;
  private pipeline?: RenderPipeline;
  private buffer?: RenderBuffer;
  /** The background bible-extraction run for the current book (awaitable in tests). */
  private biblePromise: Promise<void> | undefined;
  /** Whether `startGeneration` has been called for the current book. */
  private generationStarted = false;
  /** Whether generation is paused (no new chapters extracted / images rendered). */
  private paused = false;
  private readonly illustrateAfter: "book" | "chapter";

  constructor(private opts: EngineOptions) {
    this.store = opts.store ?? new InMemoryStore();
    this.tier = opts.tier ?? DEFAULT_TIER_CONFIG;
    this.illustrateAfter = opts.illustrateAfter ?? "chapter";
  }

  /**
   * Load a book *without* generating anything new. Restores the cached Visual
   * Bible and any images rendered in previous sessions (so the reader shows prior
   * work immediately), then waits — fresh extraction and image generation only
   * begin when `startGeneration()` is called (the "Begin generating book" action).
   */
  async openBook(book: BookSource): Promise<void> {
    this.book = book;
    // Discard a bible cached at an older schema (e.g. pre-storyboard) so it's rebuilt.
    const stored = await this.store.getBible(book.id);
    this.bible = stored && stored.version === BIBLE_VERSION ? stored : createEmptyBible(book.id);
    // Collapse duplicate characters left by earlier sessions (e.g. "Violet" +
    // "Violet Sorrengail") without a full re-analysis; persist if anything merged.
    if (this.bible.characters.length > 1) {
      const consolidated = consolidateCharacters(this.bible.characters);
      if (consolidated.length !== this.bible.characters.length) {
        this.bible = { ...this.bible, characters: consolidated };
        await this.store.putBible(this.bible);
      }
    }
    this.generationStarted = false;
    this.paused = false;
    this.biblePromise = undefined;

    this.pipeline = new RenderPipeline({
      book,
      // Getter, not a snapshot: the bible grows as chapters are extracted.
      getBible: () => this.bible!,
      llm: this.opts.llm,
      image: this.opts.image,
      store: this.store,
      tier: this.tier,
      captureReference: (id, bytes, mimeType) => this.captureCharacterReference(id, bytes, mimeType),
    });
    this.buffer = new RenderBuffer({
      totalPages: book.pages.length,
      render: (pageIndex, onProgress) => this.pipeline!.renderPage(pageIndex, onProgress),
      // "book": wait for the whole book to be analysed; "chapter": as soon as the
      // unit's own chapter is ready.
      canRender: (pageIndex) =>
        this.illustrateAfter === "book" ? this.isBibleComplete() : this.isChapterReady(pageIndex),
      // Front/back matter is never illustrated (shows as a text-only page).
      shouldSkip: (pageIndex) => !this.isStoryPage(pageIndex),
      // Stay paused until the user begins generating; cached pages still show.
      generationEnabled: false,
      ...(this.opts.onUpdate ? { onUpdate: this.opts.onUpdate } : {}),
    });

    // Surface the restored bible + any previously-rendered images right away.
    this.opts.onBibleUpdate?.(this.bible);
    await this.loadCachedImages();
  }

  /**
   * Begin generating: build the Visual Bible in the background (chapter by
   * chapter, cached) and render pages as soon as their chapter is ready — the
   * first illustration appears after the first chapter, not the whole book.
   * Idempotent; cached pages are skipped so only missing work runs.
   */
  startGeneration(): void {
    if (this.generationStarted) return;
    this.generationStarted = true;
    this.buffer?.setGenerationEnabled(true);
    this.buffer?.setIdleAllowed(true);
    this.biblePromise = this.buildBibleInBackground();
  }

  /** Whether generation has been started for the current book. */
  isGenerating(): boolean {
    return this.generationStarted;
  }

  /** Resolves when background Visual Bible extraction for the current book is done. */
  whenBibleReady(): Promise<void> {
    return this.biblePromise ?? Promise.resolve();
  }

  /** Seed the buffer with cached images from previous sessions (no generation). */
  private async loadCachedImages(): Promise<void> {
    if (!this.book || !this.pipeline || !this.buffer) return;
    for (let i = 0; i < this.book.pages.length; i++) {
      const cached = await this.pipeline.cachedResult(i);
      if (cached) {
        this.buffer.seed(i, cached);
        this.opts.onUpdate?.(i, cached);
      }
    }
  }

  /** Whether this page belongs to a story chapter (not front/back matter). */
  private isStoryPage(pageIndex: number): boolean {
    if (!this.book) return true;
    const page = this.book.pages[pageIndex];
    if (!page) return true;
    const chapter = this.book.chapters.find((c) => c.id === page.chapterId);
    return chapter?.isStory !== false;
  }

  /** Is the chapter that contains this page already in the bible? */
  private isChapterReady(pageIndex: number): boolean {
    if (!this.book || !this.bible) return false;
    const page = this.book.pages[pageIndex];
    if (!page) return true; // out of range — let renderPage return its own error
    const chapter = this.book.chapters.find((c) => c.id === page.chapterId);
    return this.bible.processedChapters.includes(chapter?.index ?? 0);
  }

  /** Has every chapter of the book been processed into the bible? */
  private isBibleComplete(): boolean {
    if (!this.book || !this.bible) return false;
    for (const idx of chapterText(this.book).keys()) {
      if (!this.bible.processedChapters.includes(idx)) return false;
    }
    return true;
  }

  /**
   * Extract any chapters not yet in the bible, persisting as we go and letting the
   * buffer start pages whose chapter just became ready. Per-chapter failures are
   * swallowed (the chapter is still marked processed) so reading never deadlocks
   * on a single bad extraction.
   */
  private async buildBibleInBackground(): Promise<void> {
    if (!this.book || !this.bible) return;
    const textByChapter = chapterText(this.book); // story chapters only
    const storyIndices = [...textByChapter.keys()];
    const total = storyIndices.length;
    const isProcessed = (i: number): boolean => this.bible!.processedChapters.includes(i);
    const pending = storyIndices
      .filter((i) => !isProcessed(i))
      .map((i) => [i, textByChapter.get(i)!] as [number, string]);
    // Progress is reported against ALL story chapters (not just pending), so a
    // fully-cached re-open shows 100% rather than 0/0.
    let done = total - pending.length;
    this.opts.onBibleProgress?.(done, total);
    this.opts.onBibleUpdate?.(this.bible);
    // A fully-cached book: nothing pending, but its pages are already renderable.
    if (pending.length === 0) this.buffer?.refresh();
    for (const [chapterIndex, text] of pending) {
      if (this.paused) return; // resume() re-invokes this loop for the rest
      // Extraction has no timeout (a slow-but-working LLM is never cut off). On a
      // transient failure, retry ONCE; only if it still fails do we mark the
      // chapter processed (so pages aren't gated forever) and surface a note.
      let extracted = false;
      for (let attempt = 0; attempt < 2 && !extracted; attempt++) {
        if (this.paused) return;
        try {
          this.bible = await this.opts.llm.extractEntities({
            bookId: this.book.id,
            chapterIndex,
            chapterText: text,
            existing: this.bible,
          });
          extracted = true;
        } catch {
          /* retry once, then give up on just this chapter */
        }
      }
      if (!extracted) {
        this.bible = markChapterProcessed(this.bible, chapterIndex);
        this.opts.onBibleNote?.(`Chapter ${chapterIndex + 1} analysis failed — continuing.`);
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

  /** Serialize the current Visual Bible (+ AI rules) to an export JSON string. */
  exportBible(): string {
    return exportBible(this.bible);
  }

  /**
   * Series continuity: carry a previous book's characters/creatures/locations/
   * glossary into the current book's bible (the new book keeps its own storyboard
   * and re-reads its chapters, accumulating any changed descriptions). Persists.
   */
  async carryOverBibleFrom(priorBookId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.book) return { ok: false, error: "Open a book first." };
    if (priorBookId === this.book.id) return { ok: false, error: "Pick a different book." };
    const prior = await this.store.getBible(priorBookId);
    if (!prior) return { ok: false, error: "That book has no Visual Bible to carry over yet." };
    const base = this.bible ?? createEmptyBible(this.book.id);
    this.bible = mergeCarryOver(base, prior);
    await this.store.putBible(this.bible);
    this.opts.onBibleUpdate?.(this.bible);
    this.buffer?.refresh();
    return { ok: true };
  }

  /**
   * Import a Visual Bible JSON (from an export or external AI), merging it onto the
   * current book and persisting. Validates the schema version; does NOT re-render
   * images (the bible is metadata). Returns stats or an error message.
   */
  async importBible(json: string): Promise<{ ok: boolean; stats?: ImportStats; error?: string }> {
    if (!this.book) return { ok: false, error: "Open a book first." };
    const result = parseImportedBible(json, this.book.id);
    if (!result.bible) return { ok: false, ...(result.error ? { error: result.error } : {}) };
    this.bible = result.bible;
    await this.store.putBible(this.bible);
    this.opts.onBibleUpdate?.(this.bible);
    this.buffer?.refresh();
    return { ok: true, ...(result.stats ? { stats: result.stats } : {}) };
  }

  /**
   * Save a just-rendered solo frame as a character's reference image (for
   * IP-Adapter), set it on the bible's anchor, and persist. Called by the pipeline
   * the first time a character appears alone.
   */
  private async captureCharacterReference(
    characterId: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ): Promise<void> {
    if (!this.book || !this.bible) return;
    const refId = `${this.book.id}:charref:${characterId}`;
    await this.store.putImage(refId, bytes, mimeType);
    this.bible = {
      ...this.bible,
      characters: this.bible.characters.map((c) =>
        c.id === characterId && !c.anchor.referenceImageId
          ? { ...c, anchor: { ...c.anchor, referenceImageId: refId } }
          : c,
      ),
    };
    await this.store.putBible(this.bible);
    this.opts.onBibleUpdate?.(this.bible);
  }

  /**
   * Apply a user correction to one character in the bible and persist it. This is
   * "save only": cached images are NOT re-rendered — the edit takes effect on the
   * next render (or when the user hits a regenerate button), keeping the user in
   * control of when (potentially expensive) re-illustration happens.
   */
  async updateCharacter(characterId: string, patch: CharacterPatch): Promise<void> {
    if (!this.bible) return;
    // A look change makes any captured reference image stale → drop it so a fresh
    // one is recaptured on the next solo render.
    const looksChanged =
      patch.appearance !== undefined || patch.clothing !== undefined || patch.outfits !== undefined;
    const characters = this.bible.characters.map((c) =>
      c.id === characterId
        ? {
            ...c,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.aliases !== undefined ? { aliases: patch.aliases } : {}),
            ...(patch.persistentTraits !== undefined
              ? { persistentTraits: patch.persistentTraits }
              : {}),
            ...(patch.clothing !== undefined ? { clothing: patch.clothing } : {}),
            ...(patch.outfits !== undefined ? { outfits: patch.outfits } : {}),
            ...(patch.appearance !== undefined
              ? { appearance: { ...c.appearance, ...patch.appearance } }
              : {}),
            ...(looksChanged ? { anchor: dropReference(c.anchor) } : {}),
          }
        : c,
    );
    this.bible = { ...this.bible, characters };
    await this.store.putBible(this.bible);
    this.opts.onBibleUpdate?.(this.bible);
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
    this.startGeneration(); // pre-rendering implies generation is on
    if (this.paused) this.resumeGeneration();
    this.buffer?.renderAll();
  }

  /** Pause: stop starting new chapter extractions and image renders. */
  pauseGeneration(): void {
    this.paused = true;
    this.buffer?.setGenerationEnabled(false);
    this.buffer?.setIdleAllowed(false);
  }

  /** Resume after a pause; continues the bible build from where it stopped. */
  resumeGeneration(): void {
    if (!this.paused) return;
    this.paused = false;
    this.buffer?.setGenerationEnabled(true);
    this.buffer?.setIdleAllowed(true);
    if (this.generationStarted && !this.isBibleComplete()) {
      this.biblePromise = this.buildBibleInBackground();
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Re-run the LLM analysis (bible + storyboard) from scratch, e.g. after
   * switching the text provider/model. Cached images are kept (use
   * `regenerateAllImages` to re-render them against the new storyboard).
   */
  async regenerateStoryboard(): Promise<void> {
    if (!this.book) return;
    await this.store.deleteBible?.(this.book.id);
    this.bible = createEmptyBible(this.book.id);
    this.opts.onBibleUpdate?.(this.bible);
    this.paused = false;
    if (this.generationStarted) {
      this.buffer?.setGenerationEnabled(true);
      this.biblePromise = this.buildBibleInBackground();
    }
  }

  /** Discard every cached image and re-render the book (e.g. new model/style/quality). */
  async regenerateAllImages(): Promise<void> {
    if (!this.book) return;
    await this.store.clearImages?.(this.book.id);
    this.startGeneration();
    if (this.paused) this.resumeGeneration();
    this.buffer?.invalidateAll();
  }

  /** Discard one unit's cached image and re-render just it (e.g. to try a style). */
  async regenerateCurrentImage(unitIndex: number): Promise<void> {
    if (!this.pipeline) return;
    await this.store.deleteImage?.(this.pipeline.requestIdFor(unitIndex));
    this.startGeneration();
    if (this.paused) this.resumeGeneration();
    // Focus the buffer on this unit FIRST so it renders next — ahead of any
    // predictive prefetch of other units — then drop its cached image so the
    // re-render targets the page the reader is on, not whatever was mid-flight.
    this.buffer?.setCurrentPage(unitIndex);
    this.buffer?.invalidate(unitIndex);
  }

  resultFor(pageIndex: number): ImageResult | undefined {
    return this.buffer?.resultOf(pageIndex);
  }
}

/** An identity anchor with any captured reference image dropped (look changed). */
function dropReference(anchor: IdentityAnchor): IdentityAnchor {
  const { referenceImageId: _drop, ...rest } = anchor;
  return rest;
}

/** Mark a chapter processed without adding entities (used when extraction fails). */
function markChapterProcessed(bible: VisualBible, chapterIndex: number): VisualBible {
  if (bible.processedChapters.includes(chapterIndex)) return bible;
  return { ...bible, processedChapters: [...bible.processedChapters, chapterIndex] };
}

/**
 * Concatenate each STORY chapter's page text, keyed by chapter index. Front/back
 * matter (chapter.isStory === false) is omitted entirely, so it's never analysed
 * and never blocks bible completion.
 */
function chapterText(book: BookSource): Map<number, string> {
  const byChapter = new Map<number, string[]>();
  for (const page of book.pages) {
    const chapter = book.chapters.find((c) => c.id === page.chapterId);
    if (chapter?.isStory === false) continue; // skip non-story matter
    const idx = chapter?.index ?? 0;
    const list = byChapter.get(idx) ?? [];
    list.push(...page.paragraphs.map((p) => p.text));
    byChapter.set(idx, list);
  }
  return new Map([...byChapter].map(([idx, parts]) => [idx, parts.join("\n\n")]));
}
