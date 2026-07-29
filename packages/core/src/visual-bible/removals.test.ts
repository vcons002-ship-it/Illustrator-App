import { describe, expect, it } from "vitest";
import { createEmptyBible } from "./bible.js";
import {
  entityNames,
  isRemovedEntity,
  pruneRemovedEntities,
  removeBibleEntity,
  restoreBibleEntity,
} from "./removals.js";
import { mergeExtraction, type RawExtraction } from "../providers/llm/extraction.js";
import { emptyAppearance, type Character, type Creature, type Environment, type VisualBible } from "../types/bible.js";

function character(name: string, aliases: string[] = []): Character {
  return {
    id: `char-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    aliases,
    appearance: { ...emptyAppearance(), hair: `${name} hair` },
    persistentTraits: [],
    clothing: [],
    outfits: [],
    anchor: { seed: 1 },
    firstSeenChapter: 0,
  };
}

function creature(name: string, aliases: string[] = []): Creature {
  return {
    id: `creature-${name.toLowerCase()}`,
    name,
    aliases,
    kind: "dragon",
    description: ["bronze scales"],
    anchor: { seed: 2 },
    firstSeenChapter: 0,
  };
}

function place(name: string, aliases: string[] = []): Environment {
  return {
    id: `env-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    aliases,
    description: ["low stone taproom"],
    firstSeenChapter: 0,
  };
}

function bibleWith(patch: Partial<VisualBible>): VisualBible {
  return { ...createEmptyBible("book-1"), ...patch };
}

function rawWith(patch: Partial<RawExtraction>): RawExtraction {
  return {
    characters: [],
    environments: [],
    creatures: [],
    spoilers: [],
    summary: "",
    keyMoment: "",
    ...patch,
  } as RawExtraction;
}

describe("entityNames", () => {
  it("is the name plus every alias, lowercased and trimmed", () => {
    expect(entityNames(character("Lyra", [" Ghost Broker ", ""]))).toEqual(["lyra", "ghost broker"]);
  });

  it("reads a place with no aliases at all (older cached bibles have none)", () => {
    expect(entityNames(place("The Rook"))).toEqual(["the rook"]);
  });
});

describe("removeBibleEntity", () => {
  it("removes the entry and records its names for the extractor to skip", () => {
    const bible = bibleWith({ characters: [character("Lyra", ["Ghost Broker"]), character("Nico")] });
    const next = removeBibleEntity(bible, "character", "char-lyra")!;
    expect(next.characters.map((c) => c.name)).toEqual(["Nico"]);
    expect(next.removed).toEqual([
      { kind: "character", names: ["lyra", "ghost broker"], entity: bible.characters[0] },
    ]);
  });

  it("returns undefined for an id that isn't there, so the caller skips the write", () => {
    expect(removeBibleEntity(bibleWith({ characters: [character("Lyra")] }), "character", "char-nope")).toBeUndefined();
  });

  it("keeps the kinds apart — deleting the place leaves a character of the same name alone", () => {
    const bible = bibleWith({ characters: [character("The Rook")], environments: [place("The Rook")] });
    const next = removeBibleEntity(bible, "environment", "env-the-rook")!;
    expect(next.environments).toEqual([]);
    expect(next.characters.map((c) => c.name)).toEqual(["The Rook"]);
    expect(isRemovedEntity(next, "character", ["The Rook"])).toBe(false);
    expect(isRemovedEntity(next, "environment", ["The Rook"])).toBe(true);
  });

  it("drops a deleted character from stored scene casts, leaving prompt TEXT untouched", () => {
    const bible = bibleWith({
      characters: [character("Nico"), character("Sato")],
      storyboard: [
        {
          chapterIndex: 0,
          summary: "",
          keyMoment: "",
          location: "the bar",
          locationChange: "",
          keyEvents: [
            {
              pageRange: [0, 0],
              imagePrompt: { text: "Nico and Sato at the bar" },
              cast: [{ name: "Nico" }, { name: "Sato", outfit: "coat" }],
            },
          ],
        },
      ],
    });
    const next = removeBibleEntity(bible, "character", "char-nico")!;
    expect(next.storyboard[0]!.keyEvents![0]!.cast).toEqual([{ name: "Sato", outfit: "coat" }]);
    // The written prompt is left exactly as it was — rewriting prose the reader may have edited is
    // a worse failure than one stale prompt.
    expect(next.storyboard[0]!.keyEvents![0]!.imagePrompt.text).toBe("Nico and Sato at the bar");
  });

  it("leaves the storyboard object identical when nothing in it names the entry", () => {
    const bible = bibleWith({
      creatures: [creature("Tairn")],
      storyboard: [{ chapterIndex: 0, summary: "", keyMoment: "", location: "", locationChange: "" }],
    });
    const next = removeBibleEntity(bible, "creature", "creature-tairn")!;
    expect(next.storyboard).toEqual(bible.storyboard);
  });
});

