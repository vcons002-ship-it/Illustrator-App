import { describe, expect, it } from "vitest";
import { isSelfPortraitRequest, isUserPortraitRequest, portraitSubjects } from "./souls.js";

const names = { selfName: "Aria", userName: "Nick" };
const selfOnly = { self: true, user: false };
const userOnly = { self: false, user: true };
const both = { self: true, user: true };

describe("portrait subjects follow the reader before the model's rewrite", () => {
  it.each([
    ["draw yourself", "a portrait of you and me under the stars", selfOnly],
    ["draw me", "a portrait of you and me under the stars", userOnly],
    ["make an image of the assistant", "a portrait of Nick", selfOnly],
    ["make an image of the AI assistant", "a portrait of Nick", selfOnly],
    ["Aria, draw me", "a portrait of Aria and Nick", userOnly],
    ["Hey Aria, please make a picture of me", "you and me", userOnly],
    ["Draw yourself, not Nick", "Nick and Aria on a beach", selfOnly],
    ["Draw Nick, not Aria", "you and me", userOnly],
    ["Draw yourself without Nick", "Nick and Aria on a beach", selfOnly],
    ["Draw me rather than Aria", "you and me", userOnly],
    ["Draw yourself instead of me", "you and me", selfOnly],
    ["Nick would like an image of yourself", "Nick and Aria on a beach", selfOnly],
    ["Make a portrait of yourself for Nick", "Nick and Aria on a beach", selfOnly],
  ])("%s ignores conflicting model subjects", (userText, modelPrompt, expected) => {
    expect(portraitSubjects({ userText, modelPrompt, ...names })).toEqual(expected);
  });

  it.each([
    "draw you and me on a beach",
    "draw yourself and me on a beach",
    "draw the AI assistant and me together",
    "draw me and the assistant together",
    "draw the two of us in a garden",
    "a picture of Aria and Nick",
    "draw Nick and Aria together",
    "Aria, draw you and me together",
  ])("retains a real pair: %s", (userText) => {
    expect(portraitSubjects({ userText, modelPrompt: "one figure in a garden", ...names })).toEqual(both);
  });

  it("still uses a model-resolved subject for an implicit follow-up", () => {
    expect(portraitSubjects({ userText: "make one", modelPrompt: "a portrait of Nick", ...names })).toEqual(userOnly);
    expect(portraitSubjects({ userText: "make another", modelPrompt: "Aria and Nick together", ...names })).toEqual(both);
  });

  it("supports identifying the reader's subjects without a model prompt", () => {
    expect(portraitSubjects({ userText: "draw yourself", modelPrompt: "", ...names })).toEqual(selfOnly);
    expect(portraitSubjects({ userText: "draw me a castle", modelPrompt: "", ...names })).toEqual({ self: false, user: false });
  });

  it("keeps named depictions while excluding direct addresses and negated names", () => {
    expect(isSelfPortraitRequest("Aria, standing by the sea", "Aria")).toBe(true);
    expect(isSelfPortraitRequest("Aria, draw me", "Aria")).toBe(false);
    expect(isUserPortraitRequest("draw yourself, not Nick", "Nick")).toBe(false);
    expect(isSelfPortraitRequest("draw the AI assistant", "Aria")).toBe(true);
  });
});
