import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * P4 — EVERY DIALOG GOES THROUGH THE SHELL.
 *
 * The shell owns the contract a hand-rolled overlay has no way to acquire by accident:
 * role="dialog" with a name, Escape, a focus trap, focus returned to whatever opened it. Twelve
 * panels in this package were moved onto it; apps/web kept six of its own — Data, Import bible,
 * Paste text, Test image, Photo transform, Link a phone — and could not have been fixed while the
 * shell was internal to this package, which is why it is now exported.
 *
 * The assertion is the ABSENCE of the pattern. Counting adoptions would pass while a seventh
 * overlay was being written next to them, and that is exactly how six accumulated.
 */
describe("no dialog is hand-rolled", () => {
  const APP = join(__dirname, "..", "..", "..", "apps", "web", "src", "App.tsx");

  it("apps/web reaches the shell rather than building its own overlay", () => {
    const app = readFileSync(APP, "utf8");
    expect(app, "the app cannot see the shell").toMatch(/\bModalShell\b/);
    expect((app.match(/<ModalShell/g) ?? []).length, "the modals stopped using it").toBeGreaterThanOrEqual(6);
  });

  it("has no full-screen overlay left outside the shell", () => {
    // `position: fixed` pinned to every edge IS a modal backdrop. The privacy curtain and the
    // particle backdrop are full-screen too, but neither is a dialog and neither is written this
    // way — they are declared in the styles record and in CSS.
    const app = readFileSync(APP, "utf8");
    const rolled = [...app.matchAll(/position: "fixed", inset: 0/g)];
    expect(rolled.map((m) => app.slice(0, m.index).split("\n").length), "a hand-rolled backdrop is back").toEqual(
      [],
    );
  });

  it("is exported, or apps/web silently goes back to hand-rolling", () => {
    const barrel = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(barrel).toMatch(/export \* from "\.\/ModalShell\.js"/);
  });

  it("still names every dialog it opens, which is what a screen reader announces", () => {
    const app = readFileSync(APP, "utf8");
    const shells = [...app.matchAll(/<ModalShell\b([\s\S]{0,220}?)>/g)];
    expect(shells.length, "no shells found to check").toBeGreaterThanOrEqual(6);
    for (const m of shells) {
      expect(m[1], `a ModalShell with no title:\n${m[0]}`).toMatch(/title=/);
    }
  });
});
