import type { ImageGenerationInput, ImageGenerationOutput } from "../image-provider.js";

/**
 * Adapter interface for an app-managed local inference engine (the desktop tier).
 *
 * The desktop shell installs, launches, and shuts down the engine (e.g. a
 * portable ComfyUI) invisibly; this interface is how the engine-agnostic image
 * provider talks to it. Modelling it as an adapter means a different engine
 * (Automatic1111's REST API, or a Rust-native `candle` engine later) can be
 * swapped in without touching the provider or the UI. Every implementation is
 * built on the injectable `Transport` seam, so it is unit-testable with a fake
 * transport exactly like the cloud providers.
 */

export interface LocalModelDescriptor {
  /** Engine-specific model id (e.g. a checkpoint filename). */
  id: string;
  /** Human-friendly label for the picker. */
  label: string;
  /** Approximate on-disk size in GB, when known (0 = unknown). */
  sizeGB: number;
}

/**
 * The separate component files a split-file diffusion model loads (Flux.2 / Z-Image /
 * Qwen-Image / UNET-only Flux.1): the text encoders and VAEs the engine has on disk. Empty
 * for an all-in-one engine (AUTOMATIC1111 SD/SDXL) where the checkpoint bundles them. Drives
 * the Settings dropdowns + the "which one works with this model" suggestion.
 */
export interface LocalEngineComponents {
  /** Text-encoder filenames the engine exposes (CLIPLoader + DualCLIPLoader, deduped). */
  textEncoders: string[];
  /** VAE filenames the engine exposes (VAELoader). */
  vaes: string[];
}

export interface LocalEngineBackend {
  /** Models the running engine has available right now. */
  listModels(): Promise<LocalModelDescriptor[]>;
  /** Separate text-encoder + VAE files the engine has (empty for all-in-one engines). */
  listComponents(): Promise<LocalEngineComponents>;
  /** Generate one image with the given checkpoint. */
  generate(input: ImageGenerationInput, model: string): Promise<ImageGenerationOutput>;
}
