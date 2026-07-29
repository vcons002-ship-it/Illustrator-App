import { describe, it, expect } from "vitest";
import { RenderPipeline, countSceneSubjects, nameActiveScene } from "./pipeline.js";
import { InMemoryStore } from "../storage/store.js";
import { createEmptyBible } from "../visual-bible/bible.js";
import { DEFAULT_TIER_CONFIG } from "../types/tier.js";
import { emptyAppearance } from "../types/bible.js";
import { unitSeed } from "./unit-seed.js";
import type { BookSource } from "../types/book.js";
import type { Character, VisualBible } from "../types/bible.js";
import type { LLMProvider } from "../providers/llm/llm-provider.js";
import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "../providers/image/image-provider.js";

function oneParagraphBook(text = "a quiet room"): BookSource {
  return {
    id: "book-1",
    title: "Test",
    chapters: [{ id: "ch-0", index: 0, title: "I" }],
    pages: [{ id: "pg-0", index: 0, chapterId: "ch-0", paragraphs: [{ id: "pg-0-0", index: 0, text }] }],
  };
}

const llm: LLMProvider = {
  id: "mock",
  extractEntities: async (i): Promise<VisualBible> => i.existing,
  buildImagePrompt: async () => "a knight by a window",
};

/** Image provider that records the prompt it was asked to render. */
function recordingImage(): { provider: ImageProvider; lastPrompt: () => string } {
  let seen = "";
  const provider: ImageProvider = {
    id: "mock",
    generate: async (input: ImageGenerationInput): Promise<ImageGenerationOutput> => {
      seen = input.prompt;
      return { bytes: new ArrayBuffer(1), mimeType: "image/png" };
    },
  };
  return { provider, lastPrompt: () => seen };
}

/** A bible carrying one stored Layer-1 prompt for page range [0,0]. */
function bibleWithPrompt(bookId: string, text: string) {
  const bible = createEmptyBible(bookId);
  bible.storyboard.push({
    chapterIndex: 0,
    summary: "",
    keyMoment: "",
    location: "",
    locationChange: "",
    keyEvents: [{ pageRange: [0, 0], imagePrompt: { text } }],
  });
  return bible;
}

describe("RenderPipeline style injection", () => {
  it("appends the selected style's prompt suffix", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, style: "anime" },
    });

    await pipeline.renderPage(0);

    expect(lastPrompt()).toContain("a knight by a window");
    expect(lastPrompt()).toContain("anime illustration");
  });

  it("adds nothing for the 'auto' style", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, style: "auto" },
    });

    await pipeline.renderPage(0);

    expect(lastPrompt()).toBe("a knight by a window");
  });
});

describe("RenderPipeline technical content mode", () => {
  it("a technical book's requests carry the technical_illustration kind; without figure search it skips (never generates)", async () => {
    const book = oneParagraphBook("Mitochondria convert glucose into ATP.");
    book.contentMode = "technical";
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a cutaway view of a mitochondrion");
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: DEFAULT_TIER_CONFIG,
    });

    expect(pipeline.buildRequest(book.pages[0]!).kind).toBe("technical_illustration");
    const result = await pipeline.renderPage(0);
    expect(result.status).toBe("skipped"); // no retrieval available → no image, no generation
    expect(lastPrompt()).toBe(""); // the AI image model was never called
  });

  it("a fiction book keeps scene_illustration", () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const pipeline = new RenderPipeline({
      book,
      getBible: () => createEmptyBible(book.id),
      llm,
      image: recordingImage().provider,
      store: new InMemoryStore(),
      tier: DEFAULT_TIER_CONFIG,
    });
    expect(pipeline.buildRequest(book.pages[0]!).kind).toBe("scene_illustration");
  });
});

