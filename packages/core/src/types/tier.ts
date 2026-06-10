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
  imageModelFamily?: "sd15" | "sdxl" | "flux" | "flux2";
  /**
   * True when the SAME cloud vendor + key serves both the text and image slots (e.g.
   * both Gemini). A future "native" mode can then let that one API read a chapter and
   * emit illustrations directly (epub-chapter-in → images-out) instead of the split
   * extract→prompt→image path. Seam only today — the pipeline still uses the split path.
   */
  nativeIllustration?: boolean;
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  tier: "cloud",
  llmProvider: "claude",
  imageProvider: "flux",
  quality: "cinematic",
  style: "auto",
};
