/**
 * Compute-tier seam. "cloud" is the default (hosted LLM + image APIs); "local"
 * is the opt-in on-device tier (WebGPU/WASM). Both are selected through the
 * same provider interfaces, so adding the local implementation later requires
 * no pipeline changes.
 */
export type ComputeTier = "cloud" | "local";

export interface TierConfig {
  tier: ComputeTier;
  /** Which LLM provider to use within the tier (e.g. "claude", "gemini"). */
  llmProvider: string;
  /** Which image provider to use within the tier (e.g. "flux", "onnx-webgpu"). */
  imageProvider: string;
  /** Image quality hint; cloud favours fidelity, local favours speed. */
  quality: "sketch" | "standard" | "cinematic";
  /**
   * Resolved render quality level (steps + resolution), from the user's quality
   * setting and pages-per-image. When set, the pipeline passes its profile to the
   * image provider; when absent, providers use their own defaults.
   */
  renderQuality?: "draft" | "standard" | "high" | "ultra";
  /** Art-style id (see catalog `IMAGE_STYLES`); its prompt suffix is appended. */
  style?: string;
  /**
   * Manual image model-family override for SD prompt formatting (Settings). When
   * unset, the local backends auto-detect from the checkpoint. Cloud providers
   * ignore it (they always use natural language).
   */
  imageModelFamily?: "sd15" | "sdxl" | "flux" | "flux2" | "zimage" | "qwenimage";
  /**
   * "One API" native mode: the SAME cloud vendor + key serves both slots (e.g. both
   * Gemini), and the image slot uses the vendor's MULTIMODAL endpoint — which accepts
   * the character reference photos inline, giving cloud renders the consistency
   * conditioning that previously needed a local ComfyUI + IP-Adapter. The render
   * pipeline is otherwise unchanged (it still writes the per-image scene prompt).
   */
  nativeIllustration?: boolean;
  /**
   * Experimental sub-mode of `nativeIllustration`: feed the chapter PASSAGE text to the
   * multimodal model directly (it reads + draws in one step) instead of the pre-written
   * scene prompt. The Visual Bible still gates rendering and supplies reference photos /
   * world style; only the prompt TEXT is swapped. Off unless the user opts in.
   */
  nativeOneShot?: boolean;
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  tier: "cloud",
  llmProvider: "claude",
  imageProvider: "flux",
  quality: "cinematic",
  style: "auto",
};
