import { describe, expect, it } from "vitest";
import {
  anchorByParagraph,
  bestParagraphIndex,
  conceptIntroductions,
  segmentByTerms,
  subjectFromCaption,
} from "./technical-support.js";

describe("anchorByParagraph", () => {
  const anchorPages = [
    { chapterIndex: 0, paragraphs: [{ text: "Intro about cells." }, { text: "The Krebs cycle releases energy." }] },
    { chapterIndex: 1, paragraphs: [{ text: "Photosynthesis happens in chloroplasts." }] },
  ];
  it("anchors each item to the best paragraph within its OWN chapter, keyed by global page index", () => {
    const items = [
      { chapterIndex: 0, anchor: "Krebs cycle energy" },
      { chapterIndex: 1, anchor: "photosynthesis chloroplast" },
    ];
    const map = anchorByParagraph(anchorPages, items, (i) => i.chapterIndex, (i) => i.anchor);
    expect(map.get(0)).toEqual([{ paragraphIndex: 1, item: items[0] }]);
    expect(map.get(1)).toEqual([{ paragraphIndex: 0, item: items[1] }]);
  });
  it("skips items whose chapter has no pages", () => {
    const map = anchorByParagraph(anchorPages, [{ chapterIndex: 9, anchor: "x" }], (i) => i.chapterIndex, (i) => i.anchor);
    expect(map.size).toBe(0);
  });
});

const pages = [
  {
    paragraphs: [
      { text: "Cells need energy to function." },
      { text: "The Krebs cycle produces ATP inside the mitochondrion." },
    ],
  },
  {
    paragraphs: [
      { text: "The Krebs cycle appears again here." },
      { text: "Electron transport chains finish the job." },
    ],
  },
];

describe("conceptIntroductions", () => {
  const glossary = [
    { term: "Krebs cycle", definition: "How cells turn fuel into usable energy, step by step." },
    { term: "ATP", definition: "The cell's energy currency." },
    { term: "electron transport chain", definition: "The final stage of respiration." },
    { term: "References (chapter 1)", definition: "https://example.org" }, // citation, not a concept
    { term: "unmentioned thing", definition: "never appears" },
  ];

  it("places each concept at its FIRST appearance only", () => {
    const intros = conceptIntroductions(pages, glossary);
    const page0 = intros.get(0)!;
    expect(page0.map((c) => c.term)).toEqual(["Krebs cycle", "ATP"]);
    expect(page0[0]!.paragraphIndex).toBe(1);
    // Page 1 repeats "Krebs cycle" — no second card; only the chain intro shows.
    expect(intros.get(1)!.map((c) => c.term)).toEqual(["electron transport chain"]);
    expect(intros.get(1)![0]!.paragraphIndex).toBe(1);
  });

  it("skips citations, empty definitions, and whole-word mismatches", () => {
    const intros = conceptIntroductions(pages, [
      ...glossary,
      { term: "ell", definition: "substring of 'Cells' — must NOT match" },
      { term: "energy", definition: "" }, // no definition → nothing to show
    ]);
    const all = [...intros.values()].flat().map((c) => c.term);
    expect(all).not.toContain("References (chapter 1)");
    expect(all).not.toContain("ell");
    expect(all).not.toContain("energy");
    expect(all).not.toContain("unmentioned thing");
  });

  it("matches multi-word concepts case-insensitively", () => {
    const intros = conceptIntroductions(pages, [
      { term: "ELECTRON TRANSPORT CHAIN", definition: "d" },
    ]);
    expect(intros.get(1)![0]).toMatchObject({ paragraphIndex: 1 });
  });
});

describe("bestParagraphIndex", () => {
  const paragraphs = pages[0]!.paragraphs.map((p) => p.text);

  it("anchors a figure to the paragraph sharing its subject's words", () => {
    expect(bestParagraphIndex(paragraphs, "the Krebs cycle diagram")).toBe(1);
    expect(bestParagraphIndex(paragraphs, "cells and energy")).toBe(0);
  });

  it("falls back to the top when nothing matches", () => {
    expect(bestParagraphIndex(paragraphs, "quantum chromodynamics")).toBe(0);
    expect(bestParagraphIndex(paragraphs, "")).toBe(0);
  });
});

describe("segmentByTerms", () => {
  it("marks whole-word term occurrences, longest term first, preserving case", () => {
    const segs = segmentByTerms("The Krebs cycle produces ATP.", ["cycle", "Krebs cycle", "ATP"]);
    expect(segs).toEqual([
      { text: "The " },
      { text: "Krebs cycle", term: "Krebs cycle" },
      { text: " produces " },
      { text: "ATP", term: "ATP" },
      { text: "." },
    ]);
  });

  it("never matches inside words and passes through unmatched text", () => {
    expect(segmentByTerms("Scattered catscan results.", ["cat"])).toEqual([
      { text: "Scattered catscan results." },
    ]);
    expect(segmentByTerms("plain", [])).toEqual([{ text: "plain" }]);
  });
});

describe("subjectFromCaption", () => {
  it("recovers the concept from captions and skip notes (curly or straight quotes)", () => {
    expect(subjectFromCaption("Retrieved figure for “the Krebs cycle”\n\nSource: x")).toBe(
      "the Krebs cycle",
    );
    expect(subjectFromCaption('No verified figure found for "ATP synthase" — …')).toBe(
      "ATP synthase",
    );
    expect(subjectFromCaption("no quotes here")).toBeUndefined();
  });
});
