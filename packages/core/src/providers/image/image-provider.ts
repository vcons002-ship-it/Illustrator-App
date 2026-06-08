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
  /** Explicit sampler steps (from the resolved quality profile); overrides the quality default. */
  steps?: number;
  width?: number;
  height?: number;
  /** Local-engine style: a LoRA to apply when installed (ignored by cloud providers). */
  styleLora?: StyleLora;
  /** Local-engine style: prefer this checkpoint when installed (ignored by cloud providers). */
  styleCheckpoint?: string;
  /**
   * Explicit model-family override for prompt formatting (Settings). When set, the
   * local SD backends format for this family instead of guessing from the
   * checkpoint name. Ignored by cloud providers (they always use natural language).
   */
  modelFamily?: "sd15" | "sdxl" | "flux";
  /**
   * Optional negative-prompt override for SD backends. When absent they use a
   * sensible default (and Flux always sends none). Ignored by cloud providers.
   */
  negativePrompt?: string;
  /**
   * Structured identities of the characters present, for light SD-only weighting
   * emphasis (e.g. `(Ana: silver hair:1.1)`). Ignored by Flux/cloud providers.
   */
  subjects?: { name: string; features: string; outfit: string }[];
  /**
   * Per-character reference images for IP-Adapter conditioning (ComfyUI only, when
   * the IPAdapter nodes/models are installed). Resolved bytes, not ids. Ignored by
   * every other provider.
   */
  ipAdapterRefs?: { bytes: ArrayBuffer; mimeType: string; weight: number }[];
  /**
   * Optional progress sink (0..1) for engines that can report it (e.g. ComfyUI's
   * websocket emits per-step progress). Best-effort: providers that can't report
   * progress simply never call it. Not serialised — set in-process by the pipeline.
   */
  onProgress?: (fraction: number) => void;
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
