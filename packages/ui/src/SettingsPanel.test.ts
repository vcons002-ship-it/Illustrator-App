import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isComfyBackend, panelStyle } from "./SettingsPanel.js";
import { t } from "./design/tokens.js";

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

  /**
   * The assertion is now on the TOKEN rather than the hex, because the palette lives in one CSS
   * file and this panel must read it rather than restate it. The intent is unchanged and still
   * the point of the test: a portalled card that inherits nothing must declare a light-on-dark
   * pair of its own, or the browser draws its default black-on-black.
   *
   * Deliberately not deleted when tokenising broke it — a style contract that gets removed the
   * moment it fails is not a contract.
   */
  it("has readable contrast — light text on a dark card, not the UA's black on black", () => {
    expect(panelStyle.color).toBe(t.text.base);
    expect(panelStyle.background).toBe(t.surface.card);
  });

  it("reads those from tokens that actually exist", () => {
    // The one silent failure of a var()-based palette: a typo resolves to nothing, and a card
    // with no background renders transparent over whatever is behind it.
    const css = readFileSync(join(__dirname, "styles", "tokens.css"), "utf8");
    for (const value of [panelStyle.color, panelStyle.background]) {
      const name = /var\((--[a-z0-9-]+)\)/.exec(String(value))?.[1];
      expect(name, `${String(value)} is not a token reference`).toBeTruthy();
      expect(css, `${name} is referenced but never declared`).toContain(`${name}:`);
    }
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

/**
 * THE SECTION STRUCTURE.
 *
 * Settings is 4,184 lines and its sections are assembled from CSS `order` numbers scattered
 * across the file, not from a list anyone can read. That makes it very easy for a group to
 * drift into the wrong section — or for "App settings" to become a dump again, which is what
 * happened to the six sections this replaces.
 *
 * So the intended shape is written down once, here, and asserted. When a group genuinely moves,
 * this list moves with it in the same commit. The list changing is fine; it changing SILENTLY is
 * what this prevents.
 */
describe("settings sections", () => {
  const src = readFileSync(join(__dirname, "SettingsPanel.tsx"), "utf8");

  /** Every `<Group order={n} title="…">`, read straight out of the JSX. */
  const groups = [...src.matchAll(/order=\{(\d+)\}\s*\n\s*title="([^"]+)"/g)].map((m) => ({
    order: Number(m[1]),
    title: m[2]!,
  }));

  const SECTIONS = [
    { order: 10, name: "LLM & reasoning" },
    { order: 20, name: "Image & video models" },
    { order: 30, name: "Book illustration style" },
    { order: 40, name: "Connections" },
    { order: 50, name: "App settings" },
  ];

  it("has exactly five sections, named for the task rather than the technology", () => {
    const headers = [...src.matchAll(/<SectionHeader[^>]*title="([^"]+)"[^>]*order=\{(\d+)\}/g)];
    expect(headers).toHaveLength(5);
    expect(headers.map((h) => Number(h[2]))).toEqual(SECTIONS.map((s) => s.order));
  });

  it("files every group under exactly one section", () => {
    expect(groups.length).toBeGreaterThan(15);
    for (const g of groups) {
      const section = Math.floor(g.order / 10) * 10;
      expect(
        SECTIONS.some((s) => s.order === section),
        `"${g.title}" has order ${g.order}, which is under no section header`,
      ).toBe(true);
    }
  });

  it("puts the things the reader asked to be together, together", () => {
    const at = (title: string) => groups.find((g) => g.title.includes(title))?.order;
    const section = (title: string) => Math.floor((at(title) ?? 0) / 10) * 10;

    // Models — image AND video, which used to be a section of its own containing one group.
    expect(section("Paint — image provider")).toBe(20);
    expect(section("Image-to-video")).toBe(20);
    expect(section("local engine")).toBe(20);

    // Style is the craft, split out of the machinery it used to be filed under.
    expect(section("Look & layout")).toBe(30);
    expect(section("Illustration cadence")).toBe(30);

    // Every permission in ONE place — they were split across "Authorizations" and "Other".
    for (const perm of ["Assistant autonomy", "commands & screen", "Task automation", "incognito"]) {
      expect(section(perm), `${perm} is not under App settings`).toBe(50);
    }
    expect(section("Mature content")).toBe(50);
  });

  it("leaves no group stranded in a section that no longer exists", () => {
    // The old sections were 10/20/25/30/40/50 — 25 (Video generation) is gone, and anything
    // still pointing at it would render under no header at all.
    expect(groups.filter((g) => g.order >= 25 && g.order < 30)).toEqual([]);
  });
});