describe("RenderPipeline technical figure retrieval", () => {
  const png = new TextEncoder().encode("REAL_FIGURE").buffer;

  function technicalSetup(retrieve: (q: string) => Promise<import("../providers/image/image-search.js").RetrievedImage | undefined>) {
    const book = oneParagraphBook("The Krebs cycle has eight steps.");
    book.contentMode = "technical";
    book.pages[0]!.pageRange = [0, 0];
    const bible = createEmptyBible(book.id);
    bible.storyboard.push({
      chapterIndex: 0,
      summary: "",
      keyMoment: "",
      location: "",
      locationChange: "",
      keyEvents: [
        {
          pageRange: [0, 0],
          imagePrompt: {
            subject: "the Krebs cycle",
            action: "shows the eight steps in order",
            environment: "step-by-step process diagram",
            mood: "clean",
            composition: "left to right",
          },
        },
      ],
    });
    let generated = 0;
    const provider: ImageProvider = {
      id: "mock",
      generate: async (): Promise<ImageGenerationOutput> => {
        generated++;
        return { bytes: new ArrayBuffer(1), mimeType: "image/png" };
      },
    };
    const queries: string[] = [];
    const store = new InMemoryStore();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store,
      tier: DEFAULT_TIER_CONFIG,
      imageSearch: {
        retrieve: (q: string) => {
          queries.push(q);
          return retrieve(q);
        },
      },
    });
    return { pipeline, store, queries, generatedCount: () => generated };
  }

  it("still retrieves when the plan has no structured subject (falls back to prompt text)", async () => {
    const { pipeline, queries, generatedCount } = technicalSetup(async () => ({
      bytes: { bytes: png, mimeType: "image/png" },
    }));
    // Simulate an under-structured plan: only a freeform text prompt, no subject.
    const bible = (pipeline as unknown as { deps: { getBible: () => VisualBible } }).deps.getBible();
    bible.storyboard[0]!.keyEvents![0]!.imagePrompt = { text: "carnot cycle pressure-volume diagram" };
    const result = await pipeline.renderPage(0);
    expect(queries.length).toBeGreaterThan(0); // retrieval still ran
    expect(queries[0]).toContain("carnot cycle");
    expect(generatedCount()).toBe(0); // real figure beat generation
    expect(result.status).toBe("ready");
  });

  it("retrieves a REAL figure first (cached like a generated image; no generation)", async () => {
    const { pipeline, store, queries, generatedCount } = technicalSetup(async () => ({
      bytes: { bytes: png, mimeType: "image/png" },
      contextLink: "https://example.org/krebs",
      title: "The Krebs cycle",
    }));

    const result = await pipeline.renderPage(0);

    expect(queries[0]).toBe("the Krebs cycle step-by-step process diagram"); // LLM plan drives the query
    expect(generatedCount()).toBe(0); // the AI image model was never called
    expect(result.status).toBe("ready");
    expect(new TextDecoder().decode(result.image!.bytes)).toBe("REAL_FIGURE");
    expect(result.prompt).toContain("Retrieved figure");
    expect(result.prompt).toContain("https://example.org/krebs"); // attribution in the caption
    expect(await store.getImage(result.requestId)).toBeDefined(); // persisted like any render
  });

  it("hotlink-only figures display via sourceUrl (not persisted; re-resolved next session)", async () => {
    const { pipeline, store, generatedCount } = technicalSetup(async () => ({
      sourceUrl: "https://tbn.gstatic.com/k1",
    }));
    const result = await pipeline.renderPage(0);
    expect(result.status).toBe("ready");
    expect(result.sourceUrl).toBe("https://tbn.gstatic.com/k1");
    expect(result.image).toBeUndefined();
    expect(generatedCount()).toBe(0);
    expect(await store.getImage(result.requestId)).toBeUndefined();
  });

  it("NEVER generates when nothing is found or search fails — skips with a note instead", async () => {
    // A plausible-looking invented diagram would corrupt the technical book's
    // source of truth, so the fallback is a skip (the UI explains the concept).
    const { pipeline, generatedCount } = technicalSetup(async () => undefined);
    const result = await pipeline.renderPage(0);
    expect(result.status).toBe("skipped");
    expect(result.prompt).toContain("No verified figure found");
    expect(result.prompt).toContain("the Krebs cycle");
    expect(generatedCount()).toBe(0);

    const failing = technicalSetup(async () => {
      throw new Error("quota exceeded");
    });
    expect((await failing.pipeline.renderPage(0)).status).toBe("skipped");
    expect(failing.generatedCount()).toBe(0);
  });

  it("fiction books never search — retrieval is technical-only", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const { provider } = recordingImage();
    let searched = 0;
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: DEFAULT_TIER_CONFIG,
      imageSearch: {
        retrieve: async () => {
          searched++;
          return undefined;
        },
      },
    });
    await pipeline.renderPage(0);
    expect(searched).toBe(0);
  });
});

describe("RenderPipeline world style vs explicit art style", () => {
  async function renderWithStyle(styleId: string) {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    bible.worldStyle = "grim dark fantasy world";
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, style: styleId }, // cloud tier → reference expansion
    });
    await pipeline.renderPage(0);
    return lastPrompt();
  }

  it("auto style: the bible's world style rides along in the reference block", async () => {
    expect(await renderWithStyle("auto")).toContain("grim dark fantasy world");
  });

  it("explicit style WINS: the world style is omitted so two Style directives never compete", async () => {
    const prompt = await renderWithStyle("watercolor");
    expect(prompt).not.toContain("grim dark fantasy world");
    expect(prompt).toContain("watercolor painting"); // the chosen style's suffix is there
  });
});

