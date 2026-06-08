import { describe, it, expect } from "vitest";
import { mergeExtraction, promptUserContent } from "./extraction.js";
import { createEmptyBible } from "../../visual-bible/bible.js";
import type { VisualRequest } from "../../types/content.js";

describe("mergeExtraction storyboard", () => {
  it("upserts a chapter scene and re-running a chapter replaces (not duplicates) it", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      { characters: [], environments: [], spoilers: [], summary: "Ch0 happens", keyMoment: "A duel" },
      0,
    );
    expect(bible.storyboard).toEqual([{ chapterIndex: 0, summary: "Ch0 happens", keyMoment: "A duel" }]);

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
      spoilerIds: [],
    };
    const text = promptUserContent(req, bible);
    expect(text).toContain("Key moment to illustrate");
    expect(text).toContain("The duel.");
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
