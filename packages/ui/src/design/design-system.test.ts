import { existsSync, readFileSync, readdirSync } from "node:fs";
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
/**
 * THE BACKDROP HAS TO BE VISIBLE, AND TWO SEPARATE THINGS CAN HIDE IT.
 *
 * The particle field now sits BEHIND the whole app at z-index -1, which only works because the
 * shell is transparent and the canvas carries the base colour itself. `styles.shell` used to
 * declare `background` inline — the same cascade trap that made every button's hover invisible —
 * and an inline value there beats `.vr-app-backdrop` and paints over the entire field.
 *
 * And nothing may introduce a stacking context on the shell: `isolation`, a `transform`, a
 * `filter` or a `z-index` on `.vr-app` all trap the negative z-index inside, where the shell's own
 * paint order puts it behind everything including the background. That failure is total and silent
 * — the field simply is not there — so it is asserted rather than remembered.
 */
describe("the particle backdrop can actually be seen", () => {
  const components = readFileSync(join(STYLES, "components.css"), "utf8");
  const base = readFileSync(join(STYLES, "base.css"), "utf8");

  it("puts the canvas behind the app and gives it the background to carry", () => {
    const rule = /\.vr-backdrop \{([\s\S]*?)\}/.exec(components)?.[1] ?? "";
    expect(rule, ".vr-backdrop not found").toBeTruthy();
    expect(rule, "the canvas is not behind the shell").toMatch(/z-index:\s*-1/);
    expect(rule, "the canvas paints no background, so the page behind it is bare").toMatch(/background:/);
    expect(/\.vr-app-backdrop \{([\s\S]*?)\}/.exec(components)?.[1] ?? "").toMatch(
      /background:\s*transparent/,
    );
  });

  it("keeps the shell out of the way, in the sheet and inline", () => {
    const app = readFileSync(join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8");
    const shell = /\n {2}shell: \{([\s\S]*?)\n {2}\},/.exec(app)?.[1] ?? "";
    expect(shell, "styles.shell not found").toBeTruthy();
    expect(shell, "styles.shell sets background inline, which beats .vr-app-backdrop").not.toContain(
      "background:",
    );

    const rule = /\.vr-app \{([\s\S]*?)\}/.exec(base)?.[1] ?? "";
    // `isolation` and `z-index` trap the negative z-index. The rest are worse: each one makes the
    // shell the containing block for `position: fixed`, so the backdrop would stop being pinned to
    // the viewport and start resizing and scrolling with the app — and a resize used to reseed the
    // entire field. One property away from the motes resetting every time the page moves.
    for (const prop of [
      "isolation",
      "transform",
      "filter",
      "perspective",
      "contain",
      "will-change",
      "z-index",
    ]) {
      expect(rule, `.vr-app sets ${prop}, which breaks how the backdrop is positioned`).not.toContain(
        prop,
      );
    }
  });
});

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

/**
 * THE DOCK MUST ALWAYS BE REOPENABLE.
 *
 * `bar` shipped as a flat 56px. The dock carries 10px of padding, leaving 36px of content box for
 * an input row that needs more — so collapsing the chat clipped away the input bar AND the caret
 * that reopens it. The chat vanished with no way back, which is the worst class of UI bug: not a
 * wrong pixel, a trapped user.
 *
 * The dock's contract has always been "the input bar is always visible". Nothing in CSS knows how
 * tall that bar is, so a fixed height can never honour it — the content has to decide.
 */
describe("the collapsed dock cannot swallow its own controls", () => {
  const layout = readFileSync(join(STYLES, "layout.css"), "utf8");
  const rule = (sel: string): string =>
    new RegExp(`\\${sel} \\{([^}]*)\\}`).exec(layout)?.[1] ?? "";

  it("lets content decide the collapsed height instead of pinning it", () => {
    const bar = rule(".vr-dock--bar");
    expect(bar, ".vr-dock--bar rule not found").toBeTruthy();
    expect(bar, "a fixed collapsed height cannot keep the input bar visible").toMatch(/height:\s*auto/);
  });

  it("keeps a floor under every mode, so no height token can clip the input row", () => {
    expect(rule(".vr-dock")).toMatch(/min-height:/);
  });
});

/**
 * THE CONVERSATION IS THE SURFACE THE READER LIVES IN.
 *
 * An audit of class-application counts found the delight layer almost entirely disconnected:
 * `vr-card`, `vr-arrive`, `vr-breathing` and `vr-progress-fill` were applied ZERO times between
 * them, and the chat — messages, thinking, typing, sending — had no motion whatsoever. The CSS for
 * all of it existed. Nothing wore any of it, and every gate was green.
 *
 * So the counts are the gate now. Not "the rule is defined", not "some element has a class" —
 * these specific effects, on the specific surfaces they were written for.
 */
describe("the conversation actually moves", () => {
  const uiDir = join(__dirname, "..");
  const all = readdirSync(uiDir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => readFileSync(join(uiDir, f), "utf8"))
    .join("\n");

  it.each([
    ["cx.msg", "a message arrives instead of appearing"],
    ["cx.card", "message bubbles are cursor-reactive surfaces"],
    ["cx.typing", "a caret shows while the model is producing words"],
    ["cx.thinking", "reasoning shimmers rather than sitting still"],
    ["cx.sent", "sending a message is felt, not just done"],
  ])("%s is applied — %s", (name) => {
    expect(all, `${name} is defined in CSS and worn by nothing`).toContain(`${name}`);
  });

  it("wires the effects that spent three commits attached to nothing", () => {
    for (const name of ["cx.arrive", "cx.breathing", "cx.progressFill"]) {
      expect(all, `${name} is still unused`).toContain(name);
    }
  });

  it("keeps the thinking shimmer readable where background-clip is unsupported", () => {
    // The gradient is painted THROUGH the glyphs, which needs transparent text — and transparent
    // text with no gradient is invisible text. The colour must be set outside the @supports guard.
    // Comments stripped FIRST. The comment above the rule explains the @supports guard and
    // therefore contains the word, so splitting on it cut the file before the rule itself — a
    // gate defeated by its own documentation, which is the third time that has happened here.
    const components = readFileSync(join(STYLES, "components.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const before = components.split("@supports")[0] ?? "";
    expect(before, ".vr-thinking has no unguarded colour to fall back to").toMatch(
      /\.vr-thinking \{[^}]*color:/,
    );
  });
});

/**
 * THREE FAULTS FROM ONE CHANGE, ALL SHIPPED, ALL GREEN.
 *
 * Putting `.vr-card` on message bubbles brought `overflow: hidden` with it, and that has a
 * consequence nothing about "a card" suggests: in a flex container, `overflow` other than `visible`
 * replaces an item's automatic minimum size of `auto` with 0. The bubbles became free to shrink
 * below their own text, so the chat squeezed an entire conversation into one screen with every
 * message clipped to a single line and no scrollbar.
 *
 * The aura shipped with the same shape of mistake: an absolutely-positioned decorative layer with
 * no `pointer-events: none`, sitting over the reasoning disclosure and swallowing the click that
 * opens it.
 *
 * Neither is visible in a stylesheet read on its own. Both are asserted here.
 */
describe("decoration cannot break layout or interaction", () => {
  const components = readFileSync(join(STYLES, "components.css"), "utf8");
  const rule = (sel: string): string =>
    new RegExp(`\\${sel}(?:::before|::after)? \\{([^}]*)\\}`).exec(components)?.[1] ?? "";

  it("keeps message bubbles from being squeezed below their own text", () => {
    // .vr-card sets overflow:hidden, which in a flex column zeroes the automatic minimum size.
    const msg = rule(".vr-msg");
    expect(msg, ".vr-msg rule not found").toBeTruthy();
    expect(msg, "bubbles can be shrunk below their content — the chat will clip every message").toMatch(
      /flex-shrink:\s*0/,
    );
  });

  it.each([".vr-card::before", ".vr-msg::after", ".vr-live::before"])(
    "%s is decoration, not a hit target",
    (sel) => {
      // Each covers its whole host. Without this the layer eats every click underneath it, and the
      // control below simply stops working with nothing logged anywhere.
      expect(rule(sel), `${sel} has no pointer-events: none`).toMatch(/pointer-events:\s*none/);
    },
  );
});

/**
 * ONE ARRIVAL, USED EVERYWHERE A PICTURE LANDS.
 *
 * The book's illustration and the chat's generated image are produced by the same engine and should
 * land the same way. They were two separate <img> tags, and only one of them had the effect — which
 * is how "the chat images don't do the thing" happens without anyone writing a bug.
 *
 * So the effect is a component rather than a class applied twice, and this asserts that both call
 * sites use it. Applying `cx.arrive` directly to an <img> would ALSO look right and be subtly wrong:
 * the sheen is a sibling because replaced elements have no ::after to hang it on.
 */
describe("every generated picture arrives the same way", () => {
  const uiDir = join(__dirname, "..");
  const read = (f: string): string => readFileSync(join(uiDir, f), "utf8");

  it.each(["ImagePanel.tsx", "ChatPanel.tsx"])("%s renders through ArrivingImage", (f) => {
    expect(read(f), `${f} still renders a bare <img> for generated content`).toMatch(/<ArrivingImage\b/);
  });

  it("keys the arrival on the source, or it plays exactly once per mount and never again", () => {
    // A CSS animation runs on mount. Without the key, the second picture in the same element simply
    // appears — no error, no warning, and identical to the effect not existing.
    const src = read("ArrivingImage.tsx");
    expect(src).toMatch(/key=\{src\}/);
    expect(src, "the sheen would sit finished over the new picture").toMatch(/key=\{`\$\{src\}-sheen`\}/);
  });

  it("gives the sheen a positioned, clipping parent to cross", () => {
    const components = readFileSync(join(STYLES, "components.css"), "utf8");
    const wrap = /\.vr-arrive-wrap \{([^}]*)\}/.exec(components)?.[1] ?? "";
    expect(wrap, ".vr-arrive-wrap rule not found").toBeTruthy();
    expect(wrap).toMatch(/position:\s*relative/);
    expect(wrap, "an unclipped sheen sweeps across the whole message").toMatch(/overflow:\s*hidden/);
  });
});

/**
 * THE CLASSES WERE WRITTEN AND NOTHING WORE THEM — the fourth time, and the last one to be closed.
 *
 * components.css has had hover, press and focus rules for `.vr-btn` and `.vr-input` since P0, and
 * the pointer handler that drives the touch path since P3. None of it reached the panels: TasksPanel,
 * SoulPanel, CalendarPanel and MemoriesPanel carried ZERO classNames between them, so every button
 * in them was as inert after the redesign as before it. The rules existed, the handler ran, and the
 * elements were not wearing anything for either to find.
 *
 * This asserts the elements themselves, not the sheet and not the handler — the one link that was
 * missing while both of those were green.
 */
describe("every interactive element in the panels can actually be interacted with", () => {
  const PANELS = [
    "TasksPanel",
    "SoulPanel",
    "CalendarPanel",
    "MemoriesPanel",
    "ScheduledTasksPanel",
    "StockChartPanel",
    "ChatPanel",
    "ChatBuddyPanel",
    "SettingsPanel",
  ];

  /** End of the opening tag that starts at `i`, tracking braces and strings so a `>` inside an
   * expression (`onClick={() => …}`) is not mistaken for the end of the tag. */
  function tagEnd(s: string, i: number): number {
    let depth = 0;
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j]!;
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        for (j++; j < s.length && s[j] !== q; j++) if (s[j] === "\\") j++;
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) return j;
    }
    return -1;
  }

  it.each(PANELS)("%s dresses every button, field and select", (panel) => {
    const src = readFileSync(join(__dirname, "..", `${panel}.tsx`), "utf8");
    const bare: string[] = [];
    for (const m of src.matchAll(/<(button|input|textarea|select)(?=[\s/>])/g)) {
      const end = tagEnd(src, m.index);
      if (end === -1) continue;
      const tag = src.slice(m.index, end);
      if (!tag.includes("className")) {
        bare.push(`${panel}:${src.slice(0, m.index).split("\n").length} <${m[1]}>`);
      }
    }
    expect(bare, `these have no class, so no hover, press or focus ring reaches them:\n${bare.join("\n")}`).toEqual(
      [],
    );
  });
});

