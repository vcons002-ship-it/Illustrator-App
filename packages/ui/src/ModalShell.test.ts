import { describe, expect, it } from "vitest";
import { nextTrapFocus } from "./ModalShell.js";

describe("nextTrapFocus (focus-trap wrap decision)", () => {
  const els = ["a", "b", "c"] as const;

  it("wraps to the first element when Tab is pressed on the last", () => {
    expect(nextTrapFocus(els, "c", false)).toBe("a");
  });

  it("wraps to the last element when Shift+Tab is pressed on the first", () => {
    expect(nextTrapFocus(els, "a", true)).toBe("c");
  });

  it("lets the browser move focus normally in the middle of the list", () => {
    expect(nextTrapFocus(els, "b", false)).toBeNull();
    expect(nextTrapFocus(els, "b", true)).toBeNull();
  });

  it("pulls focus back in when it has escaped the card (active outside the list)", () => {
    // Tab from the card itself / the page → re-enter at the first; Shift+Tab → the last.
    expect(nextTrapFocus(els, null, false)).toBe("a");
    expect(nextTrapFocus(els, "outside", false)).toBe("a");
    expect(nextTrapFocus(els, null, true)).toBe("c");
  });

  it("returns null for an empty card (caller focuses the card itself)", () => {
    expect(nextTrapFocus([], "a", false)).toBeNull();
    expect(nextTrapFocus([], null, true)).toBeNull();
  });
});
