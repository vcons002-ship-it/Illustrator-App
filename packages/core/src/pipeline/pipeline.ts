import type { BookSource, Page } from "../types/book.js";
import type { Character, VisualBible } from "../types/bible.js";
import type { ImageResult, VisualRequest } from "../types/content.js";
import type { TierConfig } from "../types/tier.js";
import type { LLMProvider } from "../providers/llm/llm-provider.js";
import type { ImageProvider } from "../providers/image/image-provider.js";
import type { VisualReaderStore } from "../storage/store.js";
import { resolvePageEntities } from "../visual-bible/bible.js";
import { composeScenePrompt, resolveKeyEvent } from "../visual-bible/key-events.js";
import { expandPrompt, findBibleTermsInText } from "../providers/image/bible-injection.js";
import { getImageStyle } from "../providers/catalog.js";
import { qualityProfile } from "../quality.js";

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
    const { characterIds, environmentIds, creatureIds, spoilerIds } = resolvePageEntities(
      this.deps.getBible(),
      page,
    );
    const chapterContext = this.chapterContextFor(page);
    return {
      kind: "scene_illustration",
      bookId: this.deps.book.id,
      ...(this.deps.book.title ? { bookTitle: this.deps.book.title } : {}),
      pageId: page.id,
      pageIndex: page.index,
      chapterIndex: this.deps.book.chapters.find((c) => c.id === page.chapterId)?.index ?? 0,
      // Always carry a range so a stored prompt can be matched by overlap (a raw single
      // page is [index, index]); keeps buildRequest, hasKeyEvent, and renderPage aligned.
      pageRange: page.pageRange ?? [page.index, page.index],
      sourceText: page.paragraphs.map((p) => p.text).join("\n\n"),
      ...(chapterContext ? { chapterContext } : {}),
      characterIds,
      environmentIds,
      creatureIds,
      spoilerIds,
    };
  }

  /** Bounded text of the whole chapter this page belongs to, for continuity. */
  private chapterContextFor(page: Page): string {
    const full = this.deps.book.pages
      .filter((p) => p.chapterId === page.chapterId)
      .flatMap((p) => p.paragraphs.map((x) => x.text))
      .join("\n\n")
      .replace(/\s+/g, " ")
      .trim();
    return full.length <= 1500 ? full : `${full.slice(0, 1500).trimEnd()}…`;
  }

  /** Stable cache id for a unit's image (`${bookId}:${pageId}`). */
  requestIdFor(pageIndex: number): string {
    const page = this.deps.book.pages[pageIndex];
    return `${this.deps.book.id}:${page?.id ?? `page-${pageIndex}`}`;
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
    signal?: AbortSignal,
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
      const bible = this.deps.getBible();
      const style = getImageStyle(this.deps.tier.style);
      // Stored-only: render from the precomputed Layer-1 prompt for this unit. The buffer's
      // gate (canRender = hasKeyEvent) means a renderable unit always has one, so this never
      // falls back to a live LLM call; the guard below is purely defensive.
      const keyEvent = resolveKeyEvent(bible, request.chapterIndex, request.pageRange);
      const stored = keyEvent ? composeScenePrompt(keyEvent.imagePrompt) : "";
      if (!stored) {
        return {
          requestId,
          pageId: request.pageId,
          status: "error",
          error: "No illustration prompt for this unit yet.",
        };
      }
      const basePrompt = style.promptSuffix ? `${stored}\n\nStyle: ${style.promptSuffix}` : stored;
      const present = bible.characters.filter((c) => request.characterIds.includes(c.id));
      const presentCreatures = (bible.creatures ?? []).filter((c) =>
        request.creatureIds.includes(c.id),
      );
      // Characters first so the seed anchor (anchors[0]) stays a character when one
      // is present; a creature-only frame is pinned by the creature's seed.
      const anchors = [...present.map((c) => c.anchor), ...presentCreatures.map((c) => c.anchor)];
      // Bible terms mentioned in the prompt (names → descriptors). Local backends expand them
      // family-aware; for cloud we pre-expand here (cloud providers don't know the bible).
      const terms = findBibleTermsInText(basePrompt, bible);
      const isLocal = this.deps.tier.tier === "local";
      const prompt = isLocal
        ? basePrompt
        : expandPrompt(
            basePrompt,
            terms,
            cloudNameHandling(this.deps.image.id),
            bible.worldStyle,
            request.bookTitle,
          );
      // Reference images for IP-Adapter — user-uploaded only (auto-capture removed).
      const ipAdapterRefs = await this.referenceImagesFor(present);
      // Local engines additionally apply a style LoRA/checkpoint when installed.
      const local = isLocal ? style.local : undefined;
      // Resolved quality profile → steps + resolution (more pages/image = higher).
      const profile = this.deps.tier.renderQuality
        ? qualityProfile(this.deps.tier.renderQuality)
        : undefined;
      const output = await this.deps.image.generate({
        prompt,
        anchors,
        quality: this.deps.tier.quality,
        ...(profile ? { steps: profile.steps, width: profile.width, height: profile.height } : {}),
        ...(local?.lora ? { styleLora: local.lora } : {}),
        ...(local?.checkpoint ? { styleCheckpoint: local.checkpoint } : {}),
        ...(this.deps.tier.imageModelFamily ? { modelFamily: this.deps.tier.imageModelFamily } : {}),
        // Local backends expand bible terms themselves (family-aware); cloud got them above.
        ...(isLocal && terms.length ? { terms } : {}),
        ...(isLocal && bible.worldStyle ? { worldStyle: bible.worldStyle } : {}),
        ...(isLocal && request.bookTitle ? { bookTitle: request.bookTitle } : {}),
        ...(ipAdapterRefs.length ? { ipAdapterRefs } : {}),
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
        // A keyEvent may pin a reproducible seed (overrides the character anchor seed).
        ...(typeof keyEvent?.seed === "number" ? { seed: keyEvent.seed } : {}),
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
      // A cancelled render (the user paused images) is NOT a failure — re-throw so the
      // buffer drops it back to "queued" to re-render on resume, instead of caching an error.
      if (signal?.aborted) throw err;
      return {
        requestId,
        pageId: request.pageId,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Resolve stored reference images for characters that have one. */
  private async referenceImagesFor(
    present: Character[],
  ): Promise<{ bytes: ArrayBuffer; mimeType: string; weight: number }[]> {
    const refs: { bytes: ArrayBuffer; mimeType: string; weight: number }[] = [];
    for (const c of present) {
      const id = c.anchor.referenceImageId;
      if (!id) continue;
      const img = await this.deps.store.getImage(id);
      // Moderate weight (not 0.7): the reference keeps the face recognizable without
      // forcing a portrait — the backend also ends IP-Adapter early so the scene
      // composition forms first.
      if (img) refs.push({ bytes: img.bytes, mimeType: img.mimeType, weight: 0.5 });
    }
    return refs;
  }
}

/**
 * How a CLOUD image provider handles character names: the BFL Flux API uses the same
 * CLIP/T5 encoder as local Flux (names are meaningless → inject descriptors), while
 * Gemini/OpenAI are LLM-grade (keep names + a reference block). Local backends decide
 * this themselves from the resolved model family.
 */
function cloudNameHandling(imageProviderId: string): "inject" | "reference" {
  return imageProviderId === "flux" ? "inject" : "reference";
}
