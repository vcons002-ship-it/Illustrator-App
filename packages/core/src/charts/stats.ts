import type { DataPoint } from "../types/bible.js";

/**
 * Summary statistics for one extracted dataset, shown under its chart. Pure math
 * over the REAL extracted values — this is the half of "data analysis" a generated
 * image can't be trusted with, so it is computed, never asked of a model.
 */
export interface SeriesStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  /** Direction of the series over x (or reading order when no real x). */
  trend: "rising" | "falling" | "flat" | "mixed";
  /** Least-squares slope over (x ?? index, y) — sign carries the trend. */
  slope: number;
}

/** How small a normalized slope still counts as "flat" (fraction of y-range per step). */
const FLAT_THRESHOLD = 0.02;
/** Residual-to-range ratio above which a sloped series is "mixed" rather than a trend. */
const MIXED_RESIDUAL_RATIO = 0.35;

export function computeStats(points: readonly DataPoint[]): SeriesStats | undefined {
  const ys = points.map((p) => p.y).filter((y) => Number.isFinite(y));
  if (ys.length === 0) return undefined;
  const sorted = [...ys].sort((a, b) => a - b);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const { slope, trend } = fitTrend(points);
  return {
    count: ys.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean,
    median,
    trend,
    slope,
  };
}

/**
 * Least-squares fit over (x ?? index, y). The slope is judged NORMALIZED by the
 * y-range and per x-step, so "rising" means the same thing for nanometres and
 * gigawatts; large residuals demote a nominal slope to "mixed" (no clean trend).
 */
function fitTrend(points: readonly DataPoint[]): { slope: number; trend: SeriesStats["trend"] } {
  const pts = points
    .map((p, i) => ({ x: p.x ?? i, y: p.y }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return { slope: 0, trend: "flat" };
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) * (p.x - mx);
  }
  if (sxx === 0) return { slope: 0, trend: "flat" };
  const slope = sxy / sxx;
  const ys = pts.map((p) => p.y);
  const range = Math.max(...ys) - Math.min(...ys);
  if (range === 0) return { slope: 0, trend: "flat" };
  const xs = pts.map((p) => p.x);
  const xSpan = Math.max(...xs) - Math.min(...xs);
  const step = xSpan / Math.max(1, n - 1);
  // Slope as fraction of the y-range covered per x-step — scale-free.
  const normalized = (slope * step) / range;
  if (Math.abs(normalized) < FLAT_THRESHOLD) return { slope, trend: "flat" };
  // Residuals: how much of the variation the line does NOT explain.
  let sse = 0;
  for (const p of pts) {
    const fit = my + slope * (p.x - mx);
    sse += (p.y - fit) * (p.y - fit);
  }
  const rmse = Math.sqrt(sse / n);
  if (rmse / range > MIXED_RESIDUAL_RATIO) return { slope, trend: "mixed" };
  return { slope, trend: slope > 0 ? "rising" : "falling" };
}

/** Compact human number for the stats footer (1234.5 → "1,234.5"; tiny → sci-free). */
export function formatStat(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 1 : 3;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}
