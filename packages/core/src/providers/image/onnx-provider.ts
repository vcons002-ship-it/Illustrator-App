import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "./image-provider.js";

/**
 * Local (opt-in) image provider — on-device Stable Diffusion Turbo via ONNX
 * Runtime Web + WebGPU. Stubbed for v1; the interface is fixed so the full
 * implementation can land later (Phase F) with no pipeline changes.
 *
 * Real implementation would lazily import `onnxruntime-web`, run the diffusion
 * pipeline on WebGPU, and honour the identity seed for character consistency.
 * Requires Cross-Origin Isolation (COOP/COEP) — already configured on the web
 * app (see apps/web/vite.config.ts).
 */
export class OnnxDiffusionProvider implements ImageProvider {
  readonly id = "onnx-webgpu";

  async generate(_input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    throw new Error(
      "OnnxDiffusionProvider is not implemented yet (local tier — planned for Phase F).",
    );
  }
}
