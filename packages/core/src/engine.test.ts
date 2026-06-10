import { describe, it, expect, vi } from "vitest";
import { Engine } from "./engine.js";
import { MockLLMProvider } from "./providers/llm/mock-llm-provider.js";
import { MockImageProvider } from "./providers/image/mock-image-provider.js";
import { InMemoryStore } from "./storage/store.js";
import { DEFAULT_TIER_CONFIG } from "./types/tier.js";
import { referenceIdsOf } from "./types/bible.js";
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

  it("setBiblePaused halts the LLM phase; an already-prompted image keeps its render", async () => {
    let releaseCh1: (() => void) | undefined;
    const llm = new MockLLMProvider();
    const realExtract = llm.extractEntities.bind(llm);
    vi.spyOn(llm, "extractEntities").mockImplementation(async (input) => {
      if (input.chapterIndex === 1) await new Promise<void>((r) => (releaseCh1 = r));
      return realExtract(input);
    });

    const engine = new Engine({ llm, image: new MockImageProvider(), illustrateAfter: "chapter" });
    await engine.openBook(twoChapterBook());
    engine.startGeneration();
    // Chapter 0 extracts, gets its prompt, and renders (images are never paused here).
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));

    // Pause the BIBLE while chapter 1's extraction is in flight.
    await vi.waitFor(() => expect(releaseCh1).toBeDefined());
    engine.setBiblePaused(true);
    releaseCh1?.();
    await engine.whenBibleReady(); // the LLM phase stops at the pause checkpoint

    // Chapter 0's image stands (images weren't paused); chapter 1's prompt wasn't written
    // while the bible was paused, so its page holds.
    expect(engine.resultFor(0)?.status).toBe("ready");
    expect(engine.resultFor(1)?.status).not.toBe("ready");

    // Resuming the bible writes chapter 1's prompt, and its page then renders.
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

  it("a unit whose prompt can't be written errors VISIBLY, and ↻ Prompts recovers it", async () => {
    // The LLM yields no keyEvents AND fails the per-unit sweep → in the old code the
    // unit sat silently queued forever behind the canRender gate.
    const llm = new MockLLMProvider();
    vi.spyOn(llm, "extractEntities").mockImplementation(async (input) => {
      // Entities only — no folded keyEvents (e.g. a small model ignoring the field).
      const { unitRanges: _drop, ...rest } = input;
      void _drop;
      return MockLLMProvider.prototype.extractEntities.call(new MockLLMProvider(), rest);
    });
    let promptsFail = true;
    vi.spyOn(llm, "buildImagePrompt").mockImplementation(async () => {
      if (promptsFail) throw new Error("model offline");
      return "a recovered scene prompt";
    });
    const notes: string[] = [];
    const engine = new Engine({
      llm,
      image: new MockImageProvider(),
      onBibleNote: (m) => notes.push(m),
    });
    await engine.openBook(sampleBook());
    engine.startGeneration();
    await engine.whenBibleReady();

    // Visible failure, not a silent forever-queue.
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("error"));
    expect(engine.resultFor(0)?.error).toMatch(/prompt/i);
    expect(notes.some((n) => /prompt/i.test(n))).toBe(true);

    // The model comes back → ↻ Prompts rewrites them and the unit renders.
    promptsFail = false;
    await engine.rebuildPrompts();
    await engine.whenBibleReady();
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
  });

  it("paintForward repaints from the chosen unit onward, keeping earlier images", async () => {
    const image = new MockImageProvider();
    const genSpy = vi.spyOn(image, "generate");
    const engine = new Engine({ llm: new MockLLMProvider(), image });
    await engine.openBook(sampleBook()); // 2 units
    engine.startGeneration();
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
    await vi.waitFor(() => expect(engine.resultFor(1)?.status).toBe("ready"));
    const callsBefore = genSpy.mock.calls.length;
    const firstImage = engine.resultFor(0)?.image;

    // Repaint from unit 1 onward: unit 0's image is untouched, unit 1 re-renders.
    await engine.paintForward(1);
    await vi.waitFor(() => expect(engine.resultFor(1)?.status).toBe("ready"));
    expect(genSpy.mock.calls.length).toBe(callsBefore + 1); // exactly one repaint
    expect(engine.resultFor(0)?.image).toBe(firstImage); // earlier unit kept as-is
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

  it("does NOT auto-capture a reference image; user uploads add/remove them", async () => {
    const store = new InMemoryStore();
    const engine = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider(), store });
    await engine.openBook(sampleBook()); // page 0 features only "Aria"
    engine.startGeneration();
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));

    // Auto-capture was removed — rendering never pins a reference image.
    const aria = engine.getBible()!.characters.find((c) => c.name === "Aria")!;
    expect(referenceIdsOf(aria.anchor)).toEqual([]);

    // Deliberate user uploads append (multi-view), capped at MAX_CHARACTER_REFS.
    const png = (n: number) => ({ bytes: new Uint8Array([n]).buffer, mimeType: "image/png" });
    await engine.addCharacterReference(aria.id, png(1));
    await engine.addCharacterReference(aria.id, png(2));
    await engine.addCharacterReference(aria.id, png(3));
    await engine.addCharacterReference(aria.id, png(4)); // over the cap → ignored
    const ids = referenceIdsOf(engine.getBible()!.characters.find((c) => c.id === aria.id)!.anchor);
    expect(ids).toEqual([
      "book-1:charref:char-aria:0",
      "book-1:charref:char-aria:1",
      "book-1:charref:char-aria:2",
    ]);
    for (const id of ids) expect(await store.getImage(id)).toBeDefined();
    expect(await engine.getCharacterReference(ids[1]!)).toBeDefined();

    // Removing one deletes its bytes and keeps the others; a re-add gets a fresh slot.
    await engine.removeCharacterReference(aria.id, ids[1]!);
    expect(await store.getImage(ids[1]!)).toBeUndefined();
    await engine.addCharacterReference(aria.id, png(5));
    expect(
      referenceIdsOf(engine.getBible()!.characters.find((c) => c.id === aria.id)!.anchor),
    ).toEqual([
      "book-1:charref:char-aria:0",
      "book-1:charref:char-aria:2",
      "book-1:charref:char-aria:3", // max existing slot (2) + 1 — never collides
    ]);
  });

  it("folds a legacy single referenceImageId into the array form on the next change", async () => {
    const store = new InMemoryStore();
    const engine = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider(), store });
    await engine.openBook(sampleBook());
    engine.startGeneration();
    await vi.waitFor(() => expect(engine.getBible()!.characters.some((c) => c.name === "Aria")).toBe(true));
    const aria = engine.getBible()!.characters.find((c) => c.name === "Aria")!;
    // Simulate a pre-multi-view cached bible: the old single-id field, no array.
    const legacyId = "book-1:charref:char-aria";
    await store.putImage(legacyId, new Uint8Array([1]).buffer, "image/png");
    const bible = engine.getBible()!;
    await store.putBible({
      ...bible,
      characters: bible.characters.map((c) =>
        c.id === aria.id ? { ...c, anchor: { ...c.anchor, referenceImageId: legacyId } } : c,
      ),
    });
    await engine.openBook(sampleBook()); // restore the legacy-shaped bible from cache

    const before = engine.getBible()!.characters.find((c) => c.id === aria.id)!.anchor;
    expect(referenceIdsOf(before)).toEqual([legacyId]); // legacy form readable as one ref
    await engine.addCharacterReference(aria.id, { bytes: new Uint8Array([2]).buffer, mimeType: "image/png" });
    const anchor = engine.getBible()!.characters.find((c) => c.id === aria.id)!.anchor;
    expect(anchor.referenceImageId).toBeUndefined(); // legacy field rewritten away
    expect(anchor.referenceImageIds).toEqual([legacyId, "book-1:charref:char-aria:0"]);
  });

  it("keeps user-uploaded reference images when the character's looks are edited", async () => {
    const store = new InMemoryStore();
    const engine = new Engine({ llm: new MockLLMProvider(), image: new MockImageProvider(), store });
    await engine.openBook(sampleBook());
    engine.startGeneration();
    await vi.waitFor(() => expect(engine.getBible()!.characters.some((c) => c.name === "Aria")).toBe(true));
    const aria = engine.getBible()!.characters.find((c) => c.name === "Aria")!;
    await engine.addCharacterReference(aria.id, { bytes: new Uint8Array([7]).buffer, mimeType: "image/png" });
    const refId = "book-1:charref:char-aria:0";

    // Editing the text appearance/clothing/outfits must NOT discard the manual upload —
    // it's the user's ground-truth likeness (auto-capture, which justified dropping it,
    // is gone). Only the explicit "Remove" clears it.
    await engine.updateCharacter(aria.id, {
      appearance: { hair: "auburn" },
      clothing: ["green cloak"],
      outfits: [{ label: "travel", description: "worn leather", context: "" }],
    });

    const after = engine.getBible()!.characters.find((c) => c.id === aria.id)!;
    expect(after.appearance.hair).toBe("auburn"); // edit applied
    expect(referenceIdsOf(after.anchor)).toEqual([refId]); // reference survived
    expect(await store.getImage(refId)).toBeDefined(); // bytes still stored
  });

  it("passes bible terms (name + descriptor) for every present character to the backend", async () => {
    const image = new MockImageProvider();
    const genSpy = vi.spyOn(image, "generate");
    const engine = new Engine({
      llm: new MockLLMProvider(),
      image,
      tier: { ...DEFAULT_TIER_CONFIG, tier: "local" }, // local → terms passed for backend injection
    });
    await engine.openBook(sampleBook());
    engine.startGeneration();
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));

    // The mock prompt names "Aria", so the term scan finds her and passes a descriptor term.
    const call = genSpy.mock.calls.find((c) =>
      (c[0].terms ?? []).some((t) => t.kind === "character" && t.names.includes("Aria")),
    );
    expect(call).toBeDefined();
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
