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
      bible: createEmptyBible(book.id),
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
      bible: createEmptyBible(book.id),
      llm,
      image: provider,
      store: new InMemoryStore(),
      tier: { ...DEFAULT_TIER_CONFIG, style: "auto" },
    });

    await pipeline.renderPage(0);

    expect(lastPrompt()).toBe("a knight by a window");
  });
});
