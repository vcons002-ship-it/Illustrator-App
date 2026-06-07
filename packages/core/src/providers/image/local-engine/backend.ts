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

export interface LocalEngineBackend {
  /** Models the running engine has available right now. */
  listModels(): Promise<LocalModelDescriptor[]>;
  /** Generate one image with the given checkpoint. */
  generate(input: ImageGenerationInput, model: string): Promise<ImageGenerationOutput>;
}
