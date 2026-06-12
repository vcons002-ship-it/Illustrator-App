import { describe, it, expect } from "vitest";
import { RenderPipeline } from "./pipeline.js";
import { InMemoryStore } from "../storage/store.js";
import { createEmptyBible } from "../visual-bible/bible.js";
import { DEFAULT_TIER_CONFIG } from "../types/tier.js";
import { emptyAppearance } from "../types/bible.js";
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
  it("a technical book's requests carry the technical_illustration kind and still render", async () => {
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
    expect(result.status).toBe("ready"); // the kind is supported end-to-end
    expect(lastPrompt()).toContain("cutaway view");
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

  it("falls back to AI generation when nothing is found or search fails", async () => {
    const { pipeline, generatedCount } = technicalSetup(async () => undefined);
    expect((await pipeline.renderPage(0)).status).toBe("ready");
    expect(generatedCount()).toBe(1);

    const failing = technicalSetup(async () => {
      throw new Error("quota exceeded");
    });
    expect((await failing.pipeline.renderPage(0)).status).toBe("ready");
    expect(failing.generatedCount()).toBe(1);
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

  it("disableStyleLora renders prompt-only (no LoRA)", async () => {
    expect((await renderWithTier({ disableStyleLora: true })).styleLora).toBeUndefined();
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
