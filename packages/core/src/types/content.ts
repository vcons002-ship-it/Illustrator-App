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
  // --- deferred (info-graphics), declared for forward-compatibility ---
  | "diagram"
  | "flowchart"
  | "summary";

export const SUPPORTED_KINDS: readonly ContentKind[] = ["scene_illustration"];

export function isSupportedKind(kind: ContentKind): boolean {
  return SUPPORTED_KINDS.includes(kind);
}

/** A unit of visual work derived from a page, fed through the pipeline. */
export interface VisualRequest {
  /** Discriminates which Renderer strategy handles this request. */
  kind: ContentKind;
  bookId: string;
  pageId: string;
  pageIndex: number;
  /** Source text the visual is derived from. */
  sourceText: string;
  /** Ids of Visual Bible characters relevant to this page. */
  characterIds: string[];
  /** Ids of Visual Bible environments relevant to this page. */
  environmentIds: string[];
  /** Spoiler entities present in the generated visual, if any. */
  spoilerIds: string[];
}

export type RenderStatus = "queued" | "prompting" | "rendering" | "ready" | "error";

export interface ImageResult {
  requestId: string;
  pageId: string;
  status: RenderStatus;
  /** Object URL or data URL of the rendered image when status === "ready". */
  imageUrl?: string;
  /** The final prompt sent to the image provider (for debugging / caching). */
  prompt?: string;
  error?: string;
}
