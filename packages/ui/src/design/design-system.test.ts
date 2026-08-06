import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cx, DOCK_CLASS, READER_CLASS } from "./classes.js";
import { NARROW_PX } from "./breakpoints.js";
import { t } from "./tokens.js";

/**
 * THE GATES THAT MAKE A SWEEP ACROSS ~48 COMPONENTS REVIEWABLE.
 *
 * Tokenising 665 colour literals produces a diff far too large to read line by line. These
 * tests are the proof instead of the review: they check the properties that would otherwise
 * fail silently and look like a styling opinion rather than a bug.
 */

const STYLES = join(__dirname, "..", "styles");
const sheets = readdirSync(STYLES).filter((f) => f.endsWith(".css"));
const css = sheets.map((f) => readFileSync(join(STYLES, f), "utf8")).join("\n");
const tokensTs = readFileSync(join(__dirname, "tokens.ts"), "utf8");

describe("token parity", () => {
  /** Written from JavaScript at runtime rather than declared in a sheet. --vr-view-h is
   * published by App.tsx's ResizeObserver from the real content box; the pointer position and
   * stagger index are written straight to the element by their handlers. */
  const RUNTIME_WRITTEN = new Set(["--vr-view-h", "--vr-mx", "--vr-my", "--vr-i"]);

  it("every token the TypeScript mirror references is declared in CSS", () => {
    // The one silent failure of a var()-based system: a typo resolves to nothing and paints
    // transparent, which looks like a design decision rather than a mistake.
    const declared = new Set([...css.matchAll(/^\s*(--vr-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!));
    const referenced = new Set([...tokensTs.matchAll(/var\((--vr-[a-z0-9-]+)\)/g)].map((m) => m[1]!));
    const missing = [...referenced].filter((v) => !declared.has(v) && !RUNTIME_WRITTEN.has(v));
    expect(missing, `referenced in tokens.ts but never declared in CSS: ${missing.join(", ")}`).toEqual([]);
  });

  it("every token declared in CSS is reachable from TypeScript", () => {
    const declared = [...css.matchAll(/^\s*(--vr-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!);
    const referenced = new Set([...tokensTs.matchAll(/var\((--vr-[a-z0-9-]+)\)/g)].map((m) => m[1]!));
    // These are consumed only by CSS rules or written from JS at runtime, never read through
    // the mirror — so they're expected to be absent from it.
    const cssOnly = new Set([
      "--vr-fg-rgb",
      "--vr-accent-rgb",
      "--vr-dock-h",
      "--vr-mx",
      "--vr-my",
      "--vr-i",
    ]);
    const orphans = [...new Set(declared)].filter((v) => !referenced.has(v) && !cssOnly.has(v));
    expect(orphans, `declared in CSS but unreachable from tokens.ts: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the mirror holds var() references, never raw colour values", () => {
    // The moment a hex lands here the redesign stops being a one-file change. Comments are
    // stripped first: the header deliberately shows a before/after with a real colour in it,
    // and that example is worth more than the strictness of the check.
    const code = tokensTs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const hexes = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(hexes).toEqual([]);
  });
});

describe("the scoping invariant", () => {
  it("no rule outside :root can escape the .vr- namespace", () => {
    // apps/extension mounts these components into an ARBITRARY WEBSITE's body with no shadow
    // DOM. A bare `button {}` here would restyle whatever page the reader is on.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders: string[] = [];
    for (const block of withoutComments.split("}")) {
      const head = block.split("{")[0];
      if (!head || !block.includes("{")) continue;
      for (const sel of head.split(",")) {
        const s = sel.trim();
        if (!s || s.startsWith("@") || s.startsWith("/") || s.startsWith("from") || s.startsWith("to")) continue;
        if (/^\d+%$/.test(s)) continue; // keyframe stops
        if (s === ":root" || s.startsWith(":root")) continue;
        if (!s.includes(".vr-")) offenders.push(s);
      }
    }
    expect(offenders, `selectors that could leak onto a host page: ${offenders.join(" | ")}`).toEqual([]);
  });

  it("declares its tokens on :root so portalled panels inherit them", () => {
    // SettingsPanel, ModalShell and AnchoredMenu all portal to <body>, outside the app tree.
    // Tokens scoped to .vr-app would leave every one of them unstyled.
    expect(css).toMatch(/:root\s*\{[\s\S]*--vr-surface-2/);
  });
});

describe("class existence", () => {
  it("every class name in classes.ts appears as a selector", () => {
    // A className that matches nothing fails silently and is indistinguishable from "the
    // animation didn't work".
    // Applied by the pointer handlers and only ever written as compound selectors
    // (`.vr-btn.is-press`), so a bare `.is-press` rule correctly does not exist.
    const applied = new Set<string>([cx.isPress, cx.isTap]);
    const missing = Object.values(cx)
      .filter((c) => !applied.has(c))
      .filter((c) => !css.includes(`.${c}`));
    expect(missing, `named in classes.ts but absent from the sheets: ${missing.join(", ")}`).toEqual([]);
  });

  it("maps every dock mode and reader layout to a real class", () => {
    for (const c of [...Object.values(DOCK_CLASS), ...Object.values(READER_CLASS)]) {
      expect(css, `${c} has no rule`).toContain(`.${c}`);
    }
  });
});

describe("breakpoint parity", () => {
  it("NARROW_PX matches the media query in layout.css", () => {
    // The breakpoint has to exist twice — CSS decides layout, React decides DOM order
    // (inlineImages). A silent divergence gives a phone one layout in each dimension.
    const layout = readFileSync(join(STYLES, "layout.css"), "utf8");
    const found = [...layout.matchAll(/max-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(found, `layout.css declares ${found.join(",")} but NARROW_PX is ${NARROW_PX}`).toContain(NARROW_PX);
  });
});

describe("the dock animation's precondition", () => {
  it("registers --vr-dock-h with @property", () => {
    // Without this the transition does not interpolate at all, and an overshooting spring can
    // resolve the grid track to an invalid value — which collapses every row, not just the
    // dock. Found in a prototype, where it read as the chat AND the book disappearing.
    expect(css).toMatch(/@property\s+--vr-dock-h\s*\{[\s\S]*syntax:\s*"<length>"/);
  });
});

describe("reduced motion", () => {
  it("collapses the duration tokens and sweeps inline durations", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/--vr-dur-1:\s*1ms/);
    expect(css).toMatch(/animation-duration:\s*1ms\s*!important/);
  });

  it("uses 1ms rather than 0, so transitionend still fires", () => {
    // Several components remove a class in an animationend/transitionend handler. At 0 those
    // events never fire and the class sticks forever.
    const reduced = /@media \(prefers-reduced-motion: reduce\)([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? "";
    expect(reduced).not.toMatch(/duration:\s*0s/);
  });
});

describe("touch parity", () => {
  it("every hover effect has a pointer-driven equivalent", () => {
    // This app runs on a linked phone, where :hover never fires. A redesign that only comes
    // alive under a cursor would land there as a redesign that does nothing.
    const components = readFileSync(join(STYLES, "components.css"), "utf8");
    expect(components).toContain("@media (hover: hover)");
    expect(components).toMatch(/\.vr-btn\.is-press/);
    expect(components).toMatch(/\.vr-card\.is-tap/);
  });
});

describe("the token surface itself", () => {
  it("exposes the values the sweep needs, so no component has to invent one", () => {
    expect(t.surface.card).toBe("var(--vr-surface-2)");
    expect(t.border.subtle).toBe("var(--vr-border-subtle)");
    expect(t.accent.base).toBe("var(--vr-accent)");
    expect(t.motion.spring).toBe("var(--vr-spring)");
    // The prose measure is a token so that every layout mode reads the same one — widening it
    // per mode is the mistake this prevents.
    expect(t.layout.measure).toBe("var(--vr-measure)");
  });
});
