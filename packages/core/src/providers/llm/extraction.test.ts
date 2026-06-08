import { describe, it, expect } from "vitest";
import {
  consolidateCharacters,
  extractionUserContent,
  mergeExtraction,
  promptUserContent,
} from "./extraction.js";
import { createEmptyBible } from "../../visual-bible/bible.js";
import { emptyAppearance, type Character } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";

function char(name: string, over: Partial<Character> = {}): Character {
  return {
    id: `char-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    aliases: [],
    appearance: emptyAppearance(),
    persistentTraits: [],
    clothing: [],
    anchor: { seed: 1 },
    firstSeenChapter: 0,
    ...over,
  };
}

describe("mergeExtraction storyboard", () => {
  it("upserts a chapter scene and re-running a chapter replaces (not duplicates) it", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      { characters: [], environments: [], spoilers: [], summary: "Ch0 happens", keyMoment: "A duel" },
      0,
    );
    expect(bible.storyboard).toEqual([
      { chapterIndex: 0, summary: "Ch0 happens", keyMoment: "A duel", location: "", locationChange: "" },
    ]);

    // Re-run chapter 0 → replaced, still length 1.
    bible = mergeExtraction(
      bible,
      { characters: [], environments: [], spoilers: [], summary: "Ch0 v2", keyMoment: "A storm" },
      0,
    );
    expect(bible.storyboard).toHaveLength(1);
    expect(bible.storyboard[0]!.keyMoment).toBe("A storm");
  });
});

describe("mergeExtraction glossary + appearance", () => {
  it("upserts glossary entries (deduped by term) and stores structured appearance", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Ana",
            aliases: [],
            appearance: { hair: "silver", gender: "woman", build: "slender, athletic" },
            persistentTraits: [],
            clothing: [],
          },
        ],
        glossary: [{ term: "dragon riders", definition: "wear black flight leathers" }],
        environments: [],
        spoilers: [],
      },
      0,
    );
    expect(bible.glossary).toEqual([
      { term: "dragon riders", definition: "wear black flight leathers" },
    ]);
    const ana = bible.characters.find((c) => c.name === "Ana")!;
    expect(ana.appearance.hair).toBe("silver");
    expect(ana.appearance.gender).toBe("woman");
    expect(ana.appearance.eyes).toBe(""); // unspecified fields default to empty

    // A later chapter re-states the same term (case-insensitive) → not duplicated.
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        glossary: [{ term: "Dragon Riders", definition: "also fireproof gloves" }],
        environments: [],
        spoilers: [],
      },
      1,
    );
    expect(bible.glossary).toHaveLength(1);
  });
});

describe("promptUserContent", () => {
  it("includes the key moment, story-so-far, and character outfits", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          { name: "Ana", aliases: [], persistentTraits: ["tall"], clothing: ["red cloak"] },
        ],
        environments: [],
        spoilers: [],
        summary: "Ana arrives in the city.",
        keyMoment: "Ana enters the gates.",
      },
      0,
    );
    bible = mergeExtraction(
      bible,
      { characters: [], environments: [], spoilers: [], summary: "Ana fights.", keyMoment: "The duel." },
      1,
    );

    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-1",
      pageIndex: 1,
      chapterIndex: 1,
      sourceText: "swords clash",
      characterIds: ["char-ana"],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    const text = promptUserContent(req, bible);
    expect(text).toContain("pivotal moment");
    expect(text).toContain("The duel.");
    expect(text).toContain("this specific passage");
    expect(text).toContain("Story so far"); // chapter 0's summary precedes chapter 1
    expect(text).toContain("Ana arrives in the city.");
    expect(text).toContain("red cloak"); // outfit carried into the prompt
  });

  it("injects the world glossary as defaults and structured appearance", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Ana",
            aliases: [],
            appearance: { hair: "silver", gender: "woman", build: "slender" },
            persistentTraits: [],
            clothing: [],
          },
        ],
        glossary: [{ term: "dragon riders", definition: "wear black flight leathers" }],
        environments: [],
        spoilers: [],
        summary: "Ana rides.",
        keyMoment: "Ana mounts her dragon.",
      },
      0,
    );

    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "wings beat",
      characterIds: ["char-ana"],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    const text = promptUserContent(req, bible);
    expect(text).toContain("World facts");
    expect(text).toContain("dragon riders: wear black flight leathers");
    // Structured appearance fields render into the character line.
    expect(text).toContain("hair: silver");
    expect(text).toContain("gender: woman");
  });
});

describe("environments + location tracking", () => {
  it("accumulates location descriptions across chapters (no loss, no dup)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [{ name: "The Spire", description: ["black basalt tower", "tall"] }],
        spoilers: [],
      },
      0,
    );
    // A later chapter re-describes the same place, adding a detail (and repeating one).
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [{ name: "the spire", description: ["tall", "ringed by storm clouds"] }],
        spoilers: [],
      },
      3,
    );
    const spire = bible.environments.find((e) => e.name.toLowerCase() === "the spire")!;
    expect(bible.environments).toHaveLength(1); // not duplicated by case
    expect(spire.description).toEqual(["black basalt tower", "tall", "ringed by storm clouds"]);
  });

  it("stores the chapter location and a single-location Setting line in the prompt", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [{ name: "the Great Hall", description: ["vaulted", "banners"] }],
        spoilers: [],
        summary: "A feast.",
        keyMoment: "The toast.",
        location: "the Great Hall",
        locationChange: "moves to the courtyard at the end",
      },
      0,
    );
    expect(bible.storyboard[0]!.location).toBe("the Great Hall");
    expect(bible.storyboard[0]!.locationChange).toContain("courtyard");

    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "Goblets rose in the Great Hall.",
      characterIds: [],
      environmentIds: ["env-the-great-hall"],
      creatureIds: [],
      spoilerIds: [],
    };
    const text = promptUserContent(req, bible);
    expect(text).toContain("Setting for this image");
    expect(text).toContain("the Great Hall");
    expect(text).toContain("do not blend places");
  });

  it("feeds known locations back into the next chapter's extraction context", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [{ name: "the Spire", description: ["black basalt"] }],
        spoilers: [],
      },
      0,
    );
    const text = extractionUserContent({
      bookId: "b",
      chapterIndex: 1,
      chapterText: "They returned to the Spire.",
      existing: bible,
    });
    expect(text).toContain("Known locations so far");
    expect(text).toContain("the Spire: black basalt");
  });
});

describe("character de-duplication", () => {
  it("merges a partial name into its unique fuller name (Violet → Violet Sorrengail)", () => {
    const out = consolidateCharacters([
      char("Violet", { appearance: { ...emptyAppearance(), hair: "silver-tipped" } }),
      char("Violet Sorrengail", { appearance: { ...emptyAppearance(), eyes: "blue" } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Violet Sorrengail"); // fuller name is canonical
    expect(out[0]!.aliases).toContain("Violet");
    // Appearance from both is preserved.
    expect(out[0]!.appearance.hair).toBe("silver-tipped");
    expect(out[0]!.appearance.eyes).toBe("blue");
  });

  it("merges when name/alias sets overlap", () => {
    const out = consolidateCharacters([
      char("Xaden Riorson", { aliases: ["Xaden"] }),
      char("Xaden"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Xaden Riorson");
  });

  it("leaves an ambiguous bare name alone (two different full names)", () => {
    const out = consolidateCharacters([char("Anne Boleyn"), char("Anne Frank"), char("Anne")]);
    // "Anne" is a subset of BOTH → ambiguous → not merged; all three remain.
    expect(out.map((c) => c.name).sort()).toEqual(["Anne", "Anne Boleyn", "Anne Frank"]);
  });

  it("mergeExtraction consolidates across chapters (no duplicate Violet)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Violet", aliases: [], persistentTraits: [], clothing: [] }],
        environments: [],
        spoilers: [],
      },
      0,
    );
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Violet Sorrengail", aliases: [], persistentTraits: [], clothing: [] }],
        environments: [],
        spoilers: [],
      },
      4,
    );
    expect(bible.characters).toHaveLength(1);
    expect(bible.characters[0]!.name).toBe("Violet Sorrengail");
    expect(bible.characters[0]!.aliases).toContain("Violet");
  });

  it("feeds the known cast back into the next chapter's extraction context", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Violet Sorrengail", aliases: ["Vi"], persistentTraits: [], clothing: [] }],
        environments: [],
        spoilers: [],
      },
      0,
    );
    const text = extractionUserContent({ bookId: "b", chapterIndex: 1, chapterText: "x", existing: bible });
    expect(text).toContain("Known characters so far");
    expect(text).toContain("Violet Sorrengail (aka Vi)");
  });
});

describe("appearance accumulation", () => {
  it("keeps adding new appearance details across chapters (does not drop them)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          { name: "Ana", aliases: [], appearance: { hair: "brown" }, persistentTraits: [], clothing: [] },
        ],
        environments: [],
        spoilers: [],
      },
      0,
    );
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Ana",
            aliases: [],
            appearance: { hair: "fades to silver at the tips", eyes: "green" },
            persistentTraits: [],
            clothing: [],
          },
        ],
        environments: [],
        spoilers: [],
      },
      3,
    );
    const ana = bible.characters.find((c) => c.name === "Ana")!;
    expect(ana.appearance.hair).toBe("brown; fades to silver at the tips"); // accumulated
    expect(ana.appearance.eyes).toBe("green"); // newly filled
  });
});

describe("context-based outfits", () => {
  it("accumulates distinct outfits and offers them as scene choices in the prompt", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Violet",
            aliases: [],
            persistentTraits: [],
            outfits: [{ label: "flight leathers", description: "fitted black hide", context: "flying, battle" }],
          },
        ],
        environments: [],
        spoilers: [],
      },
      0,
    );
    // A later chapter adds a different outfit (and repeats the first).
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Violet",
            aliases: [],
            persistentTraits: [],
            outfits: [
              { label: "flight leathers", description: "fitted black hide", context: "flying" },
              { label: "ball gown", description: "emerald silk", context: "formal events" },
            ],
          },
        ],
        environments: [],
        spoilers: [],
      },
      3,
    );
    const v = bible.characters.find((c) => c.name === "Violet")!;
    expect(v.outfits?.map((o) => o.label)).toEqual(["flight leathers", "ball gown"]); // deduped by label

    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "She buckled on her flight leathers.",
      characterIds: ["char-violet"],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    const prompt = promptUserContent(req, bible);
    expect(prompt).toContain("outfits to choose from");
    expect(prompt).toContain("flight leathers");
    expect(prompt).toContain("ball gown");
  });

  it("falls back to legacy clothing when a character has no structured outfits", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Ana", aliases: [], persistentTraits: [], clothing: ["red cloak"] }],
        environments: [],
        spoilers: [],
      },
      0,
    );
    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "Ana walked.",
      characterIds: ["char-ana"],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    expect(promptUserContent(req, bible)).toContain("wearing red cloak");
  });
});

describe("creatures", () => {
  it("captures a creature, accumulates its description, and injects it into the prompt", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [],
        spoilers: [],
        creatures: [{ name: "Tairn", aliases: [], kind: "dragon", description: ["massive", "midnight black"] }],
      },
      0,
    );
    expect(bible.creatures).toHaveLength(1);
    expect(bible.creatures[0]!.kind).toBe("dragon");
    expect(bible.creatures[0]!.anchor.seed).toBeGreaterThan(0);

    // A later chapter names Tairn again, adding detail (and repeating one line).
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [],
        spoilers: [],
        creatures: [{ name: "tairn", aliases: [], kind: "dragon", description: ["midnight black", "tail spikes"] }],
      },
      2,
    );
    expect(bible.creatures).toHaveLength(1); // deduped by name (case-insensitive)
    expect(bible.creatures[0]!.description).toEqual(["massive", "midnight black", "tail spikes"]);

    // The known-creatures context is fed back for the next chapter.
    const ctx = extractionUserContent({
      bookId: "b",
      chapterIndex: 3,
      chapterText: "Tairn roared.",
      existing: bible,
    });
    expect(ctx).toContain("Known creatures so far");
    expect(ctx).toContain("Tairn (dragon)");

    // And a present creature is injected into the image prompt.
    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "Tairn beat his wings.",
      characterIds: [],
      environmentIds: [],
      creatureIds: ["creature-tairn"],
      spoilerIds: [],
    };
    const prompt = promptUserContent(req, bible);
    expect(prompt).toContain("Creatures present");
    expect(prompt).toContain("Tairn (dragon): massive, midnight black, tail spikes");
  });
});
