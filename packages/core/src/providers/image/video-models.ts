import type { VideoModelFiles } from "./image-provider.js";

/**
 * Catalog of installable image-to-video models for the local ComfyUI engine. v1 ships Wan2.2 14B I2V
 * (a two-expert high/low-noise pair + the umt5 text encoder + the Wan 2.1 VAE). The download URLs live
 * with the rest of the model catalog (see the auto-download wiring); this module is the single source of
 * the FILENAMES the engine graph references, shared by the host (which passes them to generateVideo) and
 * the downloader.
 */
export interface VideoModelCatalogEntry {
  id: string;
  label: string;
  /** Approx total on-disk size in GB (for the picker + a "this is a big download" warning). */
  sizeGB: number;
  /** The engine model filenames this entry resolves to. */
  files: VideoModelFiles;
}

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
};

export const VIDEO_MODELS: readonly VideoModelCatalogEntry[] = [WAN22_I2V_14B];

export function videoModelById(id: string | undefined): VideoModelCatalogEntry | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

/** The model files for the reader's selected video model, or the default (Wan2.2) when unset/unknown. */
export function resolveVideoModelFiles(id?: string): VideoModelFiles {
  return (videoModelById(id) ?? WAN22_I2V_14B).files;
}
