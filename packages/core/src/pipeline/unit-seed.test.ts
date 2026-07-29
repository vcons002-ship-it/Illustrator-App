import { describe, expect, it } from "vitest";
import { unitSeed } from "./unit-seed.js";

describe("unitSeed", () => {
  it("is deterministic — the same book renders the same way twice", () => {
    expect(unitSeed(12345, 7)).toBe(unitSeed(12345, 7));
  });

  it("gives every unit its own seed, so one bad draw can't spoil a whole book", () => {
    const seeds = Array.from({ length: 50 }, (_, i) => unitSeed(12345, i));
    expect(new Set(seeds).size).toBe(50);
  });

  it("puts neighbours far apart — consecutive seeds can produce visibly related noise", () => {
    const a = unitSeed(12345, 3);
    const b = unitSeed(12345, 4);
    expect(Math.abs(a - b)).toBeGreaterThan(1000);
  });

  it("different casts (different anchors) render differently", () => {
    expect(unitSeed(1, 0)).not.toBe(unitSeed(2, 0));
  });

  it("stays a valid unsigned 32-bit seed", () => {
    for (const [base, i] of [[0, 0], [0xffffffff, 999], [7, 1]] as const) {
      const s = unitSeed(base, i);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
