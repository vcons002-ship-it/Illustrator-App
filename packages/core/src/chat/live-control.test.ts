import { describe, expect, it } from "vitest";
import {
  LIVE_REPEAT_LIMIT,
  MAX_BUDDY_TOOL_ROUNDS,
  MAX_LIVE_CONTROL_ROUNDS,
  roundSignature,
  stuckOnRepeat,
  type BuddyToolCall,
} from "./buddy-tools.js";

const click = (target: string): BuddyToolCall => ({ tool: "control_ui", action: "click", window: "App", target });

describe("roundSignature", () => {
  it("is stable across key order", () => {
    // A model re-issuing the same call does not re-emit the keys in the same order, and a
    // fingerprint that moved when it did would never match twice — so the detector would never fire.
    const a = { tool: "control_ui", action: "click", window: "App", target: "Save" } as BuddyToolCall;
    const b = { target: "Save", window: "App", action: "click", tool: "control_ui" } as BuddyToolCall;
    expect(roundSignature([a])).toBe(roundSignature([b]));
  });

  it("separates different arguments and different batches", () => {
    expect(roundSignature([click("Save")])).not.toBe(roundSignature([click("Cancel")]));
    expect(roundSignature([click("Save")])).not.toBe(roundSignature([click("Save"), click("Save")]));
  });

  it("an empty round has an empty signature", () => {
    expect(roundSignature([])).toBe("");
  });
});

describe("stuckOnRepeat", () => {
  const sig = roundSignature([click("Save")]);

  it("does not fire below the limit", () => {
    expect(stuckOnRepeat(Array(LIVE_REPEAT_LIMIT - 1).fill(sig))).toBe(false);
  });

  it("fires at exactly the limit", () => {
    expect(stuckOnRepeat(Array(LIVE_REPEAT_LIMIT).fill(sig))).toBe(true);
  });

  it("needs the repeats CONSECUTIVE — a different round resets it", () => {
    const other = roundSignature([click("Cancel")]);
    const history = [...Array(LIVE_REPEAT_LIMIT - 1).fill(sig), other, sig];
    expect(stuckOnRepeat(history)).toBe(false);
  });

  it("looks only at the tail, so early repetition doesn't poison a run that recovered", () => {
    const other = roundSignature([click("Cancel")]);
    expect(stuckOnRepeat([...Array(10).fill(sig), ...Array(LIVE_REPEAT_LIMIT).fill(other)])).toBe(true);
    expect(stuckOnRepeat([...Array(10).fill(sig), other])).toBe(false);
  });

  it("never fires on empty rounds", () => {
    // A round with no tool calls ENDS the turn on its own; treating a run of them as "stuck" would
    // report a loop where there wasn't one.
    expect(stuckOnRepeat(Array(LIVE_REPEAT_LIMIT * 2).fill(""))).toBe(false);
  });

  it("tolerates a patient wait — repeated LOOKING is how you wait for a dialog", () => {
    const shot = roundSignature([{ tool: "screenshot", window: "App" }]);
    const nudge = roundSignature([click("OK")]);
    // look, click, look, click… never five identical in a row.
    const alternating = Array.from({ length: 20 }, (_, i) => (i % 2 ? shot : nudge));
    expect(stuckOnRepeat(alternating)).toBe(false);
  });
});

describe("the live round budget", () => {
  it("is far larger than the ordinary one, because the unit of work is a click", () => {
    expect(MAX_LIVE_CONTROL_ROUNDS).toBeGreaterThan(MAX_BUDDY_TOOL_ROUNDS * 4);
  });

  it("is still finite — a backstop, not a licence", () => {
    expect(Number.isFinite(MAX_LIVE_CONTROL_ROUNDS)).toBe(true);
  });
});
