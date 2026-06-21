import type { ModelFamily } from "./sd-prompt.js";
import { catalogEntryForModel } from "../catalog.js";
import {
  SPLIT_FILE_HEURISTICS,
  flux2EncoderPatterns,
  pickComponentAsset,
} from "./local-engine/comfyui-backend.js";

/**
 * "Which text encoder + VAE go with this image model?" — a pure recommendation for the
 * Settings dropdowns. It mirrors EXACTLY what the ComfyUI backend's `resolveComponents` does
 * when a field is left on Auto (catalog filename → same-family variant → family pattern/hints),
 * so what the UI suggests is what a render would actually load. No I/O: the caller supplies the
 * resolved family and the engine's installed-file lists.
 *
 * Families:
 *  - **SD1.5 / SDXL** — all-in-one checkpoints: no separate files apply (`usesComponents: false`).
 *  - **Flux.2 / Z-Image / Qwen-Image** — split-file: a single CLIPLoader text encoder + a VAE.
 *  - **Flux.1 (UNET-only)** — uses TWO auto-detected encoders (t5xxl + clip_l), so the single
 *    encoder picker doesn't apply, but a VAE does.
 *  - **HiDream** — uses FOUR auto-detected encoders (clip_l + clip_g + t5xxl + llama) via a
 *    QuadrupleCLIPLoader, so the single-encoder picker doesn't apply, but a VAE does.
 */
export interface ComponentSuggestion {
  family: ModelFamily;
  /** False for an all-in-one SD/SDXL checkpoint — no separate encoder/VAE files are loaded. */
  usesComponents: boolean;
  /** Whether the single text-encoder picker applies (split-file CLIPLoader families). */
  encoderApplies: boolean;
  /** Whether the VAE picker applies (every diffusion-only family). */
  vaeApplies: boolean;
  /** Recommended text encoder that's actually installed, or undefined if none matches. */
  recommendedEncoder?: string;
  /** Recommended VAE that's actually installed, or undefined if none matches. */
  recommendedVae?: string;
  /** One-line, human guidance about what this model needs. */
  note: string;
}

const SPLIT_FILE: ReadonlySet<ModelFamily> = new Set<ModelFamily>(["flux2", "zimage", "qwenimage"]);

function noteFor(family: ModelFamily, model: string): string {
  const m = model.toLowerCase();
  switch (family) {
    case "flux2":
      if (/klein/.test(m)) return "Flux.2 Klein → the Qwen-3-8B text encoder (NOT Z-Image's 4B) + the Flux.2 VAE.";
      if (/dev|pro/.test(m)) return "Flux.2 dev/pro → a Mistral-Small text encoder + the Flux.2 VAE.";
      return "Flux.2 → a Mistral-Small (dev/pro) or Qwen-3-8B (Klein) text encoder + the Flux.2 VAE.";
    case "zimage":
      return "Z-Image → the Qwen-3-4B text encoder (NOT Flux.2 Klein's 8B) + the Z-Image VAE (ae.safetensors).";
    case "qwenimage":
      return "Qwen-Image → a Qwen-2.5-VL text encoder + the Qwen-Image VAE.";
    case "flux":
      return "Flux.1 (diffusion-only) → dual encoders (t5xxl + clip_l, auto-detected) + the Flux VAE (ae.safetensors).";
    case "hidream":
      return "HiDream → four auto-detected encoders (clip_l + clip_g + t5xxl + llama_3.1_8b) + the Flux VAE (ae.safetensors).";
    default:
      return "All-in-one checkpoint — no separate text encoder or VAE needed.";
  }
}

/**
 * Recommend the text encoder + VAE for `model` (with its resolved `family`) from the files the
 * engine actually has installed. Pure; tolerant of empty lists (recommendations come back
 * undefined and the UI prompts to install). The recommendation precedence matches the backend.
 */
export function suggestComponents(
  model: string,
  family: ModelFamily,
  available: { textEncoders: readonly string[]; vaes: readonly string[] },
): ComponentSuggestion {
  const splitFile = SPLIT_FILE.has(family);
  const isFlux1Unet = family === "flux";
  const isHiDream = family === "hidream";
  // Flux.1 (dual) and HiDream (quad) auto-detect their encoders, so the single-encoder
  // picker doesn't apply to them — but they still load a separate VAE.
  const usesComponents = splitFile || isFlux1Unet || isHiDream;
  const note = noteFor(family, model);

  if (!usesComponents) {
    return { family, usesComponents: false, encoderApplies: false, vaeApplies: false, note };
  }

  const entry = catalogEntryForModel(model);
  const wantedEncoder = entry?.files?.find((f) => f.folder === "text_encoders")?.filename;
  const wantedVae = entry?.files?.find((f) => f.folder === "vae")?.filename;
  const h = SPLIT_FILE_HEURISTICS[family];

  // Encoder picker only applies to the single-CLIPLoader split-file families (Flux.1 uses a
  // dual auto-detected pair, so we don't surface a single-encoder recommendation for it).
  const encoderPatterns = family === "flux2" ? flux2EncoderPatterns(model) : h ? [h.clip] : [];
  const recommendedEncoder = splitFile
    ? pickComponentAsset(available.textEncoders, wantedEncoder, encoderPatterns, [])
    : undefined;

  // VAE applies to every diffusion-only family. Flux.1 has no heuristic entry → reuse the
  // backend's Flux.1 hints ("ae"/"flux").
  const vaeHints = h?.vae ?? ["ae", "flux"];
  const recommendedVae = pickComponentAsset(available.vaes, wantedVae, [], vaeHints);

  return {
    family,
    usesComponents: true,
    encoderApplies: splitFile,
    vaeApplies: true,
    ...(recommendedEncoder ? { recommendedEncoder } : {}),
    ...(recommendedVae ? { recommendedVae } : {}),
    note,
  };
}
