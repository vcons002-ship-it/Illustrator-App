import { describe, expect, it } from "vitest";
import { generationRateNote, measureGeneration } from "./generation-rate.js";

describe("measureGeneration", () => {
  it("measures a normal reply", () => {
    const r = measureGeneration(4000, 20_000)!;
    expect(r.approxTokens).toBe(1000);
    expect(r.tokensPerSecond).toBe(50);
  });

  it("refuses to call a very short reply a speed measurement", () => {
    // A two-word answer that "took" 40ms says nothing about generation speed, and a figure derived
    // from it would be quoted as if it did.
    expect(measureGeneration(20, 40)!.tokensPerSecond).toBe(0);
    expect(generationRateNote(measureGeneration(20, 40))).toContain("too short to time meaningfully");
  });

  it("returns nothing at all for a non-measurement", () => {
    for (const [c, m] of [[0, 100], [100, 0], [-5, 100], [NaN, 100], [100, Infinity]] as const) {
      expect(measureGeneration(c, m), `${c}/${m}`).toBeUndefined();
    }
    expect(generationRateNote(undefined)).toBe("");
  });

  it("rounds to one decimal rather than claiming precision it doesn't have", () => {
    // The whole estimate rests on chars/4; more digits would dress that up as a measurement.
    expect(measureGeneration(1234, 7_777)!.tokensPerSecond).toBe(39.7);
  });
});

describe("generationRateNote", () => {
  it("tells the model to quote it instead of computing, and why it can't compute it", () => {
    // Asked to time itself, a model loops or invents: its own stamp is written after the reply
    // exists, so the number simply isn't available while it's writing.
    const note = generationRateNote(measureGeneration(4000, 20_000));
    expect(note).toContain("≈1000 tokens");
    expect(note).toContain("20s");
    expect(note).toContain("cannot time your own reply");
    expect(note).toContain("approximate");
  });
});
