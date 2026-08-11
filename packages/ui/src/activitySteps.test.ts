import { describe, expect, it } from "vitest";
import { pushActivityStep, sentStepLabel, stepCount, stepLabel, STEP_ECHO_MAX } from "./activitySteps.js";

/**
 * Reported from a run that counted to 24: a column of "✓ Working" tall enough to fill the screen,
 * every row identical, none of them saying what was worked on. One row per tool call is right for a
 * turn that does three different things and useless for a turn that does one thing twenty-six times.
 */
describe("the trace of what a turn did", () => {
  it("keeps distinct steps as distinct rows", () => {
    let steps: string[] = [];
    for (const s of ["Searching the web", "Reading a file", "Writing a file"]) steps = pushActivityStep(steps, s);
    expect(steps).toEqual(["Searching the web", "Reading a file", "Writing a file"]);
  });

  it("folds a repeat into the row above it, with a count", () => {
    let steps: string[] = [];
    for (let i = 0; i < 26; i++) steps = pushActivityStep(steps, "Working");
    expect(steps, "twenty-six identical rows survived").toEqual(["Working ×26"]);
  });

  it("counts rather than dropping, because five searches is worth knowing", () => {
    // The difference between a model working and a model stuck is exactly this number, and the trace
    // exists to show it. Silently collapsing repeats would hide the one case worth looking at.
    let steps: string[] = [];
    for (let i = 0; i < 5; i++) steps = pushActivityStep(steps, "Searching the web");
    expect(stepCount(steps[0]!)).toBe(5);
    expect(stepLabel(steps[0]!)).toBe("Searching the web");
  });

  it("only folds ADJACENT rows", () => {
    // search → read → search is three things that happened in that order. Folding the two searches
    // would claim they were one run and lose the read between them.
    let steps: string[] = [];
    for (const s of ["Searching", "Reading", "Searching"]) steps = pushActivityStep(steps, s);
    expect(steps).toEqual(["Searching", "Reading", "Searching"]);
  });

  it("keeps counting past the first fold", () => {
    let steps = pushActivityStep(pushActivityStep(["Working"], "Working"), "Working");
    expect(steps).toEqual(["Working ×3"]);
  });

  it("ignores an empty label instead of adding a blank row", () => {
    expect(pushActivityStep(["Working"], "   ")).toEqual(["Working"]);
  });

  it("never mutates what it was given", () => {
    const before = ["Working"];
    pushActivityStep(before, "Working");
    expect(before).toEqual(["Working"]);
  });

  it("reads a plain label as a count of one", () => {
    expect(stepCount("Working")).toBe(1);
    expect(stepLabel("Working")).toBe("Working");
  });
});

describe("saying what a series message actually was", () => {
  it("shows the message, which is the only fact worth showing", () => {
    expect(sentStepLabel("A")).toBe("Sent “A”");
    expect(sentStepLabel("24")).toBe("Sent “24”");
  });

  it("does not put a paragraph in a status row", () => {
    const long = "x".repeat(STEP_ECHO_MAX + 1);
    expect(sentStepLabel(long)).toBe("Sent a message");
  });

  it("flattens a message that spans lines", () => {
    expect(sentStepLabel("A\n")).toBe("Sent “A”");
  });

  it("falls back rather than showing empty quotes", () => {
    expect(sentStepLabel("   ")).toBe("Continuing");
  });

  it("keeps each message of a series on its own row", () => {
    // The point of the whole change: these must NOT fold, because they are different messages.
    let steps: string[] = [];
    for (const m of ["A", "B", "C"]) steps = pushActivityStep(steps, sentStepLabel(m));
    expect(steps).toEqual(["Sent “A”", "Sent “B”", "Sent “C”"]);
  });
});
