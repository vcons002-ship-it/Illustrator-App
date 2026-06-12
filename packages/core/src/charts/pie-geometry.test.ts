import { describe, expect, it } from "vitest";
import { donutArcs } from "./pie-geometry.js";

const layout = { cx: 50, cy: 50, outerR: 46, innerR: 28 };

describe("donutArcs", () => {
  it("lays out fractions clockwise from 12 o'clock summing to a full turn", () => {
    const arcs = donutArcs(
      [
        { key: "a", value: 50 },
        { key: "b", value: 30 },
        { key: "c", value: 20 },
      ],
      layout,
    );
    expect(arcs.map((a) => a.key)).toEqual(["a", "b", "c"]);
    expect(arcs.map((a) => Math.round(a.fraction * 100))).toEqual([50, 30, 20]);
    expect(arcs[0]!.startAngle).toBeCloseTo(-Math.PI / 2, 6); // 12 o'clock
    expect(arcs[2]!.endAngle).toBeCloseTo(-Math.PI / 2 + Math.PI * 2, 6); // full circle
    expect(arcs[0]!.path).toMatch(/^M /);
    expect(arcs[0]!.path).toContain("A 46 46"); // outer arc radius
    expect(arcs[0]!.path).toContain("A 28 28"); // inner arc radius
  });

  it("skips zero/negative values and returns nothing for an all-zero input", () => {
    const arcs = donutArcs(
      [
        { key: "a", value: 0 },
        { key: "b", value: 10 },
        { key: "c", value: -5 },
      ],
      layout,
    );
    expect(arcs.map((a) => a.key)).toEqual(["b"]);
    expect(arcs[0]!.fraction).toBe(1);
    expect(donutArcs([{ key: "a", value: 0 }], layout)).toEqual([]);
  });
});
