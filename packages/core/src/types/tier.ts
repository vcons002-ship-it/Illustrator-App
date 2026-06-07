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
  /** Art-style id (see catalog `IMAGE_STYLES`); its prompt suffix is appended. */
  style?: string;
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  tier: "cloud",
  llmProvider: "claude",
  imageProvider: "flux",
  quality: "cinematic",
  style: "auto",
};
