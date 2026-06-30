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
  /**
   * Resolved render-quality level. Natural-language families scale their own recommended
   * step count by this (SD families use `steps` from the profile ladder instead). Unset =
   * "standard".
   */
  renderQuality?: "draft" | "standard" | "high" | "ultra";
  /**
   * Explicit render seed (e.g. from a keyEvent for reproducibility). Overrides the
   * character/creature anchor seed when set.
   */
  seed?: number;
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
  modelFamily?: "sd15" | "sdxl" | "flux" | "flux2" | "zimage" | "qwenimage" | "hidream";
  /**
   * Visual-Bible terms (characters/creatures/outfits/locations) that appear in the
   * prompt, each with a visual `descriptor`. The local backends expand them per the
   * target's text-encoder grade: CLIP/T5 (SD/Flux.1) inject `(descriptor)` in place;
   * LLM-grade (Flux.2/Mistral) keep the name + a reference block. The pipeline
   * pre-expands cloud prompts, so cloud providers ignore this.
   */
  terms?: { names: string[]; descriptor: string; kind: "character" | "creature" | "outfit" | "location" }[];
  /** How a local backend should expand `terms` (resolved from the model family). */
  nameHandling?: "inject" | "reference";
  /**
   * Manual overrides for a split-file model's components (Flux.2 / Z-Image / Qwen-Image)
   * when auto-detection picks the wrong file: the exact text-encoder and/or VAE filename
   * as ComfyUI lists them. Empty/unset = auto-resolve. Ignored by cloud providers.
   */
  textEncoder?: string;
  vae?: string;
  /**
   * Advanced manual sampler overrides (local ComfyUI only). `stepsOverride` sets the
   * sampler step count for ANY family (natural-language families otherwise use their
   * fixed recommended count). `cfgOverride` sets the embedded GUIDANCE value for
   * guidance-distilled Flux, else the real CFG scale. Unset = the family/catalog default.
   */
  stepsOverride?: number;
  cfgOverride?: number;
  /**
   * Advanced manual sampler/scheduler choice (local ComfyUI only), overriding the
   * family/catalog default (e.g. "dpmpp_2m" / "karras"). Unset = the default. Ignored
   * by cloud providers.
   */
  localSampler?: string;
  localScheduler?: string;
  /** Low-VRAM: load the diffusion UNET in fp8 (split-file families) to roughly halve its
   * resident weights. The engine's --lowvram flag handles encoder offload. Local only. */
  lowVram?: boolean;
  /**
   * Hi-Res two-pass: render at the family's native-safe size (single coherent subject),
   * then upscale the latent ~2× and refine at low denoise for a larger, more detailed
   * image without the subject duplication that comes from sampling above the trained
   * resolution. ComfyUI only; cloud providers render at their own resolution and ignore it.
   */
  hires?: boolean;
  /** Always-applied world-style/genre anchor (from the bible), added to every prompt. */
  worldStyle?: string;
  /** Book title, for the reference-block header on LLM-grade targets. */
  bookTitle?: string;
  /**
   * Optional negative-prompt override for SD backends. When absent they use a
   * sensible default (and Flux always sends none). Ignored by cloud providers.
   */
  negativePrompt?: string;
  /**
   * Per-character reference images for IP-Adapter conditioning (ComfyUI only, when
   * the IPAdapter nodes/models are installed). Resolved bytes, not ids. Ignored by
   * every other provider.
   */
  ipAdapterRefs?: { bytes: ArrayBuffer; mimeType: string; weight: number }[];
  /**
   * img2img base — photo manipulation. When set, the backend encodes this image to
   * latent and denoises FROM it (transform an existing picture) instead of starting
   * from pure noise. ComfyUI only; the other providers ignore it and run txt2img.
   */
  initImage?: { bytes: ArrayBuffer; mimeType: string };
  /**
   * img2img strength 0..1 — how much the init image may change. Lower stays closer
   * to the photo, higher reinvents more. Only meaningful with `initImage`; the
   * backend defaults to ~0.65 when unset.
   */
  denoise?: number;
  /**
   * Optional progress sink (0..1) for engines that can report it (e.g. ComfyUI's
   * websocket emits per-step progress). Best-effort: providers that can't report
   * progress simply never call it. Not serialised — set in-process by the pipeline.
   */
  onProgress?: (fraction: number) => void;
  /**
   * Optional cancellation signal. When it aborts (the user paused image generation),
   * the backend stops the in-flight request — and local backends additionally tell
   * the engine to interrupt the running job so the GPU frees immediately.
   */
  signal?: AbortSignal;
}

