import type { VideoModelFiles } from "./image-provider.js";

/**
 * Catalog of installable image-to-video models for the local ComfyUI engine. v1 ships Wan2.2 14B I2V
 * (a two-expert high/low-noise pair + the umt5 text encoder + the Wan 2.1 VAE). The download URLs live
 * with the rest of the model catalog (see the auto-download wiring); this module is the single source of
 * the FILENAMES the engine graph references, shared by the host (which passes them to generateVideo) and
 * the downloader.
 */
/** One downloadable file for a video model, with the ComfyUI subfolder it belongs in. */
export interface VideoModelDownload {
  filename: string;
  url: string;
  folder: "diffusion_models" | "text_encoders" | "vae";
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

/** Comfy-Org's repackaged Wan 2.2 weights, laid out exactly as ComfyUI expects. */
const WAN22_BASE = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files";

/** Wan 2.2 14B image-to-video (fp8) — the v1 default. */
export const WAN22_I2V_14B: VideoModelCatalogEntry = {
  id: "wan2.2-i2v-14b",
  label: "Wan 2.2 (14B image-to-video)",
  sizeGB: 33,
  files: {
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

export const VIDEO_MODELS: readonly VideoModelCatalogEntry[] = [WAN22_I2V_14B];

export function videoModelById(id: string | undefined): VideoModelCatalogEntry | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

/** The model files for the reader's selected video model, or the default (Wan2.2) when unset/unknown. */
export function resolveVideoModelFiles(id?: string): VideoModelFiles {
  return (videoModelById(id) ?? WAN22_I2V_14B).files;
}

/** The files to download to install the reader's selected video model (default Wan2.2). */
export function videoModelDownloads(id?: string): VideoModelDownload[] {
  return (videoModelById(id) ?? WAN22_I2V_14B).downloads;
}
