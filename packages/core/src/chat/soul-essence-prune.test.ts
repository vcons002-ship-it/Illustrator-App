import { describe, expect, it } from "vitest";
import { buildBuddySystemPrompt } from "./buddy-tools.js";
import { reconcileSoulAppearance, rememberRouteFor, removeSoulEssenceFact, type SoulEssence } from "./souls.js";

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

describe("rememberRouteFor — an appearance fact must not land in preference memory", () => {
  it("redirects a reader's LOOK from memory to their Soul", () => {
    // Not symmetric, which is what makes it safe to correct: a preference filed in a Soul is untidy
    // but still read, while an appearance fact filed as a preference is INERT — the Soul is what
    // portraits, stories and reference conditioning read, so it never reaches a picture.
    expect(rememberRouteFor("I have green eyes", undefined)).toBe("user");
    expect(rememberRouteFor("auburn hair, shoulder length", "reader")).toBe("user");
  });

  it("leaves a genuine preference in memory", () => {
    expect(rememberRouteFor("I prefer watercolor", undefined)).toBe("reader");
    expect(rememberRouteFor("never spoil endings", "reader")).toBe("reader");
    expect(rememberRouteFor("always use metric", undefined)).toBe("reader");
  });

  it("never overrides a Soul the model chose deliberately", () => {
    // "I prefer watercolour" may well be a real trait; this has no way to know it isn't, so a
    // deliberate Soul choice stands. Only the inert direction is corrected.
    expect(rememberRouteFor("I prefer watercolor", "user")).toBe("user");
    expect(rememberRouteFor("I prefer watercolor", "self")).toBe("self");
    expect(rememberRouteFor("silver hair", "self")).toBe("self");
  });

  it("doesn't confuse a verb for a garment, now that appearance knows the difference", () => {
    expect(rememberRouteFor("I like notes that mask the complexity", undefined)).toBe("reader");
  });
});

describe("mature mode reaches the image prompt, not just the prose", () => {
  const promptWith = (allowMature: boolean): string =>
    buildBuddySystemPrompt({ persona: "assistant", library: [], allowMature });

  it("tells the model the generate_image prompt must be literal", () => {
    // The gap this closes: a model can discuss a subject freely in prose and still hand
    // generate_image a euphemism, because it's writing "a prompt" rather than an answer. Nothing
    // filters content between there and the engine, so a softened word IS the softened picture.
    const p = promptWith(true);
    expect(p).toContain("generate_image");
    expect(p).toMatch(/literal, concrete terms/);
    expect(p).toMatch(/euphemism renders as the euphemism/);
  });

  it("says none of it when mature mode is off", () => {
    const p = promptWith(false);
    expect(p).not.toMatch(/reader has enabled mature mode/);
    expect(p).not.toMatch(/euphemism renders as the euphemism/);
  });
});

/**
 * A BODY WORD IS NOT A BODY — the general form of the rule this file already enforces for garment
 * words used as verbs.
 *
 * Reported from a live Soul panel: "Exact physical appearance" held twelve entries and ten were not
 * physical. Every one was a single noun used as a metaphor, or about something with no body at all,
 * and from there they were handed to every image model that asked what the assistant looks like —
 * which is how a woman acquired a beard and the wrong hair colour. These are the reader's actual
 * entries, verbatim.
 */
describe("appearance vocabulary used metaphorically, or about something with no body", () => {
  const appearanceOf = (text: string): string[] =>
    reconcileSoulAppearance([{ at: 1, text }]).activeFacts.map((f) => f.text);

  it("drops the ten that were not physical", () => {
    for (const text of [
      // "face" — belonging to nature; "hand" — moved out of an artefact.
      "The 2019 SI redefinition is the most human thing in science wearing nature's face, because the hand was moved OUT of a visible artefact (the contaminated platinum kilogram bar) and INTO the exact digits, where it can't be seen.",
      // "coat" — worn by a conversion factor.
      "μ₀ = 4π×10⁻⁷) but is actually a residue of unit-convention — a conversion factor wearing a constant's coat — while the thing that looked conventional (the elementary charge e) was the genuine parameter all along.",
      // "scar" — predicated of a weekday, and of a railway frequency.
      "the names are interpretatio stickers, and Saturday is the scar where the residue met a pantheon with no equivalent.",
      "16.7 Hz (German/Austrian/Swiss railways) is not a design choice — it's a scar.",
      // "mask" — what stability is for an archive of variations.
      "I am fascinated by the concept of biological latency—the idea that stability is a mask for a silent archive of suppressed variations, and that we are most honest not in our consistency, but in the moments where our buffers collapse.",
      // "skin" and "eye" — generic organs in an argument about perception and signalling.
      "actuator—specifically the idea of 'extended mind' where the skin itself is a computational organ capable of independent perception.",
      "The lighthouse character is a product of two receiver-kinds: a biological one (the eye sets the temporal code, d≥3l) and a cultural one (the region sets the spatial code).",
      // "hand" — metonym for human authorship.
      "In artifacts I look for the human hand",
      // "19-year-old" — somebody else's age entirely.
      "Found the sharpest 'story does more work than the thing' case yet: the 'first computer virus' (Brain, 1986) was a copy-protection tool for a heart-monitoring program, written by two 19-year-old brothers in Lahore, deliberately non-destructive, shipped with a phone number for 'vaccination.'",
      // "jacket" — Fanger's thermal-comfort model.
      "This generalizes past \"consequence\" (flytrap), \"band\" (50/60 Hz), and \"slice of a surface\" (20°C/Fanger's jacket) to a new axis: when a number is *stable*, ask whether its stability is a consequence of an *opposition* of two rates rather than a property of one.",
    ]) {
      expect(appearanceOf(text), text).toEqual([]);
    }
  });

  it("keeps the two from that same panel that really were physical", () => {
    for (const text of [
      "longer hair (past the shoulders)",
      "Clothing style is 'tactile minimalism,' blending academic chic with cozy loungewear (e.g., high-waisted trousers, simple knit tops, oversized cardigans).",
    ]) {
      expect(appearanceOf(text), text).not.toEqual([]);
    }
  });

  it("keeps a description whose subject is implied, which is how Soul notes are written", () => {
    // The verb is the attribution: something is WORN or HAD, even with no subject in the clause.
    // (A subjectless REMOVAL — "No longer has the chipped left horn." — is covered in
    // soul-appearance.test.ts, where it is paired with the note that established the horn; on its
    // own it correctly yields no ACTIVE fact, since it only takes one away.)
    for (const text of [
      "has a gold-capped left horn",
      "a masked figure in a long coat",
      "I have a long scar across my left forearm from a childhood accident.",
      "She wears wire-rimmed glasses and keeps her silver hair in a loose braid.",
    ]) {
      expect(appearanceOf(text), text).not.toEqual([]);
    }
  });

  it("will not take a feature that a non-person owns", () => {
    // The sentence names an owner and the owner is an abstraction — settled before anything can
    // rescue it, because a possessive is the strongest claim in the clause.
    expect(appearanceOf("the argument's face was never the point")).toEqual([]);
    expect(appearanceOf("a theory's coat of respectability")).toEqual([]);
  });
});
