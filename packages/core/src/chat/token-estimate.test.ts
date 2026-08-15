import { describe, expect, it } from "vitest";
import { charsPerToken, estimateTokens } from "./token-estimate.js";

/**
 * THE RULER REPORTED 4.00 CHARS/TOKEN FOR EVERY FORMAT EVER WRITTEN.
 *
 * The always-on budget was policed by `Math.round(s.length / 4)`. That is roughly right for English
 * prose and wrong for everything else, and the error runs in BOTH directions at once: measured
 * against o200k, this repo's prose is ~4.76 chars/token (over-counted ~19%) while mermaid is ~3.26
 * and XML ~3.42 (under-counted 15-19%).
 *
 * The consequence was specific and was nearly acted on: a structured rewrite of the routing rules
 * could have shown a large saving against the budget assertion while costing MORE real tokens on
 * every provider — a 36-point swing invented entirely by the measuring instrument. Every format
 * decision was unmeasurable until this was fixed.
 */
describe("estimating tokens rather than dividing by four", () => {
  const PROSE =
    "The reader asked for a picture of a dragon soaring over a neon city skyline at night, and we " +
    "should simply make it rather than describing what we would make.";
  const JSON_ISH = '{"tool":"generate_image","prompt":"a dragon over a neon city","style":"watercolor"}';
  const XML = "<rule><when>reader asks for a picture</when><then>call generate_image</then></rule>";
  const MERMAID = "graph TD\n  A[start] -->|yes| B{multi?}\n  B -->|yes| C[set_plan]\n  B -->|no| D[go]";

  it("charges prose LESS per character than punctuation-dense formats", () => {
    // The single property `chars/4` lacked, and the whole reason this file exists.
    expect(charsPerToken(PROSE)).toBeGreaterThan(charsPerToken(JSON_ISH));
    expect(charsPerToken(PROSE)).toBeGreaterThan(charsPerToken(XML));
    expect(charsPerToken(PROSE)).toBeGreaterThan(charsPerToken(MERMAID));
  });

  it("puts prose in the right absolute band, near the measured 4.76", () => {
    // Not a claim of tokenizer accuracy — a claim that the number is usable for comparing drafts.
    expect(charsPerToken(PROSE)).toBeGreaterThan(4.2);
    expect(charsPerToken(PROSE)).toBeLessThan(5.4);
  });

  it("puts the structured formats in theirs, near the measured 3.3-3.5", () => {
    // XML with realistic word content lands at 3.46 against a measured 3.42. The JSON sample above is
    // deliberately NOT asserted into this band: its values are long quoted phrases, so it reads at
    // 4.15 — a reminder that "the format" is not a density, the actual text is.
    expect(charsPerToken(XML)).toBeGreaterThan(2.8);
    expect(charsPerToken(XML)).toBeLessThan(4.0);
    // Structured syntax with SHORT content is where the cost really shows.
    expect(charsPerToken("<r><w>picture</w><t>generate_image</t></r>")).toBeLessThan(2.6);
  });

  it("ranks the formats the way the measurements do", () => {
    // The ordering is the usable output. Absolute numbers shift with the tokenizer; this does not.
    const dense = "<r><w>picture</w><t>generate_image</t></r>";
    expect(charsPerToken(PROSE)).toBeGreaterThan(charsPerToken(JSON_ISH));
    expect(charsPerToken(JSON_ISH)).toBeGreaterThan(charsPerToken(XML));
    expect(charsPerToken(XML)).toBeGreaterThan(charsPerToken(dense));
  });

  it("would have caught the trap: fewer characters, MORE tokens", () => {
    // The bug, stated as a test. Identical information in two formats: the XML is shorter in
    // characters, so `chars/4` scores it cheaper and a rewrite would have looked like a saving. In
    // real tokens it costs more. That inversion is what made every format decision unmeasurable.
    const asProse = "When the reader asks for a picture, call generate_image.";
    const asXml = "<r><w>picture</w><t>generate_image</t></r>";
    expect(asXml.length, "the XML is not shorter, so the trap is not reproduced").toBeLessThan(asProse.length);
    expect(
      Math.round(asXml.length / 4),
      "chars/4 does not prefer the XML here, so there is no trap to catch",
    ).toBeLessThan(Math.round(asProse.length / 4));
    expect(
      estimateTokens(asXml),
      "the estimator still believes fewer characters means fewer tokens",
    ).toBeGreaterThan(estimateTokens(asProse));
  });

  it("counts an indent as about one token, not one per space", () => {
    // Charging per character for whitespace was this estimator's own version of the bias it exists
    // to remove — it over-charged indented formats by roughly half.
    const flat = "alpha beta gamma";
    const indented = "alpha\n        beta\n        gamma";
    expect(estimateTokens(indented)).toBeLessThan(estimateTokens(flat) + 6);
  });

  it("handles the degenerate inputs a prompt assembler actually produces", () => {
    expect(estimateTokens("")).toBe(0);
    expect(charsPerToken("")).toBe(0);
    expect(estimateTokens(" ")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
  });

  it("is monotonic — more text is never fewer tokens", () => {
    // A budget assertion built on a non-monotonic measure could be passed by ADDING text.
    let prev = 0;
    for (const n of [1, 10, 100, 1000]) {
      const t = estimateTokens("the quick brown fox jumps over the lazy dog. ".repeat(n));
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it("is deterministic, because a flaky ruler is worse than a biased one", () => {
    expect(estimateTokens(PROSE)).toBe(estimateTokens(PROSE));
  });

  it("does not split contractions at the apostrophe", () => {
    // "don't" is two pre-tokens, not three — the pattern that gets this wrong inflates every prose
    // measurement it touches.
    expect(estimateTokens("don't")).toBeLessThanOrEqual(2);
  });
});

/**
 * THE WIRING. A better ruler nothing measures with is the same as no ruler.
 */
describe("the budget is policed with it", () => {
  it("the always-on assertion uses the estimator, not chars/4", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "toolsets.test.ts"), "utf8");
    expect(src, "the budget test still divides by four").not.toMatch(/const tok = \(s: string\) => Math\.round/);
    expect(src).toMatch(/const tok = estimateTokens;/);
  });
});