export interface ImageGenerationOutput {
  /** Raw image bytes; the caller turns this into an object URL and caches it. */
  bytes: ArrayBuffer;
  mimeType: string;
}

/** Files a Wan2.2 two-expert image-to-video graph needs (a high/low-noise pair + encoder + VAE).
 * Every field is a ComfyUI filename the reader can override from Settings to swap a component or work
 * around a failed download. The two experts take independent LoRAs (Wan ships separate high/low-noise
 * LoRAs); each is optional and wraps only its own expert. */
export interface WanVideoFiles {
  readonly kind: "wan-i2v";
  /** High-noise diffusion model (first sampling stage). */
  highNoise: string;
  /** Low-noise diffusion model (refinement stage). */
  lowNoise: string;
  /** Text encoder (umt5 for Wan). */
  textEncoder: string;
  /** VAE. */
  vae: string;
  /** Optional LoRA wrapping the high-noise expert only. */
  loraHigh?: string;
  /** Optional LoRA wrapping the low-noise expert only. */
  loraLow?: string;
}

/** One LoRA in a stack: a ComfyUI filename + a model strength (default 1). */
export interface VideoLora {
  name: string;
  /** ComfyUI strength_model weight. Default 1 when omitted. */
  strength?: number;
}

/** Files an LTX-2 image-to-video graph needs: one combined checkpoint (model + VAE) plus the separate
 * Gemma text encoder. `loras` is an optional ordered stack, each chained onto the previous (motion/style
 * LoRAs, the distilled speed LoRA, etc.). */
export interface Ltx2VideoFiles {
  readonly kind: "ltx2-i2v";
  /** Combined LTX-2 checkpoint (loaded via CheckpointLoaderSimple — provides the model and VAE). */
  checkpoint: string;
  /** Gemma text encoder. */
  textEncoder: string;
  /** Optional ordered stack of LoRAs applied to the model (each chained onto the previous). */
  loras?: VideoLora[];
}

/** The model files an image-to-video engine needs — the shape depends on the model family (`kind`).
 * Discriminate on `kind` before reading family-specific filenames. */
export type VideoModelFiles = WanVideoFiles | Ltx2VideoFiles;

/** A flat bag of per-file Settings overrides — a superset of every family's filenames, all optional.
 * Applied over the selected model's catalog defaults by resolveVideoModelFiles. */
export interface VideoFileOverrides {
  highNoise?: string;
  lowNoise?: string;
  textEncoder?: string;
  vae?: string;
  checkpoint?: string;
  /** Wan high-noise expert LoRA. */
  loraHigh?: string;
  /** Wan low-noise expert LoRA. */
  loraLow?: string;
  /** LTX-2 ordered LoRA stack. */
  ltxLoras?: VideoLora[];
}

/** The sampler/size/length choices for an image-to-video render — overridable from Settings. */
export interface VideoRenderParams {
  frames?: number;
  fps?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  /** Sigma shift (Wan's recommended ~8 for video). */
  shift?: number;
}

/** Input for an image-to-video render: a source image + a motion prompt + clip params. */
export interface VideoGenerationInput {
  /** What should happen / how the scene should move (the image already fixes what it looks like). */
  prompt: string;
  /** The source image to animate. */
  image: { bytes: ArrayBuffer; mimeType: string };
  negativePrompt?: string;
  /** Number of frames in the clip. */
  frames?: number;
  /** Frames per second of the output file. */
  fps?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  /** Sigma shift (Wan ~8 for video). */
  shift?: number;
  seed?: number;
  lowVram?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface VideoGenerationOutput {
  bytes: ArrayBuffer;
  /** The artifact's MIME — "video/mp4", "video/webm", or "image/webp"/"image/gif" for an animated image. */
  mimeType: string;
}

export interface ImageProvider {
  /** Stable provider key, e.g. "flux". */
  readonly id: string;
  generate(input: ImageGenerationInput): Promise<ImageGenerationOutput>;
  /** Optional: animate a source image into a short video (image-to-video). Present only for a local
   * engine that supports it (ComfyUI); absent / rejects elsewhere. */
  generateVideo?(input: VideoGenerationInput, models: VideoModelFiles): Promise<VideoGenerationOutput>;
  /** Optional: release the image model's VRAM now (e.g. a local ComfyUI /free) so a chat LLM can reload
   * into the freed memory. No-op / absent for providers whose VRAM the app can't coordinate. */
  freeMemory?(): Promise<void>;
}