describe("RenderPipeline style LoRA override", () => {
  function inputRecorder(): { provider: ImageProvider; last: () => ImageGenerationInput } {
    let seen: ImageGenerationInput | undefined;
    const provider: ImageProvider = {
      id: "mock",
      generate: async (input): Promise<ImageGenerationOutput> => {
        seen = input;
        return { bytes: new ArrayBuffer(1), mimeType: "image/png" };
      },
    };
    return { provider, last: () => seen! };
  }

  async function renderWithTier(tier: Partial<typeof DEFAULT_TIER_CONFIG>) {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const { provider, last } = inputRecorder();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, tier: "local", style: "anime", ...tier },
    });
    await pipeline.renderPage(0);
    return last();
  }

  it("uses the style's automatic LoRA by default", async () => {
    expect((await renderWithTier({})).styleLora?.name).toBe("anime");
  });

  it("a manual override forces any installed LoRA over the style mapping", async () => {
    const input = await renderWithTier({ styleLoraOverride: "my-custom-lora.safetensors" });
    expect(input.styleLora?.name).toBe("my-custom-lora.safetensors");
  });

  /**
   * Every image used to be sampled from ONE seed — `anchors[0].seed`, a hash of the first
   * character's name — because extraction never writes a per-unit seed and the backends fall back to
   * the anchor. A whole book on one draw: when the draw is poor, every first render is poor, and
   * Redo (which writes a random seed) is the only render that escapes it.
   */
  describe("per-unit seeds", () => {
    it("mixes the unit index in, so two units of the same book differ", async () => {
      const book = oneParagraphBook();
      book.pages[0]!.pageRange = [0, 0];
      book.pages[0]!.paragraphs[0]!.text = "Aria stood by the window."; // so she resolves as present
      const bible = bibleWithPrompt(book.id, "a knight by a window");
      bible.characters.push({
        id: "char-a",
        name: "Aria",
        aliases: [],
        appearance: emptyAppearance(),
        persistentTraits: [],
        clothing: [],
        anchor: { seed: 4242 },
        firstSeenChapter: 0,
      });
      const { provider, last } = inputRecorder();
      const pipeline = new RenderPipeline({
        book,
        getBible: () => bible,
        llm,
        image: provider,
        store: new InMemoryStore(),
        tier: { ...DEFAULT_TIER_CONFIG, tier: "local", style: "anime" },
      });
      await pipeline.renderPage(0);
      const seed = last().seed;
      // A seed IS sent now — the backend's "fall back to the anchor for everything" path is gone.
      expect(typeof seed).toBe("number");
      expect(seed).not.toBe(4242);
      expect(seed).toBe(unitSeed(4242, 0));
      // And it's stable: the same unit renders the same way again.
      await pipeline.renderPage(0);
      expect(last().seed).toBe(seed);
    });
  });

  it("disableStyleLora renders prompt-only (no LoRA)", async () => {
    expect((await renderWithTier({ disableStyleLora: true })).styleLora).toBeUndefined();
  });

  /**
   * Per-character regions: sent only where they can be honoured (a local engine's node graph) and
   * only where they help (two to four described characters). castRegions decides the second part;
   * the pipeline decides the first.
   */
  describe("per-character regions", () => {
    /** Two described characters, both resolved as present on the page. */
    function twoHander(): ReturnType<typeof bibleWithPrompt> {
      const bible = bibleWithPrompt("book-1", "Sato and Mara at the counter");
      bible.characters.push(
        {
          id: "char-sato",
          name: "Sato",
          aliases: [],
          appearance: { ...emptyAppearance(), hair: "close-cropped, wire glasses" },
          persistentTraits: [],
          clothing: [],
          anchor: { seed: 1 },
          firstSeenChapter: 0,
        },
        {
          id: "char-mara",
          name: "Mara",
          aliases: [],
          appearance: { ...emptyAppearance(), hair: "red braid" },
          persistentTraits: [],
          clothing: [],
          anchor: { seed: 2 },
          firstSeenChapter: 0,
        },
      );
      return bible;
    }

    async function renderTwoHander(tier: Partial<typeof DEFAULT_TIER_CONFIG>) {
      const book = oneParagraphBook();
      book.pages[0]!.pageRange = [0, 0];
      book.pages[0]!.paragraphs[0]!.text = "Sato and Mara at the counter.";
      const { provider, last } = inputRecorder();
      const pipeline = new RenderPipeline({
        book,
        getBible: () => twoHander(),
        llm,
        image: provider,
        store: new InMemoryStore(),
        tier: { ...DEFAULT_TIER_CONFIG, tier: "local", style: "anime", ...tier },
      });
      await pipeline.renderPage(0);
      return last();
    }

    it("gives each character their own column when the reader turns it on", async () => {
      const regions = (await renderTwoHander({ perCharacterRegions: true })).castRegions ?? [];
      expect(regions.map((r) => r.name)).toEqual(["Sato", "Mara"]);
      expect(regions[0]!.text).toContain("close-cropped, wire glasses");
      expect(regions[1]!.text).toContain("red braid");
      expect(regions[0]!.x).toBe(0);
    });

    it("sends none by default — it's opt-in, and it constrains the composition", async () => {
      expect((await renderTwoHander({})).castRegions).toBeUndefined();
    });

    it("sends none to a cloud provider, even when asked — there's no way for it to honour them", async () => {
      expect((await renderTwoHander({ tier: "cloud", perCharacterRegions: true })).castRegions).toBeUndefined();
    });
  });
});

