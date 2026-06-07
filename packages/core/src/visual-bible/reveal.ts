import type { Page } from "../types/book.js";
import type { SpoilerEntity } from "../types/bible.js";

/**
 * Progress-driven reveal math (pure, unit-tested).
 *
 * The reader's reading progress through the current page drives how far an
 * illustration "blooms" in. Two requirements fall out of one curve:
 *  1. Fast-scrolling/searching never reveals an image — bloom only completes
 *     once the reader is far enough through the page (`READ_THRESHOLD`).
 *  2. An image never reveals a spoiler before the reader reaches the spoiler's
 *     paragraph on the page — the reveal point is pushed to that paragraph.
 *
 * Spoiler location is derived from the existing label match (the paragraph whose
 * text contains a depicted spoiler's label), so this does not depend on the
 * unresolved `SpoilerEntity.revealParagraphId`.
 *
 * Forward-compat: the spoiler helpers accept an optional `paragraphRange`, so a
 * future per-panel image (tagged to a paragraph range) reuses the same math.
 */

/** Full bloom is only permitted once the reader is at least this far through a page. */
export const READ_THRESHOLD = 0.5;
/** A spoiler-free image may begin blooming this early into the page. */
export const SPOILER_FREE_REVEAL_POINT = 0.15;
/** Ease-in exponent: keeps the image dim until near the reveal point (bloom-only leakage guard). */
export const BLOOM_EASE = 1.6;

export interface ParagraphRange {
  /** Inclusive start paragraph index. */
  start: number;
  /** Inclusive end paragraph index. */
  end: number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Within-page paragraph index from a paragraph id ("pg-7-3" → 3); undefined if unparsable. */
export function paragraphIndexFromId(id: string | undefined): number | undefined {
  if (!id) return undefined;
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

/**
 * The latest paragraph index on the page whose text contains a depicted spoiler's
 * label, or undefined when no depicted spoiler appears in the (optionally ranged)
 * paragraphs. Case-insensitive substring match, mirroring `resolvePageEntities`.
 */
export function latestSpoilerParagraphIndex(
  page: Page,
  imageSpoilerIds: string[],
  spoilers: SpoilerEntity[],
  range?: ParagraphRange,
): number | undefined {
  if (imageSpoilerIds.length === 0) return undefined;
  const depicted = new Set(imageSpoilerIds);
  const labels = spoilers
    .filter((s) => depicted.has(s.id))
    .map((s) => s.label.toLowerCase())
    .filter((l) => l.length > 0);
  if (labels.length === 0) return undefined;

  let latest: number | undefined;
  for (const para of page.paragraphs) {
    if (range && (para.index < range.start || para.index > range.end)) continue;
    const haystack = para.text.toLowerCase();
    if (labels.some((l) => haystack.includes(l))) {
      latest = latest === undefined ? para.index : Math.max(latest, para.index);
    }
  }
  return latest;
}

/**
 * Page fraction (0..1) past which full bloom is allowed.
 *  - no depicted spoiler → small default (image may bloom early).
 *  - spoiler depicted but its paragraph couldn't be located → fail-safe: 1 (hold to end).
 *  - spoiler located → just past that paragraph.
 */
export function spoilerRevealPoint(
  latestSpoilerParaIndex: number | undefined,
  hasDepictedSpoiler: boolean,
  paragraphCount: number,
): number {
  if (!hasDepictedSpoiler) return SPOILER_FREE_REVEAL_POINT;
  if (latestSpoilerParaIndex === undefined) return 1;
  if (paragraphCount <= 0) return 1;
  return clamp01((latestSpoilerParaIndex + 1) / paragraphCount);
}

/**
 * Bloom target (0..1) for the current page given reading `progress` (0..1).
 * Full reveal is reached when progress hits the effective reveal point; an ease-in
 * keeps the image dim until close to it.
 */
export function computeBloomTarget(progress: number, revealPoint: number, hasSpoiler: boolean): number {
  const divisor = hasSpoiler ? Math.max(revealPoint, READ_THRESHOLD) : READ_THRESHOLD;
  const linear = clamp01(clamp01(progress) / (divisor > 0 ? divisor : 1));
  return clamp01(Math.pow(linear, BLOOM_EASE));
}
