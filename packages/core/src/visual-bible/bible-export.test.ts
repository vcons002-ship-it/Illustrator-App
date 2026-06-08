import { describe, it, expect } from "vitest";
import { exportBible, parseImportedBible } from "./bible-export.js";
import { BIBLE_VERSION, createEmptyBible } from "./bible.js";
import { mergeExtraction } from "../providers/llm/extraction.js";

function sampleBible() {
  let b = createEmptyBible("book-1");
  b = mergeExtraction(
    b,
    {
      characters: [
        { name: "Violet Sorrengail", aliases: ["Violet"], appearance: { hair: "silver" }, persistentTraits: [], clothing: [], outfits: [{ label: "flight leathers", description: "black hide", context: "flying" }] },
      ],
      environments: [{ name: "The Spire", description: ["black basalt"] }],
      creatures: [{ name: "Tairn", aliases: [], kind: "dragon", description: ["massive", "black"] }],
      glossary: [{ term: "riders", definition: "wear flight leathers" }],
      spoilers: [{ label: "the rebellion", revealHint: "late" }],
      summary: "Ch0",
      keyMoment: "A duel",
      location: "The Spire",
      locationChange: "",
    },
    0,
  );
  return b;
}

describe("exportBible / parseImportedBible", () => {
  it("round-trips through export → import to an equivalent bible", () => {
    const bible = sampleBible();
    const json = exportBible(bible);
    const { bible: back, error } = parseImportedBible(json, "book-1");
    expect(error).toBeUndefined();
    expect(back!.characters.map((c) => c.name)).toEqual(["Violet Sorrengail"]);
    expect(back!.creatures.map((c) => c.name)).toEqual(["Tairn"]);
    expect(back!.environments[0]!.description).toContain("black basalt");
    expect(back!.glossary[0]!.term).toBe("riders");
    expect(back!.storyboard[0]!.keyMoment).toBe("A duel");
    expect(back!.version).toBe(BIBLE_VERSION);
  });

  it("rejects a mismatched schema version", () => {
    const json = JSON.stringify({ _exportMeta: { schemaVersion: 1 }, data: { schemaVersion: 1, characters: [] } });
    const { bible, error } = parseImportedBible(json, "book-1");
    expect(bible).toBeUndefined();
    expect(error).toMatch(/v1/);
  });

  it("dedupes characters and generates seeds on import", () => {
    const json = JSON.stringify({
      _exportMeta: { schemaVersion: BIBLE_VERSION },
      data: {
        schemaVersion: BIBLE_VERSION,
        characters: [
          { name: "Violet" },
          { name: "Violet Sorrengail" },
        ],
        environments: [
          { name: "Hall", description: ["a"] },
          { name: "hall", description: ["b"] },
        ],
      },
    });
    const { bible } = parseImportedBible(json, "book-9");
    expect(bible!.characters).toHaveLength(1); // Violet folded into Violet Sorrengail
    expect(bible!.characters[0]!.anchor.seed).toBeGreaterThan(0); // seeded
    expect(bible!.environments).toHaveLength(1); // deduped by name
    expect(bible!.environments[0]!.description).toEqual(["a", "b"]); // accumulated
    expect(bible!.bookId).toBe("book-9"); // keyed to the target book
  });

  it("accepts a bare data object (no _exportMeta wrapper)", () => {
    const json = JSON.stringify({ schemaVersion: BIBLE_VERSION, characters: [{ name: "Ana" }] });
    const { bible, error } = parseImportedBible(json, "b");
    expect(error).toBeUndefined();
    expect(bible!.characters[0]!.name).toBe("Ana");
  });
});