describe("restoreBibleEntity", () => {
  it("puts the entry back exactly as it was and stops suppressing its names", () => {
    const original = character("Lyra", ["Ghost Broker"]);
    const removedBible = removeBibleEntity(bibleWith({ characters: [original] }), "character", "char-lyra")!;
    const back = restoreBibleEntity(removedBible, "character", "char-lyra")!;
    expect(back.characters).toEqual([original]);
    expect(back.removed).toEqual([]);
    expect(isRemovedEntity(back, "character", ["Lyra"])).toBe(false);
  });

  it("returns undefined when there is no such removal", () => {
    expect(restoreBibleEntity(bibleWith({}), "character", "char-lyra")).toBeUndefined();
  });
});

describe("pruneRemovedEntities", () => {
  it("drops anything a provider handed back that the reader had deleted", () => {
    const bible = removeBibleEntity(
      bibleWith({ characters: [character("Ghost Broker"), character("Nico")] }),
      "character",
      "char-ghost-broker",
    )!;
    // What a provider that did its own merging could return: the deleted person, back.
    const returned = { ...bible, characters: [...bible.characters, character("Ghost Broker")] };
    expect(pruneRemovedEntities(returned).characters.map((c) => c.name)).toEqual(["Nico"]);
  });

  it("catches it by alias too, and leaves an untouched bible identical", () => {
    const bible = removeBibleEntity(
      bibleWith({ creatures: [creature("Tairn", ["the black"])] }),
      "creature",
      "creature-tairn",
    )!;
    expect(pruneRemovedEntities({ ...bible, creatures: [creature("Sgaeyl", ["the black"])] }).creatures).toEqual([]);
    expect(pruneRemovedEntities(bible)).toBe(bible);
  });

  it("is free when nothing was ever deleted", () => {
    const bible = bibleWith({ characters: [character("Nico")] });
    expect(pruneRemovedEntities(bible)).toBe(bible);
  });
});

describe("a deletion survives reading on", () => {
  // The whole point: the extractor upserts by name as it reads each chapter, so a deletion that
  // isn't remembered undoes itself on exactly the entries worth deleting — a duplicate person, or
  // a costume the model read as one, is named again and again in the prose.
  it("does not re-add a deleted character, by name or by alias", () => {
    const bible = removeBibleEntity(
      bibleWith({ characters: [character("Ghost Broker"), character("Nico")] }),
      "character",
      "char-ghost-broker",
    )!;
    const merged = mergeExtraction(
      bible,
      rawWith({
        characters: [
          { name: "Ghost Broker", aliases: [], persistentTraits: [], clothing: [] },
          { name: "Someone Else", aliases: ["ghost broker"], persistentTraits: [], clothing: [] },
          { name: "Nico", aliases: [], persistentTraits: [], clothing: [] },
        ],
      }),
      1,
    );
    expect(merged.characters.map((c) => c.name)).toEqual(["Nico"]);
  });

  it("does not re-add a deleted creature or place", () => {
    let bible = removeBibleEntity(bibleWith({ creatures: [creature("Tairn")] }), "creature", "creature-tairn")!;
    bible = removeBibleEntity({ ...bible, environments: [place("The Rook")] }, "environment", "env-the-rook")!;
    const merged = mergeExtraction(
      bible,
      rawWith({
        creatures: [{ name: "Tairn", aliases: [], kind: "dragon", description: ["black scales"] }],
        environments: [
          { name: "The Rook", aliases: [], description: ["a bar"] },
          { name: "Elsewhere", aliases: ["the rook"], description: ["also a bar"] },
        ],
      }),
      1,
    );
    expect(merged.creatures).toEqual([]);
    expect(merged.environments).toEqual([]);
  });

  it("lets the extractor add it again once it is restored", () => {
    const removedBible = removeBibleEntity(
      bibleWith({ creatures: [creature("Tairn")] }),
      "creature",
      "creature-tairn",
    )!;
    const back = restoreBibleEntity(removedBible, "creature", "creature-tairn")!;
    const merged = mergeExtraction(
      back,
      rawWith({ creatures: [{ name: "Tairn", aliases: [], kind: "dragon", description: ["torn left wing"] }] }),
      1,
    );
    expect(merged.creatures[0]!.description).toEqual(["bronze scales", "torn left wing"]);
  });
});
