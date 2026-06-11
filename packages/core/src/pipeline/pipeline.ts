import type { BookSource, Page } from "../types/book.js";
import type { Character, VisualBible } from "../types/bible.js";
import { referenceIdsOf } from "../types/bible.js";
import type { ImageResult, VisualRequest } from "../types/content.js";
import type { TierConfig } from "../types/tier.js";
import type { LLMProvider } from "../providers/llm/llm-provider.js";
import type {
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageProvider,
} from "../providers/image/image-provider.js";
import type { RenderQuality } from "../quality.js";
import type { VisualReaderStore } from "../storage/store.js";
import { resolvePageEntities } from "../visual-bible/bible.js";
import { anchorSetting, composeScenePrompt, resolveKeyEvent } from "../visual-bible/key-events.js";
import { expandPrompt, findBibleTermsInText } from "../providers/image/bible-injection.js";
import { getImageStyle } from "../providers/catalog.js";
import { profileDimensions, qualityProfile } from "../quality.js";

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

/**
 * Most IP-Adapter conditioning images per frame. Stacking many refs (e.g. several
 * characters × several views) blends identities and muddies the scene, so a crowded
 * frame is throttled — solo frames get the full multi-view benefit.
 */
const MAX_FRAME_REFS = 4;

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
      // The prompt this image was actually rendered from (persisted with it), so the
      // UI's per-image description stays STABLE across sessions instead of being
      // re-derived from the live (still-growing) bible.
      ...(cached.prompt ? { prompt: cached.prompt } : {}),
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
        ...(cached.prompt ? { prompt: cached.prompt } : {}),
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
      // One-shot native mode: the multimodal model reads the passage and draws it itself,
      // so the base is the passage text (its character names still resolve to Bible
      // descriptors below). Otherwise render the pre-written, beat-located scene prompt.
      // Either way a keyEvent must exist — it's what gates a unit as renderable.
      const stored = !keyEvent
        ? ""
        : this.deps.tier.nativeOneShot
          ? oneShotPrompt(request.sourceText)
          : anchorSetting(composeScenePrompt(keyEvent.imagePrompt), keyEvent.location);
      if (!stored) {
        return {
          requestId,
          pageId: request.pageId,
          status: "error",
          error: "No illustration prompt for this unit yet.",
        };
      }
      const styled = style.promptSuffix ? `${stored}\n\nStyle: ${style.promptSuffix}` : stored;
      // Multi-panel comic page (opt-in, comic/manga only): ask for a SINGLE image laid
      // out as a comic page of sequential panels. Works best on natural-language/cloud
      // models. The reader's panel-grid view is separate (it composes per-unit images).
      const comicPage =
        this.deps.tier.drawAsComicPage && (this.deps.tier.style === "comic" || this.deps.tier.style === "manga");
      const basePrompt = comicPage
        ? `${styled}\n\nLayout: a single comic page composed of 4–6 sequential panels with clear gutters between them, telling this moment in order.`
        : styled;
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
      // Everything about the render except the quality-level-dependent steps + canvas,
      // which are filled per-attempt so an out-of-memory failure can retry one level down.
      const baseInput: ImageGenerationInput = {
        prompt,
        anchors,
        quality: this.deps.tier.quality,
        ...(isLocal && this.deps.tier.localSampler ? { localSampler: this.deps.tier.localSampler } : {}),
        ...(isLocal && this.deps.tier.localScheduler ? { localScheduler: this.deps.tier.localScheduler } : {}),
        ...(local?.lora ? { styleLora: local.lora } : {}),
        ...(local?.checkpoint ? { styleCheckpoint: local.checkpoint } : {}),
        ...(this.deps.tier.imageModelFamily ? { modelFamily: this.deps.tier.imageModelFamily } : {}),
        ...(isLocal && this.deps.tier.localTextEncoder ? { textEncoder: this.deps.tier.localTextEncoder } : {}),
        ...(isLocal && this.deps.tier.localVae ? { vae: this.deps.tier.localVae } : {}),
        ...(isLocal && this.deps.tier.localSteps ? { stepsOverride: this.deps.tier.localSteps } : {}),
        ...(isLocal && this.deps.tier.localCfg !== undefined ? { cfgOverride: this.deps.tier.localCfg } : {}),
        // Local backends expand bible terms themselves (family-aware); cloud got them above.
        ...(isLocal && terms.length ? { terms } : {}),
        ...(isLocal && bible.worldStyle ? { worldStyle: bible.worldStyle } : {}),
        ...(isLocal && request.bookTitle ? { bookTitle: request.bookTitle } : {}),
        ...(ipAdapterRefs.length ? { ipAdapterRefs } : {}),
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
        // A keyEvent may pin a reproducible seed (overrides the character anchor seed).
        ...(typeof keyEvent?.seed === "number" ? { seed: keyEvent.seed } : {}),
      };
      // Quality level → steps + aspect-aware resolution (more pages/image = higher
      // quality; the canvas orientation comes from the user's aspect setting).
      const renderAt = (lvl: typeof this.deps.tier.renderQuality): Promise<ImageGenerationOutput> => {
        const dims = lvl ? profileDimensions(lvl, this.deps.tier.aspectRatio) : undefined;
        return this.deps.image.generate({
          ...baseInput,
          ...(lvl ? { renderQuality: lvl, steps: qualityProfile(lvl).steps } : {}),
          ...(dims ? { width: dims.width, height: dims.height } : {}),
        });
      };
      const level = this.deps.tier.renderQuality;
      let output: ImageGenerationOutput;
      try {
        output = await renderAt(level);
      } catch (err) {
        // Out-of-memory safety net: a too-large canvas can exhaust VRAM. Retry ONCE one
        // level down (smaller canvas + fewer steps) before giving up — but never on a
        // user cancellation, and only when there's a lower level to drop to.
        const down = !signal?.aborted && level ? oneLevelDown(level) : undefined;
        if (!down || !isOutOfMemoryError(err)) throw err;
        try {
          output = await renderAt(down);
        } catch (retryErr) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(`${msg} (already retried at lower "${down}" quality after running out of GPU memory)`);
        }
      }
      await this.deps.store.putImage(requestId, output.bytes, output.mimeType, prompt);
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

  /**
   * Resolve stored reference images for the characters in this frame. A character may
   * have several uploads (angles of the same face) — they condition together, with the
   * 0.5 total weight split across them so one character's pull on the image stays
   * where it's tuned regardless of how many views they have. Across characters, the
   * frame is capped at MAX_FRAME_REFS conditioning images, allocated round-robin (one
   * view per character first) so a crowded scene degrades to one ref each instead of
   * the first character monopolising the budget.
   */
  private async referenceImagesFor(
    present: Character[],
  ): Promise<{ bytes: ArrayBuffer; mimeType: string; weight: number }[]> {
    // Round-robin allocation of each character's ref ids into the frame budget.
    const perChar: string[][] = present.map((c) => referenceIdsOf(c.anchor));
    const chosen: { id: string; charIndex: number }[] = [];
    for (let round = 0; chosen.length < MAX_FRAME_REFS; round++) {
      const before = chosen.length;
      for (let i = 0; i < perChar.length && chosen.length < MAX_FRAME_REFS; i++) {
        const id = perChar[i]![round];
        if (id) chosen.push({ id, charIndex: i });
      }
      if (chosen.length === before) break; // every character exhausted
    }
    // Per-character weight: split the tuned 0.5 across the views actually used.
    const usedCount = new Map<number, number>();
    for (const c of chosen) usedCount.set(c.charIndex, (usedCount.get(c.charIndex) ?? 0) + 1);
    const refs: { bytes: ArrayBuffer; mimeType: string; weight: number }[] = [];
    for (const { id, charIndex } of chosen) {
      const img = await this.deps.store.getImage(id);
      // Moderate total (not 0.7): the reference keeps the face recognizable without
      // forcing a portrait — the backend also ends IP-Adapter early so the scene
      // composition forms first.
      if (img) {
        refs.push({ bytes: img.bytes, mimeType: img.mimeType, weight: 0.5 / usedCount.get(charIndex)! });
      }
    }
    return refs;
  }
}

/**
 * One-shot native prompt: a short directive plus the book passage itself, so the
 * multimodal model reads the scene and depicts it directly. Character names in the
 * prose are still expanded into their Bible descriptors by the caller's term pass.
 */
/** The next-lower render-quality level, or undefined when already at the floor (draft). */
function oneLevelDown(level: RenderQuality): RenderQuality | undefined {
  const order: RenderQuality[] = ["draft", "standard", "high", "ultra"];
  const i = order.indexOf(level);
  return i > 0 ? order[i - 1] : undefined;
}

/** Heuristic: does this error look like a GPU out-of-memory / allocation failure? */
function isOutOfMemoryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /out of memory|cuda|alloc|vram|oom/i.test(msg);
}

function oneShotPrompt(sourceText: string): string {
  const passage = sourceText.replace(/\s+/g, " ").trim().slice(0, 1200);
  return (
    "Illustrate the single most important moment of this book passage as one scene — " +
    "a wide or medium shot showing the characters acting in their setting, not a portrait. " +
    `Passage: ${passage}`
  );
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
