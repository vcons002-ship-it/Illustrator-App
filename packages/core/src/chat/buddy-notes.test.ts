import { describe, expect, it } from "vitest";
import {
  interruptedRunNote,
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

describe("an interrupted run keeps what it did", () => {
  // Reported with three web searches visible in the chat and the model answering "I haven't done any
  // historical music searches in this session". It was right: a turn's tool calls reach later turns
  // only through the transcript on the SETTLE message, and an interrupted run never settles — the
  // error path stored `turns: []`. The reader could see the work; the model could not.
  const records = ['[tool search_web results for "pythagorean comma"]\n[1] Pythagorean tuning', '[tool search_web results for "key colour"]\n[1] Music theory'];

  it("carries every completed call into the model-facing history", () => {
    const note = interruptedRunNote(records, "Stopped.");
    const contents = note.turns.map((t) => t.content).join("\n");
    expect(contents).toContain("pythagorean comma");
    expect(contents).toContain("key colour");
    expect(note.turns.every((t) => t.role === "user")).toBe(true);
  });

  it("says the run STOPPED, so partial work isn't read as a finished job", () => {
    // The half that isn't "just save the transcript": results replayed without this read as a
    // completed run, and the model answers from partial work instead of resuming it.
    const note = interruptedRunNote(records, "Stopped.");
    const last = note.turns[note.turns.length - 1]!.content;
    expect(last).toMatch(/STOPPED before it finished/);
    expect(last).toMatch(/2 tool calls/);
    expect(last).toMatch(/still outstanding/);
    expect(last).toMatch(/NOT as a finished job/);
  });

  it("still says so when it managed nothing at all", () => {
    const note = interruptedRunNote([], "The chat went quiet for too long.");
    expect(note.text).toMatch(/went quiet/);
    expect(note.turns[note.turns.length - 1]!.content).toMatch(/hadn't finished anything yet/);
  });

  it("singularises one call, because a record that reads wrong is read as noise", () => {
    expect(interruptedRunNote([records[0]!], "Stopped.").turns.at(-1)!.content).toMatch(/1 tool call:/);
  });
});
