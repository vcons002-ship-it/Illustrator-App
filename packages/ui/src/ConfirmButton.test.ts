import { describe, expect, it } from "vitest";
import { CONFIRM_MIN_MS, CONFIRM_WINDOW_MS, confirmPress, type ConfirmState } from "./ConfirmButton.js";

describe("confirmPress (two-press destructive button)", () => {
  it("arms on the first press and doesn't fire", () => {
    const r = confirmPress(undefined, 1_000);
    expect(r.fire).toBe(false);
    expect(r.next).toEqual({ armedAt: 1_000 });
  });

  it("fires on a deliberate second press", () => {
    const armed: ConfirmState = { armedAt: 1_000 };
    const r = confirmPress(armed, 1_000 + CONFIRM_MIN_MS + 100);
    expect(r.fire).toBe(true);
    expect(r.next).toBeUndefined(); // disarmed, so a third press can't delete the next thing
  });

  it("IGNORES a double-tap — the mis-tap a phone makes easy", () => {
    // Two fast taps on a small target would otherwise arm and confirm in one gesture, which is a
    // one-tap delete wearing a confirmation's clothes.
    const armed: ConfirmState = { armedAt: 1_000 };
    const r = confirmPress(armed, 1_000 + CONFIRM_MIN_MS - 1);
    expect(r.fire).toBe(false);
    expect(r.next).toEqual(armed); // still armed, still waiting for a real answer
  });

  it("re-asks instead of firing when the first press has gone stale", () => {
    const armed: ConfirmState = { armedAt: 1_000 };
    const r = confirmPress(armed, 1_000 + CONFIRM_WINDOW_MS + 1);
    expect(r.fire).toBe(false);
    expect(r.next).toEqual({ armedAt: 1_000 + CONFIRM_WINDOW_MS + 1 });
  });

  it("takes two more presses to fire again after firing once", () => {
    let state: ConfirmState = { armedAt: 0 };
    const first = confirmPress(state, CONFIRM_MIN_MS + 1);
    expect(first.fire).toBe(true);
    state = first.next;
    const second = confirmPress(state, CONFIRM_MIN_MS + 2);
    expect(second.fire).toBe(false);
    expect(confirmPress(second.next, CONFIRM_MIN_MS * 2 + 200).fire).toBe(true);
  });
});
