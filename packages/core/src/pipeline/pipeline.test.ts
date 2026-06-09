import { describe, it, expect } from "vitest";
import { RenderPipeline } from "./pipeline.js";
import { InMemoryStore } from "../storage/store.js";
import { createEmptyBible } from "../visual-bible/bible.js";
import { DEFAULT_TIER_CONFIG } from "../types/tier.js";
import type { BookSource } from "../types/book.js";
import type { VisualBible } from "../types/bible.js";
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

describe("RenderPipeline style injection", () => {
  it("appends the selected style's prompt suffix", async () => {
    const book = oneParagraphBook();
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => createEmptyBible(book.id),
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
    const { provider, lastPrompt } = recordingImage();
    const pipeline = new RenderPipeline({
      book,
      getBible: () => createEmptyBible(book.id),
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

  it("falls back to the LLM when no keyEvent matches the unit", async () => {
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

    await pipeline.renderPage(0);

    expect(calls()).toBe(1);
    expect(lastPrompt()).toContain("LIVE LLM PROMPT");
  });
});
