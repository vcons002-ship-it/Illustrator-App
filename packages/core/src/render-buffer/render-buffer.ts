import type { ImageResult, RenderStatus } from "../types/content.js";

/**
 * Just-In-Time predictive render buffer (spec Module 2).
 *
 * Maintains a sliding window ahead of the reader so an image is essentially
 * never awaited: the current page is rendered, the next pages are pre-rendered,
 * and — when the device is idle/powered — pages further ahead are speculatively
 * rendered up to a cap.
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
  render: (pageIndex: number, onProgress: (fraction: number) => void) => Promise<ImageResult>;
  /** Pages ahead of the current page to keep actively rendered. Default 2. */
  windowAhead?: number;
  /** Max simultaneous renders. Default 2. */
  maxConcurrent?: number;
  /** Cap on speculative idle pre-rendering ahead of the window. Default 50. */
  maxPrerender?: number;
  /**
   * Gate: may this page be rendered yet? Used to hold pages whose chapter isn't
   * in the Visual Bible yet (the bible builds in the background). Gated pages stay
   * `queued` and are retried on the next `refresh()`/`pump()`. Default: always true.
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
  private readonly totalPages: number;
  private readonly render: (
    pageIndex: number,
    onProgress: (fraction: number) => void,
  ) => Promise<ImageResult>;
  private readonly windowAhead: number;
  private readonly maxConcurrent: number;
  private readonly maxPrerender: number;
  private readonly canRender: (pageIndex: number) => boolean;
  private readonly shouldSkip: (pageIndex: number) => boolean;
  private readonly onUpdate?: ((pageIndex: number, result: ImageResult) => void) | undefined;

  private current = 0;
  private idleAllowed = false;
  private renderEverything = false;
  private generationEnabled: boolean;
  private readonly inflight = new Set<number>();
  private readonly results = new Map<number, ImageResult>();

  constructor(options: RenderBufferOptions) {
    this.totalPages = options.totalPages;
    this.render = options.render;
    this.windowAhead = options.windowAhead ?? 2;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.maxPrerender = options.maxPrerender ?? 50;
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

  /** Turn fresh generation on/off (e.g. the "Begin generating book" action). */
  setGenerationEnabled(enabled: boolean): void {
    this.generationEnabled = enabled;
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
    this.pump();
  }

  /** Drop every result so the whole book re-renders (regenerate all images). */
  invalidateAll(): void {
    this.results.clear();
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

  /** Whether speculative pre-rendering beyond the window is permitted. */
  setIdleAllowed(allowed: boolean): void {
    this.idleAllowed = allowed;
    this.pump();
  }

  /** Move the reader to a page; renders it and refreshes the look-ahead window. */
  setCurrentPage(pageIndex: number): void {
    this.current = clamp(pageIndex, 0, this.totalPages - 1);
    this.pump();
  }

  /**
   * Render every page now (the optional "pre-render the whole book" action),
   * ignoring the look-ahead window and idle cap. The current page and look-ahead
   * still take priority so reading stays responsive while the rest fills in.
   */
  renderAll(): void {
    this.renderEverything = true;
    this.pump();
  }

  /** Pages, in priority order, that still need rendering. */
  private candidates(): number[] {
    if (!this.generationEnabled) return []; // generation not started → nothing new
    const out: number[] = [];
    const last = this.totalPages - 1;
    const windowEnd = Math.min(last, this.current + this.windowAhead);
    // Highest priority: the current page, then the look-ahead window.
    for (let p = this.current; p <= windowEnd; p++) out.push(p);
    if (this.renderEverything) {
      // Whole-book pre-render: every remaining page, after the priority window.
      for (let p = 0; p <= last; p++) out.push(p);
    } else if (this.idleAllowed) {
      const prerenderEnd = Math.min(last, this.current + this.maxPrerender);
      for (let p = windowEnd + 1; p <= prerenderEnd; p++) out.push(p);
    }
    const seen = new Set<number>();
    return out.filter((p) => {
      if (seen.has(p) || this.results.has(p) || this.inflight.has(p)) return false;
      // Hold pages whose chapter isn't ready yet; a later refresh() retries them.
      if (!this.canRender(p)) return false;
      seen.add(p);
      return true;
    });
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
    this.applySkips();
    for (const page of this.candidates()) {
      if (this.inflight.size >= this.maxConcurrent) break;
      this.start(page);
    }
  }

  private start(pageIndex: number): void {
    this.inflight.add(pageIndex);
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
    this.render(pageIndex, onProgress)
      .then((result) => this.settle(pageIndex, result))
      .catch((err) =>
        this.settle(pageIndex, {
          requestId: `page-${pageIndex}`,
          pageId: `page-${pageIndex}`,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  private settle(pageIndex: number, result: ImageResult): void {
    this.inflight.delete(pageIndex);
    this.results.set(pageIndex, result);
    this.onUpdate?.(pageIndex, result);
    // A slot freed up — schedule the next highest-priority page.
    this.pump();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
