import { describe, expect, it } from "vitest";
import { COMPOSER_MIN_PX, composerMaxHeight } from "./growTextarea.js";

/**
 * Both chat composers were a fixed two rows with `resize: none`, so pasting a page of code showed
 * two lines of it and read as though the paste had been cut off — with no grip to drag the field
 * bigger either. The growth needs a CEILING as much as it needs to grow: an unbounded field eats the
 * conversation it belongs to, and on a phone it pushes the send button off the screen.
 */
describe("composerMaxHeight", () => {
  it("gives a long paste real room on a normal window", () => {
    expect(composerMaxHeight(900)).toBe(315);
    expect(composerMaxHeight(1200)).toBe(420);
  });

  it("still leaves most of the window to the conversation", () => {
    for (const h of [400, 700, 900, 1400]) expect(composerMaxHeight(h)).toBeLessThan(h / 2);
  });

  it("never collapses below the two rows it started as, however short the window", () => {
    expect(composerMaxHeight(100)).toBe(COMPOSER_MIN_PX);
    expect(composerMaxHeight(0)).toBe(COMPOSER_MIN_PX);
  });
});