describe("RenderPipeline stored-first prompt fetch", () => {
  function countingLlm(): { provider: LLMProvider; calls: () => number } {
    let calls = 0;
    const provider: LLMProvider = {
      id: "mock",
      extractEntities: async (i) => i.existing,
      buildImagePrompt: async () => {
        calls++;
        return "LIVE LLM PROMPT";
      },
    };
    return { provider, calls: () => calls };
  }

  it("renders from a stored keyEvent without calling the LLM", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = createEmptyBible(book.id);
    bible.storyboard.push({
      chapterIndex: 0,
      summary: "",
      keyMoment: "",
      location: "",
      locationChange: "",
      keyEvents: [{ pageRange: [0, 0], imagePrompt: { text: "STORED SCENE PROMPT" } }],
    });
    const { provider: img, lastPrompt } = recordingImage();
    const { provider: spyLlm, calls } = countingLlm();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm: spyLlm,
      image: img,
      store: new InMemoryStore(),
      tier: DEFAULT_TIER_CONFIG,
    });

    await pipeline.renderPage(0);

    expect(calls()).toBe(0); // LLM untouched — image gen ran offline
    expect(lastPrompt()).toContain("STORED SCENE PROMPT");
  });

  it("pins the prompt to the keyEvent's beat-level location", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = createEmptyBible(book.id);
    bible.storyboard.push({
      chapterIndex: 0,
      summary: "",
      keyMoment: "",
      location: "the Great Hall", // chapter-level place differs — the beat must win
      locationChange: "moves to the courtyard",
      keyEvents: [{ pageRange: [0, 0], imagePrompt: { text: "blades crossed" }, location: "the Courtyard" }],
    });
    const { provider: img, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: img,
      store: new InMemoryStore(),
      tier: DEFAULT_TIER_CONFIG,
    });

    await pipeline.renderPage(0);

    expect(lastPrompt()).toContain("blades crossed");
    expect(lastPrompt()).toContain("Setting: the Courtyard.");
    expect(lastPrompt()).not.toContain("Great Hall");
  });

  it("persists the rendered prompt with the image and serves it from cache (stable caption)", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const { provider } = recordingImage();
    const store = new InMemoryStore();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store,
      tier: DEFAULT_TIER_CONFIG,
    });

    const fresh = await pipeline.renderPage(0);
    expect(fresh.prompt).toContain("a knight by a window");

    // Both cached paths return the EXACT prompt the image was rendered from — the
    // UI's description must not be re-derived from the live (still-growing) bible.
    const cached = await pipeline.renderPage(0);
    expect(cached.prompt).toBe(fresh.prompt);
    const restored = await pipeline.cachedResult(0);
    expect(restored?.prompt).toBe(fresh.prompt);
  });

  it("never calls the LLM at render time — holds (errors) when no prompt is stored", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const { provider: img, lastPrompt } = recordingImage();
    const { provider: spyLlm, calls } = countingLlm();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => createEmptyBible(book.id), // no keyEvents
      llm: spyLlm,
      image: img,
      store: new InMemoryStore(),
      tier: DEFAULT_TIER_CONFIG,
    });

    const result = await pipeline.renderPage(0);

    // Stored-only: the LLM is never reached and no image is generated (the buffer's gate
    // means this is unreachable in practice; here it surfaces as a defensive error).
    expect(calls()).toBe(0);
    expect(result.status).toBe("error");
    expect(lastPrompt()).toBe(""); // image.generate was never called
  });
});

describe("RenderPipeline OOM fallback", () => {
  it("retries ONCE one quality level down after an out-of-memory error", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const attempts: { steps: number | undefined; width: number | undefined }[] = [];
    const provider: ImageProvider = {
      id: "mock",
      generate: async (input: ImageGenerationInput): Promise<ImageGenerationOutput> => {
        attempts.push({ steps: input.steps, width: input.width });
        if (attempts.length === 1) throw new Error("CUDA out of memory: tried to allocate 2GB");
        return { bytes: new ArrayBuffer(1), mimeType: "image/png" };
      },
    };
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, renderQuality: "ultra" },
    });

    const result = await pipeline.renderPage(0);

    expect(result.status).toBe("ready");
    expect(attempts).toHaveLength(2);
    // The retry dropped to a smaller canvas + fewer steps (ultra → high).
    expect(attempts[1]!.steps).toBeLessThan(attempts[0]!.steps!);
    expect(attempts[1]!.width).toBeLessThan(attempts[0]!.width!);
  });

  it("does not retry on a non-OOM error", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    let calls = 0;
    const provider: ImageProvider = {
      id: "mock",
      generate: async (): Promise<ImageGenerationOutput> => {
        calls++;
        throw new Error("model not found");
      },
    };
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, renderQuality: "ultra" },
    });

    const result = await pipeline.renderPage(0);
    expect(result.status).toBe("error");
    expect(calls).toBe(1); // tried once, surfaced the error
  });
});

