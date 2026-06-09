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

  it("reports bible-build progress against story-chapter totals (100% when cached)", async () => {
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
    // One story chapter to process: an initial (0,1) then a (1,1) on completion.
    expect(first).toEqual([
      [0, 1],
      [1, 1],
    ]);

    // Reopening the cached book: nothing pending, but progress is reported against
    // ALL story chapters, so it shows 100% (1/1) immediately rather than 0/0.
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
    expect(second).toEqual([[1, 1]]);
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

  it("setImagePaused halts new renders while the Visual Bible keeps building", async () => {
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

    // Pause IMAGES only — the bible build must continue to completion (GPU balancing).
    engine.setImagePaused(true);
    const callsAtPause = genSpy.mock.calls.length;
    releaseCh1?.(); // chapter 1 extraction proceeds despite images being paused
    await engine.whenBibleReady();
    expect(engine.getBible()?.processedChapters).toContain(1); // bible finished while images paused
    await new Promise((r) => setTimeout(r, 20));
    expect(genSpy.mock.calls.length).toBe(callsAtPause); // …but no new image was rendered
    expect(engine.resultFor(1)?.status).not.toBe("ready");

    // Resuming images renders the now-ready chapter.
    engine.setImagePaused(false);
    await vi.waitFor(() => expect(engine.resultFor(1)?.status).toBe("ready"));
  });

  it("setBiblePaused halts extraction while images keep rendering", async () => {
    let releaseCh0: (() => void) | undefined;
    const llm = new MockLLMProvider();
    const realExtract = llm.extractEntities.bind(llm);
    const extractSpy = vi.spyOn(llm, "extractEntities").mockImplementation(async (input) => {
      if (input.chapterIndex === 0) await new Promise<void>((r) => (releaseCh0 = r));
      return realExtract(input);
    });

    const engine = new Engine({ llm, image: new MockImageProvider(), illustrateAfter: "chapter" });
    await engine.openBook(twoChapterBook());
    engine.startGeneration();
    engine.goToPage(0);
    // Wait until chapter 0's extraction is in flight (blocked on releaseCh0).
    await vi.waitFor(() => expect(releaseCh0).toBeDefined());

    // Pause the BIBLE before chapter 0 finishes → the loop stops before chapter 1.
    engine.setBiblePaused(true);
    releaseCh0?.();
    await engine.whenBibleReady(); // the loop returns at the pause checkpoint

    // Chapter 0 still renders (images never paused) but chapter 1 was never extracted.
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
    expect(engine.getBible()?.processedChapters).not.toContain(1);
    expect(extractSpy.mock.calls.filter((c) => c[0].chapterIndex === 1)).toHaveLength(0);
    expect(engine.resultFor(1)?.status).not.toBe("ready");

    // Resuming the bible extracts chapter 1, and its page can then render.
    engine.setBiblePaused(false);
    await engine.whenBibleReady();
    await vi.waitFor(() => expect(engine.resultFor(1)?.status).toBe("ready"));
  });

  it("opening another book cancels the previous book's in-flight bible build (no clobber)", async () => {
    let releaseA: (() => void) | undefined;
    const llm = new MockLLMProvider();
    const realExtract = llm.extractEntities.bind(llm);
    vi.spyOn(llm, "extractEntities").mockImplementation(async (input) => {
      if (input.bookId === "book-A") await new Promise<void>((r) => (releaseA = r));
      return realExtract(input);
    });
    const engine = new Engine({ llm, image: new MockImageProvider() });

    const bookA: BookSource = { ...sampleBook(), id: "book-A" };
    await engine.openBook(bookA);
    engine.startGeneration();
    await vi.waitFor(() => expect(releaseA).toBeDefined()); // A's chapter 0 extraction is in flight

    // Switch to a different book while A is mid-extraction.
    const bookB: BookSource = {
      id: "book-B",
      title: "B",
      chapters: [{ id: "cb", index: 0, title: "B0" }],
      pages: [{ id: "pb", index: 0, chapterId: "cb", paragraphs: [{ id: "pb-0", index: 0, text: "Zorp hummed." }] }],
    };
    await engine.openBook(bookB);

    // A's extraction now resolves — it must NOT clobber B's freshly-opened bible.
    releaseA?.();
    await new Promise((r) => setTimeout(r, 20));

    expect(engine.getBible()?.bookId).toBe("book-B");
    expect(engine.getBible()?.processedChapters).toEqual([]); // B hasn't been generated yet
    expect(engine.getBible()?.characters).toEqual([]); // A's cast never leaked into B
  });

  it("pausing the bible aborts the in-flight chapter; resume re-extracts it (in order)", async () => {
    let calls = 0;
    const llm = new MockLLMProvider();
    const real = llm.extractEntities.bind(llm);
    vi.spyOn(llm, "extractEntities").mockImplementation((input) => {
      calls++;
      if (calls === 1) {
        // First attempt hangs until the pause aborts its signal.
        return new Promise<never>((_, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      return real(input); // resume → real extraction succeeds
    });

    const engine = new Engine({ llm, image: new MockImageProvider() });
    await engine.openBook(sampleBook()); // one story chapter
    engine.startGeneration();
    await vi.waitFor(() => expect(calls).toBe(1)); // extraction in flight

    engine.setBiblePaused(true); // aborts the in-flight call → frees the GPU at once
    await engine.whenBibleReady();
    expect(engine.getBible()?.processedChapters).not.toContain(0); // NOT marked processed

    engine.setBiblePaused(false); // resume → re-extract the same chapter, in order
    await engine.whenBibleReady();
    expect(engine.getBible()?.processedChapters).toContain(0);
  });

  it("pausing images aborts the in-flight render; the unit re-renders on resume (not an error)", async () => {
    let started = 0;
    let aborted = 0;
    let live = true; // while true, a render hangs until its signal aborts
    const image = new MockImageProvider();
    vi.spyOn(image, "generate").mockImplementation((input) => {
      started++;
      return live
        ? new Promise<never>((_, reject) => {
            input.signal?.addEventListener("abort", () => {
              aborted++;
              reject(new DOMException("Aborted", "AbortError"));
            });
          })
        : Promise.resolve({ bytes: new ArrayBuffer(4), mimeType: "image/png" });
    });

    const engine = new Engine({ llm: new MockLLMProvider(), image, illustrateAfter: "chapter" });
    await engine.openBook(sampleBook());
    engine.startGeneration();
    engine.goToPage(0);
    await vi.waitFor(() => expect(started).toBeGreaterThan(0)); // a render is in flight

    engine.setImagePaused(true);
    await vi.waitFor(() => expect(aborted).toBeGreaterThan(0)); // in-flight render cancelled
    expect(engine.resultFor(0)?.status).not.toBe("error"); // dropped, not failed

    live = false; // re-renders now succeed
    engine.setImagePaused(false); // resume → the unit renders fresh
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
  });

  it("folds prompts into extraction — no per-unit buildImagePrompt during the build", async () => {
    const llm = new MockLLMProvider();
    const promptSpy = vi.spyOn(llm, "buildImagePrompt");
    const engine = new Engine({ llm, image: new MockImageProvider(), illustrateAfter: "book" });
    await engine.openBook(twoChapterBook());
    engine.startGeneration();
    await engine.whenBibleReady();

    // keyEvents came from the per-chapter extraction call, so the build wrote ZERO
    // separate prompt calls; every story chapter has its scene prompt.
    expect(promptSpy).not.toHaveBeenCalled();
    expect(engine.getBible()!.storyboard.every((s) => (s.keyEvents?.length ?? 0) > 0)).toBe(true);
  });

  it("precomputes illustration prompts into the bible, then renders with the LLM off", async () => {
    const llm = new MockLLMProvider();
    const engine = new Engine({ llm, image: new MockImageProvider(), illustrateAfter: "book" });
    await engine.openBook(twoChapterBook());
    engine.startGeneration();
    await engine.whenBibleReady(); // extraction THEN prompt precompute (chained)

    // Every story chapter now has a stored keyEvent prompt.
    const bible = engine.getBible()!;
    expect(bible.storyboard.filter((s) => (s.keyEvents?.length ?? 0) > 0).length).toBe(2);

    // A fresh render of a precomputed unit must NOT call the LLM (offline-capable).
    const spy = vi.spyOn(llm, "buildImagePrompt");
    await engine.regenerateCurrentImage(0);
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("rebuildPrompts clears and repopulates the stored prompts", async () => {
    const engine = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider() });
    await engine.openBook(twoChapterBook());
    engine.startGeneration();
    await engine.whenBibleReady();
    expect(engine.getBible()!.storyboard.some((s) => (s.keyEvents?.length ?? 0) > 0)).toBe(true);

    await engine.rebuildPrompts();
    await engine.whenBibleReady();
    expect(engine.getBible()!.storyboard.some((s) => (s.keyEvents?.length ?? 0) > 0)).toBe(true);
  });

  it("skips non-story chapters: never extracted, their pages emit 'skipped'", async () => {
    const llm = new MockLLMProvider();
    const spy = vi.spyOn(llm, "extractEntities");
    const book: BookSource = {
      id: "book-fm",
      title: "FM",
      chapters: [
        { id: "c0", index: 0, title: "Copyright", isStory: false },
        { id: "c1", index: 1, title: "One" },
      ],
      pages: [
        { id: "p0", index: 0, chapterId: "c0", paragraphs: [{ id: "p0-0", index: 0, text: "© 2026 Someone." }] },
        { id: "p1", index: 1, chapterId: "c1", paragraphs: [{ id: "p1-0", index: 0, text: "Aria walked. Aria smiled." }] },
      ],
    };
    const engine = new Engine({ llm, image: new MockImageProvider() });
    await engine.openBook(book);
    engine.startGeneration();
    await engine.whenBibleReady();

    // The non-story chapter (index 0) was never sent to the LLM.
    for (const call of spy.mock.calls) expect(call[0]!.chapterIndex).not.toBe(0);
    // Its page is skipped (not a fake "rendering"); the story page renders.
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("skipped"));
    await vi.waitFor(() => expect(engine.resultFor(1)?.status).toBe("ready"));
  });

  it("updateCharacter applies the edit and persists it to the store", async () => {
    const store = new InMemoryStore();
    const engine = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider(), store });
    await engine.openBook(sampleBook());
    engine.startGeneration();
    await engine.whenBibleReady();

    const aria = engine.getBible()!.characters.find((c) => c.name === "Aria")!;
    await engine.updateCharacter(aria.id, { appearance: { hair: "silver" }, clothing: ["red coat"] });

    const updated = engine.getBible()!.characters.find((c) => c.id === aria.id)!;
    expect(updated.appearance.hair).toBe("silver");
    expect(updated.clothing).toEqual(["red coat"]);
    // Persisted, so a re-open keeps the correction.
    const persisted = await store.getBible("book-1");
    expect(persisted!.characters.find((c) => c.id === aria.id)!.appearance.hair).toBe("silver");
  });

  it("captures a solo character's reference image on first render, and clears it on edit", async () => {
    const store = new InMemoryStore();
    const engine = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider(), store });
    await engine.openBook(sampleBook()); // page 0 features only "Aria"
    engine.startGeneration();
    engine.goToPage(0);
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));

    // A solo frame became Aria's reference image (stored + recorded on the anchor).
    let aria: { id: string; anchor: { referenceImageId?: string } } | undefined;
    await vi.waitFor(() => {
      aria = engine.getBible()!.characters.find((c) => c.name === "Aria");
      expect(aria?.anchor.referenceImageId).toBe("book-1:charref:char-aria");
    });
    expect(await store.getImage("book-1:charref:char-aria")).toBeDefined();

    // Editing the look drops the now-stale reference.
    await engine.updateCharacter(aria!.id, { appearance: { hair: "blue" } });
    expect(
      engine.getBible()!.characters.find((c) => c.id === aria!.id)!.anchor.referenceImageId,
    ).toBeUndefined();
  });

  it("passes a non-empty subject (name fallback) for every present character", async () => {
    const image = new MockImageProvider();
    const genSpy = vi.spyOn(image, "generate");
    const engine = new Engine({ llm: new MockLLMProvider(), image });
    await engine.openBook(sampleBook());
    engine.startGeneration();
    engine.goToPage(0);
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));

    const call = genSpy.mock.calls.find((c) => (c[0].subjects?.length ?? 0) > 0);
    expect(call?.[0].subjects?.[0]?.name).toBe("Aria");
  });

  it("updateCharacter applies an edited outfit list and persists it", async () => {
    const store = new InMemoryStore();
    const engine = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider(), store });
    await engine.openBook(sampleBook());
    engine.startGeneration();
    await engine.whenBibleReady();
    const aria = engine.getBible()!.characters.find((c) => c.name === "Aria")!;

    await engine.updateCharacter(aria.id, {
      outfits: [{ label: "armour", description: "steel plate", context: "battle" }],
    });
    const updated = engine.getBible()!.characters.find((c) => c.id === aria.id)!;
    expect(updated.outfits).toEqual([{ label: "armour", description: "steel plate", context: "battle" }]);
    const persisted = await store.getBible("book-1");
    expect(persisted!.characters.find((c) => c.id === aria.id)!.outfits?.[0]?.label).toBe("armour");
  });

  it("carries a prior book's bible into the current book (entities; resets storyboard)", async () => {
    const store = new InMemoryStore();
    const a = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider(), store });
    await a.openBook(sampleBook()); // book-1, features "Aria"
    a.startGeneration();
    await a.whenBibleReady();
    expect(a.getBible()!.characters.some((c) => c.name === "Aria")).toBe(true);
    expect(a.getBible()!.storyboard.length).toBeGreaterThan(0);

    const bookB: BookSource = { ...sampleBook(), id: "book-2" };
    const b = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider(), store });
    await b.openBook(bookB);
    const r = await b.carryOverBibleFrom("book-1");
    expect(r.ok).toBe(true);
    const bible = b.getBible()!;
    expect(bible.characters.some((c) => c.name === "Aria")).toBe(true); // carried forward
    expect(bible.storyboard).toEqual([]); // book-specific → reset
    expect(bible.processedChapters).toEqual([]); // re-read its own chapters
    expect(bible.bookId).toBe("book-2");
  });

  it("retries a failed chapter once, then continues with a note", async () => {
    const llm = new MockLLMProvider();
    let calls = 0;
    vi.spyOn(llm, "extractEntities").mockImplementation(async () => {
      calls++;
      throw new Error("transient");
    });
    const notes: string[] = [];
    const engine = new Engine({
      llm,
      image: new MockImageProvider(),
      onBibleNote: (m) => notes.push(m),
    });
    await engine.openBook(sampleBook()); // 1 story chapter
    engine.startGeneration();
    await engine.whenBibleReady();
    expect(calls).toBe(2); // initial + one retry
    expect(notes.some((n) => /failed/i.test(n))).toBe(true);
    expect(engine.getBible()!.processedChapters).toContain(0); // not gated forever
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
      { id: "p0", index: 0, chapterId: "c0", pageRange: [0, 0], paragraphs: [{ id: "p0-0", index: 0, text: "Aria walked. Aria smiled." }] },
      { id: "p1", index: 1, chapterId: "c1", pageRange: [1, 1], paragraphs: [{ id: "p1-0", index: 0, text: "A later, gated scene." }] },
    ],
  };
}
