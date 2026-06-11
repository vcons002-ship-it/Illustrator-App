/**
 * Image render-quality profiles and resolution.
 *
 * Quality scales with how many pages share one illustration: a one-page image is
 * frequent and cheap (draft), a whole-chapter image is rare and has time to be
 * high-resolution (ultra). The reader can also pick a level explicitly.
 */

export type RenderQuality = "draft" | "standard" | "high" | "ultra";

/** Per-level sampler steps + square resolution fed to the image engine. */
export interface QualityProfile {
  steps: number;
  width: number;
  height: number;
}

const PROFILES: Record<RenderQuality, QualityProfile> = {
  // SD-family step ladder: 10 is the minimum representative for Euler, 40 the most
  // that still helps it. Natural-language families don't use these step counts —
  // they scale their own model-recommended count via `scaleSteps` (see below).
  draft: { steps: 10, width: 768, height: 768 },
  standard: { steps: 20, width: 1024, height: 1024 },
  high: { steps: 30, width: 1280, height: 1280 },
  ultra: { steps: 40, width: 1536, height: 1536 },
};

export function qualityProfile(q: RenderQuality): QualityProfile {
  return PROFILES[q];
}

/** Per-level multiplier for a natural-language model's recommended step count. */
const STEP_MULTIPLIER: Record<RenderQuality, number> = {
  draft: 0.6,
  standard: 1.0,
  high: 1.33,
  ultra: 1.67,
};

/**
 * Scale a model's recommended step count by the quality level, for natural-language
 * families (Flux/Qwen-Image) that don't follow the SD step ladder. Clamped to a sane
 * [4, 40] window. **Turbo guard:** distilled few-step models (recommended ≤ 10, e.g.
 * Z-Image's 8 steps, SDXL-Turbo) are returned unchanged — extra steps actively hurt
 * them — so the caller can run this on every family unconditionally.
 *
 * e.g. Flux.2 (24): draft 14 / standard 24 / high 32 / ultra 40.
 */
export function scaleSteps(recommended: number, level: RenderQuality): number {
  if (recommended <= 10) return recommended;
  const scaled = Math.round(recommended * STEP_MULTIPLIER[level]);
  return Math.min(40, Math.max(4, scaled));
}

/** Canvas orientation. The profile resolution is square; portrait/landscape keep the
 * same pixel area at a 2:3 / 3:2 ratio so render time is comparable across shapes. */
export type AspectRatio = "square" | "portrait" | "landscape";

/** Round to the nearest multiple of 8 (image engines require /8 dimensions). */
function round8(n: number): number {
  return Math.max(512, Math.round(n / 8) * 8);
}

/**
 * The width/height for a quality level at the chosen aspect ratio. "square" is the
 * profile's native NxN; portrait/landscape preserve the profile's pixel AREA at a 2:3
 * (short:long) ratio, so a portrait Standard is ≈832×1256 — same cost as 1024² but
 * taller. Both axes are /8-rounded. The per-family cap is applied later by
 * `clampResolution` (to the long side, ratio-preserving).
 */
export function profileDimensions(
  level: RenderQuality,
  aspect: AspectRatio = "square",
): { width: number; height: number } {
  const { width, height } = PROFILES[level];
  if (aspect === "square") return { width, height };
  const area = width * height;
  const ratio = 2 / 3; // short:long
  const longSide = round8(Math.sqrt(area / ratio));
  const shortSide = round8(Math.sqrt(area * ratio));
  return aspect === "portrait"
    ? { width: shortSide, height: longSide }
    : { width: longSide, height: shortSide };
}

/** User's quality choice: an explicit level, or "auto" (scale with cadence). */
export type ImageQualitySetting = "auto" | RenderQuality;

/** Pages-per-image cadence: a fixed group size, or a whole chapter. */
export type PagesPerImage = number | "chapter";

/**
 * Resolve the effective render quality. An explicit level wins; "auto" scales
 * with the pages-per-image cadence (more pages per image → higher quality).
 */
export function resolveQuality(
  setting: ImageQualitySetting | undefined,
  pagesPerImage: PagesPerImage,
): RenderQuality {
  if (setting && setting !== "auto") return setting;
  if (pagesPerImage === "chapter") return "ultra";
  // The more pages an image covers, the longer the reader spends before reaching
  // it — so auto-quality climbs with the cadence (and large groups get ultra).
  if (pagesPerImage >= 8) return "ultra";
  if (pagesPerImage >= 5) return "high";
  if (pagesPerImage >= 2) return "standard";
  return "draft";
}
