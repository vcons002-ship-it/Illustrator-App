import type { BookSource, Page } from "../types/book.js";
import type { Character, Creature, VisualBible } from "../types/bible.js";
import type { ImageResult, VisualRequest } from "../types/content.js";
import type { TierConfig } from "../types/tier.js";
import type { LLMProvider } from "../providers/llm/llm-provider.js";
import type { ImageProvider } from "../providers/image/image-provider.js";
import type { VisualReaderStore } from "../storage/store.js";
import { resolvePageEntities } from "../visual-bible/bible.js";
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
  /**
   * Capture a just-rendered solo-character frame as that character's reference
   * image (for IP-Adapter). Called only when exactly one character is present and
   * they have no reference yet. The engine persists it onto the bible.
   */
  captureReference?: (characterId: string, bytes: ArrayBuffer, mimeType: string) => void | Promise<void>;
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
      pageId: page.id,
      pageIndex: page.index,
      chapterIndex: this.deps.book.chapters.find((c) => c.id === page.chapterId)?.index ?? 0,
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
      const basePrompt = await this.deps.llm.buildImagePrompt(request, bible);
      const prompt = style.promptSuffix ? `${basePrompt}\n\nStyle: ${style.promptSuffix}` : basePrompt;
      const present = bible.characters.filter((c) => request.characterIds.includes(c.id));
      const presentCreatures = (bible.creatures ?? []).filter((c) =>
        request.creatureIds.includes(c.id),
      );
      // Characters first so the seed anchor (anchors[0]) stays a character when one
      // is present; a creature-only frame is pinned by the creature's seed.
      const anchors = [...present.map((c) => c.anchor), ...presentCreatures.map((c) => c.anchor)];
      // Identity emphasis (SD-only, applied by the backend) — every present
      // character AND creature, so consistency never depends on a reference image.
      const subjects = [...present.map(buildSubject), ...presentCreatures.map(buildCreatureSubject)];
      // Reference images for IP-Adapter (ComfyUI uses them when installed).
      const ipAdapterRefs = await this.referenceImagesFor(present);
      // Local engines additionally apply a style LoRA/checkpoint when installed.
      const local = this.deps.tier.tier === "local" ? style.local : undefined;
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
        ...(subjects.length ? { subjects } : {}),
        ...(ipAdapterRefs.length ? { ipAdapterRefs } : {}),
        ...(onProgress ? { onProgress } : {}),
      });
      await this.deps.store.putImage(requestId, output.bytes, output.mimeType);
      // Capture a clean solo frame as this character's reference (first time only).
      if (this.deps.captureReference && present.length === 1 && !present[0]!.anchor.referenceImageId) {
        await this.deps.captureReference(present[0]!.id, output.bytes, output.mimeType);
      }
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

  /** Resolve stored reference images for characters that have one. */
  private async referenceImagesFor(
    present: Character[],
  ): Promise<{ bytes: ArrayBuffer; mimeType: string; weight: number }[]> {
    const refs: { bytes: ArrayBuffer; mimeType: string; weight: number }[] = [];
    for (const c of present) {
      const id = c.anchor.referenceImageId;
      if (!id) continue;
      const img = await this.deps.store.getImage(id);
      if (img) refs.push({ bytes: img.bytes, mimeType: img.mimeType, weight: 0.7 });
    }
    return refs;
  }
}

/** Structured identity for SD weighting emphasis; never empty (always has a name). */
function buildSubject(c: Character): { name: string; features: string; outfit: string } {
  const a = c.appearance;
  const fields: string[] = [];
  if (a) {
    for (const v of [a.gender, a.age, a.hair, a.eyes, a.build, a.height, a.skinTone, a.distinguishingMarks]) {
      if (v && v.trim()) fields.push(v.trim());
    }
  }
  // Fall back to free-form traits when the text never gave structured appearance.
  if (fields.length === 0) {
    for (const t of c.persistentTraits) if (t && t.trim()) fields.push(t.trim());
  }
  // Outfit is left to the LLM prompt (it picks the scene-appropriate one); the SD
  // emphasis block reinforces only the persistent identity, not a specific outfit.
  return { name: c.name, features: fields.join(", "), outfit: "" };
}

/** A creature as an SD subject: its kind + accumulated description as the features. */
function buildCreatureSubject(c: Creature): { name: string; features: string; outfit: string } {
  const features = [c.kind, ...c.description].filter((t) => t && t.trim()).join(", ");
  return { name: c.name, features, outfit: "" };
}