describe("RenderPipeline comic-page directive", () => {
  it("appends a multi-panel page directive only for comic/manga when opted in", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, style: "comic", drawAsComicPage: true },
    });

    await pipeline.renderPage(0);
    expect(lastPrompt()).toContain("comic page");
    expect(lastPrompt()).toContain("panels");
  });

  it("adds no comic-page directive for a non-comic style", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, style: "anime", drawAsComicPage: true },
    });

    await pipeline.renderPage(0);
    expect(lastPrompt()).not.toContain("comic page");
  });
});

describe("RenderPipeline shared-keyEvent differentiation", () => {
  /** Two grouped units whose ranges both fall inside ONE stored keyEvent ([0,5]) —
   * the stale-grouping / under-produced-model case that rendered identical panels. */
  function twoUnitBook(): BookSource {
    return {
      id: "book-1",
      title: "Test",
      chapters: [{ id: "ch-0", index: 0, title: "I" }],
      pages: [
        { id: "u-0", index: 0, chapterId: "ch-0", pageRange: [0, 2], paragraphs: [{ id: "u-0-0", index: 0, text: "Knight fights" }] },
        { id: "u-1", index: 1, chapterId: "ch-0", pageRange: [3, 5], paragraphs: [{ id: "u-1-0", index: 0, text: "Knight rests" }] },
      ],
    };
  }

  it("varies the prompt (beat cue) and seed per unit when units share one keyEvent", async () => {
    const book = twoUnitBook();
    const bible = createEmptyBible(book.id);
    bible.storyboard.push({
      chapterIndex: 0,
      summary: "",
      keyMoment: "",
      location: "",
      locationChange: "",
      keyEvents: [{ pageRange: [0, 5], imagePrompt: { text: "ONE SHARED SCENE" } }],
    });
    bible.characters.push({
      id: "char-knight",
      name: "Knight",
      aliases: [],
      appearance: emptyAppearance(),
      persistentTraits: [],
      clothing: [],
      anchor: { seed: 100 },
      firstSeenChapter: 0,
    });
    const inputs: ImageGenerationInput[] = [];
    const provider: ImageProvider = {
      id: "mock",
      generate: async (input) => {
        inputs.push(input);
        return { bytes: new ArrayBuffer(1), mimeType: "image/png" };
      },
    };
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: DEFAULT_TIER_CONFIG,
    });
    await pipeline.renderPage(0);
    await pipeline.renderPage(1);
    expect(inputs).toHaveLength(2);
    // Unit 0 IS the event's start: unchanged prompt + the character's true seed.
    expect(inputs[0]!.prompt).toContain("ONE SHARED SCENE");
    expect(inputs[0]!.prompt).not.toContain("LATER beat");
    expect(inputs[0]!.anchors[0]!.seed).toBe(100);
    // Unit 1 shares the event from offset 3 → beat cue + nudged seed.
    expect(inputs[1]!.prompt).toContain("ONE SHARED SCENE");
    expect(inputs[1]!.prompt).toContain("LATER beat");
    expect(inputs[1]!.anchors[0]!.seed).toBe(103);
    // The two renders can no longer be pixel-identical.
    expect(inputs[0]!.prompt).not.toBe(inputs[1]!.prompt);
  });

  it("leaves an exactly-matching keyEvent untouched (no cue, true seed)", async () => {
    const book = oneParagraphBook("Knight stands");
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "EXACT SCENE");
    bible.characters.push({
      id: "char-knight",
      name: "Knight",
      aliases: [],
      appearance: emptyAppearance(),
      persistentTraits: [],
      clothing: [],
      anchor: { seed: 7 },
      firstSeenChapter: 0,
    });
    const inputs: ImageGenerationInput[] = [];
    const provider: ImageProvider = {
      id: "mock",
      generate: async (input) => {
        inputs.push(input);
        return { bytes: new ArrayBuffer(1), mimeType: "image/png" };
      },
    };
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: DEFAULT_TIER_CONFIG,
    });
    await pipeline.renderPage(0);
    expect(inputs[0]!.prompt).not.toContain("LATER beat");
    expect(inputs[0]!.anchors[0]!.seed).toBe(7);
  });
});

