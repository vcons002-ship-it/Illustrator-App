import { describe, expect, it } from "vitest";
import { reconcileSoulAppearance, removeSoulEssenceFact, type SoulEssence } from "./souls.js";

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

describe("a garment word used as a VERB isn't physical appearance", () => {
  const appearanceOf = (text: string): string[] =>
    reconcileSoulAppearance([{ at: 1, text }]).activeFacts.map((f) => f.text);

  it("doesn't file a note about perceived time under physical appearance", () => {
    // The reported leak, verbatim. The extractor is a word test and `mask` is a thing people wear,
    // so a sentence about the brain masking latency was filed as the reader's LOOK — from where it
    // described their face to every image model that asked.
    expect(
      appearanceOf(
        "I am fascinated by the discrepancy between physical time and perceived time, particularly " +
          "how the brain curates a 'specious present' to mask the inherent latencies of biological hardware.",
      ),
    ).toEqual([]);
  });

  it("skips the other everyday verbs that are also things you wear", () => {
    expect(appearanceOf("his answers mask the uncertainty underneath")).toEqual([]);
    expect(appearanceOf("the deadline will cap the scope")).toEqual([]);
    expect(appearanceOf("a second pass to coat the surface")).toEqual([]);
  });

  it("still keeps every one of them when it IS something worn", () => {
    // The fix must cost no real appearance data. A worn one always has a determiner or adjective in
    // front; a verb has an infinitive, a modal, or an object after it.
    for (const text of [
      "wears a black mask",
      "a masked figure in a long coat",
      "she wears the hood up",
      "wearing a wool cap",
      "a silver ring on her left hand",
      "a heavy coat and leather gloves",
      "auburn hair, green eyes",
    ]) {
      expect(appearanceOf(text), text).not.toEqual([]);
    }
  });
});
