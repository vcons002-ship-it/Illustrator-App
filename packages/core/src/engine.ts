import { isNonFiction, type BookSource } from "./types/book.js";
import type { ChapterScene, CharacterAppearance, IdentityAnchor, Outfit, VisualBible } from "./types/bible.js";
import { MAX_CHARACTER_REFS, referenceIdsOf } from "./types/bible.js";
import type { ImageResult } from "./types/content.js";
import type { TierConfig } from "./types/tier.js";
import { DEFAULT_TIER_CONFIG } from "./types/tier.js";
import type { LLMProvider } from "./providers/llm/llm-provider.js";
import type { ImageProvider } from "./providers/image/image-provider.js";
import {
  formatGroundingContext,
  groundingQuery,
  type RetrievedImage,
  type WebSearchHit,
} from "./providers/image/image-search.js";
import type { VisualReaderStore } from "./storage/store.js";
import { InMemoryStore } from "./storage/store.js";
import { RenderPipeline } from "./pipeline/pipeline.js";
import { RenderBuffer } from "./render-buffer/render-buffer.js";
import { createEmptyBible, migrateBible } from "./visual-bible/bible.js";
import { addKeyEvent, clearKeyEvents, resolveKeyEvent, resolveKeyEventIn } from "./visual-bible/key-events.js";
import {
  carryReferenceImages,
  exportBible,
  mergeCarryOver,
  parseImportedBible,
  type ImportStats,
} from "./visual-bible/bible-export.js";
import { consolidateCharacters } from "./providers/llm/extraction.js";
import type { StoryPresent } from "./visual-bible/story-scene.js";

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
  /** Real-figure retrieval for technical books (see PipelineDeps.imageSearch). */
  imageSearch?: { retrieve(query: string): Promise<RetrievedImage | undefined> };
  /**
   * Provider-agnostic grounding for technical books: when set, each chapter's analysis is
   * grounded in a web search (snippets injected into the reader's prompt; sources cited in
   * the glossary). Lets a LOCAL LLM produce sourced facts. Absent for Gemini-in-call
   * grounding or when no search credentials are configured.
   */
  webSearch?: { searchWeb(query: string): Promise<WebSearchHit[]> };
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
   * Fired while precomputing illustration prompts after the bible is built (`done` of
   * `total` story units). Lets the UI show "Writing illustration prompts… X/Y" and
   * lets image generation later run with the LLM off (prompts read from the bible).
   */
  onPromptProgress?: (done: number, total: number) => void;
  /**
   * When to start illustrating: "chapter" renders a unit as soon as its chapter
   * is analysed (fast first image); "book" waits until the whole book is read so
   * every prompt has full-book context. Default "chapter".
   */
  illustrateAfter?: "book" | "chapter";
  /**
   * Story "as you go" hook: fired right AFTER a chapter is extracted + merged into the
   * bible, BEFORE its unit is released to render. The host computes the active-scene
   * present cast + location for that beat (carry-forward across terse beats — see
   * `visual-bible/story-scene.ts`) and returns it as a render override; the engine pins
   * it on the pipeline so the beat's image uses the TRACKED scene, not just names found
   * in the terse beat text. Absent for the book illustrator (cast comes from page text).
   */
  onChapterExtracted?: (chapterIndex: number, bible: VisualBible) => StoryPresent | undefined;
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
  /**
   * Bible extraction and image rendering can be paused INDEPENDENTLY so the user can
   * give the GPU to one or the other (e.g. pause images to let the bible finish
   * faster, or pause the bible to finish illustrating the current chapter).
   */
  private biblePaused = false;
  private imagePaused = false;
  /**
   * Monotonic token for the active bible-extraction run. Starting a new run (open a
   * book, resume, regenerate) bumps it; an older in-flight loop sees the mismatch at
   * its next checkpoint (and after each await) and bails WITHOUT touching shared
   * state. This guarantees exactly one bible loop is ever live, so a previous book's
   * background work can't keep running — or clobber the new book's bible — once you
   * switch books, and a rapid pause→resume can never spawn a duplicate loop.
   */
  private bibleRun = 0;
  /** Aborts the in-flight chapter extraction so a pause/book-switch frees the GPU at once. */
  private bibleAbort?: AbortController;
  /**
   * Identity token for the active render buffer. A buffer replaced on `openBook`
   * keeps any in-flight render (≤ maxConcurrent) alive; tagging updates with the
   * epoch lets us drop late results from a stale buffer so they never leak into the
   * newly-opened book.
   */
  private bufferEpoch = 0;
  private readonly illustrateAfter: "book" | "chapter";
  /**
   * Per-book lookup tables, built once on `openBook` (the book is immutable).
   * The render buffer's `canRender`/`shouldSkip` gates run for many pages on
   * EVERY pump, so they must never re-scan `book.chapters` per page.
   */
  private chapterIndexOfPage: number[] = [];
  private pageIsStory: boolean[] = [];
  /** Indices of all story render units, in reading order. */
  private storyUnitIndices: number[] = [];
  /** Story-chapter indices that have pages (matches `chapterText(book).keys()`). */
  private storyChapterIndices: number[] = [];
  private unitsByChapter = new Map<number, number[]>();
  private rangesByChapter = new Map<number, [number, number][]>();
  /**
   * Chapter→scene index for the CURRENT bible object. The bible is replaced
   * immutably on every change, so object identity is a correct cache key.
   */
  private sceneCache: { bible: VisualBible; byChapter: Map<number, ChapterScene> } | undefined;
  /** isLlmPhaseComplete memo for the current bible ("book" mode checks it per pump). */
  private llmPhaseCache: { bible: VisualBible; complete: boolean } | undefined;

  constructor(private opts: EngineOptions) {
    this.store = opts.store ?? new InMemoryStore();
    // Own copy: `updateTier` swaps this object's contents in place (the pipeline shares
    // the reference), which must never mutate the caller's object or the module default.
    this.tier = { ...(opts.tier ?? DEFAULT_TIER_CONFIG) };
    this.illustrateAfter = opts.illustrateAfter ?? "chapter";
  }

  /**
   * Apply new render TUNING (style, quality, aspect, sampler overrides…) to the live
   * engine. The pipeline and buffer hold the SAME tier object, so its contents are
   * swapped in place: future renders pick the changes up immediately while nothing is
   * disposed, aborted, or re-analysed — in-flight LLM extraction and image renders run
   * to completion, and finished images are untouched. Identity changes (different
   * providers/keys/models, pages-per-image) still need a full reopen, which the host
   * decides; this method assumes the providers themselves are unchanged.
   */
  updateTier(next: TierConfig): void {
    for (const k of Object.keys(this.tier)) {
      delete (this.tier as unknown as Record<string, unknown>)[k];
    }
    Object.assign(this.tier, next);
  }

  /**
   * Load a book *without* generating anything new. Restores the cached Visual
   * Bible and any images rendered in previous sessions (so the reader shows prior
   * work immediately), then waits — fresh extraction and image generation only
   * begin when `startGeneration()` is called (the "Begin generating book" action).
   */
  async openBook(book: BookSource): Promise<void> {
    this.book = book;
    this.indexBook(book);
    // Restore the cached bible, migrating it forward where we can (v5→v6 is additive)
    // so existing analysis survives; only un-migratable older schemas are rebuilt.
    const stored = await this.store.getBible(book.id);
    this.bible = (stored && migrateBible(stored)) ?? createEmptyBible(book.id);
    // Collapse duplicate characters left by earlier sessions (e.g. "Violet" +
    // "Violet Sorrengail") without a full re-analysis; persist if anything merged —
    // and SAY so, because a silent shrink here looks like the bible losing people.
    if (this.bible.characters.length > 1) {
      const before = this.bible.characters.length;
      const consolidated = consolidateCharacters(this.bible.characters);
      if (consolidated.length !== before) {
        this.bible = { ...this.bible, characters: consolidated };
        await this.store.putBible(this.bible);
        const merged = before - consolidated.length;
        this.opts.onBibleNote?.(
          `Merged ${merged} duplicate character entr${merged === 1 ? "y" : "ies"} (same person under different names).`,
        );
      }
    }
    this.generationStarted = false;
    this.biblePaused = false;
    this.imagePaused = false;
    this.biblePromise = undefined;
    // Cancel the previous book's background work: bump the bible run so any in-flight
    // extraction loop bails at its next checkpoint, and stop the old buffer from
    // starting new renders (its ≤maxConcurrent in-flight results are dropped below by
    // the bufferEpoch guard). Result: only the just-opened book ever processes.
    this.bibleRun++;
    this.bibleAbort?.abort(); // cancel the previous book's in-flight extraction
    this.buffer?.setGenerationEnabled(false);
    const epoch = ++this.bufferEpoch;
    const onUpdate = this.opts.onUpdate;

    this.pipeline = new RenderPipeline({
      book,
      // Getter, not a snapshot: the bible grows as chapters are extracted.
      getBible: () => this.bible!,
      llm: this.opts.llm,
      image: this.opts.image,
      store: this.store,
      tier: this.tier,
      ...(this.opts.imageSearch ? { imageSearch: this.opts.imageSearch } : {}),
    });
    this.buffer = new RenderBuffer({
      totalPages: book.pages.length,
      // A local engine (ComfyUI) serialises GPU jobs anyway, and two renders sharing one
      // websocket clientId cross-feed progress — so render one at a time locally; cloud
      // APIs parallelise fine.
      maxConcurrent: this.tier.tier === "local" ? 1 : 2,
      render: (pageIndex, onProgress, signal) =>
        this.pipeline!.renderPage(pageIndex, onProgress, signal),
      // A unit is renderable once its OWN illustration prompt exists (extraction folds the
      // chapter's prompts in, so this is true right after its chapter is analysed). Image
      // generation reads that stored prompt and never calls the LLM. In "book" mode we also
      // wait for the whole LLM phase, so every image is held until the full book is analysed.
      canRender: (pageIndex) =>
        this.hasKeyEvent(pageIndex) &&
        (this.illustrateAfter !== "book" || this.isLlmPhaseComplete()),
      // Front/back matter is never illustrated (shows as a text-only page).
      shouldSkip: (pageIndex) => !this.isStoryPage(pageIndex),
      // Stay paused until the user begins generating; cached pages still show.
      generationEnabled: false,
      // Tag updates with this buffer's epoch and drop any that arrive after the
      // buffer has been replaced (a late render from a previously-opened book).
      ...(onUpdate
        ? { onUpdate: (pageIndex: number, result: ImageResult) => {
            if (this.bufferEpoch === epoch) onUpdate(pageIndex, result);
          } }
        : {}),
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
    this.biblePromise = this.buildBibleInBackground();
  }

  /** Whether generation has been started for the current book. */
  isGenerating(): boolean {
    return this.generationStarted;
  }

  /**
   * Stop ALL of this instance's background work, permanently: the bible/prompt loop
   * (its in-flight LLM call is aborted at the next checkpoint) and image generation
   * (in-flight renders aborted; late results dropped by the epoch guard). Hosts that
   * build a NEW engine per opened book MUST dispose the old one first — otherwise its
   * loops keep running (competing for the GPU/API) and its callbacks keep firing into
   * the UI alongside the new book's, mingling status lines and character lists.
   */
  dispose(): void {
    this.bibleRun++; // every loop checkpoint now reads "cancelled" → exits silently
    this.bibleAbort?.abort(); // cut any in-flight LLM call immediately
    this.bufferEpoch++; // late render/abort updates are dropped, not surfaced
    this.buffer?.setGenerationEnabled(false); // abort in-flight renders, start no new ones
    this.generationStarted = false;
  }

  /** Resolves when background Visual Bible extraction for the current book is done. */
  whenBibleReady(): Promise<void> {
    return this.biblePromise ?? Promise.resolve();
  }

  /** Seed the buffer with cached images from previous sessions (no generation). */
  private async loadCachedImages(): Promise<void> {
    if (!this.book || !this.pipeline || !this.buffer) return;
    // Batch the lookups: each `getImage` is its own IndexedDB roundtrip, so a
    // large book paying them one at a time made opens multi-second.
    const CHUNK = 24;
    for (let start = 0; start < this.book.pages.length; start += CHUNK) {
      const count = Math.min(CHUNK, this.book.pages.length - start);
      const chunk = await Promise.all(
        Array.from({ length: count }, (_, k) => this.pipeline!.cachedResult(start + k)),
      );
      chunk.forEach((cached, k) => {
        if (cached) {
          this.buffer!.seed(start + k, cached);
          this.opts.onUpdate?.(start + k, cached);
        }
      });
    }
  }

  /** Build the per-book lookup tables (see field docs). */
  private indexBook(book: BookSource): void {
    const chapterById = new Map(book.chapters.map((c) => [c.id, c]));
    this.chapterIndexOfPage = [];
    this.pageIsStory = [];
    this.storyUnitIndices = [];
    this.unitsByChapter = new Map();
    this.rangesByChapter = new Map();
    const storyChapters = new Set<number>();
    book.pages.forEach((page, i) => {
      const chapter = chapterById.get(page.chapterId);
      const idx = chapter?.index ?? 0;
      const isStory = chapter?.isStory !== false;
      this.chapterIndexOfPage.push(idx);
      this.pageIsStory.push(isStory);
      const range = page.pageRange ?? ([page.index, page.index] as [number, number]);
      const ranges = this.rangesByChapter.get(idx);
      if (ranges) ranges.push(range);
      else this.rangesByChapter.set(idx, [range]);
      if (isStory) {
        this.storyUnitIndices.push(i);
        storyChapters.add(idx);
        const units = this.unitsByChapter.get(idx);
        if (units) units.push(i);
        else this.unitsByChapter.set(idx, [i]);
      }
    });
    this.storyChapterIndices = [...storyChapters];
    this.sceneCache = undefined;
    this.llmPhaseCache = undefined;
  }

  /** Whether this page belongs to a story chapter (not front/back matter). */
  private isStoryPage(pageIndex: number): boolean {
    return this.pageIsStory[pageIndex] ?? true;
  }

  /** The current bible's storyboard scene for a chapter (indexed, memoized). */
  private sceneFor(chapterIndex: number): ChapterScene | undefined {
    if (!this.bible) return undefined;
    if (this.sceneCache?.bible !== this.bible) {
      this.sceneCache = {
        bible: this.bible,
        byChapter: new Map(this.bible.storyboard.map((s) => [s.chapterIndex, s])),
      };
    }
    return this.sceneCache.byChapter.get(chapterIndex);
  }

  /** Has every chapter of the book been processed into the bible? */
  private isBibleComplete(): boolean {
    if (!this.book || !this.bible) return false;
    const processed = new Set(this.bible.processedChapters);
    for (const idx of this.storyChapterIndices) {
      if (!processed.has(idx)) return false;
    }
    return true;
  }

  /** Has every story unit had its illustration prompt written? */
  private arePromptsComplete(): boolean {
    if (!this.book) return false;
    for (const i of this.storyUnitIndices) {
      if (!this.hasKeyEvent(i)) return false;
    }
    return true;
  }

  /** The whole LLM phase (extraction + prompts) is done — nothing left to resume. */
  private isLlmPhaseComplete(): boolean {
    if (!this.bible) return false;
    if (this.llmPhaseCache?.bible !== this.bible) {
      this.llmPhaseCache = {
        bible: this.bible,
        complete: this.isBibleComplete() && this.arePromptsComplete(),
      };
    }
    return this.llmPhaseCache.complete;
  }

  /**
   * Extract any chapters not yet in the bible, persisting as we go and letting the
   * buffer start pages whose chapter just became ready. Per-chapter failures are
   * swallowed (the chapter is still marked processed) so reading never deadlocks
   * on a single bad extraction.
   */
  private async buildBibleInBackground(): Promise<void> {
    if (!this.book || !this.bible) return;
    // Claim this run, cancelling any older loop still in flight (book switch, resume,
    // regenerate). `myRun` is captured; the loop bails the moment it stops matching.
    const myRun = ++this.bibleRun;
    // Abort any prior run's in-flight LLM call (book switch / regenerate / resume) and
    // start a fresh cancellation scope for this run.
    this.bibleAbort?.abort();
    const ac = new AbortController();
    this.bibleAbort = ac;
    const bookId = this.book.id;
    // `cancelled`: a newer run/book took over → discard, never touch shared state.
    // `stop`: also stop when paused, but only when DECIDING to start the next chapter
    // (an already-completed extraction is still committed so in-flight work isn't wasted).
    const cancelled = (): boolean => this.bibleRun !== myRun;
    const stop = (): boolean => this.biblePaused || cancelled();
    const textByChapter = chapterText(this.book); // story chapters only
    const storyIndices = [...textByChapter.keys()];
    const total = storyIndices.length;
    const processed = new Set(this.bible.processedChapters);
    const pending = storyIndices
      .filter((i) => !processed.has(i))
      .map((i) => [i, textByChapter.get(i)!] as [number, string]);
    // Progress is reported against ALL story chapters (not just pending), so a
    // fully-cached re-open shows 100% rather than 0/0.
    let done = total - pending.length;
    this.opts.onBibleProgress?.(done, total);
    this.opts.onBibleUpdate?.(this.bible);
    // A fully-cached book: nothing pending, but its pages are already renderable.
    if (pending.length === 0) this.buffer?.refresh();
    for (const [chapterIndex, text] of pending) {
      if (stop()) return; // paused, or a newer run/book took over → stop before next chapter
      // Provider-agnostic grounding (technical books): web-search this chapter's topic and
      // inject the snippets so ANY reader — local LLM included — grounds its facts; the
      // sources are cited in the glossary below. Best-effort: any failure just skips it.
      let groundingContext = "";
      let groundingSources: string[] = [];
      if (this.opts.webSearch && isNonFiction(this.book?.contentMode)) {
        const query = groundingQuery(this.book.chapters[chapterIndex]?.title, text, this.book.title);
        if (query) {
          try {
            const hits = await this.opts.webSearch.searchWeb(query);
            ({ context: groundingContext, sources: groundingSources } = formatGroundingContext(hits));
          } catch {
            /* search unavailable / over quota → analyse ungrounded */
          }
        }
      }
      if (cancelled()) return;
      // Extraction has no timeout (a slow-but-working LLM is never cut off). On a
      // transient failure, retry ONCE; only if it still fails do we mark the
      // chapter processed (so pages aren't gated forever) and surface a note.
      let next: VisualBible | undefined;
      for (let attempt = 0; attempt < 2 && !next; attempt++) {
        if (stop()) return;
        try {
          next = await this.opts.llm.extractEntities({
            bookId,
            chapterIndex,
            chapterText: text,
            existing: this.bible,
            // Fold prompt-writing into extraction: the chapter's render-unit ranges let
            // the model emit one scene prompt per illustration in this single call.
            unitRanges: this.unitRangesForChapter(chapterIndex),
            // Technical books (papers/textbooks) use the Visual-Atlas extraction prompt.
            ...(this.book?.contentMode ? { contentMode: this.book.contentMode } : {}),
            ...(groundingContext ? { groundingContext } : {}),
            ...(this.tier.allowMature ? { allowMature: true } : {}),
            signal: ac.signal,
          });
        } catch {
          /* retry once, then give up on just this chapter */
        }
      }
      // Cite the grounding sources in the glossary (the local-reader analogue of the
      // Gemini in-call grounding's References entry).
      if (next && groundingSources.length > 0) {
        next = {
          ...next,
          glossary: [
            ...next.glossary,
            { term: `References (chapter ${chapterIndex + 1})`, definition: groundingSources.join(" · ") },
          ],
        };
      }
      // A newer run/book may have taken over WHILE we awaited the LLM. Discard before
      // mutating any shared state so we never clobber the newly-opened book's bible.
      // (Note: a mere PAUSE does NOT discard — the completed extraction is committed so
      // in-flight work isn't wasted; the loop then stops at the next iteration's `stop()`.)
      if (cancelled()) return;
      if (next) {
        // `next` was derived from the bible SNAPSHOT taken before this (long) LLM call —
        // so a reference image the user uploaded mid-extraction would be clobbered here.
        // Extraction never owns reference images, so re-apply the CURRENT bible's uploads
        // onto the result (matched by id/name/alias, surviving any consolidate/rename).
        this.bible = carryReferenceImages(this.bible!, next);
        // Story mode: the active-scene tracker (host) resolves THIS beat's present cast +
        // location from the just-grown bible and pins it on the pipeline BEFORE refresh
        // releases the unit — so a terse beat still illustrates the tracked scene.
        const present = this.opts.onChapterExtracted?.(chapterIndex, this.bible);
        if (present) this.pipeline?.setStoryPresent(chapterIndex, present);
      } else {
        this.bible = markChapterProcessed(this.bible!, chapterIndex);
        this.opts.onBibleNote?.(`Chapter ${chapterIndex + 1} analysis failed — continuing.`);
      }
      await this.store.putBible(this.bible);
      if (cancelled()) return; // re-check after the async persist, before notifying
      this.opts.onBibleProgress?.(++done, total);
      this.opts.onBibleUpdate?.(this.bible);
      // Extraction folded this chapter's illustration prompts into the bible (keyEvents),
      // so its units are already renderable — release any that were gated on this chapter.
      // Image generation then runs purely from those stored prompts (no LLM at render).
      this.buffer?.refresh();
      // Gap-fill THIS chapter's prompts now (a no-op when the folded extraction covered
      // every unit) and report prompt progress — so prompts visibly advance with each
      // chapter, and in "chapter" mode a under-delivered chapter renders without
      // waiting for the rest of the book.
      if (!stop()) await this.writePromptsForUnits(this.unitIndicesForChapter(chapterIndex), myRun, ac.signal);
    }
    // Illustration prompts are produced BY extraction (folded into each chapter's call).
    // A final sweep writes a prompt for any unit the extraction didn't emit (a count
    // mismatch / gap) so no story unit is left un-illustratable; it skips units that
    // already have one, so it's a cheap no-op when extraction covered everything.
    if (!stop()) await this.buildPromptsForUnits(myRun, ac.signal);
    // The LLM phase is over. A unit STILL without a prompt (its prompt write failed)
    // would otherwise sit silently queued forever behind the canRender gate — surface
    // an explicit, regenerable error instead so the failure is visible.
    if (!stop()) this.failUnpromptedUnits();
    // Rendering reads prompts straight from the Bible — the LLM isn't needed again
    // until chat / re-analysis. Free its VRAM/RAM so an on-GPU local model (WebLLM,
    // or Ollama on the same card) stops fighting the image engine for the GPU, which
    // is what made ComfyUI re-allocate/offload memory each render. Cloud providers
    // no-op; a later call reloads lazily. Best-effort — never block on it.
    if (!stop()) void this.opts.llm.unload?.().catch(() => {});
  }

  /** Mark every story unit that never got a prompt as an error (visible + actionable). */
  private failUnpromptedUnits(): void {
    if (!this.book || !this.buffer) return;
    let failed = 0;
    for (let i = 0; i < this.book.pages.length; i++) {
      if (!this.isStoryPage(i) || this.hasKeyEvent(i)) continue;
      if (this.buffer.resultOf(i)) continue; // already has a result (cached/skip/error)
      failed++;
      const page = this.book.pages[i]!;
      const result: ImageResult = {
        requestId: `page-${i}`,
        pageId: page.id,
        status: "error",
        error:
          "Couldn't write this unit's illustration prompt — check the text model in " +
          "Settings, then use “↻ Prompts” to retry.",
      };
      this.buffer.seed(i, result);
      this.opts.onUpdate?.(i, result);
    }
    if (failed > 0) {
      this.opts.onBibleNote?.(
        `${failed} illustration prompt${failed === 1 ? "" : "s"} couldn't be written — ` +
          `check the text model in Settings, then use “↻ Prompts”.`,
      );
    }
  }

  /** Indices of this chapter's STORY render units, in reading order (per-chapter
   * prompt gap-fill). */
  private unitIndicesForChapter(chapterIndex: number): number[] {
    return this.unitsByChapter.get(chapterIndex) ?? [];
  }

  /** The chapter's render-unit page ranges, in reading order (for folded prompts). A raw
   * single page (no explicit range) is its own unit at [index, index] — matching
   * buildRequest/hasKeyEvent so the folded keyEvents line up with the render units. */
  private unitRangesForChapter(chapterIndex: number): [number, number][] {
    return this.rangesByChapter.get(chapterIndex) ?? [];
  }

  /**
   * Write a Layer-1 image prompt for every story render unit that doesn't already have one
   * (the whole-book sweep). Reuses `writePromptsForUnits`, so it's the catch-all after the
   * folded-in extraction prompts (fills any gap) and for the on-demand "Rebuild prompts".
   */
  private async buildPromptsForUnits(myRun: number, signal: AbortSignal): Promise<void> {
    if (!this.book) return;
    await this.writePromptsForUnits(this.storyUnitIndices, myRun, signal);
  }

  /**
   * Write a stored Layer-1 prompt for each given unit that lacks one, under the same
   * pause/abort/run-token as `buildBibleInBackground`. Progress is reported against ALL
   * story units so the bar is stable whether called per-chapter or as the final sweep.
   */
  private async writePromptsForUnits(
    unitIndices: number[],
    myRun: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.book || !this.bible || !this.pipeline) return;
    const stop = (): boolean => this.biblePaused || this.bibleRun !== myRun;
    const cancelled = (): boolean => this.bibleRun !== myRun;
    const total = this.storyUnitIndices.length;
    // Count the already-prompted units once, then keep a running tally — recounting
    // the whole book after every written prompt made the pass quadratic.
    let prompted = 0;
    for (const i of this.storyUnitIndices) if (this.hasKeyEvent(i)) prompted++;
    const reportProgress = (): void => this.opts.onPromptProgress?.(prompted, total);
    reportProgress();
    // Persisting the bible is a structured clone of ALL of it (characters, glossary,
    // every chapter's keyEvents) — per prompt, that's O(units × bibleSize). Coalesce:
    // persist every few prompts / few seconds and on every exit, so a crash costs a
    // handful of cheap prompt rewrites instead of slowing the whole pass.
    let unpersisted = 0;
    let lastPersistMs = Date.now();
    const flush = async (): Promise<void> => {
      if (unpersisted > 0 && !cancelled() && this.bible) {
        unpersisted = 0;
        lastPersistMs = Date.now();
        await this.store.putBible(this.bible);
      }
    };
    for (const i of unitIndices) {
      if (stop()) {
        await flush(); // a pause must not drop prompts already written
        return;
      }
      if (this.hasKeyEvent(i)) continue;
      const page = this.book.pages[i]!;
      const request = this.pipeline.buildRequest(page);
      let text: string | undefined;
      try {
        text = await this.opts.llm.buildImagePrompt(request, this.bible, signal);
      } catch {
        /* abort (pause) or transient failure — leave it; the unit holds until retried */
      }
      if (cancelled()) return; // a newer run/book took over → don't touch shared state
      if (text && text.trim()) {
        this.bible = addKeyEvent(this.bible, request.chapterIndex, {
          pageRange: request.pageRange ?? [page.index, page.index],
          imagePrompt: { text: text.trim() },
        });
        prompted++; // this unit had no keyEvent before (checked above)
        unpersisted++;
        if (unpersisted >= 5 || Date.now() - lastPersistMs >= 3000) await flush();
        if (cancelled()) return;
        this.opts.onBibleUpdate?.(this.bible);
        // A unit previously failed as "no prompt" can render now — clear the error.
        if (this.buffer?.resultOf(i)?.status === "error") this.buffer.invalidate(i);
        // Releasing each unit as its prompt lands keeps the first image prompt-and renders.
        this.buffer?.refresh();
      }
      reportProgress();
    }
    await flush();
  }

  /** Whether this story unit already has a stored keyEvent prompt. */
  private hasKeyEvent(pageIndex: number): boolean {
    const page = this.book?.pages[pageIndex];
    if (!page || !this.bible) return false;
    const chapterIndex = this.chapterIndexOfPage[pageIndex] ?? 0;
    // Match the range buildRequest/writePromptsForUnits store under (raw page → [i, i]).
    const range = page.pageRange ?? ([page.index, page.index] as [number, number]);
    return resolveKeyEventIn(this.sceneFor(chapterIndex), range) !== undefined;
  }

  /**
   * Discard every stored illustration prompt and rebuild them from the current bible
   * (e.g. after editing characters). Cached images are kept; only prompts change.
   */
  async rebuildPrompts(): Promise<void> {
    if (!this.book || !this.bible) return;
    this.bible = clearKeyEvents(this.bible);
    await this.store.putBible(this.bible);
    this.opts.onBibleUpdate?.(this.bible);
    // Explicit on-demand rewrite: run the per-unit prompt pass (NOT re-extraction).
    if (this.generationStarted && !this.biblePaused) {
      const myRun = ++this.bibleRun;
      this.bibleAbort?.abort();
      const ac = new AbortController();
      this.bibleAbort = ac;
      this.biblePromise = this.buildPromptsForUnits(myRun, ac.signal);
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
    // Carried characters point at the PRIOR book's reference images — copy the bytes
    // into this book's keys so each book stays self-contained (deleting the prior
    // book, which clears its images, must not break this one).
    await this.localizeReferenceImages();
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
    // An imported file never carries reference images (the bytes live only in this
    // device's store) — re-attach the current bible's uploads by character name so
    // an import doesn't silently discard the user's likeness photos.
    this.bible = this.bible ? carryReferenceImages(this.bible, result.bible) : result.bible;
    await this.localizeReferenceImages();
    await this.store.putBible(this.bible);
    this.opts.onBibleUpdate?.(this.bible);
    this.buffer?.refresh();
    return { ok: true, ...(result.stats ? { stats: result.stats } : {}) };
  }

  /**
   * Add a user-uploaded reference image for a character — fed to IP-Adapter when the
   * ComfyUI nodes are installed. Multi-view: up to MAX_CHARACTER_REFS uploads per
   * character (ideally different ANGLES of the same face) condition each render
   * together for a more robust likeness. Silently a no-op at the cap (the UI hides
   * "Add" there). Auto-capture was removed (it biased every image toward a portrait);
   * references are deliberate user uploads only.
   */
  async addCharacterReference(
    characterId: string,
    image: { bytes: ArrayBuffer; mimeType: string },
  ): Promise<void> {
    if (!this.book || !this.bible) return;
    const character = this.bible.characters.find((c) => c.id === characterId);
    if (!character) return;
    const ids = referenceIdsOf(character.anchor);
    if (ids.length >= MAX_CHARACTER_REFS) return;
    const refId = `${this.book.id}:charref:${characterId}:${nextRefSlot(ids)}`;
    await this.store.putImage(refId, image.bytes, image.mimeType);
    await this.setAnchorReferences(characterId, [...ids, refId]);
  }

  /** Remove one of a character's reference images, deleting its stored bytes. */
  async removeCharacterReference(characterId: string, refId: string): Promise<void> {
    if (!this.bible) return;
    const character = this.bible.characters.find((c) => c.id === characterId);
    if (!character) return;
    const ids = referenceIdsOf(character.anchor);
    if (!ids.includes(refId)) return;
    await this.store.deleteImage?.(refId);
    await this.setAnchorReferences(characterId, ids.filter((id) => id !== refId));
  }

  /** A stored reference image's bytes (UI thumbnails). Scoped to this book's refs. */
  async getCharacterReference(
    refId: string,
  ): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> {
    if (!this.book || !refId.startsWith(`${this.book.id}:charref:`)) return undefined;
    return this.store.getImage(refId);
  }

  /**
   * Re-key reference images that point into ANOTHER book's store namespace (after a
   * series carry-over): copy the bytes under this book's keys and rewrite the ids.
   * Keeps every book self-contained — deleting the source book (which clears its
   * images) can't dangle this one, thumbnails resolve, and removing a reference here
   * never deletes the other book's copy. Ids whose bytes are already gone are dropped.
   */
  private async localizeReferenceImages(): Promise<void> {
    if (!this.book || !this.bible) return;
    const prefix = `${this.book.id}:charref:`;
    let changed = false;
    const characters = [...this.bible.characters];
    for (let i = 0; i < characters.length; i++) {
      const c = characters[i]!;
      const ids = referenceIdsOf(c.anchor);
      if (ids.length === 0 || ids.every((id) => id.startsWith(prefix))) continue;
      const local = ids.filter((id) => id.startsWith(prefix));
      for (const id of ids) {
        if (id.startsWith(prefix) || local.length >= MAX_CHARACTER_REFS) continue;
        const img = await this.store.getImage(id);
        if (!img) continue; // source ref no longer stored → drop it
        const newId = `${prefix}${c.id}:${nextRefSlot(local)}`;
        await this.store.putImage(newId, img.bytes, img.mimeType);
        local.push(newId);
      }
      characters[i] = { ...c, anchor: withReferenceIds(c.anchor, local) };
      changed = true;
    }
    if (changed) this.bible = { ...this.bible, characters };
  }

  /** Persist a character's reference ids (always the array form — legacy id folded in). */
  private async setAnchorReferences(characterId: string, ids: string[]): Promise<void> {
    if (!this.bible) return;
    // A removed slot can be re-used by a later upload (same id, new bytes) — drop
    // the pipeline's per-id byte cache so renders never see stale photos.
    this.pipeline?.clearReferenceCache();
    this.bible = {
      ...this.bible,
      characters: this.bible.characters.map((c) =>
        c.id === characterId ? { ...c, anchor: withReferenceIds(c.anchor, ids) } : c,
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
    // A reference image is now a deliberate USER upload (auto-capture was removed), so
    // it is NOT discarded when the text appearance is edited: the upload is the user's
    // ground-truth likeness and refining the description shouldn't throw it away. (Use
    // the Character Bible's "Remove" to clear it.)
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
          }
        : c,
    );
    this.bible = { ...this.bible, characters };
    await this.store.putBible(this.bible);
    this.opts.onBibleUpdate?.(this.bible);
  }

  /**
   * "Paint forward": repaint the book FROM a unit onward with the current settings,
   * keeping everything before it. Discards the cached image of every story unit at
   * or after `fromUnit`; the in-order buffer then repaints them front to back.
   * (Use `regenerateAllImages` to redo the whole book including earlier pages.)
   */
  async paintForward(fromUnit: number): Promise<void> {
    if (!this.book || !this.pipeline) return;
    this.startGeneration();
    this.resumeGeneration();
    for (let i = Math.max(0, fromUnit); i < this.book.pages.length; i++) {
      if (!this.isStoryPage(i)) continue;
      await this.store.deleteImage?.(this.pipeline.requestIdFor(i));
      this.buffer?.invalidate(i);
    }
  }

  /**
   * Pause/resume the Visual Bible build independently of image rendering. When
   * resumed, the background extraction continues from where it stopped. The restart
   * fires only on the paused→running transition (the equality guard), so it never
   * double-runs the loop.
   */
  setBiblePaused(paused: boolean): void {
    if (this.biblePaused === paused) return;
    this.biblePaused = paused;
    if (paused) {
      // Cancel the in-flight chapter extraction so the GPU frees promptly (the loop
      // then bails at its next `stop()` check); the chapter stays unprocessed and is
      // re-extracted, in order, on resume.
      this.bibleAbort?.abort();
    } else if (this.generationStarted && !this.isLlmPhaseComplete()) {
      // Resume the LLM phase if EITHER extraction or prompt-writing is unfinished (a pause
      // can stop the prompt pass after all chapters are extracted).
      this.biblePromise = this.buildBibleInBackground();
    }
  }

  /** Pause/resume image rendering independently of the bible build. */
  setImagePaused(paused: boolean): void {
    if (this.imagePaused === paused) return;
    this.imagePaused = paused;
    // Only (re-)enable rendering once the user has actually begun generating.
    this.buffer?.setGenerationEnabled(!paused && this.generationStarted);
  }

  /** Pause both pipelines (the combined "Pause" action). */
  pauseGeneration(): void {
    this.setBiblePaused(true);
    this.setImagePaused(true);
  }

  /** Resume both pipelines; continues the bible build from where it stopped. */
  resumeGeneration(): void {
    this.setBiblePaused(false);
    this.setImagePaused(false);
  }

  isBiblePaused(): boolean {
    return this.biblePaused;
  }

  isImagePaused(): boolean {
    return this.imagePaused;
  }

  isPaused(): boolean {
    return this.biblePaused && this.imagePaused;
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
    this.biblePaused = false;
    this.imagePaused = false;
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
    this.resumeGeneration();
    this.buffer?.invalidateAll();
  }

  /** Discard one unit's cached image and re-render just it as a genuine re-roll. */
  async regenerateCurrentImage(unitIndex: number): Promise<void> {
    if (!this.pipeline) return;
    // Re-roll the seed first: re-rendering the SAME prompt with the SAME seed reproduces
    // the identical image on a local engine, so a plain "redo" would look like a no-op.
    // Writing a fresh random seed into the unit's stored keyEvent makes each redo a real
    // re-roll, while normal front-to-back renders stay reproducible.
    await this.rerollUnitSeed(unitIndex);
    await this.store.deleteImage?.(this.pipeline.requestIdFor(unitIndex));
    this.startGeneration();
    this.resumeGeneration();
    // Drop its cached image, then explicitly prioritise THIS unit so it re-renders
    // next — ahead of the normal in-order schedule. (This is an explicit user action,
    // unlike passive scrolling, which never jumps the queue.)
    this.buffer?.invalidate(unitIndex);
    this.buffer?.prioritize(unitIndex);
  }

  /**
   * Write a fresh random seed into a unit's stored keyEvent (upsert, keeping the prompt),
   * so the next render of that unit differs from the cached image. No-op when the unit has
   * no stored prompt yet (its render seed still comes from the character anchor / random).
   */
  private async rerollUnitSeed(unitIndex: number): Promise<void> {
    if (!this.book || !this.bible) return;
    const page = this.book.pages[unitIndex];
    if (!page) return;
    const chapterIndex = this.chapterIndexOfPage[unitIndex] ?? 0;
    const range = page.pageRange ?? ([page.index, page.index] as [number, number]);
    const ev = resolveKeyEvent(this.bible, chapterIndex, range);
    if (!ev) return;
    const seed = Math.floor(Math.random() * 1_000_000_000);
    this.bible = addKeyEvent(this.bible, chapterIndex, { ...ev, seed });
    await this.store.putBible(this.bible);
    this.opts.onBibleUpdate?.(this.bible);
  }

  resultFor(pageIndex: number): ImageResult | undefined {
    return this.buffer?.resultOf(pageIndex);
  }

  /**
   * Fill in the gaps without a full restart: re-run anything still missing — chapters
   * not yet analysed, story units without a prompt, and illustrations that failed —
   * while KEEPING every image already rendered. Cheap when little is missing (processed
   * chapters and ready images are skipped). Use this to "finish the book" after a pause,
   * a transient model failure, or a few errored units, instead of `regenerateAllImages`
   * (which discards everything) or scrubbing to each gap by hand.
   */
  async completeBook(): Promise<void> {
    if (!this.book) return;
    this.startGeneration();
    // Unpause + re-enable rendering, and restart the LLM phase if any prompt is still
    // missing (a missing prompt makes isLlmPhaseComplete() false → the sweep re-runs).
    this.resumeGeneration();
    // Retry only the FAILED units (their error result blocks auto-retry); ready images
    // are kept, and never-attempted units render on their own once generation is on.
    if (this.buffer) {
      for (let i = 0; i < this.book.pages.length; i++) {
        if (this.isStoryPage(i) && this.buffer.resultOf(i)?.status === "error") {
          this.buffer.invalidate(i);
        }
      }
      this.buffer.refresh();
    }
  }

  /**
   * Story "as you go": grow the OPEN book by one already-segmented beat WITHOUT a
   * re-open. `renderBook` must share this book's id and be a positional SUPERSET — every
   * prior chapter/page id byte-identical, the new beat's unit(s) appended at the END
   * (see `appendStoryChapter` + `toRenderUnits`, which assign ids positionally). The
   * stable book id keeps the `${book.id}:${pageId}` image cache and `processedChapters`
   * valid, so NO prior span is re-extracted or re-rendered — only the new chapter is
   * pending. Re-indexes the lookup tables, re-points the pipeline + extends the buffer
   * (preserving every rendered slot), then re-arms the bible loop (when generating) so it
   * extracts only the new chapter, folds its prompt, fires `onChapterExtracted`, and
   * releases its unit. The new beat's image is prioritised ahead of the in-order schedule.
   *
   * Re-opening instead (`openBook`) would `dispose` + rebuild the engine and rescan every
   * cached image — churning the reader on every beat — which is exactly what this avoids.
   */
  async appendChapter(
    renderBook: BookSource,
    opts: { illustrate?: boolean } = {},
  ): Promise<{ firstNewUnit: number; chapterIndex: number }> {
    if (!this.book || !this.pipeline || !this.buffer) {
      throw new Error("appendChapter requires an open book");
    }
    if (renderBook.id !== this.book.id) {
      throw new Error(`appendChapter: book id "${renderBook.id}" must match the open book "${this.book.id}"`);
    }
    if (renderBook.pages.length <= this.book.pages.length) {
      throw new Error("appendChapter: the grown book must add at least one unit at the end");
    }
    // The new beat is the last chapter; its first render unit is the first newly-added page.
    const firstNewUnit = this.book.pages.length;
    const chapterIndex = renderBook.chapters[renderBook.chapters.length - 1]?.index ?? 0;
    this.book = renderBook;
    this.indexBook(renderBook); // rebuild positional tables (prior entries identical + the new unit)
    this.pipeline.setBook(renderBook);
    this.buffer.extend(renderBook.pages.length); // preserves existing slot state
    // Cadence control: when the image is DEFERRED (everyN / manual cadence), seed the new
    // unit so the buffer won't auto-render it — the BIBLE still extracts this beat below, so
    // continuity keeps building; `render_scene` / regenerate releases the image on demand.
    if (opts.illustrate === false) {
      const page = renderBook.pages[firstNewUnit]!;
      this.buffer.seed(firstNewUnit, { requestId: `page-${firstNewUnit}`, pageId: page.id, status: "skipped" });
    }
    // The new chapter isn't in processedChapters → automatically pending. Re-arm the bible
    // loop exactly like rebuildPrompts/regenerateStoryboard: it cancels any in-flight prior
    // run (run-token), then extracts ONLY the new chapter (prior ones are processed/skipped).
    if (this.generationStarted && !this.biblePaused) {
      this.biblePromise = this.buildBibleInBackground();
    }
    // Jump the new beat's image ahead of the strict in-order schedule — it's what the
    // reader is waiting on. Harmless before generation starts (it renders once it does).
    if (opts.illustrate !== false) this.buffer.prioritize(firstNewUnit);
    return { firstNewUnit, chapterIndex };
  }

  /**
   * On-demand (re)illustration of a story span: render the units in [fromUnit, toUnit]
   * (inclusive) right now — for "illustrate the last bit" / a manual-cadence catch-up, or
   * re-rolling a beat. Reuses the single-unit regenerate path so each unit re-renders from
   * its stored prompt with the tracked active scene. A deferred (skipped-seeded) unit is
   * released; a rendered one is re-rolled. Clamped to the story's units.
   */
  async renderScene(fromUnit: number, toUnit: number): Promise<void> {
    if (!this.book) return;
    const lo = Math.max(0, Math.min(fromUnit, toUnit));
    const hi = Math.min(this.book.pages.length - 1, Math.max(fromUnit, toUnit));
    for (let i = lo; i <= hi; i++) {
      if (this.isStoryPage(i)) await this.regenerateCurrentImage(i);
    }
  }
}

/** The anchor rewritten to the array reference form (legacy single id folded away). */
function withReferenceIds(anchor: IdentityAnchor, ids: string[]): IdentityAnchor {
  const { referenceImageId: _legacy, referenceImageIds: _old, ...rest } = anchor;
  return ids.length > 0 ? { ...rest, referenceImageIds: ids } : rest;
}

/** Next free numeric slot for a new reference id. New ids end `:n`; the legacy
 * un-suffixed id never matches, so it simply keeps its place in the array. */
function nextRefSlot(ids: string[]): number {
  let max = -1;
  for (const id of ids) {
    const m = /:(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Mark a chapter processed without adding entities (used when extraction fails). */
function markChapterProcessed(bible: VisualBible, chapterIndex: number): VisualBible {
  if (bible.processedChapters.includes(chapterIndex)) return bible;
  return { ...bible, processedChapters: [...bible.processedChapters, chapterIndex] };
}

/**
 * Concatenate each STORY chapter's page text, keyed by chapter index. Front/back
 * matter (chapter.isStory === false) is omitted entirely, so it's never analysed
 * and never blocks bible completion. Exported: the chat builds its book context
 * from the SAME segmentation so chapter indices/offsets line up with the bible.
 *
 * Memoized per book object (books are immutable once built): joining a whole
 * book is megabytes of string work, and both the bible build and every chat
 * turn call this. Callers must treat the returned map as read-only.
 */
const chapterTextCache = new WeakMap<BookSource, Map<number, string>>();
export function chapterText(book: BookSource): Map<number, string> {
  const cached = chapterTextCache.get(book);
  if (cached) return cached;
  const chapterById = new Map(book.chapters.map((c) => [c.id, c]));
  const byChapter = new Map<number, string[]>();
  for (const page of book.pages) {
    const chapter = chapterById.get(page.chapterId);
    if (chapter?.isStory === false) continue; // skip non-story matter
    const idx = chapter?.index ?? 0;
    const list = byChapter.get(idx) ?? [];
    list.push(...page.paragraphs.map((p) => p.text));
    byChapter.set(idx, list);
  }
  const result = new Map([...byChapter].map(([idx, parts]) => [idx, parts.join("\n\n")]));
  chapterTextCache.set(book, result);
  return result;
}
