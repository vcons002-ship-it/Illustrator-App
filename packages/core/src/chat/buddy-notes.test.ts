import { describe, expect, it } from "vitest";
import { openedImageNote, referenceAdoptedNote, referenceFailedNote } from "./buddy-notes.js";
import { stripPersistedDirectives } from "./transcript-hygiene.js";

const NOTES = [
  referenceAdoptedNote("grandma.jpg", 2),
  referenceFailedNote("HTTP 403"),
  referenceFailedNote(),
  openedImageNote("skyline.png"),
];

describe("buddy notes — an app-authored chat line that survives the rebuild", () => {
  it("carries model-facing turns, which is the whole point (a bare line contributes nothing)", () => {
    for (const note of NOTES) {
      expect(note.turns.length).toBeGreaterThan(0);
      expect(note.turns.every((t) => t.content.trim().length > 0)).toBe(true);
    }
  });

  it("speaks as the reader's side, like every other tool result the app feeds back", () => {
    for (const note of NOTES) expect(note.turns.every((t) => t.role === "user")).toBe(true);
  });

  it("names the picture and the count in both halves — 'picture 3' is not something a model can reason about", () => {
    const note = referenceAdoptedNote("grandma.jpg", 2);
    expect(note.text).toContain("grandma.jpg");
    expect(note.text).toContain("2 in use");
    expect(note.turns[0]!.content).toContain("grandma.jpg");
    expect(note.turns[0]!.content).toContain("2 in use");
  });

  it("says a failure was a failure, so the next turn can't answer as if a reference were in place", () => {
    const withReason = referenceFailedNote("HTTP 403");
    expect(withReason.text).toContain("HTTP 403");
    expect(withReason.turns[0]!.content).toContain("HTTP 403");
    expect(withReason.turns[0]!.content).toContain("NOT");
    // No reason given is still a failure worth persisting — it just doesn't invent one.
    expect(referenceFailedNote().turns[0]!.content).not.toContain("undefined");
    expect(referenceFailedNote().text).not.toContain("undefined");
  });

  it("records the opened picture by name", () => {
    const note = openedImageNote("skyline.png");
    expect(note.text).toContain("skyline.png");
    expect(note.turns[0]!.content).toContain("skyline.png");
  });

  it("is a record, not an instruction — nothing that would read as a standing order on replay", () => {
    // The reference INSTRUCTION ("prompt for what should change") is restated every turn by
    // buildImageReferenceBlock. Repeating it here would replay one moment's advice forever, which is
    // the exact failure transcript-hygiene had to be written to undo.
    for (const note of NOTES) {
      for (const turn of note.turns) {
        expect(turn.content).not.toMatch(/generate_image|do NOT describe|prompt for what/i);
      }
    }
  });

  it("survives transcript hygiene — a bracketed note must not look like a persisted directive", () => {
    for (const note of NOTES) {
      expect(stripPersistedDirectives(note.turns)).toEqual(note.turns);
    }
  });
});
