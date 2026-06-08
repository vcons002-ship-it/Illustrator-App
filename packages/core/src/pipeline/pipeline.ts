import type { BookSource, Page } from "../types/book.js";
import type { VisualBible, IdentityAnchor } from "../types/bible.js";
import type { ImageResult, VisualRequest } from "../types/content.js";
import type { TierConfig } from "../types/tier.js";
import type { LLMProvider } from "../providers/llm/llm-provider.js";
import type { ImageProvider } from "../providers/image/image-provider.js";
import type { VisualReaderStore } from "../storage/store.js";
import { resolvePageEntities } from "../visual-bible/bible.js";
import { getImageStyle } from "../providers/catalog.js";

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
  /**
   * Accessor for the current Visual Bible. It's a getter (not a snapshot) because
   * the bible is built incrementally in the background — a page rendered later
   * must see the entities extracted since the pipeline was created.
   */
  getBible: () => VisualBible;
  llm: LLMProvider;
  image: ImageProvider;
  store: VisualReaderStore;
  tier: TierConfig;
}

export class RenderPipeline {
  constructor(private deps: PipelineDeps) {}

  buildRequest(page: Page): VisualRequest {
    const { characterIds, environmentIds, spoilerIds } = resolvePageEntities(
      this.deps.getBible(),
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

  /**
   * The page's cached image from a previous session, if any — without calling
   * the LLM or image provider. Used to populate the reader with prior work on
   * open, before (or without) starting fresh generation.
   */
  async cachedResult(pageIndex: number): Promise<ImageResult | undefined> {
    const page = this.deps.book.pages[pageIndex];
    if (!page) return undefined;
    const request = this.buildRequest(page);
    const requestId = `${request.bookId}:${request.pageId}`;
    const cached = await this.deps.store.getImage(requestId);
    if (!cached) return undefined;
    return {
      requestId,
      pageId: request.pageId,
      status: "ready",
      image: { bytes: cached.bytes, mimeType: cached.mimeType },
    };
  }

  /**
   * Render a page, using the cache when available. `onProgress` (0..1) is an
   * optional sink for engines that report generation progress (e.g. ComfyUI).
   */
  async renderPage(
    pageIndex: number,
    onProgress?: (fraction: number) => void,
  ): Promise<ImageResult> {
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
      const style = getImageStyle(this.deps.tier.style);
      const basePrompt = await this.deps.llm.buildImagePrompt(request, this.deps.getBible());
      const prompt = style.promptSuffix ? `${basePrompt}\n\nStyle: ${style.promptSuffix}` : basePrompt;
      const anchors = this.anchorsFor(request);
      // Local engines additionally apply a style LoRA/checkpoint when installed.
      const local = this.deps.tier.tier === "local" ? style.local : undefined;
      const output = await this.deps.image.generate({
        prompt,
        anchors,
        quality: this.deps.tier.quality,
        ...(local?.lora ? { styleLora: local.lora } : {}),
        ...(local?.checkpoint ? { styleCheckpoint: local.checkpoint } : {}),
        ...(onProgress ? { onProgress } : {}),
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
    return this.deps
      .getBible()
      .characters.filter((c) => request.characterIds.includes(c.id))
      .map((c) => c.anchor);
  }
}
