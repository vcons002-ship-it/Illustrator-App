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
});
