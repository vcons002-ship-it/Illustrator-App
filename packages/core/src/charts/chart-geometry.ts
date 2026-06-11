import type { DataPoint } from "../types/bible.js";

/**
 * Pure SVG geometry for the computed charts — no React, no dependencies, so every
 * coordinate is unit-testable. The UI component (packages/ui/DataChart) maps these
 * numbers straight into SVG elements; keeping the math here means the charts stay
 * exact (the whole point of computing them instead of generating an image).
 */

export interface ChartLayout {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
}

export const DEFAULT_LAYOUT: ChartLayout = {
  width: 360,
  height: 200,
  margin: { top: 12, right: 12, bottom: 28, left: 44 },
};

export interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  value: number;
}

export interface ScatterDot {
  cx: number;
  cy: number;
  label: string;
  value: number;
}

/** Linear domain→range mapping (no clamping — callers pick domains that cover data). */
export function linearScale(
  domain: [number, number],
  range: [number, number],
): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/**
 * Round tick values covering [min, max] on the 1-2-5 ladder (the steps humans read
 * fastest), aiming for ~`target` ticks. Always returns at least the two ends.
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, target);
  const power = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const candidates = [1, 2, 5, 10].map((m) => m * power);
  const step = candidates.find((c) => span / c <= target) ?? candidates[candidates.length - 1]!;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  // Float-tolerant loop end so 0.30000000000000004 still lands the last tick.
  for (let v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

/** The y-domain for a series: zero-based for bars (a bar's length IS its value). */
export function valueDomain(points: readonly DataPoint[], zeroBase: boolean): [number, number] {
  const ys = points.map((p) => p.y).filter((y) => Number.isFinite(y));
  if (ys.length === 0) return [0, 1];
  let min = Math.min(...ys);
  let max = Math.max(...ys);
  if (zeroBase) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    // Degenerate flat series — pad so the chart still has height.
    min = min === 0 ? -1 : min - Math.abs(min) * 0.1;
    max = max === 0 ? 1 : max + Math.abs(max) * 0.1;
  }
  return [min, max];
}

/** Inner plotting area for a layout. */
export function plotArea(layout: ChartLayout): { x: number; y: number; width: number; height: number } {
  const { width, height, margin } = layout;
  return {
    x: margin.left,
    y: margin.top,
    width: Math.max(1, width - margin.left - margin.right),
    height: Math.max(1, height - margin.top - margin.bottom),
  };
}

/**
 * Bar rectangles with a ZERO baseline: positive values rise from y(0), negative
 * values hang below it — never bars scaled off a non-zero floor (the classic
 * misleading-chart mistake a computed chart exists to avoid).
 */
export function barRects(points: readonly DataPoint[], layout: ChartLayout = DEFAULT_LAYOUT): BarRect[] {
  const area = plotArea(layout);
  const domain = valueDomain(points, true);
  const yScale = linearScale(domain, [area.y + area.height, area.y]);
  const zeroY = yScale(0);
  const n = points.length;
  if (n === 0) return [];
  const slot = area.width / n;
  const barWidth = Math.max(1, slot * 0.7);
  return points.map((p, i) => {
    const top = yScale(Math.max(0, p.y));
    const bottom = yScale(Math.min(0, p.y));
    return {
      x: area.x + i * slot + (slot - barWidth) / 2,
      y: top,
      width: barWidth,
      height: Math.max(0, bottom - top) || Math.max(0.5, Math.abs(zeroY - top)),
      label: p.label,
      value: p.y,
    };
  });
}

/** SVG path `d` ("M x y L x y …") through the points over (x ?? index, y). */
export function linePath(points: readonly DataPoint[], layout: ChartLayout = DEFAULT_LAYOUT): string {
  return scatterDots(points, layout)
    .map((d, i) => `${i === 0 ? "M" : "L"} ${round2(d.cx)} ${round2(d.cy)}`)
    .join(" ");
}

/** Dot positions over (x ?? index, y) — shared by line (vertices) and scatter. */
export function scatterDots(points: readonly DataPoint[], layout: ChartLayout = DEFAULT_LAYOUT): ScatterDot[] {
  const area = plotArea(layout);
  const pts = points.map((p, i) => ({ x: p.x ?? i, y: p.y, label: p.label }));
  const finite = pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (finite.length === 0) return [];
  const xs = finite.map((p) => p.x);
  const xScale = linearScale([Math.min(...xs), Math.max(...xs)], [area.x, area.x + area.width]);
  const yScale = linearScale(valueDomain(points, false), [area.y + area.height, area.y]);
  return finite.map((p) => ({ cx: xScale(p.x), cy: yScale(p.y), label: p.label, value: p.y }));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
