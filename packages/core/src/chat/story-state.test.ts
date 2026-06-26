import { describe, expect, it } from "vitest";
import {
  storyStatePromptBlock,
  synopsisRequest,
  storyOpeningRequest,
  parseStoryOpening,
  STORY_STATE_MAX_CHARS,
} from "./story-state.js";

describe("storyOpeningRequest", () => {
  it("asks for a title + opening beat as JSON, grounded in the premise and cast", () => {
    const { system, user } = storyOpeningRequest("two rivals trapped in a lighthouse", {
      characters: [{ name: "Wren", description: "lean, grey coat" }, { name: "Cass" }],
      mode: "direct",
    });
    expect(system).toMatch(/OPENING BEAT/);
    expect(system).toMatch(/"title"/);
    expect(system).toMatch(/"opening"/);
    expect(user).toContain("two rivals trapped in a lighthouse");
    expect(user).toContain("Wren (lean, grey coat)");
    expect(user).toContain("Cass");
  });

  it("adds the no-acting-for-the-reader rule + me/you mapping in roleplay", () => {
    const { system, user } = storyOpeningRequest("a heist goes wrong", {
      mode: "roleplay",
      play: { me: "Ada", you: "Vex" },
    });
    expect(system).toMatch(/do NOT act, speak, or decide/i);
    expect(user).toContain("The reader plays Ada");
    expect(user).toContain("you voice Vex");
  });
});

describe("parseStoryOpening", () => {
  it("parses a clean JSON object", () => {
    expect(parseStoryOpening('{"title":"Salt and Smoke","opening":"The lamp guttered."}')).toEqual({
      title: "Salt and Smoke",
      opening: "The lamp guttered.",
    });
  });
  it("tolerates a code fence and surrounding prose", () => {
    const out = parseStoryOpening('Here you go:\n```json\n{"title":"Dusk","opening":"Rain fell."}\n```');
    expect(out).toEqual({ title: "Dusk", opening: "Rain fell." });
  });
  it("returns empty on unparseable input (caller falls back to the premise)", () => {
    expect(parseStoryOpening("sorry, I can't do that")).toEqual({});
  });
});

describe("storyStatePromptBlock", () => {
  it("assembles synopsis, present cast, location, and recent beats", () => {
    const block = storyStatePromptBlock({
      mode: "direct",
      presentCast: [{ name: "Mara", note: "red cloak, scarred hand" }, { name: "Toll" }],
      location: "the harbor at dusk",
      recentBeats: ["Mara stepped onto the dock.", "Toll watched from the rigging."],
      synopsis: "Mara hunts the smuggler; Toll is wary of her.",
    });
    expect(block).toContain("STORY STATE");
    expect(block).toContain("Story so far: Mara hunts the smuggler");
    expect(block).toContain("On stage now: Mara (red cloak, scarred hand); Toll");
    expect(block).toContain("Location: the harbor at dusk");
    expect(block).toContain("Toll watched from the rigging.");
  });

  it("adds the roleplay me/you mapping only in roleplay mode", () => {
    const direct = storyStatePromptBlock({ mode: "direct", presentCast: [{ name: "X" }], recentBeats: ["a"] });
    expect(direct).not.toMatch(/Roleplay:/);
    const rp = storyStatePromptBlock({
      mode: "roleplay",
      play: { me: "Alex", you: "Sage" },
      presentCast: [{ name: "Alex" }],
      recentBeats: ["a"],
    });
    expect(rp).toContain("the reader plays Alex; you voice Sage");
  });

  it("returns empty when there is nothing to say", () => {
    expect(storyStatePromptBlock({ mode: "direct", presentCast: [], recentBeats: [] })).toBe("");
  });

  it("stays within the char cap on a huge story", () => {
    const huge = Array.from({ length: 50 }, (_, i) => `Beat ${i} ` + "x".repeat(500));
    const block = storyStatePromptBlock({ mode: "direct", presentCast: [{ name: "A" }], recentBeats: huge, synopsis: "y".repeat(2000) });
    expect(block.length).toBeLessThanOrEqual(STORY_STATE_MAX_CHARS + 1);
  });
});

describe("synopsisRequest", () => {
  it("includes the beats and the previous synopsis", () => {
    const { system, user } = synopsisRequest(["beat one", "beat two"], "earlier summary");
    expect(system).toMatch(/running synopsis/i);
    expect(user).toContain("earlier summary");
    expect(user).toContain("beat one");
    expect(user).toContain("beat two");
  });

  it("omits the previous-synopsis section on the first refresh", () => {
    const { user } = synopsisRequest(["beat one"]);
    expect(user).not.toMatch(/Previous synopsis/);
  });
});
