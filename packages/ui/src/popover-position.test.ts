import { describe, expect, it } from "vitest";
import {
  POPOVER_GAP,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  placePopover,
  type AnchorRect,
} from "./popover-position.js";

/** A button `w` wide with its LEFT edge at `left`, sitting `top`..`top+h` down the screen. */
const button = (left: number, top: number, w = 90, h = 26): AnchorRect => ({
  left,
  right: left + w,
  top,
  bottom: top + h,
});

/** A roomy desktop window — the case that already worked and must keep working. */
const desktop = { width: 1440, height: 900 };
/** A phone held upright: narrow, tall. */
const portrait = { width: 390, height: 844 };
/** The same phone turned sideways: wide enough, but very little height once the header is drawn. */
const landscape = { width: 844, height: 390 };

describe("placePopover", () => {
  it("hangs under the button with its right edge aligned, when there's room", () => {
    const p = placePopover(button(1200, 60), desktop);
    expect(p.side).toBe("below");
    expect(p.top).toBe(60 + 26 + POPOVER_GAP);
    expect(p.bottom).toBeUndefined();
    expect(p.width).toBe(POPOVER_WIDTH);
    expect(p.left + p.width).toBe(1290); // the button's right edge
  });

  it("keeps a left-hand button's panel on screen instead of hanging it off the left edge", () => {
    // The header wraps on a phone, so the menu button can end up near the left. Right-aligning a
    // 320px panel to it would put its left edge at 20 - 320 = -300.
    const p = placePopover(button(20, 120), portrait);
    expect(p.left).toBeGreaterThanOrEqual(POPOVER_MARGIN);
    expect(p.left + p.width).toBeLessThanOrEqual(portrait.width - POPOVER_MARGIN);
  });

  it("keeps a right-hand button's panel on screen too", () => {
    const p = placePopover(button(280, 120), portrait);
    expect(p.left).toBeGreaterThanOrEqual(POPOVER_MARGIN);
    expect(p.left + p.width).toBeLessThanOrEqual(portrait.width - POPOVER_MARGIN);
  });

  it("narrows to fit a screen too small for the preferred width, rather than overflowing it", () => {
    const p = placePopover(button(10, 40), { width: 280, height: 600 });
    expect(p.width).toBe(280 - POPOVER_MARGIN * 2);
    expect(p.left).toBe(POPOVER_MARGIN);
  });

  it("caps the height to the room below, so a long menu scrolls instead of running off the bottom", () => {
    const p = placePopover(button(700, 300), desktop);
    expect(p.side).toBe("below");
    expect(p.top! + p.maxHeight).toBe(desktop.height - POPOVER_MARGIN);
  });

  it("flips above the button when the landscape header leaves no room below it", () => {
    // Phone on its side: the wrapped header pushes the button to y≈300 of a 390px-tall viewport,
    // leaving ~60px underneath — the case where items used to be unreachable.
    const p = placePopover(button(700, 300), landscape);
    expect(p.side).toBe("above");
    expect(p.top).toBeUndefined();
    // Pinned by its bottom edge, so a short menu still sits against its button.
    expect(p.bottom).toBe(landscape.height - 300 + POPOVER_GAP);
    // And it still can't reach past the top of the screen.
    expect(p.maxHeight).toBe(300 - POPOVER_GAP - POPOVER_MARGIN);
  });

  it("stays below for a small shortfall — flipping over a few pixels is more disorienting than a scroll", () => {
    // Room below is a little under the minimum, but there's even less above.
    const p = placePopover(button(700, 40), { width: 844, height: 220 });
    expect(p.side).toBe("below");
  });

  it("never reports a negative height, however little room there is", () => {
    // A viewport shorter than the button itself — nothing fits either way. `maxHeight: -23px` would
    // be ignored by the browser and the panel would draw at full height, off-screen.
    const p = placePopover(button(700, 5), { width: 844, height: 20 });
    expect(p.maxHeight).toBe(0);
  });

  it("can align by the left edge instead, for a menu that reads left-to-right", () => {
    const p = placePopover(button(400, 60), desktop, { align: "start" });
    expect(p.left).toBe(400);
  });
});
