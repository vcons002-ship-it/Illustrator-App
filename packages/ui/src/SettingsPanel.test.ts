import { describe, expect, it } from "vitest";
import { isComfyBackend, panelStyle } from "./SettingsPanel.js";

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

describe("isComfyBackend — which local engine the ComfyUI-only sections belong to", () => {
  it("says ComfyUI when NEITHER field is set, because that is what the status pill says", () => {
    // The bug this replaces: the sections read `localBackend ?? "a1111"`, so an install running the
    // app's managed ComfyUI — which needs no choosing, and therefore leaves localBackend unset — was
    // told it was on AUTOMATIC1111 and the ComfyUI-only settings never rendered. The status pill,
    // meanwhile, read the other field and said "ComfyUI" on the same screen.
    expect(isComfyBackend({})).toBe(true);
  });

  it("follows the RUNNING engine over the stored preference", () => {
    // engineBackend is what the live engine actually speaks; localBackend is only a preference, and
    // the app falls back to the managed ComfyUI even when A1111 was chosen.
    expect(isComfyBackend({ engineBackend: "comfyui", localBackend: "a1111" })).toBe(true);
    expect(isComfyBackend({ engineBackend: "a1111", localBackend: "comfyui" })).toBe(false);
  });

  it("uses the stored preference when nothing is running yet", () => {
    expect(isComfyBackend({ localBackend: "comfyui" })).toBe(true);
    expect(isComfyBackend({ localBackend: "a1111" })).toBe(false);
  });

  it("agrees with the status pill's own test, for every combination", () => {
    // The pill in App.tsx computes `(engineBackend ?? localBackend) === "a1111" ? A1111 : ComfyUI`.
    // Two places deciding the same thing differently is what produced a screen that contradicted
    // itself, so this pins them to one answer.
    const pillSaysComfy = (v: { engineBackend?: "comfyui" | "a1111"; localBackend?: "comfyui" | "a1111" }) =>
      (v.engineBackend ?? v.localBackend) !== "a1111";
    const options = [undefined, "comfyui", "a1111"] as const;
    for (const engineBackend of options) {
      for (const localBackend of options) {
        const v = {
          ...(engineBackend ? { engineBackend } : {}),
          ...(localBackend ? { localBackend } : {}),
        };
        expect(isComfyBackend(v), JSON.stringify(v)).toBe(pillSaysComfy(v));
      }
    }
  });
});
