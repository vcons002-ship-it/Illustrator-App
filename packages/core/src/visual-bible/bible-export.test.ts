import { describe, it, expect } from "vitest";
import { carryReferenceImages, exportBible, parseImportedBible } from "./bible-export.js";
import { BIBLE_VERSION, createEmptyBible, migrateBible } from "./bible.js";
import { mergeExtraction } from "../providers/llm/extraction.js";
import { referenceIdsOf } from "../types/bible.js";

function sampleBible() {
  let b = createEmptyBible("book-1");
  b = mergeExtraction(
    b,
    {
      characters: [
        { name: "Violet Sorrengail", aliases: ["Violet"], appearance: { hair: "silver" }, persistentTraits: [], clothing: [], outfits: [{ label: "flight leathers", description: "black hide" }] },
      ],
      environments: [{ name: "The Spire", description: ["black basalt"] }],
      creatures: [{ name: "Tairn", aliases: [], kind: "dragon", description: ["massive", "black"] }],
      glossary: [{ term: "riders", definition: "wear flight leathers" }],
      spoilers: [{ label: "the rebellion" }],
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

  it("strips device-local reference-image ids from the export", () => {
    const bible = sampleBible();
    bible.characters[0]!.anchor.referenceImageIds = ["book-1:charref:char-violet-sorrengail:0"];
    const exported = JSON.parse(exportBible(bible)) as {
      data: { characters: { anchor: Record<string, unknown> }[] };
    };
    // The ids key into THIS device's store; the bytes don't travel with the file.
    expect(exported.data.characters[0]!.anchor.referenceImageIds).toBeUndefined();
    expect(exported.data.characters[0]!.anchor.referenceImageId).toBeUndefined();
    expect(exported.data.characters[0]!.anchor.seed).toBeDefined(); // seed still travels
  });

  it("carryReferenceImages re-attaches stored uploads to imported characters by name/alias", () => {
    const prev = sampleBible();
    prev.characters[0]!.anchor.referenceImageIds = ["book-1:charref:char-violet-sorrengail:0"];
    // The imported file names her differently (an alias) and carries no refs.
    const next = parseImportedBible(
      JSON.stringify({
        _exportMeta: { schemaVersion: BIBLE_VERSION },
        data: { schemaVersion: BIBLE_VERSION, characters: [{ name: "Violet" }, { name: "Dain" }] },
      }),
      "book-1",
    ).bible!;
    const out = carryReferenceImages(prev, next);
    const violet = out.characters.find((c) => /violet/i.test(c.name))!;
    expect(referenceIdsOf(violet.anchor)).toEqual(["book-1:charref:char-violet-sorrengail:0"]);
    const dain = out.characters.find((c) => c.name === "Dain")!;
    expect(referenceIdsOf(dain.anchor)).toEqual([]); // no prior upload → untouched
  });

  it("imports storyboard keyEvents (Layer-1 prompts) from an external AI", () => {
    const json = JSON.stringify({
      _exportMeta: { schemaVersion: BIBLE_VERSION },
      data: {
        schemaVersion: BIBLE_VERSION,
        storyboard: [
          {
            chapterIndex: 0,
            keyEvents: [
              {
                pageRange: [4, 0], // out-of-order → normalized to [0, 4]
                imagePrompt: { subject: "Elena", action: "flying", environment: "", mood: "", composition: "" },
                seed: 123,
              },
            ],
          },
        ],
      },
    });
    const { bible, error } = parseImportedBible(json, "b");
    expect(error).toBeUndefined();
    const ev = bible!.storyboard[0]!.keyEvents![0]!;
    expect(ev.pageRange).toEqual([0, 4]);
    expect(ev.imagePrompt.subject).toBe("Elena");
    expect(ev.imagePrompt.environment).toBeUndefined(); // empty strings dropped
    expect(ev.seed).toBe(123);
  });
});

describe("migrateBible", () => {
  it("upgrades a v5 bible to the current version, keeping its data", () => {
    const v5 = { ...createEmptyBible("b"), version: 5 };
    v5.characters.push({
      id: "char-ana",
      name: "Ana",
      aliases: [],
      appearance: { hair: "", eyes: "", gender: "", build: "", height: "", skinTone: "", age: "", distinguishingMarks: "", notes: "" },
      persistentTraits: [],
      clothing: [],
      outfits: [],
      anchor: { seed: 1 },
      firstSeenChapter: 0,
    });
    const migrated = migrateBible(v5)!;
    expect(migrated.version).toBe(BIBLE_VERSION);
    expect(migrated.characters.map((c) => c.name)).toEqual(["Ana"]); // data preserved
  });

  it("returns the bible unchanged when already current, and undefined for ancient schemas", () => {
    const cur = createEmptyBible("b");
    expect(migrateBible(cur)).toBe(cur);
    expect(migrateBible({ ...cur, version: 3 })).toBeUndefined();
  });

  it("v6 → v7 keeps entities but clears old prompts, drops auto-refs, defaults worldStyle", () => {
    const v6 = { ...createEmptyBible("b"), version: 6 };
    v6.characters.push({
      id: "char-ana",
      name: "Ana",
      aliases: [],
      appearance: { hair: "silver", eyes: "", gender: "", build: "", height: "", skinTone: "", age: "", distinguishingMarks: "", notes: "" },
      persistentTraits: [],
      clothing: [],
      outfits: [],
      anchor: { seed: 1, referenceImageId: "b:charref:char-ana" }, // an auto-captured reference
      firstSeenChapter: 0,
    });
    v6.storyboard.push({
      chapterIndex: 0,
      summary: "s",
      keyMoment: "k",
      location: "",
      locationChange: "",
      keyEvents: [{ pageRange: [0, 0], imagePrompt: { text: "old inline-style prompt" } }],
    });

    const m = migrateBible(v6)!;
    expect(m.version).toBe(BIBLE_VERSION);
    expect(m.characters[0]!.name).toBe("Ana"); // entity kept
    expect(m.characters[0]!.appearance.hair).toBe("silver"); // appearance kept
    expect(m.characters[0]!.anchor.referenceImageId).toBeUndefined(); // auto-ref dropped
    expect(m.storyboard[0]!.keyEvents).toBeUndefined(); // old prompt cleared for rewrite
    expect(m.storyboard[0]!.summary).toBe("s"); // summary kept
    expect(m.worldStyle).toBe("");
  });
});

describe("worldStyle round-trips and carries over", () => {
  it("export → import preserves worldStyle", () => {
    const b = createEmptyBible("book-1");
    b.worldStyle = "high-fantasy military academy, dark, painterly";
    const back = parseImportedBible(exportBible(b), "book-1").bible!;
    expect(back.worldStyle).toBe("high-fantasy military academy, dark, painterly");
  });

  it("accepts a one-version-back (v6) export, clearing its prompts", () => {
    const json = JSON.stringify({
      _exportMeta: { schemaVersion: BIBLE_VERSION - 1 },
      data: {
        schemaVersion: BIBLE_VERSION - 1,
        characters: [{ name: "Ana" }],
        storyboard: [{ chapterIndex: 0, summary: "s", keyEvents: [{ pageRange: [0, 0], imagePrompt: { text: "old" } }] }],
      },
    });
    const res = parseImportedBible(json, "book-1");
    expect(res.bible).toBeDefined();
    expect(res.bible!.storyboard[0]!.keyEvents).toBeUndefined();
  });
});
