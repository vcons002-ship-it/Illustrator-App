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
  it("renders the current page and look-ahead window within the concurrency limit", () => {
    const { render, started } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 10, render, windowAhead: 2, maxConcurrent: 2 });

    buf.setCurrentPage(0);

    // Only maxConcurrent renders start at once; current page is highest priority.
    expect(started).toEqual([0, 1]);
    expect(buf.statusOf(0)).toBe("rendering");
    expect(buf.statusOf(2)).toBe("queued");
  });

  it("advances the window and fills freed slots as renders settle", async () => {
    const { render, started, finish } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 10, render, windowAhead: 2, maxConcurrent: 2 });

    buf.setCurrentPage(0);
    expect(started).toEqual([0, 1]);

    await finish(0);
    // A slot freed → next window page (2) starts.
    expect(started).toEqual([0, 1, 2]);
    expect(buf.statusOf(0)).toBe("ready");
  });

  it("does not pre-render beyond the window unless idle is allowed", async () => {
    const { render, started, finish } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 100, render, windowAhead: 1, maxConcurrent: 4, maxPrerender: 50 });

    buf.setCurrentPage(0);
    // Window is current + 1 = pages 0,1 only.
    expect(started).toEqual([0, 1]);

    await finish(0);
    await finish(1);
    // Nothing past the window starts while idle is disallowed.
    expect(started).toEqual([0, 1]);

    buf.setIdleAllowed(true);
    expect(started).toContain(2);
  });

  it("caps speculative pre-rendering at maxPrerender", () => {
    const { render, started } = deferredRenderer();
    const buf = new RenderBuffer({
      totalPages: 1000,
      render,
      windowAhead: 0,
      maxConcurrent: 1000,
      maxPrerender: 5,
    });

    buf.setIdleAllowed(true);
    buf.setCurrentPage(0);

    // current (0) + 5 prerender = pages 0..5
    expect(Math.max(...started)).toBe(5);
    expect(started).toHaveLength(6);
  });

  it("renderAll eventually renders every page, current/window first", async () => {
    const { render, started, finish } = deferredRenderer();
    const buf = new RenderBuffer({ totalPages: 6, render, windowAhead: 1, maxConcurrent: 2, maxPrerender: 0 });

    buf.setCurrentPage(0);
    expect(started).toEqual([0, 1]); // priority window first

    buf.renderAll();
    // Still capped by concurrency until slots free up.
    expect(started).toEqual([0, 1]);

    for (let p = 0; p < 6; p++) await finish(p);

    // Every page got rendered, none twice.
    expect([...started].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(started).size).toBe(6);
  });

  it("notifies onUpdate on start and settle", async () => {
    const { render, finish } = deferredRenderer();
    const onUpdate = vi.fn();
    const buf = new RenderBuffer({ totalPages: 3, render, windowAhead: 0, maxConcurrent: 1, onUpdate });

    buf.setCurrentPage(0);
    expect(onUpdate).toHaveBeenCalledWith(0, expect.objectContaining({ status: "rendering" }));

    await finish(0);
    expect(onUpdate).toHaveBeenCalledWith(0, expect.objectContaining({ status: "ready" }));
  });
});
