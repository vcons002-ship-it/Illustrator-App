import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  barRects,
  linePath,
  linearScale,
  niceTicks,
  plotArea,
  scatterDots,
  valueDomain,
} from "./chart-geometry.js";

const pts = (ys: number[]) => ys.map((y, i) => ({ label: `p${i}`, y }));

describe("linearScale", () => {
  it("maps domain endpoints to range endpoints (and inverts for y-down SVG)", () => {
    const s = linearScale([0, 10], [100, 0]);
    expect(s(0)).toBe(100);
    expect(s(10)).toBe(0);
    expect(s(5)).toBe(50);
  });
  it("degenerates to the range midpoint for a zero-span domain", () => {
    expect(linearScale([4, 4], [0, 100])(4)).toBe(50);
  });
});

describe("niceTicks", () => {
  it("yields round 1-2-5 steps covering the domain", () => {
    const ticks = niceTicks(0, 97, 5);
    expect(ticks[0]).toBe(0);
    expect(ticks).toContain(20);
    expect(ticks[ticks.length - 1]!).toBeLessThanOrEqual(97);
    const step = ticks[1]! - ticks[0]!;
    expect([1, 2, 5, 10, 20, 50].some((s) => Math.abs(step - s) < 1e-9)).toBe(true);
  });
  it("handles fractional ranges without float drift dropping the last tick", () => {
    const ticks = niceTicks(0, 0.3, 3);
    expect(ticks[ticks.length - 1]).toBeCloseTo(0.3);
  });
  it("collapses a flat domain to one tick", () => {
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});

describe("barRects", () => {
  it("keeps a zero baseline: bar heights are proportional to values", () => {
    const [a, b] = barRects(pts([10, 20]));
    expect(b!.height / a!.height).toBeCloseTo(2, 5);
  });
  it("hangs negative bars below the baseline with non-negative heights", () => {
    const rects = barRects(pts([5, -5]));
    expect(rects.every((r) => r.height >= 0)).toBe(true);
    // Negative bar starts AT the zero line; positive bar ends at it.
    const zeroY = rects[1]!.y;
    expect(rects[0]!.y + rects[0]!.height).toBeCloseTo(zeroY, 5);
  });
  it("lays bars left to right inside the plot area", () => {
    const rects = barRects(pts([1, 2, 3]));
    const area = plotArea(DEFAULT_LAYOUT);
    expect(rects[0]!.x).toBeGreaterThanOrEqual(area.x);
    expect(rects[2]!.x + rects[2]!.width).toBeLessThanOrEqual(area.x + area.width + 1e-6);
    expect(rects[0]!.x).toBeLessThan(rects[1]!.x);
  });
});

describe("linePath + scatterDots", () => {
  it("emits an SVG path through every point", () => {
    const d = linePath(pts([1, 2, 3]));
    expect(d).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
  });
  it("positions dots by real x when given, else by index", () => {
    const byIndex = scatterDots(pts([0, 10]));
    expect(byIndex[0]!.cx).toBeLessThan(byIndex[1]!.cx);
    const byX = scatterDots([
      { label: "late", x: 2000, y: 1 },
      { label: "early", x: 1900, y: 2 },
    ]);
    expect(byX[0]!.cx).toBeGreaterThan(byX[1]!.cx); // 2000 plots right of 1900
  });
  it("returns empty for no points", () => {
    expect(scatterDots([])).toEqual([]);
    expect(linePath([])).toBe("");
  });
});

describe("valueDomain", () => {
  it("zero-bases for bars but not for lines", () => {
    expect(valueDomain(pts([5, 10]), true)).toEqual([0, 10]);
    expect(valueDomain(pts([5, 10]), false)).toEqual([5, 10]);
  });
  it("pads a degenerate flat series so the chart has height", () => {
    const [lo, hi] = valueDomain(pts([4, 4]), false);
    expect(lo).toBeLessThan(4);
    expect(hi).toBeGreaterThan(4);
  });
});