/**
 * THE WORKFLOW STRIP LIVES IN TWO PLACES AND SHOWS IN ONE.
 *
 * It sat in the sticky header, costing a band of vertical space on every screen, while on a wide
 * one the rail gutter sat empty beside the prose. Moving it answers both complaints at once — but a
 * strip that MOVES is a strip that can go missing, so both copies always render and CSS picks.
 *
 * The two conditions live in different languages and both are required. The rail must be the
 * layout in play, which only JS knows (it is the reader's per-book choice) and which reaches the
 * shell as `.vr-rail-layout`; and the window must be wide enough for the rail to exist, which only
 * CSS knows. Drop either and the strip moves into a gutter that is not there.
 */
describe("the workflow strip has somewhere to be at every width", () => {
  const layout = readFileSync(join(STYLES, "layout.css"), "utf8");
  const app = readFileSync(join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8");

  it("builds the strip once, so the two copies cannot drift apart", () => {
    expect(app).toMatch(/const workflowStrip =/);
    expect(
      (app.match(/<WorkflowBar\b/g) ?? []).length,
      "a second <WorkflowBar> was written out by hand — the copies will diverge",
    ).toBe(1);
  });

  it("renders BOTH copies unconditionally on the strip's own existence", () => {
    // `workflowStrip &&` is the only guard either copy may carry: it is null when there is no book
    // to report on. A guard on width or layout here is the failure this whole shape avoids.
    expect(app).toMatch(/\{workflowStrip && <div className=\{cx\.workflowHeader\}>/);
    expect(app).toMatch(/\{workflowStrip && <div className=\{cx\.workflowRail\}>/);
  });

  it("hides the rail copy by default, so a narrow window shows the header one", () => {
    const base = /\.vr-workflow--rail \{([^}]*)\}/.exec(layout)?.[1] ?? "";
    expect(base, ".vr-workflow--rail rule not found").toBeTruthy();
    expect(base, "the rail copy shows before the rail exists").toMatch(/display:\s*none/);
  });

  it("swaps them only when BOTH the layout and the width agree", () => {
    // Read out of the 1440px block specifically: the same two selectors outside it would swap the
    // copies at every width, which is the bug this is shaped to prevent.
    const wide = /@media \(min-width: 1440px\) \{([\s\S]*?)\n\}/g;
    const blocks = [...layout.matchAll(wide)].map((m) => m[1] ?? "");
    const swap = blocks.find((b) => b.includes(".vr-workflow--rail"));
    expect(swap, "the swap is not inside a 1440px query").toBeTruthy();
    expect(swap).toMatch(/\.vr-rail-layout \.vr-workflow--rail \{\s*display:\s*block/);
    expect(swap).toMatch(/\.vr-rail-layout \.vr-workflow--header \{\s*display:\s*none/);
  });

  it("carries the layout fact to the shell, which is outside the reader grid", () => {
    expect(app).toMatch(/railLayout \? ` \$\{cx\.railLayout\}` : ""/);
    expect(app, "railLayout is not derived from the grid's own mode — the two can disagree").toMatch(
      /const railLayout = readerModeClass === cx\.readerRail/,
    );
  });
});

/**
 * P6 — WHAT THE SWEEP DELETED, AND WHY IT HAD TO GO.
 *
 * `ARTICLE_HTML_STYLE` was a template literal injected into a `<style>` at two call sites, holding
 * a second copy of the article rules that `article.css` already owns. The copy was not merely
 * redundant — it was BROKEN, and silently. Two of its values lost their `${}` during the tokenising
 * sweep and shipped as the literal text `t.accent.text` and `t.fill.subtle`, so every link in an
 * imported article and the background of every code block in one resolved to nothing. Nobody could
 * see it because the class name was identical, which is exactly what a duplicate buys you.
 *
 * The `tokens.ts` shim was the other planned deletion: a re-export kept for one migration so ten
 * components would not churn in the same diff as the sweep. That migration is over, and a shim left
 * in place is just a second name for the same thing waiting to disagree with the first.
 */
describe("the sweep stays swept", () => {
  const ui = join(__dirname, "..");

  it("has no second copy of the article rules", () => {
    expect(existsSync(join(STYLES, "article.css")), "article.css is the one copy and it is gone").toBe(true);
    const html = readFileSync(join(ui, "HtmlParagraph.tsx"), "utf8");
    expect(html, "the <style> template is back — it will drift from article.css again").not.toContain(
      "ARTICLE_HTML_STYLE",
    );
    const app = readFileSync(join(ui, "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8");
    expect(app, "App.tsx is injecting article CSS again").not.toContain("ARTICLE_HTML_STYLE");
  });

  it("still dresses the article container, or article.css matches nothing", () => {
    // The rules are all `.vr-article-html …`, so deleting the template is only safe while the
    // element still carries the class. Losing both would look identical to losing neither.
    const html = readFileSync(join(ui, "HtmlParagraph.tsx"), "utf8");
    expect(html).toMatch(/className=\{cx\.articleHtml\}/);
    expect(readFileSync(join(STYLES, "article.css"), "utf8")).toMatch(/\.vr-article-html\s*\{/);
  });

  it("never interpolates a token by writing its path as text", () => {
    // The exact failure above: `color: t.accent.text;` inside a template literal is a string, not a
    // value, and CSS drops the declaration without a word. Cheap to check across every sheet and
    // every remaining template.
    for (const f of ["tokens.css", "base.css", "motion.css", "components.css", "layout.css", "article.css"]) {
      const css = readFileSync(join(STYLES, f), "utf8");
      expect(css, `${f} contains a literal token path where a value belongs`).not.toMatch(/:\s*t\.[a-z]+\.[a-zA-Z]+/);
    }
  });

  it("has retired the tokens.ts shim rather than leaving a second name for design/", () => {
    expect(existsSync(join(ui, "tokens.ts")), "the shim is back — two names for one token surface").toBe(false);
  });
});

/**
 * NOTHING SHOULD BE CARRYING A STYLE NOBODY WEARS.
 *
 * `noUnusedLocals` gives this for free on a standalone `const fooStyle`, and it caught the orphan
 * left behind when ARTICLE_HTML_STYLE went. It gives NOTHING on an entry inside a record: `styles`
 * in App.tsx is one object with seventy-odd keys, and an unreferenced key is just data. Two were
 * sitting in it, describing elements that no longer exist.
 */
describe("the app's style record has no orphans", () => {
  it("references every entry it declares", () => {
    const app = readFileSync(
      join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "App.tsx"),
      "utf8",
    );
    const body = /\nconst styles: Record<string, React\.CSSProperties> = \{\n([\s\S]*?)\n\};/.exec(app)?.[1] ?? "";
    expect(body, "the styles record moved — this test is asserting nothing").toBeTruthy();
    const keys = [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]!);
    expect(keys.length, "no keys parsed out of the styles record").toBeGreaterThan(20);
    const orphans = keys.filter((k) => !new RegExp(`styles\\.${k}\\b`).test(app));
    expect(orphans, `declared in \`styles\` and never used: ${orphans.join(", ")}`).toEqual([]);
  });
});
