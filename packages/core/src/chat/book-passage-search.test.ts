import { describe, expect, it } from "vitest";
import { searchBookPassages } from "./book-passage-search.js";

const chapters = [
  { index: 0, title: "Arrival", text: "The harbour was grey.\n\nViolet stepped onto the dock at dawn." },
  {
    index: 1,
    title: "The Spire",
    text: "They climbed the black spire.\n\nA dragon named Tairn waited at the summit, vast and dark.",
  },
  { index: 2, title: "Apples", text: "She ate a red apple by the fire. The apple was sweet." },
];

describe("searchBookPassages", () => {
  it("ranks paragraphs by distinct-term coverage then frequency", () => {
    const hits = searchBookPassages(chapters, "Tairn dragon");
    expect(hits[0]!.chapterIndex).toBe(1);
    expect(hits[0]!.chapterTitle).toBe("The Spire");
    expect(hits[0]!.text).toContain("Tairn");

    // "apple" appears twice in one paragraph → that paragraph wins for the query.
    const apples = searchBookPassages(chapters, "apple");
    expect(apples[0]!.chapterIndex).toBe(2);
    expect(apples[0]!.text).toContain("apple");
  });

  it("returns nothing for stopword-only / too-short queries and for no match", () => {
    expect(searchBookPassages(chapters, "the and a")).toEqual([]);
    expect(searchBookPassages(chapters, "submarine")).toEqual([]);
  });

  it("caps the number of passages and the length of each", () => {
    const many = [{ index: 0, text: Array.from({ length: 10 }, () => "apple here.").join("\n\n") }];
    expect(searchBookPassages(many, "apple", 3)).toHaveLength(3);
    const long = [{ index: 0, text: `apple ${"x".repeat(2000)}` }];
    expect(searchBookPassages(long, "apple", 1, 700)[0]!.text.length).toBe(700);
  });
});
