import { describe, expect, it } from "vitest";
import {
  MAX_STRIPPED_UNITS,
  isIdentityRecital,
  splitSentences,
  stripIdentityRecital,
  type IdentityContext,
} from "./thinking-display.js";

const identity: IdentityContext = {
  names: ["Sage", "Alex"],
  notes: [
    "Warm, dry wit; silver hair; wears a long coat",
    "I'm drawn to problems where the obvious answer is wrong",
    "The reader is a keen gardener and dislikes spoilers",
  ],
};

describe("splitSentences", () => {
  it("re-joins into exactly the original text", () => {
    const text = "One thing.  Then another!\n\nAnd a third? Yes.";
    expect(splitSentences(text).join("")).toBe(text);
  });

  it("splits on terminators and newlines", () => {
    expect(splitSentences("A. B\nC").map((s) => s.trim())).toEqual(["A.", "B", "C"]);
  });

  it("leaves a decimal or an abbreviation mid-sentence alone (no space after the dot)", () => {
    expect(splitSentences("It costs 3.50 today.").map((s) => s.trim())).toEqual(["It costs 3.50 today."]);
  });
});

describe("spotting the identity recital", () => {
  it("catches a verbatim quote of a note", () => {
    expect(isIdentityRecital("I'm drawn to problems where the obvious answer is wrong.", identity)).toBe(true);
  });

  it("catches a paraphrase built mostly out of the identity's own words", () => {
    expect(isIdentityRecital("I'm Sage: warm, dry wit, silver hair, long coat.", identity)).toBe(true);
  });

  it("catches a sentence that NAMES the blocks, even sharing no vocabulary with them", () => {
    expect(isIdentityRecital("Per my identity notes, I should keep this brisk.", identity)).toBe(true);
  });

  it("leaves ordinary reasoning alone", () => {
    expect(isIdentityRecital("The user wants the marsh survey filtered by date.", identity)).toBe(false);
    expect(isIdentityRecital("I should check whether the file already has that column.", identity)).toBe(false);
  });

  it("doesn't judge a short sentence by overlap alone", () => {
    // Two meaningful words, both in the corpus — too little to be sure, so it's kept.
    expect(isIdentityRecital("Wit matters.", identity)).toBe(false);
  });
});

describe("stripping the recital off displayed reasoning", () => {
  it("removes the opening recital and keeps the actual thought", () => {
    const thinking =
      "I'm Sage: warm, dry wit, silver hair, long coat. The reader is a keen gardener and dislikes spoilers. " +
      "Now, they want the marsh survey filtered to the last two years, so I need to read the sheet first.";
    expect(stripIdentityRecital(thinking, identity)).toBe(
      "Now, they want the marsh survey filtered to the last two years, so I need to read the sheet first.",
    );
  });

  it("only ever removes a PREFIX — identity recalled mid-thought stays", () => {
    const thinking =
      "They want a warmer tone in this email. I'm Sage: warm, dry wit, silver hair, long coat. So I'll soften it.";
    expect(stripIdentityRecital(thinking, identity)).toBe(thinking);
  });

  it("returns nothing when the whole block was recital — an empty bubble is hidden", () => {
    const thinking = "I'm Sage: warm, dry wit, silver hair, long coat. The reader is a keen gardener.";
    expect(stripIdentityRecital(thinking, identity)).toBe("");
  });

  it("gives up rather than eating a long block that all reads as recital", () => {
    const line = "I'm Sage: warm, dry wit, silver hair, long coat. ";
    const thinking = line.repeat(MAX_STRIPPED_UNITS + 1) + "And now the actual point.";
    // Past the limit the test isn't trusted — the reasoning is shown exactly as it came.
    expect(stripIdentityRecital(thinking, identity)).toBe(thinking);
  });

  it("does nothing at all when there's no identity to match against", () => {
    const thinking = "I'm Sage: warm, dry wit, silver hair, long coat. Then the real thought.";
    expect(stripIdentityRecital(thinking, { notes: [], names: [] })).toBe(thinking);
  });

  it("leaves reasoning that never recites completely untouched", () => {
    const thinking = "They asked for the survey by date.\nI'll read the sheet, then filter it.";
    expect(stripIdentityRecital(thinking, identity)).toBe(thinking);
  });

  it("passes empty/whitespace through", () => {
    expect(stripIdentityRecital("", identity)).toBe("");
    expect(stripIdentityRecital("   ", identity)).toBe("   ");
  });
});