describe("RenderPipeline reference images (IP-Adapter)", () => {
  function character(name: string, refIds: string[]): Character {
    return {
      id: `char-${name.toLowerCase()}`,
      name,
      aliases: [],
      appearance: emptyAppearance(),
      persistentTraits: [],
      clothing: [],
      anchor: { seed: 1, ...(refIds.length ? { referenceImageIds: refIds } : {}) },
      firstSeenChapter: 0,
    };
  }

  /** Image provider that records the full generation input. */
  function inputRecordingImage(): { provider: ImageProvider; lastInput: () => ImageGenerationInput } {
    let seen: ImageGenerationInput | undefined;
    const provider: ImageProvider = {
      id: "mock",
      generate: async (input: ImageGenerationInput): Promise<ImageGenerationOutput> => {
        seen = input;
        return { bytes: new ArrayBuffer(1), mimeType: "image/png" };
      },
    };
    return { provider, lastInput: () => seen! };
  }

  async function renderWith(chars: Character[], pageText: string) {
    const book = oneParagraphBook(pageText);
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a scene");
    bible.characters.push(...chars);
    const store = new InMemoryStore();
    for (const c of chars) {
      for (const id of c.anchor.referenceImageIds ?? []) {
        await store.putImage(id, new Uint8Array([1]).buffer, "image/png");
      }
    }
    const { provider, lastInput } = inputRecordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store,
      tier: DEFAULT_TIER_CONFIG,
    });
    await pipeline.renderPage(0);
    return lastInput();
  }

  it("splits one character's tuned 0.5 weight across their views", async () => {
    const input = await renderWith(
      [character("Ana", ["b:charref:char-ana:0", "b:charref:char-ana:1", "b:charref:char-ana:2"])],
      "Ana stood alone.",
    );
    expect(input.ipAdapterRefs).toHaveLength(3);
    for (const ref of input.ipAdapterRefs!) expect(ref.weight).toBeCloseTo(0.5 / 3);
  });

  it("caps a multi-character frame at 4 refs, round-robin, with per-character weights", async () => {
    const input = await renderWith(
      [
        character("Ana", ["b:charref:char-ana:0", "b:charref:char-ana:1", "b:charref:char-ana:2"]),
        character("Bram", ["b:charref:char-bram:0", "b:charref:char-bram:1", "b:charref:char-bram:2"]),
      ],
      "Ana and Bram crossed blades.",
    );
    // Round-robin allocation: each character keeps 2 of their 3 views (never one
    // character monopolising the budget), each weighted 0.5/2.
    expect(input.ipAdapterRefs).toHaveLength(4);
    for (const ref of input.ipAdapterRefs!) expect(ref.weight).toBeCloseTo(0.25);
  });

  it("one-shot native mode renders from the passage text, not the stored scene prompt", async () => {
    const book = oneParagraphBook("Ana drew her blade as the gate shuddered open.");
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "STORED SCENE PROMPT");
    const { provider, lastInput } = inputRecordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, nativeIllustration: true, nativeOneShot: true },
    });
    await pipeline.renderPage(0);
    const prompt = lastInput().prompt;
    expect(prompt).toContain("Ana drew her blade"); // the passage drives the image
    expect(prompt).not.toContain("STORED SCENE PROMPT"); // the pre-written prompt is bypassed
  });

  it("a single legacy referenceImageId still conditions at the tuned 0.5", async () => {
    const book = oneParagraphBook("Ana stood alone.");
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a scene");
    const legacy = character("Ana", []);
    legacy.anchor.referenceImageId = "b:charref:char-ana"; // pre-multi-view shape
    bible.characters.push(legacy);
    const store = new InMemoryStore();
    await store.putImage("b:charref:char-ana", new Uint8Array([1]).buffer, "image/png");
    const { provider, lastInput } = inputRecordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store,
      tier: DEFAULT_TIER_CONFIG,
    });
    await pipeline.renderPage(0);
    expect(lastInput().ipAdapterRefs).toHaveLength(1);
    expect(lastInput().ipAdapterRefs![0]!.weight).toBeCloseTo(0.5);
  });
});

