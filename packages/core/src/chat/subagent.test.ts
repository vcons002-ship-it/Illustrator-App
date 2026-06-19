import { describe, expect, it } from "vitest";
import { buildDelegatePrompt, mapWithConcurrency } from "./subagent.js";

describe("buildDelegatePrompt", () => {
  it("embeds the task and constrains the sub-agent to read-only tools", () => {
    const p = buildDelegatePrompt("  find the 3 biggest EU photonics firms  ");
    expect(p).toContain("SUBTASK: find the 3 biggest EU photonics firms");
    expect(p).toMatch(/read-only/i);
    expect(p).toMatch(/do not change settings/i);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]); // input order preserved
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // it actually ran some in parallel
  });

  it("clamps a bad limit to 1 and handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (x) => x * 2)).toEqual([2, 4]);
  });
});
