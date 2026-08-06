/**
 * The TypeScript face of the design tokens.
 *
 * EVERY VALUE HERE IS A `var()` STRING, never a hex. The values live in styles/tokens.css and
 * only there — that is what makes the redesign a one-file change, and what stops the two from
 * drifting the way the eight hand-copied colour constants this replaces did.
 *
 * A `var()` reference is a legal inline style value, so a component tokenises without any
 * structural change at all:
 *
 *     background: "#16181d"   →   background: t.surface.card
 *
 * A test asserts that every token declared in the CSS is referenced here and vice versa, which
 * catches the one silent failure this approach has: a `var()` that resolves to nothing and
 * paints transparent.
 */

export const t = {
  surface: {
    /** App shell ground. */
    base: "var(--vr-bg)",
    /** Deepest chrome — the dock, the darkest bars. */
    sunken: "var(--vr-surface-0)",
    /** Inset panels. */
    inset: "var(--vr-surface-1)",
    /** Cards and modals — the most-used surface in the app. */
    card: "var(--vr-surface-2)",
    /** Raised / hover. New: nothing had a hover surface before, because nothing could hover. */
    raised: "var(--vr-surface-3)",
    overlay: "var(--vr-overlay)",
  },

  text: {
    base: "var(--vr-text)",
    dim: "var(--vr-text-dim)",
    faint: "var(--vr-text-faint)",
  },

  /** Background washes. Kept separate from `border` on purpose: the same rgba value served
   * both roles across the codebase, and collapsing them by value would have lost the meaning. */
  fill: {
    subtle: "var(--vr-fill-subtle)",
    base: "var(--vr-fill)",
    strong: "var(--vr-fill-strong)",
  },

  border: {
    faint: "var(--vr-border-faint)",
    subtle: "var(--vr-border-subtle)",
    input: "var(--vr-border-input)",
    button: "var(--vr-border-button)",
  },

  accent: {
    base: "var(--vr-accent)",
    text: "var(--vr-accent-text)",
    wash: "var(--vr-accent-wash)",
    fill: "var(--vr-accent-fill)",
    edge: "var(--vr-accent-edge)",
  },

  /** Semantic state. Deliberately NOT the accent — these mean something and must not be used
   * as decoration. */
  state: {
    good: "var(--vr-good)",
    warn: "var(--vr-warn)",
    danger: "var(--vr-danger)",
  },

  radius: {
    sm: "var(--vr-radius-sm)",
    md: "var(--vr-radius-md)",
    lg: "var(--vr-radius-lg)",
  },

  space: {
    1: "var(--vr-space-1)",
    2: "var(--vr-space-2)",
    3: "var(--vr-space-3)",
    4: "var(--vr-space-4)",
    5: "var(--vr-space-5)",
  },

  elev: {
    1: "var(--vr-elev-1)",
    2: "var(--vr-elev-2)",
    3: "var(--vr-elev-3)",
  },

  font: {
    ui: "var(--vr-font-ui)",
    read: "var(--vr-font-read)",
    mono: "var(--vr-font-mono)",
  },

  motion: {
    fast: "var(--vr-dur-1)",
    base: "var(--vr-dur-2)",
    slow: "var(--vr-dur-3)",
    ease: "var(--vr-ease)",
    /** A real spring curve baked into a static easing — see styles/tokens.css. */
    spring: "var(--vr-spring)",
    springSnap: "var(--vr-spring-snap)",
  },

  layout: {
    /** The prose column. Correct for reading; never widened by any layout mode. */
    measure: "var(--vr-measure)",
    readerMax: "var(--vr-reader-max)",
    artMin: "var(--vr-art-min)",
    artMax: "var(--vr-art-max)",
    railWidth: "var(--vr-rail-w)",
    dockBar: "var(--vr-dock-bar)",
    dockPeek: "var(--vr-dock-peek)",
    dockFull: "var(--vr-dock-full)",
    /** The MEASURED content height, published by App.tsx's ResizeObserver. Replaces five
     * hand-written height constants that each counted a different set of chrome. */
    viewHeight: "var(--vr-view-h)",
  },

  z: {
    sticky: "var(--vr-z-sticky)",
    overlay: "var(--vr-z-overlay)",
    modal: "var(--vr-z-modal)",
    toast: "var(--vr-z-toast)",
  },
} as const;
