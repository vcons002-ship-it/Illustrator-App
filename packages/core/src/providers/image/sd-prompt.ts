import { catalogModelFamily } from "../catalog.js";

/**
 * Stable-Diffusion prompt shaping, applied by the LOCAL backends only (ComfyUI /
 * AUTOMATIC1111) where the model and its family are known. The LLM produces a
 * clean natural-language scene; this layer adds SD-specific quality tags, a
 * proper negative prompt, and light identity emphasis — but ONLY for SD-family
 * models. Flux (and all cloud providers) want plain natural language, so they get
 * no tags/weighting and an empty negative. "unknown" is treated conservatively:
 * a negative prompt (always safe) but no tags or weighting.
 */

export type ModelFamily = "sd15" | "sdxl" | "flux" | "flux2" | "zimage" | "qwenimage" | "unknown";

/** Flux.1 or Flux.2 — natural-language prompts, no negatives, no SD tags. */
export function isFlux(family: ModelFamily): boolean {
  return family === "flux" || family === "flux2";
}

/**
 * Natural-language families (Flux, Z-Image, Qwen-Image): plain prose prompts, no
 * SD tags/weighting, no negative, and a fixed model-recommended step count.
 */
export function isNaturalLanguage(family: ModelFamily): boolean {
  return isFlux(family) || family === "zimage" || family === "qwenimage";
}

/** Sampler settings for a family. Flux uses embedded guidance (cfg≈1) + the `simple`
 * scheduler; at SD's cfg 7 it washes out and runs a wasted second pass. Z-Image /
 * Qwen-Image values come from the official Comfy-Org workflow templates. */
export interface SamplerSettings {
  cfg: number;
  sampler: string;
  scheduler: string;
  /** Recommended step count (natural-language models ignore the quality-profile steps). */
  steps: number;
  /**
   * Flux embedded-guidance value (set via a FluxGuidance node, with KSampler cfg=1).
   * Undefined for SD families, which use real CFG instead.
   */
  guidance?: number;
  /** ModelSamplingAuraFlow shift (Z-Image / Qwen-Image); undefined = no node. */
  shift?: number;
}

export function samplerFor(family: ModelFamily): SamplerSettings {
  switch (family) {
    case "flux":
      return { cfg: 1, sampler: "euler", scheduler: "simple", steps: 20, guidance: 3.5 };
    case "flux2":
      return { cfg: 1, sampler: "euler", scheduler: "simple", steps: 24, guidance: 4.0 };
    case "zimage": // 8-step turbo: cfg 1, res_multistep, AuraFlow shift 3
      return { cfg: 1, sampler: "res_multistep", scheduler: "simple", steps: 8, shift: 3 };
    case "qwenimage": // real CFG 4, AuraFlow shift 3.1
      return { cfg: 4, sampler: "euler", scheduler: "simple", steps: 20, shift: 3.1 };
    default: // sd15 / sdxl / unknown
      return { cfg: 7, sampler: "euler", scheduler: "normal", steps: 28 };
  }
}

/**
 * How a target expands bible terms, by text-encoder grade:
 *  - CLIP/T5 (SD1.5, SDXL, Flux.1) can't read a name → **inject** the descriptor in place.
 *  - LLM-grade (Flux.2/Mistral·Qwen, Z-Image/Qwen3, Qwen-Image/Qwen2.5-VL) tracks a
 *    name↔description glossary → **reference** block.
 */
export function nameHandlingFor(family: ModelFamily): "inject" | "reference" {
  return family === "flux2" || family === "zimage" || family === "qwenimage"
    ? "reference"
    : "inject";
}

/** Largest square dimension a family handles well (bounds time + artifacts). The
 * natural-language families (Flux, Flux.2, Qwen-Image) stay coherent at large canvases,
 * so High/Ultra can reach 1280/1536 there; SDXL duplicates/degrades above ~1024 and
 * SD1.5 above ~768; Z-Image (turbo) is happiest up to ~1280. */
