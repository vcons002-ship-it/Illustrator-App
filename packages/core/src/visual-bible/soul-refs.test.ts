import { describe, expect, it } from "vitest";
import { soulRefSeeds } from "./soul-refs.js";
import type { IdentityAnchor } from "../types/bible.js";

const anchor = (refs?: string[]): IdentityAnchor => ({ seed: 1, ...(refs ? { referenceImageIds: refs } : {}) });
const chars = [
  { id: "c1", name: "Mira", anchor: anchor() },
  { id: "c2", name: "Toll", anchor: anchor() },
  { id: "c3", name: "Bex", anchor: anchor() },
];
const both = () => true;

describe("soulRefSeeds — a cast soul's own face reaches the story", () => {
  it("seeds each cast character from the soul playing them", () => {
    // The gap this closes: soulCast renamed the character in the TEXT prompt and stopped, so a
    // reader cast as Toll got a stranger in every picture while their photos sat two panels away.
    expect(soulRefSeeds({ self: "Mira", user: "Toll" }, chars, both)).toEqual([
      { characterId: "c1", kind: "self" },
      { characterId: "c2", kind: "user" },
    ]);
  });

  it("matches the name the way a person would — case and spacing don't count", () => {
    expect(soulRefSeeds({ self: "  mira " }, chars, both)).toEqual([{ characterId: "c1", kind: "self" }]);
  });

  it("leaves a character who already has references completely alone", () => {
    // The reader's own uploads are a deliberate choice; an automatic seed must not overwrite one.
    // This is also what makes it safe to run on every story open — no stacking duplicates.
    const withRefs = [{ id: "c1", name: "Mira", anchor: anchor(["b:charref:c1:0"]) }, chars[1]!];
    expect(soulRefSeeds({ self: "Mira", user: "Toll" }, withRefs, both)).toEqual([
      { characterId: "c2", kind: "user" },
    ]);
  });

  it("owes nothing for a soul with no photos", () => {
    expect(soulRefSeeds({ self: "Mira", user: "Toll" }, chars, (k) => k === "user")).toEqual([
      { characterId: "c2", kind: "user" },
    ]);
    expect(soulRefSeeds({ self: "Mira" }, chars, () => false)).toEqual([]);
  });

  it("resolves to nothing when the cast names a character the bible no longer has", () => {
    // A bible is rewritten as a story grows. A stale mapping must produce NO seed rather than
    // quietly landing one person's face on someone else.
    expect(soulRefSeeds({ self: "Someone Gone" }, chars, both)).toEqual([]);
  });

  it("never puts two souls' faces on one character", () => {
    // The validator rejects this mapping, but a hand-edited book could carry it, and two sets of
    // faces conditioning one person is a worse picture than no reference at all.
    const one = [{ id: "c1", name: "Mira", anchor: anchor() }];
    expect(soulRefSeeds({ self: "Mira", user: "Mira" }, one, both)).toEqual([
      { characterId: "c1", kind: "self" },
    ]);
  });

  it("does nothing without a cast, or without characters", () => {
    expect(soulRefSeeds(undefined, chars, both)).toEqual([]);
    expect(soulRefSeeds({ self: "Mira" }, [], both)).toEqual([]);
  });
});
