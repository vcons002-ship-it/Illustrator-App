import type { BookSource, Page } from "../types/book.js";
import type { VisualBible, IdentityAnchor } from "../types/bible.js";
import type { ImageResult, VisualRequest } from "../types/content.js";
import type { TierConfig } from "../types/tier.js";
import type { LLMProvider } from "../providers/llm/llm-provider.js";
import type { ImageProvider } from "../providers/image/image-provider.js";
import type { VisualReaderStore } from "../storage/store.js";
import { resolvePageEntities } from "../visual-bible/bible.js";

/**
 * Orchestrates a single page → image. Builds a VisualRequest from the page and
 * the Visual Bible, asks the LLM provider for a prompt, asks the image provider
 * to render it, caches the bytes, and returns an ImageResult.
 *
 * The renderer is selected by `request.kind`; v1 only handles
 * "scene_illustration". When info-graphics land, add a branch here keyed on the
 * discriminator — nothing else in the buffer or UI changes.
 */
export interface PipelineDeps {
  book: BookSource;
  bible: VisualBible;
  llm: LLMProvider;
  image: ImageProvider;
  store: VisualReaderStore;
  tier: TierConfig;
}

export class RenderPipeline {
  constructor(private deps: PipelineDeps) {}

  buildRequest(page: Page): VisualRequest {
    const { characterIds, environmentIds, spoilerIds } = resolvePageEntities(
      this.deps.bible,
      page,
    );
    return {
      kind: "scene_illustration",
      bookId: this.deps.book.id,
      pageId: page.id,
      pageIndex: page.index,
      sourceText: page.paragraphs.map((p) => p.text).join("\n\n"),
      characterIds,
      environmentIds,
      spoilerIds,
    };
  }

  /** Render a page, using the cache when available. */
  async renderPage(pageIndex: number): Promise<ImageResult> {
    const page = this.deps.book.pages[pageIndex];
    if (!page) {
      return { requestId: `page-${pageIndex}`, pageId: `page-${pageIndex}`, status: "error", error: "Page out of range" };
    }
    const request = this.buildRequest(page);
    const requestId = `${request.bookId}:${request.pageId}`;

    const cached = await this.deps.store.getImage(requestId);
    if (cached) {
      return {
        requestId,
        pageId: request.pageId,
        status: "ready",
        image: { bytes: cached.bytes, mimeType: cached.mimeType },
      };
    }

    if (request.kind !== "scene_illustration") {
      return { requestId, pageId: request.pageId, status: "error", error: `Unsupported content kind: ${request.kind}` };
    }

    try {
      const prompt = await this.deps.llm.buildImagePrompt(request, this.deps.bible);
      const anchors = this.anchorsFor(request);
      const output = await this.deps.image.generate({
        prompt,
        anchors,
        quality: this.deps.tier.quality,
      });
      await this.deps.store.putImage(requestId, output.bytes, output.mimeType);
      return {
        requestId,
        pageId: request.pageId,
        status: "ready",
        prompt,
        image: { bytes: output.bytes, mimeType: output.mimeType },
      };
    } catch (err) {
      return {
        requestId,
        pageId: request.pageId,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private anchorsFor(request: VisualRequest): IdentityAnchor[] {
    return this.deps.bible.characters
      .filter((c) => request.characterIds.includes(c.id))
      .map((c) => c.anchor);
  }
}
