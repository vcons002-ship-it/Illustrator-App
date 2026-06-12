/**
 * The visual-output seam.
 *
 * `ContentKind` is the single discriminator that lets new output types
 * (diagrams, flowcharts, summaries — the deferred "info-graphics") be added
 * later without reworking the pipeline. v1 implements `scene_illustration`
 * only; the other kinds are declared so call sites and the Renderer strategy
 * are exhaustive from day one.
 */
export type ContentKind =
  | "scene_illustration"
  /** Non-fiction (papers, textbooks): illustrate the CONCEPT/process, not a story scene. */
  | "technical_illustration"
  // --- deferred (info-graphics), declared for forward-compatibility ---
  | "diagram"
  | "flowchart"
  | "summary";

export const SUPPORTED_KINDS: readonly ContentKind[] = [
  "scene_illustration",
  "technical_illustration",
];

export function isSupportedKind(kind: ContentKind): boolean {
  return SUPPORTED_KINDS.includes(kind);
}

/** A unit of visual work derived from a page, fed through the pipeline. */
export interface VisualRequest {
  /** Discriminates which Renderer strategy handles this request. */
  kind: ContentKind;
  bookId: string;
  /** Title of the book, for genre/continuity context in prompt-writing. */
  bookTitle?: string;
  pageId: string;
  pageIndex: number;
  /** Index of the chapter this unit belongs to (keys the storyboard scene). */
  chapterIndex: number;
  /**
   * Inclusive [start, end] original page indices this unit covers, for matching a
   * stored keyEvent prompt by page-range overlap. Absent for raw single pages.
   */
  pageRange?: [number, number];
  /** Source text the visual is derived from. */
  sourceText: string;
  /**
   * Broader chapter text (bounded) for continuity, so a unit whose own passage is
   * sparse still has surrounding context. Optional.
   */
  chapterContext?: string;
  /** Ids of Visual Bible characters relevant to this page. */
  characterIds: string[];
  /** Ids of Visual Bible environments relevant to this page. */
  environmentIds: string[];
  /** Ids of Visual Bible creatures (dragons, beasts…) relevant to this page. */
  creatureIds: string[];
  /** Spoiler entities present in the generated visual, if any. */
  spoilerIds: string[];
  /** Mature mode: depict explicit/adult content faithfully (see TierConfig.allowMature). */
  allowMature?: boolean;
}

export type RenderStatus =
  | "queued"
  | "prompting"
  | "rendering"
  | "ready"
  | "error"
  /** Page is front/back matter (not part of the story): never illustrated. */
  | "skipped";

/** Raw rendered image. Bytes (not realm-scoped object URLs) so a result can be
 * transferred from a Web Worker to the main thread; the UI makes the URL. */
export interface ImageBytes {
  bytes: ArrayBuffer;
  mimeType: string;
}

export interface ImageResult {
  requestId: string;
  pageId: string;
  status: RenderStatus;
  /** Rendered image bytes when status === "ready". */
  image?: ImageBytes;
  /**
   * Retrieved-figure fallback (technical books): a direct image URL for <img src>
   * display when the figure's bytes couldn't be downloaded (hotlink-only host).
   * Only one of `image` / `sourceUrl` is set on a ready result.
   */
  sourceUrl?: string;
  /** The final prompt sent to the image provider (for debugging / caching). */
  prompt?: string;
  error?: string;
  /** Generation progress 0..1 while status === "rendering" (best-effort, engine-reported). */
  progress?: number;
}
