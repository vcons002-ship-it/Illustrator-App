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
  render: (pageIndex: number) => Promise<ImageResult>;
  /** Pages ahead of the current page to keep actively rendered. Default 2. */
  windowAhead?: number;
  /** Max simultaneous renders. Default 2. */
  maxConcurrent?: number;
  /** Cap on speculative idle pre-rendering ahead of the window. Default 50. */
  maxPrerender?: number;
  /** Notified whenever a page's status changes. */
  onUpdate?: (pageIndex: number, result: ImageResult) => void;
}

export class RenderBuffer {
  private readonly totalPages: number;
  private readonly render: (pageIndex: number) => Promise<ImageResult>;
  private readonly windowAhead: number;
  private readonly maxConcurrent: number;
  private readonly maxPrerender: number;
  private readonly onUpdate?: ((pageIndex: number, result: ImageResult) => void) | undefined;

  private current = 0;
  private idleAllowed = false;
  private readonly inflight = new Set<number>();
  private readonly results = new Map<number, ImageResult>();

  constructor(options: RenderBufferOptions) {
    this.totalPages = options.totalPages;
    this.render = options.render;
    this.windowAhead = options.windowAhead ?? 2;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.maxPrerender = options.maxPrerender ?? 50;
    this.onUpdate = options.onUpdate;
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

  /** Pages, in priority order, that still need rendering. */
  private candidates(): number[] {
    const out: number[] = [];
    const last = this.totalPages - 1;
    const windowEnd = Math.min(last, this.current + this.windowAhead);
    // Highest priority: the current page, then the look-ahead window.
    for (let p = this.current; p <= windowEnd; p++) out.push(p);
    if (this.idleAllowed) {
      const prerenderEnd = Math.min(last, this.current + this.maxPrerender);
      for (let p = windowEnd + 1; p <= prerenderEnd; p++) out.push(p);
    }
    return out.filter((p) => !this.results.has(p) && !this.inflight.has(p));
  }

  /** Start renders up to the concurrency limit, honouring priority. */
  private pump(): void {
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
    this.render(pageIndex)
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
