import { describe, it, expect } from "vitest";
import { addKeyEvent, clearKeyEvents, composeScenePrompt, resolveKeyEvent } from "./key-events.js";
import { createEmptyBible } from "./bible.js";
import type { KeyEvent } from "../types/bible.js";

function bibleWith(chapterIndex: number, events: KeyEvent[]) {
  const b = createEmptyBible("b");
  b.storyboard.push({ chapterIndex, summary: "", keyMoment: "", location: "", locationChange: "", keyEvents: events });
  return b;
}

describe("resolveKeyEvent", () => {
  const events: KeyEvent[] = [
    { pageRange: [0, 4], imagePrompt: { text: "A" } },
    { pageRange: [5, 9], imagePrompt: { text: "B" } },
  ];

  it("picks the event with the most page-range overlap", () => {
    const b = bibleWith(0, events);
    expect(resolveKeyEvent(b, 0, [5, 6])?.imagePrompt.text).toBe("B");
    expect(resolveKeyEvent(b, 0, [3, 5])?.imagePrompt.text).toBe("A"); // overlaps A by 2, B by 1
  });

  it("returns undefined for no overlap, no range, or another chapter", () => {
    const b = bibleWith(0, events);
    expect(resolveKeyEvent(b, 0, [20, 22])).toBeUndefined();
    expect(resolveKeyEvent(b, 0, undefined)).toBeUndefined();
    expect(resolveKeyEvent(b, 1, [0, 4])).toBeUndefined(); // chapter 1 has no events
  });
});

describe("composeScenePrompt", () => {
  it("builds from the structured fields, ignoring empties", () => {
    expect(
      composeScenePrompt({ subject: "Elena", action: "flying", environment: "", mood: "tense", composition: "" }),
    ).toBe("Elena. flying. tense");
  });
  it("falls back to text when no structured fields are set", () => {
    expect(composeScenePrompt({ text: "a full prompt" })).toBe("a full prompt");
  });
  it("prefers structured over text", () => {
    expect(composeScenePrompt({ subject: "Elena", text: "ignored" })).toBe("Elena");
  });
});

describe("addKeyEvent / clearKeyEvents", () => {
  it("creates a scene if needed and upserts by pageRange (idempotent)", () => {
    let b = createEmptyBible("b");
    b = addKeyEvent(b, 2, { pageRange: [0, 1], imagePrompt: { text: "first" } });
    b = addKeyEvent(b, 2, { pageRange: [0, 1], imagePrompt: { text: "second" } }); // replaces
    const scene = b.storyboard.find((s) => s.chapterIndex === 2)!;
    expect(scene.keyEvents).toHaveLength(1);
    expect(scene.keyEvents![0]!.imagePrompt.text).toBe("second");
  });
  it("clearKeyEvents drops all stored prompts", () => {
    let b = addKeyEvent(createEmptyBible("b"), 0, { pageRange: [0, 0], imagePrompt: { text: "x" } });
    b = clearKeyEvents(b);
    expect(b.storyboard.every((s) => s.keyEvents === undefined)).toBe(true);
  });
});
