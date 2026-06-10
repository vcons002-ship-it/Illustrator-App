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
import { createEmptyBible, migrateBible } from "./visual-bible/bible.js";
import { addKeyEvent, clearKeyEvents, resolveKeyEvent } from "./visual-bible/key-events.js";
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
    // Restore the cached bible, migrating it forward where we can (v5→v6 is additive)
    // so existing analysis survives; only un-migratable older schemas are rebuilt.
    const stored = await this.store.getBible(book.id);
    this.bible = (stored && migrateBible(stored)) ?? createEmptyBible(book.id);
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


  /** Has every chapter of the book been processed into the bible? */
  private isBibleComplete(): boolean {
    if (!this.book || !this.bible) return false;
    for (const idx of chapterText(this.book).keys()) {
      if (!this.bible.processedChapters.includes(idx)) return false;
    }
    return true;
  }

  /** Has every story unit had its illustration prompt written? */
  private arePromptsComplete(): boolean {
    if (!this.book) return false;
    for (let i = 0; i < this.book.pages.length; i++) {
      if (this.isStoryPage(i) && !this.hasKeyEvent(i)) return false;
    }
    return true;
  }

  /** The whole LLM phase (extraction + prompts) is done — nothing left to resume. */
  private isLlmPhaseComplete(): boolean {
    return this.isBibleComplete() && this.arePromptsComplete();
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
      if (stop()) return; // paused, or a newer run/book took over → stop before next chapter
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
            signal: ac.signal,
          });
        } catch {
          /* retry once, then give up on just this chapter */
        }
      }
      // A newer run/book may have taken over WHILE we awaited the LLM. Discard before
      // mutating any shared state so we never clobber the newly-opened book's bible.
      // (Note: a mere PAUSE does NOT discard — the completed extraction is committed so
      // in-flight work isn't wasted; the loop then stops at the next iteration's `stop()`.)
      if (cancelled()) return;
      if (next) {
        this.bible = next;
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

  /** The chapter's render-unit page ranges, in reading order (for folded prompts). A raw
   * single page (no explicit range) is its own unit at [index, index] — matching
   * buildRequest/hasKeyEvent so the folded keyEvents line up with the render units. */
  private unitRangesForChapter(chapterIndex: number): [number, number][] {
    if (!this.book) return [];
    const ranges: [number, number][] = [];
    for (const page of this.book.pages) {
      const idx = this.book.chapters.find((c) => c.id === page.chapterId)?.index ?? 0;
      if (idx === chapterIndex) ranges.push(page.pageRange ?? [page.index, page.index]);
    }
    return ranges;
  }

  /**
   * Write a Layer-1 image prompt for every story render unit that doesn't already have one
   * (the whole-book sweep). Reuses `writePromptsForUnits`, so it's the catch-all after the
   * folded-in extraction prompts (fills any gap) and for the on-demand "Rebuild prompts".
   */
  private async buildPromptsForUnits(myRun: number, signal: AbortSignal): Promise<void> {
    if (!this.book) return;
    const units = this.book.pages.map((_, i) => i).filter((i) => this.isStoryPage(i));
    await this.writePromptsForUnits(units, myRun, signal);
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
    const allUnits = this.book.pages.map((_, i) => i).filter((i) => this.isStoryPage(i));
    const total = allUnits.length;
    const reportProgress = (): void =>
      this.opts.onPromptProgress?.(allUnits.filter((i) => this.hasKeyEvent(i)).length, total);
    reportProgress();
    for (const i of unitIndices) {
      if (stop()) return;
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
        await this.store.putBible(this.bible);
        if (cancelled()) return;
        this.opts.onBibleUpdate?.(this.bible);
        // A unit previously failed as "no prompt" can render now — clear the error.
        if (this.buffer?.resultOf(i)?.status === "error") this.buffer.invalidate(i);
        // Releasing each unit as its prompt lands keeps the first image prompt-and renders.
        this.buffer?.refresh();
      }
      reportProgress();
    }
  }

  /** Whether this story unit already has a stored keyEvent prompt. */
  private hasKeyEvent(pageIndex: number): boolean {
    const page = this.book?.pages[pageIndex];
    if (!page || !this.bible) return false;
    const chapterIndex = this.book!.chapters.find((c) => c.id === page.chapterId)?.index ?? 0;
    // Match the range buildRequest/writePromptsForUnits store under (raw page → [i, i]).
    const range = page.pageRange ?? ([page.index, page.index] as [number, number]);
    return resolveKeyEvent(this.bible, chapterIndex, range) !== undefined;
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
   * Set (or clear) a user-uploaded reference image for a character — fed to IP-Adapter
   * when the ComfyUI nodes are installed. Auto-capture was removed (it biased every image
   * toward a portrait); consistency now comes from bible-term injection + the per-character
   * seed, with this as an optional, deliberate override.
   */
  async setCharacterReference(
    characterId: string,
    image: { bytes: ArrayBuffer; mimeType: string } | undefined,
  ): Promise<void> {
    if (!this.book || !this.bible) return;
    const refId = `${this.book.id}:charref:${characterId}`;
    if (image) await this.store.putImage(refId, image.bytes, image.mimeType);
    else await this.store.deleteImage?.(refId);
    this.bible = {
      ...this.bible,
      characters: this.bible.characters.map((c) =>
        c.id === characterId
          ? { ...c, anchor: setReference(c.anchor, image ? refId : undefined) }
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

  /** Discard one unit's cached image and re-render just it (e.g. to try a style). */
  async regenerateCurrentImage(unitIndex: number): Promise<void> {
    if (!this.pipeline) return;
    await this.store.deleteImage?.(this.pipeline.requestIdFor(unitIndex));
    this.startGeneration();
    this.resumeGeneration();
    // Drop its cached image, then explicitly prioritise THIS unit so it re-renders
    // next — ahead of the normal in-order schedule. (This is an explicit user action,
    // unlike passive scrolling, which never jumps the queue.)
    this.buffer?.invalidate(unitIndex);
    this.buffer?.prioritize(unitIndex);
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

/** Set or clear an anchor's reference image id. */
function setReference(anchor: IdentityAnchor, refId: string | undefined): IdentityAnchor {
  if (!refId) return dropReference(anchor);
  return { ...anchor, referenceImageId: refId };
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
