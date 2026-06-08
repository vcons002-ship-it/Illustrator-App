import type { IdentityAnchor } from "../../types/bible.js";

/**
 * Image provider interface. Implementations: FluxProvider (default cloud) and
 * an OnnxDiffusionProvider stub for the local WebGPU tier. Identity anchors are
 * passed through so providers that support seeds / IP-Adapter / LoRA can pin
 * character appearance.
 */

/** A LoRA to apply for a chosen art style on a local engine. */
export interface StyleLora {
  /** LoRA name (filename, with or without extension) as the engine knows it. */
  name: string;
  /** Applied strength (model + clip). */
  strength: number;
  /** Optional trigger words prepended to the prompt. */
  trigger?: string;
}

export interface ImageGenerationInput {
  prompt: string;
  /** Identity anchors for characters present, for consistency conditioning. */
  anchors: IdentityAnchor[];
  /** Quality hint from the active tier config. */
  quality: "sketch" | "standard" | "cinematic";
  width?: number;
  height?: number;
  /** Local-engine style: a LoRA to apply when installed (ignored by cloud providers). */
  styleLora?: StyleLora;
  /** Local-engine style: prefer this checkpoint when installed (ignored by cloud providers). */
  styleCheckpoint?: string;
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