export function familyMaxDimension(family: ModelFamily): number {
  switch (family) {
    case "flux":
    case "flux2":
    case "qwenimage":
      return 1536;
    case "zimage":
      return 1280;
    case "sd15":
      return 768;
    default: // sdxl + unknown — conservative
      return 1024;
  }
}

/**
 * Clamp a requested resolution to the family's sweet spot, rounded to a /8 multiple.
 * The cap applies to the LONGEST side and both axes scale together, so a portrait/
 * landscape canvas keeps its aspect ratio instead of being squashed toward square.
 */
export function clampResolution(
  family: ModelFamily,
  width: number,
  height: number,
): { width: number; height: number } {
  const max = familyMaxDimension(family);
  const longest = Math.max(width, height);
  const scale = longest > max ? max / longest : 1;
  const fit = (n: number): number => Math.max(512, Math.round((n * scale) / 8) * 8);
  return { width: fit(width), height: fit(height) };
}

/**
 * Best-effort family from a checkpoint/model name. Deliberately lenient (e.g. any
 * "xl" → sdxl) because users have a manual override when it guesses wrong.
 */
export function detectModelFamily(name: string): ModelFamily {
  const n = (name || "").toLowerCase();
  if (/z[\s._-]?image/.test(n)) return "zimage"; // z_image_turbo, z-image, …
  if (/qwen[\s._-]?image/.test(n)) return "qwenimage"; // qwen_image, qwen-image, …
  if (/flux[\s._-]?2/.test(n)) return "flux2"; // flux2, flux.2, flux-2, flux_2 — before generic flux
  if (n.includes("flux")) return "flux";
  if (n.includes("xl")) return "sdxl"; // sdxl, sd_xl, realvisxl, juggernautxl, …
  if (/(^|[^0-9])1[._-]?5|v1-5|sd15|sd1\.5/.test(n)) return "sd15";
  return "unknown";
}

/**
 * Resolve the family to format for. Precedence: explicit override → managed
 * catalog family → filename heuristic → "unknown".
 */
export function resolveModelFamily(
  override: ModelFamily | undefined,
  checkpoint: string,
): ModelFamily {
  if (override && override !== "unknown") return override;
  return catalogModelFamily(checkpoint) ?? detectModelFamily(checkpoint);
}

function isSd(family: ModelFamily): boolean {
  return family === "sd15" || family === "sdxl";
}

/** Generic negative prompt — high value for SD models, harmful/ignored for Flux. */
export const DEFAULT_NEGATIVE =
  "lowres, worst quality, low quality, bad anatomy, bad hands, missing fingers, " +
  "extra fingers, extra limbs, fused fingers, deformed, mutated, disfigured, " +
  "blurry, watermark, signature, text, jpeg artifacts, cropped, out of frame, " +
  "portrait, headshot, close-up, simple background";

/** Negative prompt for a family ("" for natural-language models — ignored/harmful). */
export function negativeFor(family: ModelFamily): string {
  return isNaturalLanguage(family) ? "" : DEFAULT_NEGATIVE;
}

/** Quality tag preamble for SD families; empty for flux/unknown. */
export function qualityPreamble(family: ModelFamily): string {
  return isSd(family) ? "highly detailed, sharp focus, masterpiece, best quality" : "";
}

/**
 * Compose the final SD positive prompt for a family: quality tags + the scene. For
 * flux/unknown this returns the base prompt unchanged (natural language), since the
 * tag piece is empty. (Per-character `(name:1.1)` weighting was removed — with a
 * multi-character cast it bled attributes between subjects more than it helped.)
 */
export function composeSdPositive(family: ModelFamily, basePrompt: string): string {
  return [qualityPreamble(family), basePrompt.trim()]
    .filter((p) => p && p.length > 0)
    .join(", ");
}

/**
 * The negative prompt to send for this generation: an explicit override wins for
 * SD families; natural-language models always get "" regardless of any override.
 */
export function resolveNegative(family: ModelFamily, override: string | undefined): string {
  if (isNaturalLanguage(family)) return "";
  return override && override.trim() ? override : DEFAULT_NEGATIVE;
}
