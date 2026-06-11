import { describe, it, expect, vi } from "vitest";
import { RenderBuffer } from "./render-buffer.js";
import type { ImageResult } from "../types/content.js";

function ready(pageIndex: number): ImageResult {
  return { requestId: `r${pageIndex}`, pageId: `p${pageIndex}`, status: "ready" };
}

/** A render fn whose promises resolve only when we say so, to test scheduling. */
function deferredRenderer() {
  const resolvers = new Map<number, () => void>();
  const started: number[] = [];
  const render = (pageIndex: number): Promise<ImageResult> => {
    started.push(pageIndex);
    return new Promise((resolve) => {
      resolvers.set(pageIndex, () => resolve(ready(pageIndex)));
    });
  };
  const finish = async (pageIndex: number) => {
    resolvers.get(pageIndex)?.();
    resolvers.delete(pageIndex);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { render, started, finish };
}

describe("RenderBuffer", () => {
  it("renders from the start of the book within the concurrency limit", () => {
    const { render, started } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 10, render, maxConcurrent: 2 });

    buf.refresh();

    // Only maxConcurrent renders start at once, strictly from page 0.
    expect(started).toEqual([0, 1]);
    expect(buf.statusOf(0)).toBe("rendering");
    expect(buf.statusOf(2)).toBe("queued");
  });

  it("fills freed slots in order until the whole book is rendered", async () => {
    const { render, started, finish } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 4, render, maxConcurrent: 2 });

    buf.refresh();
    expect(started).toEqual([0, 1]);

    await finish(0);
    expect(started).toEqual([0, 1, 2]); // a slot freed → next page in order
    expect(buf.statusOf(0)).toBe("ready");

    await finish(1);
    await finish(2);
    await finish(3);
    // Every page got rendered, none twice — no reader position needed.
    expect([...started].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(new Set(started).size).toBe(4);
  });

  it("generation is independent of the reader's position (no scroll coupling)", () => {
    const { render, started } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 20, render, maxConcurrent: 2 });

    // There is no position input at all — generation simply starts at the
    // beginning; the reveal (scroll) is handled entirely in the UI.
    buf.refresh();
    expect(started).toEqual([0, 1]);
  });

  it("keeps filling in ascending order as slots free", async () => {
    const { render, started, finish } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 20, render, maxConcurrent: 2 });
    buf.refresh();

    expect(started).toEqual([0, 1]);
    await finish(0);
    expect(started).toEqual([0, 1, 2]);
    await finish(1);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it("prioritize renders the chosen unit next, then returns to in-order", async () => {
    const { render, started, finish } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 20, render, maxConcurrent: 1 });
    buf.refresh();
    expect(started).toEqual([0]); // in order

    buf.prioritize(7); // explicit "regenerate this image" on unit 7
    await finish(0); // a slot frees
    expect(started).toEqual([0, 7]); // 7 jumps ahead of 1,2,3…

    await finish(7); // one-shot priority is consumed
    expect(started).toEqual([0, 7, 1]); // …then strictly in order again
  });

  it("multiple redos render in the order clicked, one at a time (FIFO, not all at once)", async () => {
    const { render, started, finish } = deferredRenderer();
    // Local-engine style: one render at a time. The classic "redo 12, then 10, then 11"
    // must replay in CLICK order — not last-click-first, and not all at once.
    const buf = new RenderBuffer({ totalPages: 20, render, maxConcurrent: 1 });
    // Seed everything so only explicit redos drive rendering (no in-order backfill).
    for (let p = 0; p < 20; p++) buf.seed(p, ready(p));

    buf.prioritize(12);
    buf.prioritize(10);
    buf.prioritize(11);
    buf.invalidate(12); // each redo drops the cached image…
    buf.invalidate(10);
    buf.invalidate(11);

    expect(started).toEqual([12]); // only ONE in flight, the first clicked
    await finish(12);
    expect(started).toEqual([12, 10]); // then the second clicked
    await finish(10);
    expect(started).toEqual([12, 10, 11]); // then the third — strict request order
  });

  it("a double-click on the same redo doesn't queue it twice", async () => {
    const { render, started, finish } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 20, render, maxConcurrent: 1 });
    for (let p = 0; p < 20; p++) buf.seed(p, ready(p));

    buf.invalidate(5);
    buf.prioritize(5);
    buf.prioritize(5); // double-click
    expect(started).toEqual([5]);
    await finish(5);
    expect(started).toEqual([5]); // not rendered again
  });

  it("invalidate re-queues a settled page (the 'paint forward' building block)", async () => {
    const { render, started, finish } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 2, render, maxConcurrent: 2 });
    buf.refresh();
    await finish(0);
    await finish(1);
    expect(buf.statusOf(1)).toBe("ready");

    // Discard page 1's result → it repaints; page 0 is untouched.
    buf.invalidate(1);
    expect(started).toEqual([0, 1, 1]);
    expect(buf.statusOf(0)).toBe("ready");
  });

  it("notifies onUpdate on start and settle", async () => {
    const { render, finish } = deferredRenderer();
    const onUpdate = vi.fn();
    const buf = new RenderBuffer({ totalPages: 3, render, maxConcurrent: 1, onUpdate });

    buf.refresh();
    expect(onUpdate).toHaveBeenCalledWith(0, expect.objectContaining({ status: "rendering" }));

    await finish(0);
    expect(onUpdate).toHaveBeenCalledWith(0, expect.objectContaining({ status: "ready" }));
  });

  it("relays render progress as rendering updates, clamped, and ignores late frames", async () => {
    let progress: ((f: number) => void) | undefined;
    let resolve: (() => void) | undefined;
    const render = (pageIndex: number, onProgress: (f: number) => void): Promise<ImageResult> => {
      progress = onProgress;
      return new Promise((r) => {
        resolve = () => r(ready(pageIndex));
      });
    };
    const onUpdate = vi.fn();
    const buf = new RenderBuffer({ totalPages: 1, render, maxConcurrent: 1, onUpdate });

    buf.refresh();
    progress!(0.5);
    expect(onUpdate).toHaveBeenCalledWith(0, expect.objectContaining({ status: "rendering", progress: 0.5 }));

    progress!(5); // out-of-range values are clamped to 0..1
    expect(onUpdate).toHaveBeenCalledWith(0, expect.objectContaining({ progress: 1 }));

    resolve!();
    await Promise.resolve();
    await Promise.resolve();
    expect(buf.statusOf(0)).toBe("ready");

    // A progress frame arriving after the page settled must not reopen it.
    onUpdate.mockClear();
    progress!(0.9);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
