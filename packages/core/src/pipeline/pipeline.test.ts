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
