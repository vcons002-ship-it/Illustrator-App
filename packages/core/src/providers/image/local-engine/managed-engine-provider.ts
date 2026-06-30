import type {
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageProvider,
  VideoGenerationInput,
  VideoGenerationOutput,
  VideoModelFiles,
} from "../image-provider.js";
import type { LocalEngineBackend } from "./backend.js";

/**
 * Image provider for the app-managed local GPU engine (desktop "Run on my
 * computer" path). It is a thin wrapper that pairs an engine backend with the
 * user's chosen checkpoint and exposes the standard `ImageProvider` interface,
 * so the rest of the pipeline treats local GPU generation exactly like any cloud
 * provider. Real-GPU, any-model-size generation lives in the backend.
 */
export class ManagedEngineImageProvider implements ImageProvider {
  readonly id = "local";

  constructor(
    private readonly backend: LocalEngineBackend,
    private readonly model: string,
  ) {}

  generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    if (!this.model) {
      return Promise.reject(new Error("No local model selected"));
    }
    return this.backend.generate(input, this.model);
  }

  /** Animate a source image into a short video, when the backend supports it (ComfyUI). */
  generateVideo(input: VideoGenerationInput, models: VideoModelFiles): Promise<VideoGenerationOutput> {
    if (!this.backend.generateVideo) {
      return Promise.reject(new Error("This local engine doesn't support image-to-video (use ComfyUI)."));
    }
    return this.backend.generateVideo(input, models);
  }

  /** Hand the GPU back: unload the image model so a co-resident chat LLM can reload into the freed VRAM.
   * Best-effort — absent on backends that don't coordinate VRAM (resolves immediately). */
  freeMemory(): Promise<void> {
    return this.backend.freeMemory?.() ?? Promise.resolve();
  }
}
