import { isNonFiction, type BookSource, type Page } from "../types/book.js";
import type { Character, VisualBible } from "../types/bible.js";
import { referenceIdsOf } from "../types/bible.js";
import { isSupportedKind, type ImageResult, type VisualRequest } from "../types/content.js";
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
import { buildFigureQuery, type RetrievedImage } from "../providers/image/image-search.js";
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
  /**
   * Real-figure retrieval (technical books): a technical unit looks for an EXISTING
   * diagram of its keyEvent's subject (authoritative labels/data beat a generated
   * picture). Technical units NEVER fall back to AI generation — a plausible-looking
   * invented diagram would corrupt the book's source of truth — they emit a `skipped`
   * result instead, and the reader gets the concept's explanation in the text column.
   */
  imageSearch?: { retrieve(query: string): Promise<RetrievedImage | undefined> };
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
      // Technical books (papers/textbooks, chosen at import) illustrate the passage's
      // CONCEPT instead of a story scene — the LLM picks its prompt template by kind.
      kind: isNonFiction(this.deps.book.contentMode) ? "technical_illustration" : "scene_illustration",
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
      ...(this.deps.tier.allowMature ? { allowMature: true } : {}),
    };
  }

  /**
   * Reference-image bytes per ref id. A character's uploads are re-read from the
   * store for EVERY frame they appear in; caching keeps that to one read per
   * session AND hands providers identity-stable buffers (their own per-buffer
   * caches — base64 encodings, engine uploads — key off object identity).
   * The engine clears this whenever reference uploads change.
   */
  private readonly referenceBytesCache = new Map<
    string,
    Promise<{ bytes: ArrayBuffer; mimeType: string; prompt?: string } | undefined>
  >();

  /** Drop cached reference bytes (a reference was added/removed/re-keyed). */
  clearReferenceCache(): void {
    this.referenceBytesCache.clear();
  }

  private getReferenceImage(
    id: string,
  ): Promise<{ bytes: ArrayBuffer; mimeType: string; prompt?: string } | undefined> {
    let p = this.referenceBytesCache.get(id);
    if (!p) {
      p = this.deps.store.getImage(id);
      this.referenceBytesCache.set(id, p);
    }
    return p;
  }

  /** Bounded chapter context per chapterId — the book is immutable for this
   * pipeline's lifetime, and `buildRequest` runs per unit on both the prompt
   * pass and the render path, so the chapter join must not be repeated. */
  private readonly chapterContextCache = new Map<string, string>();

  /** Bounded text of the whole chapter this page belongs to, for continuity. */
  private chapterContextFor(page: Page): string {
    const cached = this.chapterContextCache.get(page.chapterId);
    if (cached !== undefined) return cached;
    const full = this.deps.book.pages
      .filter((p) => p.chapterId === page.chapterId)
      .flatMap((p) => p.paragraphs.map((x) => x.text))
      .join("\n\n")
      .replace(/\s+/g, " ")
      .trim();
    const bounded = full.length <= 1500 ? full : `${full.slice(0, 1500).trimEnd()}…`;
    this.chapterContextCache.set(page.chapterId, bounded);
    return bounded;
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
    // The cache id depends only on the page (same as `requestIdFor`) — building a
    // full VisualRequest here made every book open pay an entity+context scan per
    // page just to derive it.
    const requestId = `${this.deps.book.id}:${page.id}`;
    const cached = await this.deps.store.getImage(requestId);
    if (!cached) return undefined;
    return {
      requestId,
      pageId: page.id,
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

    if (!isSupportedKind(request.kind)) {
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
      // Technical books, retrieval-ONLY: an EXISTING figure (correct labels, correct
      // data) is the only image a technical unit shows — AI generation is disabled in
      // this mode so an invented-but-plausible diagram can never pose as a source of
      // truth. The LLM's visualization plan supplies the query (subject + visual form);
      // when it produced no structured subject, fall back to the prompt text so
      // retrieval still gets its shot. Nothing found → a `skipped` result whose note
      // names the concept (the UI shows the concept's explanation instead).
      if (request.kind === "technical_illustration") {
        const figureSubject =
          keyEvent?.imagePrompt.subject?.trim() || keyEvent?.imagePrompt.text?.trim().slice(0, 120);
        if (this.deps.imageSearch && figureSubject) {
          const query = buildFigureQuery(figureSubject, keyEvent!.imagePrompt.environment);
          try {
            const found = await this.deps.imageSearch.retrieve(query);
            if (found?.bytes) {
              const caption = retrievedCaption(query, found);
              await this.deps.store.putImage(requestId, found.bytes.bytes, found.bytes.mimeType, caption);
              return {
                requestId,
                pageId: request.pageId,
                status: "ready",
                prompt: caption,
                image: { bytes: found.bytes.bytes, mimeType: found.bytes.mimeType },
              };
            }
            if (found?.sourceUrl) {
              // Hotlink-only (the host blocked downloads): displayable but not cacheable,
              // so it re-resolves next session instead of being persisted.
              return {
                requestId,
                pageId: request.pageId,
                status: "ready",
                prompt: retrievedCaption(query, found),
                sourceUrl: found.sourceUrl,
              };
            }
          } catch {
            /* quota/network failure — fall through to the skipped result */
          }
          return {
            requestId,
            pageId: request.pageId,
            status: "skipped",
            prompt: noFigureNote(figureSubject),
          };
        }
        return { requestId, pageId: request.pageId, status: "skipped" };
      }
      // A stored keyEvent whose range doesn't exactly match this unit's is SHARED by
      // several units (the bible was extracted under a different pages-per-image
      // grouping, or the model emitted fewer keyEvents than units). Same prompt +
      // the same identity seed = pixel-identical images across those units — the
      // "every panel is the same picture" bug in the panel grid. Differentiate the
      // siblings deterministically: a beat cue in the prompt (covers providers that
      // ignore seeds) and a per-unit seed nudge below.
      const sharedEventOffset =
        keyEvent &&
        request.pageRange &&
        !this.deps.tier.nativeOneShot &&
        (keyEvent.pageRange[0] !== request.pageRange[0] ||
          keyEvent.pageRange[1] !== request.pageRange[1])
          ? Math.max(0, request.pageRange[0] - keyEvent.pageRange[0])
          : undefined;
      const beatCued =
        sharedEventOffset !== undefined && sharedEventOffset > 0
          ? `${stored}\n\n(Part ${sharedEventOffset + 1} of this scene's sequence — depict a LATER beat of the same moment, with a different composition than earlier parts.)`
          : stored;
      const styled = style.promptSuffix ? `${beatCued}\n\nStyle: ${style.promptSuffix}` : beatCued;
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
      let anchors = [...present.map((c) => c.anchor), ...presentCreatures.map((c) => c.anchor)];
      // Per-unit seed nudge for units sharing one keyEvent (see sharedEventOffset
      // above) — deterministic, so re-renders stay reproducible per unit.
      if (sharedEventOffset !== undefined && sharedEventOffset > 0) {
        anchors = anchors.map((a) => ({ ...a, seed: a.seed + sharedEventOffset }));
      }
      // Bible terms mentioned in the prompt (names → descriptors). Local backends expand them
      // family-aware; for cloud we pre-expand here (cloud providers don't know the bible).
      const terms = findBibleTermsInText(basePrompt, bible);
      const isLocal = this.deps.tier.tier === "local";
      // The bible's world style only rides along for the "auto" art style — an explicitly
      // chosen style WINS, instead of the prompt carrying two competing "Style:" directives.
      const worldStyle = this.deps.tier.style && this.deps.tier.style !== "auto" ? undefined : bible.worldStyle;
      const prompt = isLocal
        ? basePrompt
        : expandPrompt(
            basePrompt,
            terms,
            cloudNameHandling(this.deps.image.id),
            worldStyle,
            request.bookTitle,
          );
      // Reference images for IP-Adapter — user-uploaded only (auto-capture removed).
      const ipAdapterRefs = await this.referenceImagesFor(present);
      // Local engines additionally apply a style LoRA/checkpoint when installed. A manual
      // override (Settings) picks any installed LoRA over the style's automatic mapping —
      // or turns it off — so users aren't limited to the curated, model-specific packs.
      const local = isLocal ? style.local : undefined;
      const styleLora = !isLocal
        ? undefined
        : this.deps.tier.disableStyleLora
          ? undefined
          : this.deps.tier.styleLoraOverride
            ? { name: this.deps.tier.styleLoraOverride, strength: 0.8 }
            : local?.lora;
      // Everything about the render except the quality-level-dependent steps + canvas,
      // which are filled per-attempt so an out-of-memory failure can retry one level down.
      const baseInput: ImageGenerationInput = {
        prompt,
        anchors,
        quality: this.deps.tier.quality,
        ...(isLocal && this.deps.tier.localSampler ? { localSampler: this.deps.tier.localSampler } : {}),
        ...(isLocal && this.deps.tier.localScheduler ? { localScheduler: this.deps.tier.localScheduler } : {}),
        ...(styleLora ? { styleLora } : {}),
        ...(local?.checkpoint ? { styleCheckpoint: local.checkpoint } : {}),
        ...(this.deps.tier.imageModelFamily ? { modelFamily: this.deps.tier.imageModelFamily } : {}),
        ...(isLocal && this.deps.tier.localTextEncoder ? { textEncoder: this.deps.tier.localTextEncoder } : {}),
        ...(isLocal && this.deps.tier.localVae ? { vae: this.deps.tier.localVae } : {}),
        ...(isLocal && this.deps.tier.localSteps ? { stepsOverride: this.deps.tier.localSteps } : {}),
        ...(isLocal && this.deps.tier.localCfg !== undefined ? { cfgOverride: this.deps.tier.localCfg } : {}),
        ...(isLocal && this.deps.tier.lowVram ? { lowVram: true } : {}),
        // Local backends expand bible terms themselves (family-aware); cloud got them above.
        ...(isLocal && terms.length ? { terms } : {}),
        ...(isLocal && worldStyle ? { worldStyle } : {}),
        ...(isLocal && request.bookTitle ? { bookTitle: request.bookTitle } : {}),
        ...(ipAdapterRefs.length ? { ipAdapterRefs } : {}),
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
        // A keyEvent may pin a reproducible seed (overrides the character anchor seed).
        ...(typeof keyEvent?.seed === "number" ? { seed: keyEvent.seed } : {}),
      };
      // Quality level → steps + aspect-aware resolution (more pages/image = higher
      // quality; the canvas orientation comes from the user's aspect setting).
      const renderAt = (lvl: RenderQuality | undefined): Promise<ImageGenerationOutput> => {
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
      const img = await this.getReferenceImage(id);
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
/** Caption for a retrieved figure: what was searched + where it came from. */
function retrievedCaption(query: string, found: RetrievedImage): string {
  const source = found.contextLink ? `\n\nSource: ${found.title ? `${found.title} — ` : ""}${found.contextLink}` : "";
  return `Retrieved figure for “${query}”${source}`;
}

/** Skip note when no verified figure exists — names the concept so the UI can say so. */
export function noFigureNote(subject: string): string {
  return `No verified figure found for “${subject}” — image generation is off for technical books to keep a source of truth.`;
}

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
