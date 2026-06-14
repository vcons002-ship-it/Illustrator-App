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
  /** Sample standard deviation (n−1); 0 for a single point. */
  stdev: number;
  /** Sample variance (n−1); 0 for a single point. */
  variance: number;
  /** First quartile (25th percentile, linear interpolation). */
  q1: number;
  /** Third quartile (75th percentile). */
  q3: number;
  /** Direction of the series over x (or reading order when no real x). */
  trend: "rising" | "falling" | "flat" | "mixed";
  /** Least-squares slope over (x ?? index, y) — sign carries the trend. */
  slope: number;
  /** Linear fit over (x ?? index, y): line + how well it explains the data. */
  regression: { slope: number; intercept: number; r2: number; r: number };
}

/** How small a normalized slope still counts as "flat" (fraction of y-range per step). */
const FLAT_THRESHOLD = 0.02;
/** Residual-to-range ratio above which a sloped series is "mixed" rather than a trend. */
const MIXED_RESIDUAL_RATIO = 0.35;

/** Linear-interpolated percentile (0..100) of an ASCENDING-sorted array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (rank - lo) * (sorted[hi]! - sorted[lo]!);
}

export function computeStats(points: readonly DataPoint[]): SeriesStats | undefined {
  const ys = points.map((p) => p.y).filter((y) => Number.isFinite(y));
  if (ys.length === 0) return undefined;
  const sorted = [...ys].sort((a, b) => a - b);
  const n = ys.length;
  const mean = ys.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? ys.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
  const { slope, trend, intercept, r2, r } = fitTrend(points);
  return {
    count: n,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean,
    median: percentile(sorted, 50),
    stdev: Math.sqrt(variance),
    variance,
    q1: percentile(sorted, 25),
    q3: percentile(sorted, 75),
    trend,
    slope,
    regression: { slope, intercept, r2, r },
  };
}

/**
 * Least-squares fit over (x ?? index, y). Returns the line (slope + intercept), the
 * trend label (slope NORMALIZED by the y-range so "rising" means the same for
 * nanometres and gigawatts; big residuals → "mixed"), and the fit quality: r²
 * (variance explained) and Pearson r (sign = direction) between x and y.
 */
function fitTrend(points: readonly DataPoint[]): {
  slope: number;
  trend: SeriesStats["trend"];
  intercept: number;
  r2: number;
  r: number;
} {
  const flat = { slope: 0, trend: "flat" as const, intercept: 0, r2: 0, r: 0 };
  const pts = points
    .map((p, i) => ({ x: p.x ?? i, y: p.y }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return pts.length === 1 ? { ...flat, intercept: pts[0]!.y } : flat;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) * (p.x - mx);
    syy += (p.y - my) * (p.y - my);
  }
  if (sxx === 0) return { ...flat, intercept: my };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
  const r2 = r * r;
  const range = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
  if (range === 0) return { slope, trend: "flat", intercept, r2, r };
  const xs = pts.map((p) => p.x);
  const xSpan = Math.max(...xs) - Math.min(...xs);
  const step = xSpan / Math.max(1, n - 1);
  // Slope as fraction of the y-range covered per x-step — scale-free.
  const normalized = (slope * step) / range;
  if (Math.abs(normalized) < FLAT_THRESHOLD) return { slope, trend: "flat", intercept, r2, r };
  // Residuals: how much of the variation the line does NOT explain.
  let sse = 0;
  for (const p of pts) {
    const fit = intercept + slope * p.x;
    sse += (p.y - fit) * (p.y - fit);
  }
  const rmse = Math.sqrt(sse / n);
  if (rmse / range > MIXED_RESIDUAL_RATIO) return { slope, trend: "mixed", intercept, r2, r };
  return { slope, trend: slope > 0 ? "rising" : "falling", intercept, r2, r };
}

/** Compact human number for the stats footer (1234.5 → "1,234.5"; tiny → sci-free). */
export function formatStat(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 1 : 3;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}