describe("nameActiveScene (story 'as you go')", () => {
  const mara = { name: "Mara" };
  const cass = { name: "Cass" };
  const rell = { name: "Rell" };
  const tavern = { name: "the Bell" };

  it("rescues a terse beat that names nobody", () => {
    // "She nods." carries no names, so nothing would inject and the picture would be of
    // strangers. This is the case the clause exists for.
    const out = nameActiveScene("She nods, slowly.", [mara, cass], [], [tavern]);
    expect(out).toBe("She nods, slowly. Scene continuity: featuring Mara, Cass at the Bell.");
  });

  it("does NOT add the rest of the cast to a prompt that already names someone", () => {
    // The prompt-writer read the beat and chose who is in the shot. The tracked cast is who is
    // in the ROOM; the prompt is who is in the FRAME. Adding Rell here conjured a third person
    // into a two-person picture.
    const out = nameActiveScene("Mara and Cass argue by the bar.", [mara, cass, rell], [], []);
    expect(out).toBe("Mara and Cass argue by the bar.");
    expect(out).not.toContain("Rell");
  });

  it("still supplies the setting to a prompt that names people but no place", () => {
    // Naming who is present says nothing about where they are.
    const out = nameActiveScene("Mara sets down the glass.", [mara, rell], [], [tavern]);
    expect(out).toBe("Mara sets down the glass. Scene continuity: at the Bell.");
    expect(out).not.toContain("Rell");
  });

  it("leaves a fully-specified prompt alone", () => {
    expect(nameActiveScene("Mara waits at the Bell.", [mara], [], [tavern])).toBe(
      "Mara waits at the Bell.",
    );
  });

  it("counts creatures as cast for the same test", () => {
    const drake = { name: "Vess" };
    // The beat names the creature, so the prompt knows its cast — Mara isn't added.
    expect(nameActiveScene("Vess circles overhead.", [mara], [drake], [])).toBe(
      "Vess circles overhead.",
    );
  });

  it("has nothing to say when the scene is empty", () => {
    expect(nameActiveScene("An empty road.", [], [], [])).toBe("An empty road.");
  });
});

describe("RenderPipeline subject count reaches the provider", () => {
  /** Two described characters, both resolved as present on the page. */
  function twoHanderBible() {
    const bible = bibleWithPrompt("book-1", "Sato and Mara at the counter");
    bible.characters.push(
      {
        id: "char-sato",
        name: "Sato",
        aliases: [],
        appearance: { ...emptyAppearance(), hair: "close-cropped, wire glasses" },
        persistentTraits: [],
        clothing: [],
        anchor: { seed: 1 },
        firstSeenChapter: 0,
      },
      {
        id: "char-mara",
        name: "Mara",
        aliases: [],
        appearance: { ...emptyAppearance(), hair: "red braid" },
        persistentTraits: [],
        clothing: [],
        anchor: { seed: 2 },
        firstSeenChapter: 0,
      },
    );
    return bible;
  }

  async function renderWith(tier: Partial<typeof DEFAULT_TIER_CONFIG>) {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    book.pages[0]!.paragraphs[0]!.text = "Sato and Mara at the counter.";
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => twoHanderBible(),
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, ...tier },
    });
    await pipeline.renderPage(0);
    return lastPrompt();
  }

  it("leads the scene description with the count of the resolved cast", async () => {
    // Immediately before the scene, so the count frames the composition. In `reference` name
    // handling a glossary header precedes it — that block defines who the names are, and the
    // count belongs with the scene it constrains, not ahead of the definitions.
    expect(await renderWith({})).toContain("Exactly two people in focus. Sato and Mara at the counter");
  });

  it("is skipped for a comic PAGE, where the count would be read per panel", async () => {
    // 4–6 panels each showing the cast is exactly the case where "exactly two people" is wrong.
    const prompt = await renderWith({ style: "comic", drawAsComicPage: true });
    expect(prompt).toContain("comic page");
    expect(prompt).not.toContain("in focus");
  });
});

describe("countSceneSubjects (how many bodies to draw)", () => {
  const mara = { name: "Mara" };
  const cass = { name: "Cass" };
  const drake = { name: "Vess" };

  it("states the count in words at the front", () => {
    // Leading, because the first tokens carry the most weight in both encoder families — and the
    // count has to frame the composition before any descriptor arrives.
    expect(countSceneSubjects("Mara and Cass argue.", [mara, cass], [])).toBe(
      "Exactly two people in focus. Mara and Cass argue.",
    );
  });

  it("says it for a LONE character — the case a duplicate figure ruins", () => {
    // The reported failure: one person in the beat, two drawn. Nothing had ever said "one".
    expect(countSceneSubjects("Nico waits.", [{ name: "Nico" }], [])).toBe(
      "Exactly one person in focus. Nico waits.",
    );
  });

  it("counts people and creatures separately — a drake is not one of the people", () => {
    expect(countSceneSubjects("Vess circles.", [mara], [drake])).toBe(
      "Exactly one person and one creature in focus. Vess circles.",
    );
  });

  it("counts a person with a nickname ONCE, however the prompt refers to them", () => {
    // The whole reason it counts bible entities and not noun phrases: counting the prose would
    // read "Lyra (the Ghost Broker)" as two people and assert the very duplicate this prevents.
    const lyra = { name: "Lyra" };
    expect(countSceneSubjects("Lyra, the Ghost Broker, leans in.", [lyra], [])).toBe(
      "Exactly one person in focus. Lyra, the Ghost Broker, leans in.",
    );
  });

  it("collapses a same-named leftover from an un-consolidated extraction", () => {
    expect(countSceneSubjects("They talk.", [mara, { name: "mara" }, cass], [])).toBe(
      "Exactly two people in focus. They talk.",
    );
  });

  it("drops the number past three, where diffusion counting is noise", () => {
    // An ignored instruction is harmless; a wrong one that is half-obeyed is worse than silence.
    const out = countSceneSubjects("The squad forms up.", [mara, cass, drake, { name: "Rell" }], []);
    expect(out).toBe("Several people in focus. The squad forms up.");
    expect(out).not.toContain("Exactly");
    expect(out).not.toContain("four");
  });

  it("never claims 'exactly' when either group had to go soft", () => {
    const many = [mara, cass, drake, { name: "Rell" }, { name: "Toll" }];
    expect(countSceneSubjects("A gathering.", many, [{ name: "Sgaeyl" }])).toBe(
      "Several people and one creature in focus. A gathering.",
    );
  });

  it("says nothing when the bible knows of no subject in the frame", () => {
    // A landscape must not be told it contains people.
    expect(countSceneSubjects("An empty road at dusk.", [], [])).toBe("An empty road at dusk.");
  });
});

