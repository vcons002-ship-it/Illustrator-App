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
      "--vr-good-rgb",
      "--vr-warn-rgb",
      "--vr-danger-rgb",
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

  /**
   * THE ASSERTION ABOVE WAS FALSE CONFIDENCE ON ITS OWN.
   *
   * It checked only that the CSS *defines* the touch rules. It passed for three commits while
   * nothing anywhere applied them — so mobile had no interaction feedback at all and the suite
   * was green. A test that cannot fail is worse than no test, because it is read as coverage.
   */
  it("something actually applies those classes", () => {
    const src = readFileSync(join(__dirname, "..", "usePointerFeedback.ts"), "utf8");
    expect(src).toMatch(/classList\.add\("is-press"\)/);
    expect(src).toMatch(/classList\.add\("is-tap"\)/);
  });

  it("holds the press long enough for a tap to be visible", () => {
    // A tap is ~60ms; applying and removing the class inside one frame shows nothing.
    const src = readFileSync(join(__dirname, "..", "usePointerFeedback.ts"), "utf8");
    const hold = Number(/PRESS_HOLD_MS = (\d+)/.exec(src)?.[1] ?? 0);
    expect(hold, "press state is released too fast to see").toBeGreaterThanOrEqual(150);
  });

  it("does not try to track a finger, which would fight the scroll gesture", () => {
    // Following a dragging finger means competing with the browser for scrolling, and losing —
    // the only way to win is touch-action: none, which traps the page. Touch gets a TAP instead.
    const src = readFileSync(join(__dirname, "..", "usePointerFeedback.ts"), "utf8");
    // Bounded by the NEXT handler rather than by an indent-sensitive closing brace: the handlers
    // live inside useEffect, so their indentation is an implementation detail this test should
    // not encode. An empty match would make the assertion below vacuous, so it is checked first.
    const move = /const onMove[\s\S]*?(?=const onDown)/.exec(src)?.[0] ?? "";
    expect(move, "onMove handler not found — this test would otherwise assert nothing").toBeTruthy();
    expect(move, "pointermove must ignore non-mouse pointers").toMatch(/pointerType !== "mouse"/);
    expect(css).not.toMatch(/touch-action:\s*none/);
  });

  it("listens passively, so feedback can never delay a scroll", () => {
    const src = readFileSync(join(__dirname, "..", "usePointerFeedback.ts"), "utf8");
    expect(src).toMatch(/passive: true/);
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

/**
 * CONTRAST — the one thing about the palette that is objectively checkable without a browser.
 *
 * This environment has no way to render the app, so almost every claim about how it LOOKS is a
 * claim about code. Contrast is the exception: it is arithmetic on the hex values, so a palette
 * change that quietly makes body text unreadable can be caught here rather than on the reader's
 * screen. Thresholds are WCAG AA — 4.5:1 for body text, 3:1 for large text and UI edges.
 */
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Read a token's literal value straight out of the stylesheet.
 *
 * A colour may be written either as a hex or as `rgb(var(--x-rgb))`, because the state colours
 * now carry channel triples so their washes can be derived. The triple is resolved here rather
 * than exempting those tokens from the contrast check — the arithmetic below is the only claim
 * this suite can make about how the app actually LOOKS, so it must not narrow. */
function token(name: string): string {
  const viaTriple = new RegExp(`${name}:\\s*rgb\\(var\\((--vr-[a-z0-9-]+)\\)\\)`).exec(css);
  if (viaTriple) {
    const ch = new RegExp(`${viaTriple[1]}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(css);
    if (!ch) throw new Error(`${name} points at ${viaTriple[1]}, which declares no channels`);
    return "#" + [1, 2, 3].map((i) => Number(ch[i]).toString(16).padStart(2, "0")).join("");
  }
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css);
  if (!m) throw new Error(`${name} is not a literal hex in tokens.css`);
  return m[1]!;
}

describe("palette contrast", () => {
  const text = () => token("--vr-text");
  const surfaces = ["--vr-bg", "--vr-surface-0", "--vr-surface-1", "--vr-surface-2", "--vr-surface-3"];

  it.each(surfaces)("body text is readable on %s", (surface) => {
    const r = ratio(text(), token(surface));
    expect(r, `${r.toFixed(2)}:1 — body text needs 4.5:1`).toBeGreaterThanOrEqual(4.5);
  });

  it("the accent is legible as text on the surfaces it labels", () => {
    // The accent is used for links and active labels, not just for edges.
    for (const surface of ["--vr-surface-1", "--vr-surface-2"]) {
      const r = ratio(token("--vr-accent-text"), token(surface));
      expect(r, `accent text on ${surface} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["--vr-good", "--vr-warn", "--vr-danger"])("%s reads on a card", (state) => {
    // Status colours carry meaning; if one is unreadable the meaning is gone.
    const r = ratio(token(state), token("--vr-surface-2"));
    expect(r, `${state} on a card is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * CIE L* — perceptual lightness, 0 (black) to 100 (white).
   *
   * Deliberately NOT the WCAG ratio used above. That formula adds 0.05 to both luminances, so
   * between two near-black surfaces it compresses toward 1:1 no matter how different they
   * actually look — it measures text legibility, not surface separation, and using it here
   * flagged a perfectly visible step as a failure. L* is the right instrument for this job.
   */
  function lightness(hex: string): number {
    const y = luminance(hex);
    return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y;
  }

  /**
   * ONE NUMBER FOR EVERY STEP WAS THE WRONG RULE, AND IT COST A SHIPPED REGRESSION.
   *
   * This demanded 3 L* between every adjacent pair. The approved mockup does not do that — its
   * bottom steps are 1.6 and 2.6 L* apart — so the palette was re-derived upward to pass, which
   * put the card surface (the chat panel, the modals, the most-used surface in the app) at
   * L* 16.5 instead of the design's 10.8. It shipped, and it was noticed immediately: the chat
   * window was lighter and bluer than the design it came from.
   *
   * The premise was too crude. Value separation is what makes a surface read as raised only when
   * two surfaces MEET WITHOUT AN EDGE. The deep chrome — ground to dock — is divided by a
   * hairline border and a shadow, so it does not need to carry the separation in lightness too;
   * the content surfaces, which nest inside each other with nothing between them, do.
   *
   * So the rule now matches the reason it exists, and the design sets the values.
   */
  it("content surfaces are far enough apart to read as depth", () => {
    // The failure this catches is the one the old palette had: shell #11131a and card #16181d
    // were five points apart, so nothing looked raised and shadows had nothing to work against.
    const content = ["--vr-surface-1", "--vr-surface-2", "--vr-surface-3"];
    for (let i = 1; i < content.length; i++) {
      const delta = lightness(token(content[i]!)) - lightness(token(content[i - 1]!));
      expect(
        delta,
        `${content[i - 1]} → ${content[i]} is only ${delta.toFixed(1)} L* apart`,
      ).toBeGreaterThan(3);
    }
  });

  it("the deep chrome still steps, even though a border does most of the work", () => {
    // Lower bar, not no bar: the draft this replaces had two of these 1.x L* apart and they were
    // genuinely indistinguishable. The design's own smallest step is 1.6, so that is the floor.
    const deep = ["--vr-bg", "--vr-surface-0", "--vr-surface-1"];
    for (let i = 1; i < deep.length; i++) {
      const delta = lightness(token(deep[i]!)) - lightness(token(deep[i - 1]!));
      expect(delta, `${deep[i - 1]} → ${deep[i]} is only ${delta.toFixed(1)} L* apart`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("the ladder only ever climbs", () => {
    // Cheap, and it is the one thing neither threshold above can express on its own: a surface
    // that is meant to be raised must never come out darker than the one it sits on.
    const steps = surfaces.map(token).map(lightness);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!, `${surfaces[i]} is darker than ${surfaces[i - 1]}`).toBeGreaterThan(steps[i - 1]!);
    }
  });

  it("the neutrals are biased toward the accent, not flat grey", () => {
    // A pure grey is the colour you get when nobody chose one. Every surface carries more blue
    // than red, which is what makes a dark UI read as designed rather than merely dark.
    for (const surface of surfaces) {
      const hex = token(surface).replace("#", "");
      const r = parseInt(hex.slice(0, 2), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      expect(b - r, `${surface} is flat grey (r${r} b${b})`).toBeGreaterThanOrEqual(5);
    }
  });
});

/**
 * STRUCTURAL VALIDITY.
 *
 * There is no browser here, so a stylesheet that fails to parse would ship looking exactly
 * like a stylesheet that never loaded — every var() empty, every surface transparent. While
 * editing the palette an edit left four lines stranded outside a comment block, which would
 * have done precisely that, and every other test still passed because they all read the file
 * as text. These are the cheap checks that would have caught it.
 */
describe("the stylesheets parse", () => {
  it.each(sheets)("%s has balanced comments", (file) => {
    const text = readFileSync(join(STYLES, file), "utf8");
    const open = (text.match(/\/\*/g) ?? []).length;
    const close = (text.match(/\*\//g) ?? []).length;
    expect(open, `${open} /* vs ${close} */`).toBe(close);
  });

  it.each(sheets)("%s has balanced braces", (file) => {
    const text = readFileSync(join(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const open = (text.match(/\{/g) ?? []).length;
    const close = (text.match(/\}/g) ?? []).length;
    expect(open, `${open} { vs ${close} }`).toBe(close);
  });

  it.each(sheets)("%s has no stray declaration outside a rule", (file) => {
    // The exact shape of the bug: a line starting with `*` where no comment is open.
    const text = readFileSync(join(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const stray = text.split("\n").filter((l) => /^\s*\*/.test(l));
    expect(stray, `stranded comment text: ${stray.join(" / ")}`).toEqual([]);
  });

  it("index.css imports every sheet, so none is written and never loaded", () => {
    const index = readFileSync(join(STYLES, "index.css"), "utf8");
    for (const file of sheets.filter((f) => f !== "index.css")) {
      expect(index, `${file} exists but nothing imports it`).toContain(file);
    }
  });
});

/**
 * THE GATE THE PLAN PROMISED, WIDENED TO THE TREE IT WAS MEANT TO COVER.
 *
 * "No raw colour literals outside the sheets" was written to inspect tokens.ts and nothing else,
 * so 40-odd hexes survived the sweep unnoticed across 19 components. They were not harmless: every
 * one was mixed by eye against the OLD ground (#11131a) and stayed put when the palette moved to
 * a new one, leaving panels and toasts sitting at values that belong to a scheme the app no longer
 * uses. That is invisible to a token-parity check — the tokens were all fine. The colours that
 * were never tokens are the ones that drift.
 *
 * Two exemptions, both narrow and both stated at the point of use:
 *   - data-driven palettes, where a colour identifies a series or a service rather than a surface;
 *   - a `RAW-COLOUR-OK:` marker with a reason, for the handful of genuinely fixed values.
 */
describe("no colour drifts outside the palette", () => {
  /** A colour here means the series, not the surface — changing it would relabel the data. */
  const DATA_PALETTES = new Set([
    "DataChart.tsx",
    "Infographic.tsx",
    "GanttChart.tsx",
    "StockChartPanel.tsx",
    "JsonTreeView.tsx",
    "ContextUsageDonut.tsx",
  ]);

  const uiDir = join(__dirname, "..");
  const files: [string, string][] = [
    ["App.tsx", readFileSync(join(uiDir, "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8")],
    ...readdirSync(uiDir)
      .filter((f) => f.endsWith(".tsx") && !DATA_PALETTES.has(f))
      .map((f): [string, string] => [f, readFileSync(join(uiDir, f), "utf8")]),
  ];

  it("every component reads its colours from the palette", () => {
    const offenders: string[] = [];
    for (const [name, src] of files) {
      src.split("\n").forEach((line, i) => {
        if (line.includes("RAW-COLOUR-OK")) return;
        // A quoted style VALUE only — never a comment, a class name or prose.
        for (const m of line.matchAll(/"(#[0-9a-fA-F]{3,8})"/g)) {
          offenders.push(`${name}:${i + 1} ${m[1]}`);
        }
      });
    }
    expect(
      offenders,
      `hexes that will not follow the palette:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the exemption has to say why, so it cannot become a silent escape hatch", () => {
    for (const [name, src] of files) {
      for (const line of src.split("\n")) {
        if (!line.includes("RAW-COLOUR-OK")) continue;
        const reason = line.split("RAW-COLOUR-OK")[1] ?? "";
        expect(reason.replace(/^:\s*/, "").trim().length, `${name}: bare RAW-COLOUR-OK`).toBeGreaterThan(15);
      }
    }
  });
});

/**
 * DEFINED IS NOT APPLIED.
 *
 * Every rule in components.css existed and did nothing for three commits, because no component
 * carried the class. The suite was green throughout: the tests asserted the CSS *declared* the
 * rules. So these check the other end — that something in the tree actually wears them.
 *
 * Written to fail loudly if the interaction pass is ever reverted piecemeal, which is exactly how
 * a styling migration rots: a component gets rewritten, its className quietly doesn't come back,
 * and nothing anywhere notices because the stylesheet is still perfect.
 */
describe("the interaction classes are actually worn by components", () => {
  const uiDir = join(__dirname, "..");
  const sources = [
    readFileSync(join(uiDir, "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8"),
    ...readdirSync(uiDir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(join(uiDir, f), "utf8")),
  ];
  const all = sources.join("\n");

  it("puts the modal classes on ModalShell, where twelve modals inherit them", () => {
    // The one file that had to be first: these two classes animate every modal in the app, and
    // @starting-style + allow-discrete means the EXIT needs no mount-keeping in any of them.
    const shell = readFileSync(join(uiDir, "ModalShell.tsx"), "utf8");
    expect(shell).toContain("cx.modalOverlay");
    expect(shell).toContain("cx.modalCard");
  });

  it("wears the button class widely enough to be the app's buttons, not a sample", () => {
    const worn = (all.match(/className=\{cx\.btn\}/g) ?? []).length;
    expect(worn, `only ${worn} elements carry cx.btn`).toBeGreaterThan(40);
  });

  it("gives inputs their focus class, since inline styles cannot express :focus", () => {
    expect(all).toMatch(/className=\{cx\.input\}/);
  });

  it("never leaves a className referring to a class the sheets don't define", () => {
    // A className that matches nothing is invisible: it looks exactly like the animation not
    // working, and there is no runtime error to find.
    const used = new Set([...all.matchAll(/cx\.([a-zA-Z]+)/g)].map((m) => m[1]!));
    const unknown = [...used].filter((k) => !(k in cx));
    expect(unknown, `cx.${unknown.join(", cx.")} is not in classes.ts`).toEqual([]);
  });
});

/**
 * THE CLASS HAS TO BE ALLOWED TO WIN.
 *
 * Adding `className` beside `style` is safe precisely because inline styles beat class rules — a
 * class can only add behaviour, never break appearance. That same fact is why the interaction pass
 * shipped invisible: `styles.button` and Settings' `buttonStyle` declared `background` and `border`
 * INLINE, so `.vr-btn:hover`'s `background-color` and `border-color` were overridden on every
 * button in the app. Hovering moved a transparent button two pixels and nothing else.
 *
 * Half a migration looks exactly like a finished one from the test suite's side. This is the half
 * that was missing: the declarations the class now owns have to leave the inline object.
 */
describe("hover can actually reach the app's buttons", () => {
  const components = readFileSync(join(STYLES, "components.css"), "utf8");

  it("gives .vr-btn a resting background and border to transition FROM", () => {
    const base = /\.vr-btn \{([\s\S]*?)\}/.exec(components)?.[1] ?? "";
    expect(base, ".vr-btn declares no resting background").toMatch(/background:/);
    expect(base, ".vr-btn declares no resting border").toMatch(/border:/);
  });

  it("leaves those out of the inline button styles, so the hover rule is not overridden", () => {
    const app = readFileSync(join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8");
    const appBtn = /\n {2}button: \{([\s\S]*?)\n {2}\},/.exec(app)?.[1] ?? "";
    expect(appBtn, "styles.button not found").toBeTruthy();
    for (const prop of ["background:", "border:"]) {
      expect(appBtn, `styles.button still sets ${prop} inline, which beats :hover`).not.toContain(prop);
    }

    const settings = readFileSync(join(__dirname, "..", "SettingsPanel.tsx"), "utf8");
    const setBtn = /const buttonStyle = \{([\s\S]*?)\} as const;/.exec(settings)?.[1] ?? "";
    expect(setBtn, "buttonStyle not found").toBeTruthy();
    for (const prop of ["background:", "border:"]) {
      expect(setBtn, `Settings' buttonStyle still sets ${prop} inline`).not.toContain(prop);
    }
  });

  it("changes something a transparent button can actually show on hover", () => {
    // A lift and a shadow alone are close to invisible on a transparent button against a dark
    // ground — which is exactly what shipped. The colour change is the part that reads.
    const hover = /@media \(hover: hover\) \{([\s\S]*?)\n\}/.exec(components)?.[1] ?? "";
    expect(hover).toMatch(/\.vr-btn:hover[\s\S]*background-color:/);
    expect(hover).toMatch(/\.vr-btn:hover[\s\S]*border-color:/);
  });
});
