import type { ImageResult, RenderStatus } from "../types/content.js";

/**
 * In-order render buffer (spec Module 2, simplified).
 *
 * Generation works through the book strictly FRONT TO BACK — the reader's scroll
 * position never reorders or bounds it (position only drives the reveal, in the
 * UI). Staying ahead of the reader falls out naturally: the engine starts at
 * page one and keeps going, pacing only on the concurrency limit and the
 * `canRender` gate (a unit renders once its stored prompt exists).
 *
 * The actual render is injected (`render`), so this scheduler is pure logic and
 * unit-testable without providers, workers, or `URL.createObjectURL`. The web
 * app / extension wrap it in a Web Worker and feed it a RenderPipeline.
 */
export interface RenderBufferOptions {
  totalPages: number;
  /**
   * Render one page. `onProgress` (0..1) is passed so the renderer can report
   * generation progress; the buffer relays it as `rendering` updates with a
   * `progress` field. Renderers that can't report progress simply ignore it.
   */
  render: (
    pageIndex: number,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ) => Promise<ImageResult>;
  /** Max simultaneous renders. Default 2. */
  maxConcurrent?: number;
  /**
   * Gate: may this page be rendered yet? Used to hold pages whose illustration
   * prompt isn't in the Visual Bible yet (the bible builds in the background).
   * Gated pages stay `queued` and are retried on the next `refresh()`/`pump()`.
   * Default: always true.
   */
  canRender?: (pageIndex: number) => boolean;
  /**
   * Pages this returns true for are never rendered — they emit a one-time
   * `skipped` result instead. Used for front/back matter (non-story pages), which
   * stay readable but aren't illustrated. Default: nothing is skipped.
   */
  shouldSkip?: (pageIndex: number) => boolean;
  /**
   * Master switch for *new* generation. When false, no fresh renders start
   * (the buffer only serves pages seeded from cache via `seed`), so opening a
   * book can show prior-session images without kicking off generation until the
   * user explicitly begins. Default true.
   */
  generationEnabled?: boolean;
  /** Notified whenever a page's status changes. */
  onUpdate?: (pageIndex: number, result: ImageResult) => void;
}

export class RenderBuffer {
  private totalPages: number;
  private readonly render: (
    pageIndex: number,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ) => Promise<ImageResult>;
  private readonly maxConcurrent: number;
  private readonly canRender: (pageIndex: number) => boolean;
  private readonly shouldSkip: (pageIndex: number) => boolean;
  private readonly onUpdate?: ((pageIndex: number, result: ImageResult) => void) | undefined;

  private generationEnabled: boolean;
  /**
   * Units to render next, ahead of the in-order schedule, in REQUEST order (FIFO).
   * Pushed only by EXPLICIT user actions (regenerate this image) — never by passive
   * scrolling — so clicking several redos renders them one after another in the order
   * clicked (bounded by `maxConcurrent`), not all at once or last-click-first. Each
   * entry is removed once its render settles.
   */
  private readonly priorityQueue: number[] = [];
  /** Whether the one-time front/back-matter skip pass has run (re-run after invalidation). */
  private skipsApplied = false;
  private readonly inflight = new Set<number>();
  /** Abort controller per in-flight render, so a pause can cancel them mid-flight. */
  private readonly controllers = new Map<number, AbortController>();
  private readonly results = new Map<number, ImageResult>();

  constructor(options: RenderBufferOptions) {
    this.totalPages = options.totalPages;
    this.render = options.render;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.canRender = options.canRender ?? (() => true);
    this.shouldSkip = options.shouldSkip ?? (() => false);
    this.generationEnabled = options.generationEnabled ?? true;
    this.onUpdate = options.onUpdate;
  }

  /**
   * Re-evaluate what can render now. Call this when the `canRender` gate may have
   * changed (e.g. another chapter's bible entries just landed) so pages that were
   * held start without waiting for the reader to move.
   */
  refresh(): void {
    this.pump();
  }

  /**
   * Grow the page count after the book gained units at the END (a story "as you go"
   * append). Existing slot state (results, in-flight renders, the priority queue) is
   * keyed by index and left untouched — so already-rendered pages keep their images and
   * in-flight renders keep going. New higher indices simply become renderable. The skip
   * pass is re-armed so any new non-story pages get their one-time `skipped` result.
   * A no-op when `totalPages` isn't actually larger (never shrinks).
   */
  extend(totalPages: number): void {
    if (totalPages <= this.totalPages) return;
    this.totalPages = totalPages;
    this.skipsApplied = false; // re-mark: new pages may be front/back matter
    this.pump();
  }

  /** Turn fresh generation on/off (e.g. the "Begin generating book" action). */
  setGenerationEnabled(enabled: boolean): void {
    this.generationEnabled = enabled;
    // Pausing also cancels in-flight renders so the GPU frees immediately; each
    // aborted page drops back to "queued" and re-renders when generation resumes.
    if (!enabled) for (const ac of this.controllers.values()) ac.abort();
    this.pump();
  }

  /**
   * Record a result without rendering — used to surface a page's cached image
   * from a previous session. Seeded pages count as done, so generation skips them.
   */
  seed(pageIndex: number, result: ImageResult): void {
    this.results.set(pageIndex, result);
  }

  /** Drop a page's result so it re-renders (regenerate one image). */
  invalidate(pageIndex: number): void {
    this.results.delete(pageIndex);
    this.skipsApplied = false; // an invalidated non-story page must re-mark as skipped
    this.pump();
  }

