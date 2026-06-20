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
  /**
   * Canvas orientation. "square" (default) renders 1:1; portrait/landscape keep the
   * same pixel area at a 2:3 / 3:2 ratio. The pipeline resolves this to width/height.
   */
  aspectRatio?: "square" | "portrait" | "landscape";
  /** Art-style id (see catalog `IMAGE_STYLES`); its prompt suffix is appended. */
  style?: string;
  /**
   * Manual style-LoRA override for the local engine. When set, this installed LoRA
   * filename is applied instead of the style's automatic mapping (so any LoRA in the
   * engine's folder can be used with any style). `disableStyleLora` turns the LoRA off
   * entirely (prompt-only styling). Unset = the style's default mapping. Cloud ignores.
   */
  styleLoraOverride?: string;
  disableStyleLora?: boolean;
  /**
   * Advanced manual sampler/scheduler choice for local ComfyUI (e.g. "dpmpp_2m" /
   * "karras"). Unset = the family/catalog default. Cloud providers ignore these.
   */
  localSampler?: string;
  localScheduler?: string;
  /**
   * Multi-panel comic page: append a "single image laid out as a comic page" directive
   * to the prompt when the chosen style is comic/manga. Off by default. (The reader's
   * panel-grid view — composing several unit images — is a separate, UI-only feature.)
   */
  drawAsComicPage?: boolean;
  /**
   * Manual image model-family override for SD prompt formatting (Settings). When
   * unset, the local backends auto-detect from the checkpoint. Cloud providers
   * ignore it (they always use natural language).
   */
  imageModelFamily?: "sd15" | "sdxl" | "flux" | "flux2" | "zimage" | "qwenimage" | "hidream";
  /**
   * Manual component overrides for split-file local models (Flux.2 / Z-Image / Qwen-Image /
   * HiDream) when auto-detection of the text encoder / VAE picks the wrong file. Exact
   * filenames as ComfyUI lists them; unset = auto-resolve. Cloud providers ignore these.
   * (HiDream's four text encoders auto-resolve; only the VAE override applies there.)
   */
  localTextEncoder?: string;
  localVae?: string;
  /** Advanced manual sampler overrides for local ComfyUI: step count (any family) and the
   * CFG/guidance scale. Unset = the family/catalog default. Cloud providers ignore these. */
  localSteps?: number;
  localCfg?: number;
  /** Low-VRAM mode for the local engine: fp8 UNET loading + (managed engine) launch ComfyUI
   * with --lowvram so the big text encoder offloads to CPU after encoding. Shrinks the
   * resident VRAM/RAM footprint of heavy split-file models (Flux.2/Z-Image/Qwen-Image). */
  lowVram?: boolean;
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
  /**
   * Mature-content mode: the reader has opted in to unfiltered illustration and
   * discussion of explicit/adult source material. Relaxes the adjustable provider
   * safety knobs (Gemini safetySettings, Flux safety_tolerance) and tells the LLM
   * to depict/describe mature content faithfully rather than sanitize it. Off by
   * default. (Providers without an adjustable knob — Claude/OpenAI — still follow
   * their own policies; this only changes what THIS app asks for.)
   */
  allowMature?: boolean;
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  tier: "cloud",
  llmProvider: "claude",
  imageProvider: "flux",
  quality: "cinematic",
  style: "auto",
};
