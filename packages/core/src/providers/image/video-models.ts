import type { VideoModelFiles, VideoFileOverrides } from "./image-provider.js";

/**
 * Catalog of installable image-to-video models for the local ComfyUI engine. Ships two families:
 *  - Wan2.2 14B I2V — a two-expert high/low-noise pair + umt5 encoder + Wan 2.1 VAE (~5s clips, the default).
 *  - LTX-2.3 22B I2V — a single combined checkpoint + Gemma text encoder (longer/higher-fps clips).
 * The download URLs live here too; this module is the single source of the FILENAMES the engine graph
 * references, shared by the host (which passes them to generateVideo) and the downloader.
 */
/** One downloadable file for a video model, with the ComfyUI subfolder it belongs in. */
export interface VideoModelDownload {
  filename: string;
  url: string;
  folder: "checkpoints" | "diffusion_models" | "text_encoders" | "vae" | "loras" | "latent_upscale_models";
}

export interface VideoModelCatalogEntry {
  id: string;
  label: string;
  /** Approx total on-disk size in GB (for the picker + a "this is a big download" warning). */
  sizeGB: number;
  /** The engine model filenames this entry resolves to. */
  files: VideoModelFiles;
  /** The files to fetch (into ComfyUI's models subfolders) to install this model. */
  downloads: VideoModelDownload[];
}

/** Per-family render defaults — the placeholder/baseline frames/fps/size/steps/cfg/shift for each graph.
 * Shared by the backend (when a render input leaves a field blank) and the Settings UI (placeholders). */
export const VIDEO_RENDER_DEFAULTS = {
  "wan-i2v": { frames: 81, fps: 16, width: 640, height: 640, steps: 20, cfg: 3.5, shift: 8 },
  "ltx2-i2v": { frames: 121, fps: 24, width: 768, height: 512, steps: 20, cfg: 1, shift: 0 },
} as const satisfies Record<VideoModelFiles["kind"], { frames: number; fps: number; width: number; height: number; steps: number; cfg: number; shift: number }>;

/** Comfy-Org's repackaged Wan 2.2 weights, laid out exactly as ComfyUI expects. */
const WAN22_BASE = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files";

/** Wan 2.2 14B image-to-video (fp8) — the default (~5s clips, strong motion). */
export const WAN22_I2V_14B: VideoModelCatalogEntry = {
  id: "wan2.2-i2v-14b",
  label: "Wan 2.2 (14B image-to-video, ~5s)",
  sizeGB: 33,
  files: {
    kind: "wan-i2v",
    highNoise: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
    lowNoise: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
    textEncoder: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    vae: "wan_2.1_vae.safetensors",
  },
  downloads: [
    { filename: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", folder: "diffusion_models", url: `${WAN22_BASE}/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` },
    { filename: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", folder: "diffusion_models", url: `${WAN22_BASE}/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` },
    { filename: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", folder: "text_encoders", url: `${WAN22_BASE}/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` },
    { filename: "wan_2.1_vae.safetensors", folder: "vae", url: `${WAN22_BASE}/vae/wan_2.1_vae.safetensors` },
  ],
};

/** LTX-2.3 22B image-to-video (fp8) — longer (up to ~20s) and higher-fps clips. Single combined checkpoint
 * (model + VAE) loaded via CheckpointLoaderSimple, plus the separate Gemma text encoder. Fits a 32GB GPU
 * with model offloading. The checkpoint comes from Lightricks; the Gemma encoder from Comfy-Org's split. */
export const LTX2_I2V_22B: VideoModelCatalogEntry = {
  id: "ltx2.3-i2v-22b",
  label: "LTX-2.3 (22B image-to-video, longer + faster)",
  sizeGB: 31,
  files: {
    kind: "ltx2-i2v",
    checkpoint: "ltx-2.3-22b-dev-fp8.safetensors",
    textEncoder: "gemma_3_12B_it_fp4_mixed.safetensors",
    distilledLora: "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors",
    upscaler: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
  },
  downloads: [
    { filename: "ltx-2.3-22b-dev-fp8.safetensors", folder: "checkpoints", url: "https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-dev-fp8.safetensors" },
    { filename: "gemma_3_12B_it_fp4_mixed.safetensors", folder: "text_encoders", url: "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors" },
    { filename: "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors", folder: "loras", url: "https://huggingface.co/Comfy-Org/ltx-2.3/resolve/main/split_files/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors" },
    { filename: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors", folder: "latent_upscale_models", url: "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors" },
  ],
};

export const VIDEO_MODELS: readonly VideoModelCatalogEntry[] = [WAN22_I2V_14B, LTX2_I2V_22B];

export function videoModelById(id: string | undefined): VideoModelCatalogEntry | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

/**
 * The model files for the reader's selected video model, with per-file Settings OVERRIDES applied over the
 * catalog default — so a broken download or a deliberate component swap (a different checkpoint / text
 * encoder / VAE / LoRA) can be fixed without touching code. A blank/whitespace override is ignored (falls
 * back to the default); an `lora` override turns the optional LoRA on. Branches on the model family. PURE.
 */
export function resolveVideoModelFiles(id?: string, overrides?: VideoFileOverrides): VideoModelFiles {
  const base = (videoModelById(id) ?? WAN22_I2V_14B).files;
  const o = (key: Exclude<keyof VideoFileOverrides, "ltxLoras">): string | undefined =>
    overrides?.[key]?.trim() || undefined;
  if (base.kind === "ltx2-i2v") {
    // The override stack wins over the catalog default; drop blank-named rows.
    const loras = (overrides?.ltxLoras ?? base.loras)
      ?.map((l) => ({ name: l.name.trim(), ...(l.strength !== undefined ? { strength: l.strength } : {}) }))
      .filter((l) => l.name);
    return {
      kind: "ltx2-i2v",
      checkpoint: o("checkpoint") ?? base.checkpoint,
      textEncoder: o("textEncoder") ?? base.textEncoder,
      distilledLora: o("distilledLora") ?? base.distilledLora,
      upscaler: o("upscaler") ?? base.upscaler,
      ...(loras && loras.length ? { loras } : {}),
    };
  }
  const loraHigh = o("loraHigh") ?? base.loraHigh;
  const loraLow = o("loraLow") ?? base.loraLow;
  return {
    kind: "wan-i2v",
    highNoise: o("highNoise") ?? base.highNoise,
    lowNoise: o("lowNoise") ?? base.lowNoise,
    textEncoder: o("textEncoder") ?? base.textEncoder,
    vae: o("vae") ?? base.vae,
    ...(loraHigh ? { loraHigh } : {}),
    ...(loraLow ? { loraLow } : {}),
  };
}

/** The files to download to install the reader's selected video model (default Wan2.2). */
export function videoModelDownloads(id?: string): VideoModelDownload[] {
  return (videoModelById(id) ?? WAN22_I2V_14B).downloads;
}
