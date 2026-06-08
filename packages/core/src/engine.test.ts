import { describe, it, expect, vi } from "vitest";
import { Engine } from "./engine.js";
import { MockLLMProvider } from "./providers/llm/mock-llm-provider.js";
import { MockImageProvider } from "./providers/image/mock-image-provider.js";
import { InMemoryStore } from "./storage/store.js";
import type { BookSource } from "./types/book.js";

function sampleBook(): BookSource {
  return {
    id: "book-1",
    title: "Test",
    chapters: [{ id: "c1", index: 0, title: "One" }],
    pages: [
      {
        id: "pg-0",
        index: 0,
        chapterId: "c1",
        paragraphs: [
          { id: "pg-0-0", index: 0, text: "Aria walked. Aria smiled. The bridge hummed." },
        ],
      },
      {
        id: "pg-1",
        index: 1,
        chapterId: "c1",
        paragraphs: [{ id: "pg-1-0", index: 0, text: "The corridor was empty and dark." }],
      },
    ],
  };
}

describe("Engine", () => {
  it("builds and caches a Visual Bible on open", async () => {
    const store = new InMemoryStore();
    const engine = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider(), store });

    await engine.openBook(sampleBook());
    engine.startGeneration();
    await engine.whenBibleReady();

    const bible = engine.getBible();
    expect(bible).toBeDefined();
    // "Aria" recurs, so the heuristic mock should have captured it.
    expect(bible!.characters.some((c) => c.name === "Aria")).toBe(true);
    expect(bible!.processedChapters).toContain(0);

    // Bible was persisted.
    expect(await store.getBible("book-1")).toBeDefined();
  });

  it("renders pages through the buffer and reports ready results", async () => {
    const updates: number[] = [];
    const engine = new Engine({
      llm: new MockLLMProvider(),
      image: new MockImageProvider(),
      onUpdate: (pageIndex, result) => {
        if (result.status === "ready") updates.push(pageIndex);
      },
    });

    await engine.openBook(sampleBook());
    engine.startGeneration();
    engine.goToPage(0);

    // Let the async renders settle.
    await vi.waitFor(() => {
      expect(engine.resultFor(0)?.status).toBe("ready");
    });
    // Result carries transferable image bytes (no realm-scoped object URL).
    expect(engine.resultFor(0)?.image?.bytes.byteLength).toBeGreaterThan(0);
    expect(updates).toContain(0);
  });

  it("on open restores cached images and generates nothing until startGeneration", async () => {
    const store = new InMemoryStore();
    // A page rendered in a previous session (keyed `${bookId}:${pageId}`).
    await store.putImage("book-1:pg-0", new Uint8Array([1, 2, 3]).buffer, "image/png");

    const llm = new MockLLMProvider();
    const extractSpy = vi.spyOn(llm, "extractEntities");
    const image = new MockImageProvider();
    const genSpy = vi.spyOn(image, "generate");

    const engine = new Engine({ llm, image, store });
    await engine.openBook(sampleBook());
    engine.goToPage(0);

    // The cached page shows immediately; nothing was extracted or generated.
    expect(engine.isGenerating()).toBe(false);
    expect(engine.resultFor(0)?.status).toBe("ready");
    expect(engine.resultFor(0)?.image?.bytes.byteLength).toBe(3);
    expect(extractSpy).not.toHaveBeenCalled();
    expect(genSpy).not.toHaveBeenCalled();
    // The uncached page is held (no fake "rendering").
    expect(engine.resultFor(1)).toBeUndefined();

    // Begin generating → extraction runs and the uncached page renders; the
    // cached page is NOT re-generated.
    engine.startGeneration();
    await engine.whenBibleReady();
    expect(extractSpy).toHaveBeenCalled();
    await vi.waitFor(() => expect(engine.resultFor(1)?.status).toBe("ready"));
    expect(genSpy).toHaveBeenCalledTimes(1); // only page 1 (page 0 came from cache)
  });

  it("renders a page as soon as its chapter is ready, without waiting for later chapters", async () => {
    // Two chapters; chapter 1's extraction is held open so the whole-book bible
    // can't finish. The page in chapter 0 must still render (interleaving).
    let releaseChapter1: (() => void) | undefined;
    const llm = new MockLLMProvider();
    const realExtract = llm.extractEntities.bind(llm);
    vi.spyOn(llm, "extractEntities").mockImplementation(async (input) => {
      if (input.chapterIndex === 1) {
        await new Promise<void>((resolve) => {
          releaseChapter1 = resolve;
        });
      }
      return realExtract(input);
    });

    const book: BookSource = {
      id: "book-2",
      title: "Two",
      chapters: [
        { id: "c0", index: 0, title: "Zero" },
        { id: "c1", index: 1, title: "One" },
      ],
      pages: [
        { id: "p0", index: 0, chapterId: "c0", paragraphs: [{ id: "p0-0", index: 0, text: "Aria walked. Aria smiled." }] },
        { id: "p1", index: 1, chapterId: "c1", paragraphs: [{ id: "p1-0", index: 0, text: "A later, gated scene." }] },
      ],
    };

    const engine = new Engine({ llm, image: new MockImageProvider() });
    await engine.openBook(book);
    engine.startGeneration();
    engine.goToPage(0);

    // Chapter 0's page renders even though chapter 1 (and thus the full bible) is stuck.
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
    // The gated page has not rendered yet.
    expect(engine.resultFor(1)?.status).not.toBe("ready");

    // Release chapter 1 → its page becomes renderable and the bible completes.
    releaseChapter1?.();
    await engine.whenBibleReady();
    await vi.waitFor(() => expect(engine.resultFor(1)?.status).toBe("ready"));
  });

  it("reports bible-build progress per pending chapter, and (0,0) when fully cached", async () => {
    const store = new InMemoryStore();

    const first: Array<[number, number]> = [];
    const a = new Engine({
      llm: new MockLLMProvider(),
      image: new MockImageProvider(),
      store,
      onBibleProgress: (done, total) => first.push([done, total]),
    });
    await a.openBook(sampleBook());
    a.startGeneration();
    await a.whenBibleReady();
    // One chapter to process: an initial (0,1) then a (1,1) on completion.
    expect(first).toEqual([
      [0, 1],
      [1, 1],
    ]);

    // Reopening the cached book has nothing pending → a single (0,0) report.
    const second: Array<[number, number]> = [];
    const b = new Engine({
      llm: new MockLLMProvider(),
      image: new MockImageProvider(),
      store,
      onBibleProgress: (done, total) => second.push([done, total]),
    });
    await b.openBook(sampleBook());
    b.startGeneration();
    await b.whenBibleReady();
    expect(second).toEqual([[0, 0]]);
  });

  it("does not re-extract chapters when reopening a cached book", async () => {
    const store = new InMemoryStore();
    const llm = new MockLLMProvider();
    const spy = vi.spyOn(llm, "extractEntities");

    const first = new Engine({ llm, image: new MockImageProvider(), store });
    await first.openBook(sampleBook());
    first.startGeneration();
    await first.whenBibleReady();
    const callsAfterFirst = spy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = new Engine({ llm, image: new MockImageProvider(), store });
    await second.openBook(sampleBook());
    second.startGeneration();
    await second.whenBibleReady();
    // Chapter already processed + cached → no further extraction calls.
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("whole-book mode renders nothing until every chapter is analysed", async () => {
    let releaseCh1: (() => void) | undefined;
    const llm = new MockLLMProvider();
    const realExtract = llm.extractEntities.bind(llm);
    vi.spyOn(llm, "extractEntities").mockImplementation(async (input) => {
      if (input.chapterIndex === 1) await new Promise<void>((r) => (releaseCh1 = r));
      return realExtract(input);
    });

    const engine = new Engine({ llm, image: new MockImageProvider(), illustrateAfter: "book" });
    await engine.openBook(twoChapterBook());
    engine.startGeneration();
    engine.goToPage(0);

    // Chapter 1 is held → bible incomplete → even chapter 0's page must not render.
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.resultFor(0)?.status).not.toBe("ready");

    releaseCh1?.();
    await engine.whenBibleReady();
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
  });

  it("regenerateCurrentImage clears the cache and re-renders the unit", async () => {
    const image = new MockImageProvider();
    const genSpy = vi.spyOn(image, "generate");
    const engine = new Engine({ llm: new MockLLMProvider(), image });
    await engine.openBook(sampleBook());
    engine.startGeneration();
    engine.goToPage(0);
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));

    const before = genSpy.mock.calls.length;
    await engine.regenerateCurrentImage(0);
    await vi.waitFor(() => expect(genSpy.mock.calls.length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
  });

  it("pause stops new renders; resume continues", async () => {
    let releaseCh1: (() => void) | undefined;
    const llm = new MockLLMProvider();
    const realExtract = llm.extractEntities.bind(llm);
    vi.spyOn(llm, "extractEntities").mockImplementation(async (input) => {
      if (input.chapterIndex === 1) await new Promise<void>((r) => (releaseCh1 = r));
      return realExtract(input);
    });
    const image = new MockImageProvider();
    const genSpy = vi.spyOn(image, "generate");

    const engine = new Engine({ llm, image, illustrateAfter: "chapter" });
    await engine.openBook(twoChapterBook());
    engine.startGeneration();
    engine.goToPage(0);
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));

    engine.pauseGeneration();
    const callsAtPause = genSpy.mock.calls.length;
    releaseCh1?.(); // chapter 1 extraction finishes, but paused → its page must not render
    await new Promise((r) => setTimeout(r, 20));
    expect(genSpy.mock.calls.length).toBe(callsAtPause);
    expect(engine.resultFor(1)?.status).not.toBe("ready");

    engine.resumeGeneration();
    await vi.waitFor(() => expect(engine.resultFor(1)?.status).toBe("ready"));
  });
});

function twoChapterBook(): BookSource {
  return {
    id: "book-2c",
    title: "Two",
    chapters: [
      { id: "c0", index: 0, title: "Zero" },
      { id: "c1", index: 1, title: "One" },
    ],
    pages: [
      { id: "p0", index: 0, chapterId: "c0", paragraphs: [{ id: "p0-0", index: 0, text: "Aria walked. Aria smiled." }] },
      { id: "p1", index: 1, chapterId: "c1", paragraphs: [{ id: "p1-0", index: 0, text: "A later, gated scene." }] },
    ],
  };
}
