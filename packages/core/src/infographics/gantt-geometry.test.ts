import { describe, expect, it } from "vitest";
import { layoutGantt, type GanttRow } from "./gantt-geometry.js";

const rows: GanttRow[] = [
  { id: "p", label: "Plan", start: 0, end: 6, depth: 0 },
  { id: "p::a", label: "Step A", start: 0, end: 1, depth: 1 },
  { id: "p::b", label: "Step B", start: 4, end: 6, depth: 1, done: true },
];

describe("layoutGantt", () => {
  it("places one bar per row, left-to-right by start, all within the plot area", () => {
    const l = layoutGantt(rows, { width: 600 });
    expect(l.bars).toHaveLength(3);
    const [, a, b] = l.bars;
    // A starts before B, so its x is smaller; every bar stays inside [labelWidth, width].
    expect(a!.x).toBeLessThan(b!.x);
    for (const bar of l.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(l.labelWidth);
      expect(bar.x + bar.w).toBeLessThanOrEqual(600 + 0.01);
    }
  });

  it("gives a single-unit bar (start === end) a real, positive width", () => {
    const [bar] = layoutGantt([{ id: "x", label: "x", start: 3, end: 3 }]).bars;
    expect(bar!.w).toBeGreaterThan(0);
  });

  it("carries depth, done and accent through to the bar", () => {
    const l = layoutGantt(rows);
    expect(l.bars[0]!.depth).toBe(0);
    expect(l.bars[0]!.accent).toBe("group"); // depth-0, not done → group
    expect(l.bars[2]!.done).toBe(true);
    expect(l.bars[2]!.accent).toBe("done"); // done overrides
  });

  it("labels ticks via the supplied formatter and grows height with row count", () => {
    const l = layoutGantt(rows, { tickLabel: (u) => `d${u}` });
    expect(l.ticks.length).toBeGreaterThan(0);
    expect(l.ticks.every((t) => t.label.startsWith("d"))).toBe(true);
    expect(layoutGantt([rows[0]!]).height).toBeLessThan(l.height);
  });

  it("is safe on an empty row set", () => {
    const l = layoutGantt([]);
    expect(l.bars).toEqual([]);
    expect(l.width).toBeGreaterThan(0);
  });
});
