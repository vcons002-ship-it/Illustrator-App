import { describe, expect, it } from "vitest";
import { formatFileSize, rankLocalFiles } from "./local-files.js";

const files = [
  { path: "/home/u/Documents/Frankenstein.epub", name: "Frankenstein.epub" },
  { path: "/home/u/Downloads/a-study-of-frankenstein-and-gothic.pdf", name: "a-study-of-frankenstein-and-gothic.pdf" },
  { path: "/home/u/Desktop/notes.txt", name: "notes.txt" },
  { path: "/home/u/Documents/Frankenstein (annotated edition).epub", name: "Frankenstein (annotated edition).epub" },
];

describe("rankLocalFiles", () => {
  it("keeps only files whose name contains every token, ranking exact stems first", () => {
    const ranked = rankLocalFiles("frankenstein", files);
    expect(ranked.map((f) => f.name)).toEqual([
      "Frankenstein.epub", // exact stem
      "Frankenstein (annotated edition).epub", // leading match, longer
      "a-study-of-frankenstein-and-gothic.pdf", // match buried mid-name
    ]);
    expect(ranked.find((f) => f.name === "notes.txt")).toBeUndefined();
  });

  it("requires ALL tokens (AND), order-independent", () => {
    expect(rankLocalFiles("gothic frankenstein", files).map((f) => f.name)).toEqual([
      "a-study-of-frankenstein-and-gothic.pdf",
    ]);
    expect(rankLocalFiles("annotated frankenstein", files).map((f) => f.name)).toEqual([
      "Frankenstein (annotated edition).epub",
    ]);
  });

  it("returns nothing for an empty query or no matches", () => {
    expect(rankLocalFiles("", files)).toEqual([]);
    expect(rankLocalFiles("   ", files)).toEqual([]);
    expect(rankLocalFiles("dune", files)).toEqual([]);
  });

  it("respects the result limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ path: `/x/book-${i}.epub`, name: `book-${i}.epub` }));
    expect(rankLocalFiles("book", many, 5)).toHaveLength(5);
  });
});

describe("formatFileSize", () => {
  it("formats bytes, KB, and MB; blank for unknown", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(3_500_000)).toBe("3.3 MB");
    expect(formatFileSize(0)).toBe("");
    expect(formatFileSize(-1)).toBe("");
  });
});
