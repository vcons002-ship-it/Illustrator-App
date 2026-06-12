import { describe, expect, it } from "vitest";
import {
  bestParagraphIndex,
  conceptIntroductions,
  segmentByTerms,
  subjectFromCaption,
} from "./technical-support.js";

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
