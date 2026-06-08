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

export type ModelFamily = "sd15" | "sdxl" | "flux" | "unknown";

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
  "blurry, watermark, signature, text, jpeg artifacts, cropped, out of frame";

/** Negative prompt for a family ("" for flux — its negatives are ignored/harmful). */
export function negativeFor(family: ModelFamily): string {
  return family === "flux" ? "" : DEFAULT_NEGATIVE;
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
  if (family === "flux") return "";
  return override && override.trim() ? override : DEFAULT_NEGATIVE;
}
