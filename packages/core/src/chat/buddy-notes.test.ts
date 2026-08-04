import { describe, expect, it } from "vitest";
import {
  chainHaltNote,
  needsPausedTurnNote,
  openedImageNote,
  pausedTurnNote,
  referenceAdoptedNote,
  referenceFailedNote,
} from "./buddy-notes.js";
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

describe("a paused turn is always resumable", () => {
  it("posts the note standalone whenever the reply won't be shown", () => {
    // The bug: the Continue affordance rode on the settled reply, which is exactly the message an
    // app-managed TOOL step suppresses. A search step's contract is tool_ok, so on a cloud model
    // (ten tool rounds) a research step would search, read, search, read, hit the budget, and die
    // with no button and no message — searching being the one kind of work that burns rounds
    // without suspending the turn for an approval.
    expect(needsPausedTurnNote(true, false, false)).toBe(true); // paused, nothing to show
    expect(needsPausedTurnNote(true, true, true)).toBe(true); // paused, reply suppressed ← the bug
    expect(needsPausedTurnNote(true, false, true)).toBe(true);
  });

  it("leaves it to the reply when the reply IS shown, so there's only ever one Continue", () => {
    expect(needsPausedTurnNote(true, true, false)).toBe(false);
  });

  it("says nothing at all when the turn didn't pause", () => {
    for (const hasText of [true, false])
      for (const suppress of [true, false]) expect(needsPausedTurnNote(false, hasText, suppress)).toBe(false);
  });

  it("names the way back in, in words the reader can also just type", () => {
    // The button sends "continue"; the sentence has to match it, because a reader on a phone
    // scrolled past the button is going to type what the line told them to.
    expect(pausedTurnNote().text).toMatch(/continue/i);
    // Display-only: a budget checkpoint replayed out of history is turn-local machinery.
    expect(pausedTurnNote().turns).toEqual([]);
  });
});

describe("a checklist that stops advancing says so", () => {
  it("speaks for BOTH halts, not just the long one", () => {
    // The stall halt printed nothing at all, so the run stopped moving with a half-done checklist on
    // screen and no way to tell a deliberate stop from a crash. It's the commoner of the two by far:
    // it's what a model that doesn't call complete_step reliably produces, which is most local ones.
    for (const reason of ["stalled", "long"] as const) {
      const note = chainHaltNote(reason);
      expect(note.text.trim().length).toBeGreaterThan(0);
      expect(note.text).toMatch(/continue/i);
      expect(note.turns).toEqual([]); // turn-local machinery — never replayed as history
    }
  });

  it("tells the two apart, because they ask different things of the reader", () => {
    // A stall can mean the model asked a question and is waiting; running long never does.
    expect(chainHaltNote("stalled").text).not.toBe(chainHaltNote("long").text);
    expect(chainHaltNote("stalled").text).toMatch(/answer/i);
  });
});
