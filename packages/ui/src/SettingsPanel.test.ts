import { describe, expect, it } from "vitest";
import { panelStyle } from "./SettingsPanel.js";

/**
 * The settings card renders through a PORTAL, at the top of the document rather than inside the app.
 * That's deliberate — it positions itself against the viewport, and the header it's opened from has a
 * backdrop-filter, which would otherwise become the thing "fixed" is measured against. The cost is
 * that it inherits nothing: it landed on a bare <body> as black UA text on a near-black card, in
 * Times, at the UA's size.
 *
 * So the card must carry its own appearance. This asserts the properties that used to arrive by
 * inheritance and no longer can.
 */
describe("the settings card is self-sufficient", () => {
  it("declares its own colour, background, font and size", () => {
    expect(panelStyle.background).toBeTruthy();
    expect(panelStyle.color).toBeTruthy();
    expect(panelStyle.fontFamily).toBeTruthy();
    expect(panelStyle.fontSize).toBeTruthy();
  });

  it("has readable contrast — light text on a dark card, not the UA's black on black", () => {
    expect(panelStyle.color).toBe("#e7e7ee");
    expect(panelStyle.background).toBe("#16181d");
  });

  /**
   * Most of the dropdowns and inputs in the panel carry no colours of their own, so the browser draws
   * them — from the LIGHT palette unless told otherwise. That puts white boxes with black text on a
   * near-black card, and opens dropdown lists white behind the panel's pale text.
   */
  it("tells the browser to draw native controls dark, like everything around them", () => {
    expect(panelStyle.colorScheme).toBe("dark");
  });

  it("stays fixed to the viewport and scrolls itself within it", () => {
    expect(panelStyle.position).toBe("fixed");
    expect(panelStyle.overflowY).toBe("auto");
    // dvh, not vh: on a phone the address bar makes vh taller than what's on screen.
    expect(String(panelStyle.maxHeight)).toContain("dvh");
  });
});
