import { describe, it, expect } from "vitest";
import type { Page } from "../types/book.js";
import type { SpoilerEntity } from "../types/bible.js";
import {
  BLOOM_EASE,
  READ_THRESHOLD,
  SPOILER_FREE_REVEAL_POINT,
  computeBloomTarget,
  latestSpoilerParagraphIndex,
  paragraphIndexFromId,
  spoilerRevealPoint,
} from "./reveal.js";

function page(texts: string[]): Page {
  return {
    id: "pg-0",
    index: 0,
    chapterId: "ch-0",
    paragraphs: texts.map((text, index) => ({ id: `pg-0-${index}`, index, text })),
  };
}

const spoilers: SpoilerEntity[] = [
  { id: "s1", label: "the duke is the killer", revealParagraphId: "ignored" },
];

describe("paragraphIndexFromId", () => {
  it("parses the within-page index", () => {
    expect(paragraphIndexFromId("pg-7-3")).toBe(3);
    expect(paragraphIndexFromId("pg-0-0")).toBe(0);
  });
  it("returns undefined for missing/malformed ids", () => {
    expect(paragraphIndexFromId(undefined)).toBeUndefined();
    expect(paragraphIndexFromId("nope")).toBeUndefined();
  });
});

describe("latestSpoilerParagraphIndex", () => {
  it("returns the latest paragraph containing a depicted spoiler label", () => {
    const p = page(["calm open", "the Duke is the killer, gasped Anna", "aftermath"]);
    expect(latestSpoilerParagraphIndex(p, ["s1"], spoilers)).toBe(1);
  });
  it("takes the latest when the label appears more than once", () => {
    const p = page(["the duke is the killer", "x", "the duke is the killer again"]);
    expect(latestSpoilerParagraphIndex(p, ["s1"], spoilers)).toBe(2);
  });
  it("undefined when no spoilers are depicted", () => {
    expect(latestSpoilerParagraphIndex(page(["a", "b"]), [], spoilers)).toBeUndefined();
  });
  it("undefined when the depicted label is not found in the page text", () => {
    expect(latestSpoilerParagraphIndex(page(["nothing here"]), ["s1"], spoilers)).toBeUndefined();
  });
});

describe("spoilerRevealPoint", () => {
  it("uses the small default when no spoiler is depicted", () => {
    expect(spoilerRevealPoint(undefined, false, 4)).toBe(SPOILER_FREE_REVEAL_POINT);
  });
  it("fails safe to 1 when a spoiler is depicted but not located", () => {
    expect(spoilerRevealPoint(undefined, true, 4)).toBe(1);
  });
  it("is early for an early spoiler and late for a late spoiler", () => {
    expect(spoilerRevealPoint(0, true, 4)).toBeCloseTo(0.25);
    expect(spoilerRevealPoint(3, true, 4)).toBeCloseTo(1);
  });
});

describe("computeBloomTarget", () => {
  const eased = (linear: number) => Math.pow(linear, BLOOM_EASE);

  it("keeps images hidden on a fast scroll (low progress)", () => {
    // No spoiler, barely onto the page → still mostly hidden.
    expect(computeBloomTarget(0.05, SPOILER_FREE_REVEAL_POINT, false)).toBeLessThan(0.1);
  });
  it("fully reveals a spoiler-free image by the read threshold", () => {
    expect(computeBloomTarget(READ_THRESHOLD, SPOILER_FREE_REVEAL_POINT, false)).toBeCloseTo(1);
    expect(computeBloomTarget(1, SPOILER_FREE_REVEAL_POINT, false)).toBeCloseTo(1);
  });
  it("adds little delay for an early spoiler", () => {
    // revealPoint 0.25 < READ_THRESHOLD, so divisor = 0.5; same as a normal page.
    expect(computeBloomTarget(0.5, 0.25, true)).toBeCloseTo(1);
  });
  it("holds a late spoiler hidden until the reader reaches it", () => {
    // revealPoint 1.0 → divisor 1.0.
    expect(computeBloomTarget(0.5, 1, true)).toBeCloseTo(eased(0.5));
    expect(computeBloomTarget(0.5, 1, true)).toBeLessThan(0.5);
    expect(computeBloomTarget(1, 1, true)).toBeCloseTo(1);
  });
  it("late spoiler + fast scroll stays hidden", () => {
    expect(computeBloomTarget(0.15, 1, true)).toBeLessThan(0.1);
  });
  it("clamps out-of-range progress", () => {
    expect(computeBloomTarget(-1, 0.5, false)).toBe(0);
    expect(computeBloomTarget(5, 1, true)).toBeCloseTo(1);
  });
});
