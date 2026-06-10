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

export type ModelFamily = "sd15" | "sdxl" | "flux" | "flux2" | "unknown";

/** Flux.1 or Flux.2 — natural-language prompts, no negatives, no SD tags. */
export function isFlux(family: ModelFamily): boolean {
  return family === "flux" || family === "flux2";
}

/** Sampler settings for a family. Flux uses embedded guidance (cfg≈1) + the `simple`
 * scheduler; at SD's cfg 7 it washes out and runs a wasted second pass. */
export interface SamplerSettings {
  cfg: number;
  sampler: string;
  scheduler: string;
  /** Recommended step count (Flux ignores the quality-profile steps — more don't help). */
  steps: number;
  /**
   * Flux embedded-guidance value (set via a FluxGuidance node, with KSampler cfg=1).
   * Undefined for SD families, which use real CFG instead.
   */
  guidance?: number;
}

export function samplerFor(family: ModelFamily): SamplerSettings {
  switch (family) {
    case "flux":
      return { cfg: 1, sampler: "euler", scheduler: "simple", steps: 20, guidance: 3.5 };
    case "flux2":
      return { cfg: 1, sampler: "euler", scheduler: "simple", steps: 24, guidance: 4.0 };
    default: // sd15 / sdxl / unknown
      return { cfg: 7, sampler: "euler", scheduler: "normal", steps: 28 };
  }
}

/**
 * How a target expands bible terms, by text-encoder grade:
 *  - CLIP/T5 (SD1.5, SDXL, Flux.1) can't read a name → **inject** the descriptor in place.
 *  - LLM-grade (Flux.2/Mistral) tracks a name↔description glossary → **reference** block.
 */
export function nameHandlingFor(family: ModelFamily): "inject" | "reference" {
  return family === "flux2" ? "reference" : "inject";
}

/** Largest square dimension a family handles well (bounds time + SD1.5 artifacts). */
export function familyMaxDimension(family: ModelFamily): number {
  return family === "sd15" ? 768 : 1024;
}

/** Clamp a requested resolution to the family's sweet spot, rounded to a /8 multiple. */
export function clampResolution(
  family: ModelFamily,
  width: number,
  height: number,
): { width: number; height: number } {
  const max = familyMaxDimension(family);
  const fit = (n: number): number => Math.max(512, Math.round(Math.min(n, max) / 8) * 8);
  return { width: fit(width), height: fit(height) };
}

/** A character's identity, for optional SD weighting emphasis. */
export interface PromptSubject {
  name: string;
  /** Comma-joined appearance descriptors (may be empty). */
  features: string;
  /** Comma-joined clothing/outfit (may be empty). */
  outfit: string;
}

/**
 * Best-effort family from a checkpoint/model name. Deliberately lenient (e.g. any
 * "xl" → sdxl) because users have a manual override when it guesses wrong.
 */
export function detectModelFamily(name: string): ModelFamily {
  const n = (name || "").toLowerCase();
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

/** Negative prompt for a family ("" for Flux — its negatives are ignored/harmful). */
export function negativeFor(family: ModelFamily): string {
  return isFlux(family) ? "" : DEFAULT_NEGATIVE;
}

/** Quality tag preamble for SD families; empty for flux/unknown. */
export function qualityPreamble(family: ModelFamily): string {
  return isSd(family) ? "highly detailed, sharp focus, masterpiece, best quality" : "";
}

/** Light, SD-only identity emphasis blocks like `(Ana: silver hair, wearing red cloak:1.1)`. */
export function emphasizeSubjects(
  subjects: PromptSubject[] | undefined,
  family: ModelFamily,
): string {
  if (!isSd(family) || !subjects?.length) return "";
  const blocks = subjects
    .map((s) => {
      const head = [s.name?.trim(), s.features?.trim()].filter(Boolean).join(": ");
      const outfit = s.outfit?.trim() ? `, wearing ${s.outfit.trim()}` : "";
      const body = `${head}${outfit}`.trim();
      return body ? `(${body}:1.1)` : "";
    })
    .filter(Boolean);
  return blocks.join(", ");
}

/**
 * Compose the final SD positive prompt for a family: quality tags + the scene +
 * identity emphasis. For flux/unknown this returns the base prompt unchanged
 * (natural language), since the tag/emphasis pieces are empty.
 */
export function composeSdPositive(
  family: ModelFamily,
  basePrompt: string,
  subjects: PromptSubject[] | undefined,
): string {
  return [qualityPreamble(family), basePrompt.trim(), emphasizeSubjects(subjects, family)]
    .filter((p) => p && p.length > 0)
    .join(", ");
}

/**
 * The negative prompt to send for this generation: an explicit override wins for
 * SD families; flux always gets "" regardless of any override.
 */
export function resolveNegative(family: ModelFamily, override: string | undefined): string {
  if (isFlux(family)) return "";
  return override && override.trim() ? override : DEFAULT_NEGATIVE;
}