describe("the persisted prompt is what was actually sent", () => {
  /** A provider that expands the prompt itself, the way every local backend does. */
  function expandingImage(): ImageProvider {
    return {
      id: "local-ish",
      generate: async (input: ImageGenerationInput): Promise<ImageGenerationOutput> => ({
        bytes: new ArrayBuffer(1),
        mimeType: "image/png",
        prompt: `${input.prompt}\n\nCharacters: Mara = red braid.`,
      }),
    };
  }

  it("stores the provider's own expansion, not the text handed to it", async () => {
    // A local backend injects descriptors / prepends a reference block AFTER the pipeline hands
    // it the prompt. Persisting the pre-expansion text made the reader's "Full prompt (as sent
    // to the model)" a description of something that was never sent.
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const store = new InMemoryStore();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: expandingImage(),
      store,
      tier: { ...DEFAULT_TIER_CONFIG, style: "anime" },
    });

    const result = await pipeline.renderPage(0);
    expect(result.prompt).toContain("Characters: Mara = red braid.");
    // …and it survives the reload, so a reopened book shows the same thing.
    expect((await store.getImage(result.requestId))?.prompt).toContain("Characters: Mara = red braid.");
    expect((await pipeline.cachedResult(0))?.prompt).toContain("Characters: Mara = red braid.");
  });

  it("keeps the pipeline's own prompt when the provider sent it unchanged", async () => {
    const book = oneParagraphBook();
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithPrompt(book.id, "a knight by a window");
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, style: "anime" },
    });

    const result = await pipeline.renderPage(0);
    expect(result.prompt).toBe(lastPrompt());
  });
});

describe("the naming shape applies to every provider", () => {
  /** A bible with one described character, so a term exists to expand. */
  function bibleWithCharacter(bookId: string, promptText: string): VisualBible {
    const bible = bibleWithPrompt(bookId, promptText);
    const nico: Character = {
      id: "char-nico",
      name: "Nico",
      aliases: [],
      appearance: { ...emptyAppearance(), gender: "a man", hair: "with a beard" },
      persistentTraits: [],
      clothing: [],
      anchor: { seed: 7 },
      firstSeenChapter: 0,
    };
    return { ...bible, characters: [nico] };
  }

  /** A CLOUD provider (id ≠ "local"), which the pipeline pre-expands for. */
  function cloudImage(): { provider: ImageProvider; lastPrompt: () => string } {
    let seen = "";
    return {
      provider: {
        id: "gemini",
        generate: async (input: ImageGenerationInput): Promise<ImageGenerationOutput> => {
          seen = input.prompt;
          return { bytes: new ArrayBuffer(1), mimeType: "image/png" };
        },
      },
      lastPrompt: () => seen,
    };
  }

  async function renderCloudWith(promptNameStyle?: "reference" | "inject" | "appositive") {
    const book = oneParagraphBook("Nico waits.");
    book.pages[0]!.pageRange = [0, 0];
    const bible = bibleWithCharacter(book.id, "Nico waits at the bar.");
    const { provider, lastPrompt } = cloudImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => bible,
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, tier: "cloud", ...(promptNameStyle ? { promptNameStyle } : {}) },
    });
    await pipeline.renderPage(0);
    return lastPrompt();
  }

  it("uses the provider's default shape when the reader hasn't chosen", async () => {
    // Gemini is LLM-grade → the glossary block, names left in the sentence.
    const prompt = await renderCloudWith();
    expect(prompt).toContain("Characters: Nico =");
    expect(prompt).toContain("Nico waits at the bar.");
  });

  it("honours the reader's choice on a CLOUD provider too", async () => {
    // The setting used to reach local engines only, so the same choice behaved differently
    // depending on which provider a book happened to render on — invisible from the pictures.
    const prompt = await renderCloudWith("appositive");
    expect(prompt).toContain("Nico (a man, with a beard) waits at the bar.");
    expect(prompt).not.toContain("Characters:");
  });
});
