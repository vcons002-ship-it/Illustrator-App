import { describe, expect, it } from "vitest";
import { computeStats, formatStat } from "./stats.js";

const pts = (ys: number[]) => ys.map((y, i) => ({ label: `p${i}`, y }));

describe("computeStats", () => {
  it("computes count/min/max/mean/median (odd count)", () => {
    const s = computeStats(pts([3, 1, 2]))!;
    expect(s.count).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(3);
    expect(s.mean).toBe(2);
    expect(s.median).toBe(2);
  });

  it("medians an even count as the middle pair's mean", () => {
    expect(computeStats(pts([1, 2, 3, 10]))!.median).toBe(2.5);
  });

  it("classifies a monotone increase as rising (positive slope)", () => {
    const s = computeStats(pts([1, 2, 3, 4, 5]))!;
    expect(s.trend).toBe("rising");
    expect(s.slope).toBeGreaterThan(0);
  });

  it("classifies a monotone decrease as falling", () => {
    expect(computeStats(pts([10, 8, 5, 2]))!.trend).toBe("falling");
  });

  it("classifies a constant series as flat", () => {
    expect(computeStats(pts([4, 4, 4, 4]))!.trend).toBe("flat");
  });

  it("classifies a zig-zag with no direction as mixed", () => {
    expect(computeStats(pts([1, 9, 2, 8, 1, 9, 3]))!.trend).toBe("mixed");
  });

  it("uses real x values when present (unordered x still fits the trend)", () => {
    const s = computeStats([
      { label: "2020", x: 2020, y: 10 },
      { label: "2010", x: 2010, y: 0 },
      { label: "2015", x: 2015, y: 5 },
    ])!;
    expect(s.trend).toBe("rising");
  });

  it("returns flat stats for a single point and undefined for none", () => {
    expect(computeStats(pts([7]))!.trend).toBe("flat");
    expect(computeStats([])).toBeUndefined();
  });

  it("ignores non-finite y values", () => {
    expect(computeStats([{ label: "a", y: NaN }, ...pts([1, 2])])!.count).toBe(2);
  });

  it("computes sample variance / stdev (n−1) and quartiles", () => {
    const s = computeStats(pts([2, 4, 4, 4, 5, 5, 7, 9]))!;
    expect(s.variance).toBeCloseTo(4.571, 2); // sample variance (n−1) of this classic set
    expect(s.stdev).toBeCloseTo(2.138, 2);
    // Linear-interpolation percentiles (numpy "linear" default): q1=4, q3=5.5.
    expect(s.q1).toBeCloseTo(4, 5);
    expect(s.q3).toBeCloseTo(5.5, 5);
  });

  it("single point has zero variance/stdev", () => {
    const s = computeStats(pts([7]))!;
    expect(s.variance).toBe(0);
    expect(s.stdev).toBe(0);
  });

  it("fits a perfect line: slope/intercept exact, R²=1, r=1", () => {
    const s = computeStats([
      { label: "a", x: 1, y: 3 },
      { label: "b", x: 2, y: 5 },
      { label: "c", x: 3, y: 7 },
    ])!;
    expect(s.regression.slope).toBeCloseTo(2, 6);
    expect(s.regression.intercept).toBeCloseTo(1, 6);
    expect(s.regression.r2).toBeCloseTo(1, 6);
    expect(s.regression.r).toBeCloseTo(1, 6);
  });

  it("a perfect negative line gives r=−1", () => {
    const s = computeStats([
      { label: "a", x: 0, y: 10 },
      { label: "b", x: 1, y: 8 },
      { label: "c", x: 2, y: 6 },
    ])!;
    expect(s.regression.r).toBeCloseTo(-1, 6);
    expect(s.regression.r2).toBeCloseTo(1, 6);
  });
});

describe("formatStat", () => {
  it("scales decimals to magnitude", () => {
    expect(formatStat(1234.56)).toBe("1,235");
    expect(formatStat(12.34)).toBe("12.3");
    expect(formatStat(0.1234)).toBe("0.123");
  });
});