  /** Drop every result so the whole book re-renders (regenerate all images). */
  invalidateAll(): void {
    this.results.clear();
    this.priorityQueue.length = 0; // back to a clean in-order pass
    this.skipsApplied = false;
    this.pump();
  }

  /** Current status of a page (or "queued" if not started). */
  statusOf(pageIndex: number): RenderStatus {
    if (this.results.has(pageIndex)) return this.results.get(pageIndex)!.status;
    if (this.inflight.has(pageIndex)) return "rendering";
    return "queued";
  }

  resultOf(pageIndex: number): ImageResult | undefined {
    return this.results.get(pageIndex);
  }

  /**
   * Queue one unit to render ahead of the in-order schedule — for the explicit
   * "regenerate this image" action only. Multiple calls form a FIFO queue, so several
   * redos render in the order requested; each entry clears once it settles. A unit
   * already queued isn't added twice (a double-click is a no-op).
   */
  prioritize(pageIndex: number): void {
    const p = clamp(pageIndex, 0, this.totalPages - 1);
    if (!this.priorityQueue.includes(p)) this.priorityQueue.push(p);
    this.pump();
  }

  /**
   * Up to `limit` pages, in priority order, that still need rendering. The pump
   * only ever starts `maxConcurrent − inflight` renders, so the scan stops as
   * soon as that many candidates are found instead of gating every page in the
   * book on each pump (the `canRender` gate isn't free).
   */
  private candidates(limit: number): number[] {
    if (!this.generationEnabled || limit <= 0) return []; // generation not started → nothing new
    const last = this.totalPages - 1;
    const want = (p: number): boolean =>
      p >= 0 &&
      p <= last &&
      !this.results.has(p) &&
      !this.inflight.has(p) &&
      // Hold pages whose prompt isn't ready yet; a later refresh() retries them.
      this.canRender(p);

    const out: number[] = [];
    // Explicit redo requests render first, in the ORDER they were clicked.
    for (const p of this.priorityQueue) {
      if (out.length >= limit) return out;
      if (want(p)) out.push(p);
    }

    // Strict in-order generation, front to back through the whole book: always fill
    // from the FIRST un-rendered unit forward. The reader's position never reorders
    // or bounds this (scrolling only affects the reveal) — staying ahead of the
    // reader falls out of simply starting at page one and not stopping.
    const queued = new Set(this.priorityQueue);
    for (let p = 0; p <= last && out.length < limit; p++) {
      if (queued.has(p)) continue; // already considered above
      if (want(p)) out.push(p);
    }
    return out;
  }

  /** Mark any not-yet-resolved page that should be skipped (front/back matter). */
  private applySkips(): void {
    for (let p = 0; p < this.totalPages; p++) {
      if (this.results.has(p) || this.inflight.has(p)) continue;
      if (!this.shouldSkip(p)) continue;
      const result: ImageResult = {
        requestId: `page-${p}`,
        pageId: `page-${p}`,
        status: "skipped",
      };
      this.results.set(p, result);
      this.onUpdate?.(p, result);
    }
  }

  /** Start renders up to the concurrency limit, honouring priority. */
  private pump(): void {
    // Front/back matter never changes, so the skip pass runs once — not per pump.
    if (!this.skipsApplied) {
      this.applySkips();
      this.skipsApplied = true;
    }
    for (const page of this.candidates(this.maxConcurrent - this.inflight.size)) {
      this.start(page);
    }
  }

  private start(pageIndex: number): void {
    this.inflight.add(pageIndex);
    const ac = new AbortController();
    this.controllers.set(pageIndex, ac);
    this.onUpdate?.(pageIndex, {
      requestId: `page-${pageIndex}`,
      pageId: `page-${pageIndex}`,
      status: "rendering",
    });
    // Relay generation progress as `rendering` updates, but only while this page
    // is still in flight (a settled page must never be reopened by a late frame).
    const onProgress = (fraction: number): void => {
      if (!this.inflight.has(pageIndex)) return;
      this.onUpdate?.(pageIndex, {
        requestId: `page-${pageIndex}`,
        pageId: `page-${pageIndex}`,
        status: "rendering",
        progress: Math.max(0, Math.min(1, fraction)),
      });
    };
    this.render(pageIndex, onProgress, ac.signal)
      .then((result) => this.settle(pageIndex, result))
      .catch((err) => {
        // A pause cancelled this render → drop it back to "queued" so it re-renders
        // on resume (NOT a real error). Distinguish by the controller's signal.
        if (ac.signal.aborted) {
          this.dropInflight(pageIndex);
          return;
        }
        this.settle(pageIndex, {
          requestId: `page-${pageIndex}`,
          pageId: `page-${pageIndex}`,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** An aborted render: forget it (no result) and report it back to "queued". */
  private dropInflight(pageIndex: number): void {
    this.inflight.delete(pageIndex);
    this.controllers.delete(pageIndex);
    this.onUpdate?.(pageIndex, {
      requestId: `page-${pageIndex}`,
      pageId: `page-${pageIndex}`,
      status: "queued",
    });
    // A slot freed up. If generation is still on (e.g. only ONE page was paused, or
    // we've since resumed), re-pump so the re-queued page renders without waiting.
    this.pump();
  }

  private settle(pageIndex: number, result: ImageResult): void {
    this.inflight.delete(pageIndex);
    this.results.set(pageIndex, result);
    const qi = this.priorityQueue.indexOf(pageIndex);
    if (qi >= 0) this.priorityQueue.splice(qi, 1); // this redo is done; the rest keep their order
    this.onUpdate?.(pageIndex, result);
    // A slot freed up — schedule the next highest-priority page.
    this.pump();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
