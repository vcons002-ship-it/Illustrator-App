/**
 * Memory windowing for rendered images (host side). A long, fully-illustrated book
 * can hold hundreds of multi-MB images; keeping every one resident in the reader
 * process is what made RAM balloon. This pure planner decides, given the reader's
 * position, which images' BYTES to drop (they stay cached on disk) and which
 * previously-dropped ones to reload as the reader returns — so memory is bounded to
 * a window regardless of book length, with no effect on typical-length books.
 *
 * Pure (no React/IO) so it's unit-testable; the host applies the plan (evict bytes,
 * reload from IndexedDB) in `apps/web/src/useEngineWorker.ts`.
 */

/** Keep image BYTES resident only for units within this many of the reader. */
export const RETAIN_RADIUS = 30;
/** Never evict until a book holds more resident images than this — so typical books
 * (a couple hundred pages) are byte-for-byte unaffected; only long books window. */
export const RETAIN_MIN_RESIDENT = 100;

/** The fields of a display result the planner needs (kept minimal + structural). */
export interface RetentionItem {
  /** Truthy when the heavy image bytes are currently resident. */
  image?: unknown;
  /** True when bytes were dropped but the image is rendered + cached on disk. */
  evicted?: boolean;
  /** Image-cache key, to reload the bytes from IndexedDB. */
  requestId?: string;
}

export interface RetentionPlan {
  /** Units whose resident bytes should be dropped (far from the reader). */
  evict: number[];
  /** Evicted units now back near the reader — reload their bytes by `requestId`. */
  reload: { unit: number; requestId: string }[];
}

export function planRetention<T extends RetentionItem>(
  results: Map<number, T>,
  activeUnit: number,
  radius = RETAIN_RADIUS,
  minResident = RETAIN_MIN_RESIDENT,
): RetentionPlan {
  let resident = 0;
  for (const r of results.values()) if (r.image) resident++;
  // Only start dropping once a book is genuinely large; reloads of in-window evicted
  // units ALWAYS run, so the reader never sees a gap on return even past that point.
  const allowEvict = resident > minResident;
  const evict: number[] = [];
  const reload: { unit: number; requestId: string }[] = [];
  for (const [unit, r] of results) {
    const far = Math.abs(unit - activeUnit) > radius;
    if (r.image && far && allowEvict) evict.push(unit);
    else if (!r.image && r.evicted && !far && r.requestId) reload.push({ unit, requestId: r.requestId });
  }
  return { evict, reload };
}
