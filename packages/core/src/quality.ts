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
  draft: { steps: 12, width: 768, height: 768 },
  standard: { steps: 22, width: 1024, height: 1024 },
  high: { steps: 30, width: 1280, height: 1280 },
  ultra: { steps: 40, width: 1536, height: 1536 },
};

export function qualityProfile(q: RenderQuality): QualityProfile {
  return PROFILES[q];
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
