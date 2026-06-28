import { describe, expect, it } from "vitest";
import { shouldAppendBeat } from "./story-beat.js";

const outcome = (text: string, tools: string[] = []) => ({
  text,
  toolResults: tools.map((tool) => ({ call: { tool } })),
});

describe("shouldAppendBeat", () => {
  it("appends plain prose when a story book is open", () => {
    expect(shouldAppendBeat(outcome("She opens the door."), { storyOpen: true, isStoryBook: true })).toBe(true);
  });

  it("does not append when no story is open or the book isn't a story", () => {
    expect(shouldAppendBeat(outcome("prose"), { storyOpen: false, isStoryBook: true })).toBe(false);
    expect(shouldAppendBeat(outcome("prose"), { storyOpen: true, isStoryBook: false })).toBe(false);
  });

  it("does not append an empty / whitespace-only reply", () => {
    expect(shouldAppendBeat(outcome("   "), { storyOpen: true, isStoryBook: true })).toBe(false);
  });

  it("does not double-append when a story tool already grew the book this turn", () => {
    expect(shouldAppendBeat(outcome("opening prose", ["start_story"]), { storyOpen: true, isStoryBook: true })).toBe(false);
    expect(shouldAppendBeat(outcome("more prose", ["continue_story"]), { storyOpen: true, isStoryBook: true })).toBe(false);
  });

  it("still appends when an UNRELATED tool ran alongside the prose", () => {
    expect(shouldAppendBeat(outcome("prose after a search", ["search_web"]), { storyOpen: true, isStoryBook: true })).toBe(true);
  });
});
