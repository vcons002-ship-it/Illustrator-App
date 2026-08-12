import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_REQUESTED_RENDERS, requestedRenderCount, requestedRendersNote } from "./render-count.js";

/**
 * "Generate 3 images of yourself" came back as one picture, with no checklist, across three separate
 * prompt fixes. The rule that says several images means a checklist was present and correct every
 * time; it simply lost to whichever neighbouring rule the model reached first. This counts instead.
 */
describe("counting the pictures a message asks for", () => {
  it("reads the number in front of the picture word", () => {
    for (const [text, n] of [
      ["generate 3 images of yourself", 3],
      ["make me five pictures of a dragon", 5],
      ["draw 4 portraits in different styles", 4],
      ["I'd like two illustrations for this chapter", 2],
      ["give me 6 photos of a rainy street", 6],
    ] as const) {
      expect(requestedRenderCount(text), text).toBe(n);
    }
  });

  it("tolerates a word between the count and the noun", () => {
    // "3 different images", "three quick sketches of…" — the count still attaches to the picture.
    expect(requestedRenderCount("generate 3 different images of yourself")).toBe(3);
  });

  it("does not count the SUBJECT of a single picture", () => {
    // The failure that would cost the reader real GPU time: one picture containing three cats is
    // not three pictures. The noun after the number is what settles it.
    expect(requestedRenderCount("draw a picture of 3 cats")).toBeUndefined();
    expect(requestedRenderCount("an illustration of five knights on a hill")).toBeUndefined();
  });

  it("says nothing for one picture, which needs no checklist", () => {
    expect(requestedRenderCount("draw me a dragon")).toBeUndefined();
    expect(requestedRenderCount("generate 1 image of a fox")).toBeUndefined();
  });

  it("ignores a count too large to be meant, rather than running it", () => {
    // A bound on what an accident costs, not a technical limit. Past it the model decides, and it
    // will ask.
    expect(requestedRenderCount(`generate ${MAX_REQUESTED_RENDERS} images`)).toBe(MAX_REQUESTED_RENDERS);
    expect(requestedRenderCount(`generate ${MAX_REQUESTED_RENDERS + 1} images`)).toBeUndefined();
    expect(requestedRenderCount("generate 100 images of a cat")).toBeUndefined();
  });

  it("is not fooled by a number elsewhere in the sentence", () => {
    expect(requestedRenderCount("draw the scene from chapter 3")).toBeUndefined();
    expect(requestedRenderCount("make an image at 4k")).toBeUndefined();
  });
});

describe("the note that rides the turn", () => {
  it("names the count and asks for that many steps", () => {
    const note = requestedRendersNote("generate 3 images of yourself", false);
    expect(note).toContain("3 SEPARATE PICTURES");
    expect(note).toMatch(/call set_plan with 3 steps/);
  });

  it("says why rendering first loses the rest", () => {
    // The mechanism, not an instruction to obey: a render suspends the turn, so a picture drawn
    // before the plan exists takes the plan with it.
    expect(requestedRendersNote("draw 4 pictures of a fox", false)).toMatch(/a render ends this turn/);
  });

  it("goes quiet once a checklist is running", () => {
    // The plan IS the instruction by then. A second voice telling it to plan is how a model calls
    // set_plan again mid-run and starts the whole thing over.
    expect(requestedRendersNote("generate 3 images of yourself", true)).toBe("");
  });

  it("stays silent on an ordinary request", () => {
    expect(requestedRendersNote("draw me a dragon", false)).toBe("");
    expect(requestedRendersNote("what's the capital of France?", false)).toBe("");
  });
});

/**
 * THE WIRING, WHICH IS THE HALF THAT HAS FAILED BEFORE.
 *
 * This migration's recurring failure is a correct thing that nothing reaches: rules defined and
 * never worn, a handler that ran while no element carried its class. A counter nobody calls would
 * be the same story, and the suite would be green.
 */
describe("the count actually reaches the turn", () => {
  const worker = readFileSync(join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "engine.worker.ts"), "utf8");

  it("is computed from THIS turn's message", () => {
    expect(worker).toMatch(/const rendersBlock = requestedRendersNote\(msg\.userText \?\? "", !!msg\.plan\)/);
  });

  it("rides the volatile block, so it is never stored", () => {
    // Persisting it would replay "the reader asked for 3 pictures" on every later turn — the exact
    // failure `stripPersistedDirectives` exists to undo, and one this app has already had once.
    const line = /const volatile = \[([^\]]*)\]/.exec(worker)?.[1] ?? "";
    expect(line, "the volatile assembly moved").toBeTruthy();
    expect(line, "the note is not in the volatile block").toContain("rendersBlock");
  });
});
