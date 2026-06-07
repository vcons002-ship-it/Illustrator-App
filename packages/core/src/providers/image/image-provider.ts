import type { IdentityAnchor } from "../../types/bible.js";

/**
 * Image provider interface. Implementations: FluxProvider (default cloud) and
 * an OnnxDiffusionProvider stub for the local WebGPU tier. Identity anchors are
 * passed through so providers that support seeds / IP-Adapter / LoRA can pin
 * character appearance.
 */

export interface ImageGenerationInput {
  prompt: string;
  /** Identity anchors for characters present, for consistency conditioning. */
  anchors: IdentityAnchor[];
  /** Quality hint from the active tier config. */
  quality: "sketch" | "standard" | "cinematic";
  width?: number;
  height?: number;
}

export interface ImageGenerationOutput {
  /** Raw image bytes; the caller turns this into an object URL and caches it. */
  bytes: ArrayBuffer;
  mimeType: string;
}

export interface ImageProvider {
  /** Stable provider key, e.g. "flux". */
  readonly id: string;
  generate(input: ImageGenerationInput): Promise<ImageGenerationOutput>;
}
