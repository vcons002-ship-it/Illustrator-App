import { describe, expect, it } from "vitest";
import {
  storyStatePromptBlock,
  synopsisRequest,
  storyOpeningRequest,
  parseStoryOpening,
  storySoFarFromChat,
  STORY_SO_FAR_MAX_CHARS,
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

  /**
   * Carrying a chat in is the difference between "start a story" and "make a story of the one we're
   * already telling". The brief has to change with it, or the model opens a fresh scene over the top
   * of a conversation the reader is mid-way through.
   */
  it("CONTINUES the story when the chat is carried in, instead of opening a new one", () => {
    const soFar = "Reader: I duck behind the crates.\nAssistant: The lantern swings past, inches away.";
    const { system, user } = storyOpeningRequest("", { soFar, mode: "direct" });
    expect(system).toMatch(/ALREADY been telling/i);
    expect(system).toMatch(/CONTINUES from where the conversation left off/);
    expect(system).toMatch(/Do not recap, re-introduce anyone, or rewind/);
    expect(system).not.toMatch(/establishes the setting/); // that's the fresh-start brief
    expect(user).toContain("THE STORY SO FAR");
    expect(user).toContain("The lantern swings past");
    expect(user).toMatch(/continuing the story above, not restarting it/);
  });

  it("keeps a typed premise as STEERING alongside the carried chat, not as the whole idea", () => {
    const { system, user } = storyOpeningRequest("bring the storm in", { soFar: "Reader: we set sail." });
    expect(user).toContain("The reader also says:\nbring the storm in");
    expect(user).toContain("we set sail");
    expect(system).toMatch(/ALREADY been telling/i);
  });

  it("is unchanged when nothing is carried", () => {
    const { system, user } = storyOpeningRequest("two rivals in a lighthouse", {});
    expect(system).toMatch(/OPENING BEAT/);
    expect(user).not.toContain("THE STORY SO FAR");
    expect(user).toContain("Reader's idea for the story");
  });
});

describe("storySoFarFromChat", () => {
  const msg = (role: string, text: string) => ({ role, text });

  it("renders the conversation with speakers, oldest first", () => {
    expect(
      storySoFarFromChat([msg("user", "I open the door."), msg("assistant", "Cold air pours in.")]),
    ).toBe("Reader: I open the door.\nAssistant: Cold air pours in.");
  });

  it("leaves out tool notes and empty messages — the story is what's carried, not the app's chatter", () => {
    const out = storySoFarFromChat([
      msg("user", "I open the door."),
      msg("tool", "📄 Report is ready"),
      msg("assistant", ""),
      msg("assistant", "Cold air pours in."),
    ]);
    expect(out).toBe("Reader: I open the door.\nAssistant: Cold air pours in.");
  });

  it("drops the OLDEST at the budget — the end of the conversation is where the story is", () => {
    const out = storySoFarFromChat([msg("user", "A".repeat(80)), msg("assistant", "B".repeat(80))], 100);
    expect(out).toBe(`Assistant: ${"B".repeat(80)}`); // the older "A" turn didn't fit and was dropped
  });

  it("keeps at least the newest message even when it alone exceeds the budget", () => {
    const out = storySoFarFromChat([msg("assistant", "B".repeat(500))], 100);
    expect(out).toContain("B".repeat(500));
  });

  it("is empty when there's nothing worth carrying", () => {
    expect(storySoFarFromChat([])).toBe("");
    expect(storySoFarFromChat([msg("tool", "⚙ something")])).toBe("");
  });

  it("has a budget big enough for a scene or two", () => {
    expect(STORY_SO_FAR_MAX_CHARS).toBeGreaterThanOrEqual(2000);
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
