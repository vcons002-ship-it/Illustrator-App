import { describe, expect, it } from "vitest";
import { removeSoulEssenceFact, type SoulEssence } from "./souls.js";

const essence = (): SoulEssence =>
  ({
    schemaVersion: 1,
    kind: "user",
    sourceFingerprint: "fp",
    generatedAt: 1000,
    generalizedEssence: { text: "curious and precise", sourceIds: ["a"] },
    facets: {} as SoulEssence["facets"],
    exactAppearance: [
      { text: "auburn hair", sourceIds: ["a"] },
      { text: "fascinated by the discrepancy between physical and perceived time", sourceIds: ["b"] },
      { text: "green eyes", sourceIds: ["c"] },
    ],
    exactPersonalityDirections: [
      { text: "never flatter", sourceIds: ["d"] },
      { text: "prefers brevity", sourceIds: ["e"] },
    ],
  }) as unknown as SoulEssence;

describe("removeSoulEssenceFact — pruning a misfiled line", () => {
  it("drops the one item, leaving its neighbours in order", () => {
    // The case: an interest in perceived time filed under PHYSICAL APPEARANCE, from where it goes on
    // to describe the reader's face to every image model that asks.
    const out = removeSoulEssenceFact(essence(), "exactAppearance", 1);
    expect(out.exactAppearance.map((f) => f.text)).toEqual(["auburn hair", "green eyes"]);
  });

  it("prunes directions too", () => {
    const out = removeSoulEssenceFact(essence(), "exactPersonalityDirections", 0);
    expect(out.exactPersonalityDirections.map((f) => f.text)).toEqual(["prefers brevity"]);
  });

  it("leaves the OTHER list, and the synthesis, untouched", () => {
    const out = removeSoulEssenceFact(essence(), "exactAppearance", 0);
    expect(out.exactPersonalityDirections).toEqual(essence().exactPersonalityDirections);
    expect(out.generalizedEssence).toEqual(essence().generalizedEssence);
  });

  it("keeps generatedAt and the fingerprint — a correction isn't a new distillation", () => {
    const out = removeSoulEssenceFact(essence(), "exactAppearance", 1);
    expect(out.generatedAt).toBe(1000);
    expect(out.sourceFingerprint).toBe("fp");
  });

  it("returns the essence UNCHANGED for an index that isn't there", () => {
    // A stale click from a list that re-rendered must not delete a neighbour instead.
    const before = essence();
    for (const i of [-1, 3, 99, 1.5, NaN]) {
      expect(removeSoulEssenceFact(before, "exactAppearance", i)).toBe(before);
    }
  });

  it("does not mutate the essence it was given", () => {
    const before = essence();
    removeSoulEssenceFact(before, "exactAppearance", 1);
    expect(before.exactAppearance).toHaveLength(3);
  });
});
