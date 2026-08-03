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

export type ModelFamily =
  | "sd15"
  | "sdxl"
  | "flux"
  | "flux2"
  | "zimage"
  | "qwenimage"
  | "hidream"
  | "unknown";

/** Flux.1 or Flux.2 — natural-language prompts, no negatives, no SD tags. */
export function isFlux(family: ModelFamily): boolean {
  return family === "flux" || family === "flux2";
}

/**
 * Natural-language families (Flux, Z-Image, Qwen-Image, HiDream): plain prose
 * prompts, no SD tags/weighting, no negative, and a fixed model-recommended step
 * count. HiDream reads prose well (it carries a Llama-3.1 encoder alongside T5 +
 * dual CLIP) so it's natural-language for the POSITIVE, but unlike the others it runs at
 * real CFG and REQUIRES a non-empty negative (see resolveNegative) — so it's still listed
 * here for prompt formatting, with the negative carved out as an exception.
 */
export function isNaturalLanguage(family: ModelFamily): boolean {
  return isFlux(family) || family === "zimage" || family === "qwenimage" || family === "hidream";
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
  /**
   * Sigma shift for the few flow-matching families that need it: Z-Image / Qwen-Image
   * via a ModelSamplingAuraFlow node, HiDream via ModelSamplingSD3 (the backend picks
   * the node class by family). Undefined = no shift node.
   */
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
    case "hidream":
      // Default to the Full recipe (CFG-based, SD3 shift 3.0) — the safe high-quality
      // baseline for a HiDream file that isn't one of the catalog entries (those carry
      // their own sampler, e.g. Dev = cfg 1 / lcm / shift 6).
      return { cfg: 5, sampler: "uni_pc", scheduler: "simple", steps: 50, shift: 3.0 };
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
  return family === "flux2" || family === "zimage" || family === "qwenimage" || family === "hidream"
    ? "reference"
    : "inject";
}

/** Largest square dimension a family handles well (bounds time + artifacts). The
 * natural-language families (Flux, Flux.2, Qwen-Image) stay coherent at large canvases,
 * so High/Ultra can reach 1280/1536 there; SDXL duplicates/degrades above ~1024 and
 * SD1.5 above ~768; Z-Image (turbo) is happiest up to ~1280. HiDream was trained on
 * ~1 MP buckets (top side 1360) and duplicates subjects above that like SDXL does past
 * 1024 — so it caps low, and the Hi-Res two-pass path is how it reaches larger canvases. */
export function familyMaxDimension(family: ModelFamily): number {
  switch (family) {
    case "flux":
    case "flux2":
    case "qwenimage":
      return 1536;
    case "zimage":
      return 1280;
    case "hidream": // 17B DiT but trained at ~1 MP — past ~1216 it tiles the subject
      return 1216;
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

/** Hi-Res two-pass ceiling: the long side never exceeds this after upscaling, so the
 * second pass stays bounded in VRAM/time regardless of family or requested size. */
export const HIRES_MAX_DIMENSION = 2048;

/** A LOWER Hi-Res ceiling for Low-VRAM mode. Low-VRAM offloads model weights to system RAM; a full
 * 2048 second pass on top of that can exhaust system RAM and thrash the page file (the whole PC
 * stutters). 1536 keeps the upscale useful while much lighter on memory. */
export const HIRES_MAX_DIMENSION_LOWVRAM = 1536;

/** Heavy diffusion-transformer families (~12–20B weights + large encoders: Flux.2, Qwen-Image,
 * HiDream) cap their Hi-Res second pass a notch under 2048 even with VRAM headroom — 2048 on these
 * is a steep memory jump for marginal extra detail. */
export const HIRES_MAX_DIMENSION_HEAVY = 1792;

/** Linear upscale factor for the Hi-Res second pass. ~1.5× (≈2.25× the pixels) is the range a
 * low-denoise refine pass holds WITHOUT re-introducing the duplicate subjects that full-res
 * generation causes — so weaker models (SD/SDXL/HiDream) aren't pushed past what they render
 * coherently, while a memory ceiling still bounds the big models. */
export const HIRES_UPSCALE_FACTOR = 1.5;

/** Second-pass denoise for the Hi-Res upscale. Low enough that the first pass's
 * composition (locked at native res → a single subject) is preserved while the
 * upscaled latent is repainted with real detail. */
export const HIRES_DENOISE = 0.5;

/** The Hi-Res ceiling for a family + memory mode: Low-VRAM (weights in system RAM) keeps it light;
 * the heavy DiT families stay a notch under 2048; everything else can reach 2048. */
export function hiresCeiling(family: ModelFamily, lowVram?: boolean): number {
  if (lowVram) return HIRES_MAX_DIMENSION_LOWVRAM;
  switch (family) {
    case "flux2":
    case "qwenimage":
    case "hidream":
      return HIRES_MAX_DIMENSION_HEAVY;
    default:
      return HIRES_MAX_DIMENSION;
  }
}

/**
 * Target resolution for the Hi-Res two-pass path: render at the family's native-safe
 * size (so the composition stays coherent — no duplicated subjects), then upscale the
 * latent ~1.5× (model-dependent, anchored to the family's native max), bounded by the
 * memory ceiling. Aspect ratio is taken from the request. Returns null when the native
 * size already meets the ceiling (nothing to gain — the caller renders single-pass).
 */
export function hiresTarget(
  family: ModelFamily,
  width: number,
  height: number,
  maxDimension: number = HIRES_MAX_DIMENSION,
): { width: number; height: number } | null {
  const base = clampResolution(family, width, height);
  const longest = Math.max(base.width, base.height);
  const targetLongest = Math.min(maxDimension, Math.round(longest * HIRES_UPSCALE_FACTOR));
  if (targetLongest <= longest) return null;
  const scale = targetLongest / longest;
  const fit = (n: number): number => Math.max(512, Math.round((n * scale) / 8) * 8);
  return { width: fit(base.width), height: fit(base.height) };
}

/**
 * Best-effort family from a checkpoint/model name. Deliberately lenient (e.g. any
 * "xl" → sdxl) because users have a manual override when it guesses wrong.
 */
export function detectModelFamily(name: string): ModelFamily {
  const n = (name || "").toLowerCase();
  if (/hi[\s._-]?dream/.test(n)) return "hidream"; // hidream_i1_full_fp16, HiDream-O1, …
  if (/z[\s._-]?image/.test(n)) return "zimage"; // z_image_turbo, z-image, …
  if (/qwen[\s._-]?image/.test(n)) return "qwenimage"; // qwen_image, qwen-image, …
  if (/flux[\s._-]?2/.test(n)) return "flux2"; // flux2, flux.2, flux-2, flux_2 — before generic flux
  if (n.includes("flux")) return "flux";
  if (n.includes("xl")) return "sdxl"; // sdxl, sd_xl, realvisxl, juggernautxl, …
  if (/(^|[^0-9])1[._-]?5|v1-5|sd15|sd1\.5/.test(n)) return "sd15";
  return "unknown";
}

/**
 * Resolve the family to format for. Precedence: managed **catalog** family → explicit
 * override → filename heuristic → "unknown".
 *
 * The catalog wins over the override on purpose. The override exists to correct the *lenient
 * filename heuristic* on unknown/custom checkpoints — NOT to reclassify a known model. A
 * model's family fixes its encoder STRUCTURE (HiDream = quad-CLIP, Flux.2 = single CLIP,
 * SDXL = all-in-one), which is intrinsic to the file: you can't run a HiDream UNET as Flux.2.
 * Letting a sticky override beat the catalog built a Flux.2-shaped single-encoder graph around
 * a HiDream UNET → pooled 768 vs 2048 → "shapes cannot be multiplied". So an exact catalog
 * match (curated, authoritative) is honoured first; the override still beats the heuristic.
 */
export function resolveModelFamily(
  override: ModelFamily | undefined,
  checkpoint: string,
): ModelFamily {
  const fromCatalog = catalogModelFamily(checkpoint);
  if (fromCatalog) return fromCatalog;
  if (override && override !== "unknown") return override;
  return detectModelFamily(checkpoint);
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

/** Negative prompt for a family. Natural-language models that run at guidance/cfg≈1 take none
 * (Flux / Z-Image / Qwen-Image — a negative is ignored or harmful). HiDream is the exception: it
 * runs at REAL CFG and REQUIRES a non-empty negative — an empty one makes ComfyUI feed a None
 * pooled to its embedder ("linear(): … must be Tensor, not NoneType"). */
export function negativeFor(family: ModelFamily): string {
  return isNaturalLanguage(family) && family !== "hidream" ? "" : DEFAULT_NEGATIVE;
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
 * The negative prompt to send for this generation: an explicit override wins for SD families
 * (and HiDream); the cfg≈1 natural-language models (Flux / Z-Image / Qwen-Image) always get ""
 * regardless of any override. HiDream is NOT in that set — it runs at real CFG and must get a
 * non-empty negative (an empty negative → None pooled → a crash in ComfyUI's HiDream embedder).
 */
export function resolveNegative(
  family: ModelFamily,
  override: string | undefined,
  positive?: string,
): string {
  if (isNaturalLanguage(family) && family !== "hidream") return "";
  const negative = override && override.trim() ? override : DEFAULT_NEGATIVE;
  return positive ? withoutRequestedTerms(negative, positive) : negative;
}

/**
 * The record of what a render was ACTUALLY told — positive, negative, and the settings that decide
 * how hard the negative bites.
 *
 * "Full prompt (as sent to the model)" only ever showed the positive half. The negative is where a
 * subject gets suppressed, and it is generated rather than typed, so a reader comparing two engines
 * that treat the same model differently had nothing to compare: both showed the same positive text
 * and neither showed the words doing the suppressing. Recording all of it turns "this engine seems
 * to censor things" into a diff anyone can read in ten seconds.
 *
 * The sampler line is there because CFG is what gives a negative its force — the same negative at
 * cfg 7 and cfg 1 are different renders. PURE.
 */
export function renderPromptRecord(
  positive: string,
  negative: string,
  engine: { engine: string; family: ModelFamily; sampler?: string; scheduler?: string; cfg?: number; steps?: number },
): string {
  const bits = [
    engine.engine,
    engine.family,
    engine.sampler && engine.scheduler ? `${engine.sampler}/${engine.scheduler}` : engine.sampler,
    engine.cfg !== undefined ? `cfg ${engine.cfg}` : undefined,
    engine.steps !== undefined ? `${engine.steps} steps` : undefined,
  ].filter((b): b is string => !!b);
  return [positive, negative.trim() ? `Negative: ${negative.trim()}` : "Negative: (none)", `Engine: ${bits.join(" · ")}`]
    .join("\n\n");
}

/**
 * Drop any negative term the POSITIVE prompt actually asks for.
 *
 * The default negative ends with `portrait, headshot, close-up, simple background`, and it is there
 * for a good reason: a book illustration should be a SCENE, and without those the models drift to a
 * face on a plain backdrop. But it is sent with EVERY SD render, including the ones where the reader
 * asked for exactly that — "a portrait of me", "a close-up of her hands", "a headshot for my
 * profile". The render then has the same words pulling in both directions, and what comes back is a
 * weakened version of what was asked for, with nothing to explain it. From the outside that reads as
 * the engine quietly censoring certain requests, because the terms it fights are a fixed short list
 * that no one is shown.
 *
 * Whole-term, case-insensitive, on the comma-separated units the negative is built from. A negative
 * the READER wrote is filtered too: they can't see this list either, and asking for a portrait while
 * an old override still negates one is the same trap. PURE.
 */
export function withoutRequestedTerms(negative: string, positive: string): string {
  const asked = positive.toLowerCase();
  return negative
    .split(",")
    .map((t) => t.trim())
    .filter((t) => {
      if (!t) return false;
      // Word-boundary match so "text" in the negative isn't kept alive by "textured" in the prompt,
      // and "close-up" matches "close up" as well.
      const pattern = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+");
      return !new RegExp(`\\b${pattern}\\b`, "i").test(asked);
    })
    .join(", ");
}
