/**
 * Where a dropdown panel goes so it stays on screen.
 *
 * WHY THIS EXISTS. The header menus ("↻ Redo…", "⤓ Export…") used to be plain `position: absolute`
 * panels anchored `right: 0` under their button, with a fixed `min-width`. That works on a desktop
 * window and fails on a phone in two different ways, one per orientation:
 *
 *  - PORTRAIT (narrow): the header's buttons wrap, so the menu's button can land anywhere in the row.
 *    Anchoring the panel's RIGHT edge to a button sitting near the left of the screen throws a 320px
 *    panel off the left side of the viewport, and there's nothing to scroll to get it back.
 *  - LANDSCAPE (short): the header eats most of a ~380px-tall viewport, and a five-item menu is taller
 *    than what's left. The panel overflowed the bottom of the screen — and since the header is a
 *    fixed-size flex child that never scrolls, the last items were simply unreachable.
 *
 * So placement can't be a constant. It has to be measured against the viewport at the moment the menu
 * opens (and again on rotate/resize). This module is the PURE half of that: given the button's
 * rectangle and the viewport size, say where the panel goes and how tall it may be. The React half
 * (`AnchoredMenu`) measures, portals the panel to `document.body`, and applies this as `position: fixed`.
 *
 * The portal is not incidental. `position: fixed` resolves against the nearest ancestor with a
 * `filter`/`backdrop-filter`/`transform`, and the app header has `backdrop-filter: blur(8px)` — a fixed
 * panel left inside it would be positioned relative to the HEADER, not the viewport, and every number
 * here would be wrong.
 */

/** The anchor's on-screen rectangle — the shape of `getBoundingClientRect()`, in viewport pixels. */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The visible viewport, in CSS pixels (`window.innerWidth`/`innerHeight`). */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * A placement, in the same units and origin as `position: fixed`. Exactly one of `top`/`bottom` is
 * set: a panel opening UPWARDS is pinned by its BOTTOM edge, so that when it turns out shorter than
 * `maxHeight` it still sits against its button instead of floating away from it.
 */
export interface PopoverPlacement {
  side: "above" | "below";
  left: number;
  width: number;
  /** The panel must scroll internally beyond this — it's the room that actually exists. */
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** Clearance kept between the panel and the edges of the screen. */
export const POPOVER_MARGIN = 8;
/** Clearance between the panel and the button it hangs off. */
export const POPOVER_GAP = 4;
/** Below this, opening downwards isn't worth it — flip and use the (larger) space above instead. */
export const POPOVER_MIN_HEIGHT = 160;
/** What these menus want when the screen allows it. */
export const POPOVER_WIDTH = 320;

/**
 * Place `anchor`'s panel inside `viewport`.
 *
 * Horizontally the panel prefers to line up with the anchor — its right edge by default, matching how
 * these menus have always looked when there's room — and is then CLAMPED into the viewport, which is
 * what stops a left-hand button from throwing the panel off-screen. It narrows below the preferred
 * width only when the screen itself is narrower.
 *
 * Vertically it opens downwards unless there isn't {@link POPOVER_MIN_HEIGHT} to work with and there
 * is more room above, in which case it flips. Either way `maxHeight` is the real remaining space, so
 * the panel scrolls rather than running off the screen. PURE.
 */
export function placePopover(
  anchor: AnchorRect,
  viewport: ViewportSize,
  opts: {
    /** Preferred width; narrowed to fit. Default {@link POPOVER_WIDTH}. */
    width?: number;
    margin?: number;
    gap?: number;
    minHeight?: number;
    /** Which of the panel's edges lines up with the anchor's. Default `"end"` (right edges). */
    align?: "start" | "end";
  } = {},
): PopoverPlacement {
  const margin = opts.margin ?? POPOVER_MARGIN;
  const gap = opts.gap ?? POPOVER_GAP;
  const minHeight = opts.minHeight ?? POPOVER_MIN_HEIGHT;

  // Never wider than the screen minus its margins — but on an absurdly narrow viewport, filling it
  // beats a zero-width panel.
  const room = Math.max(0, viewport.width - margin * 2);
  const width = room > 0 ? Math.min(opts.width ?? POPOVER_WIDTH, room) : viewport.width;

  const wanted = (opts.align ?? "end") === "start" ? anchor.left : anchor.right - width;
  const left = clamp(wanted, margin, Math.max(margin, viewport.width - margin - width));

  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  // Flip only when down is genuinely too cramped AND up is roomier — a menu that jumps above its
  // button for a few pixels' gain is more disorienting than a short scroll.
  const side: "above" | "below" = below < minHeight && above > below ? "above" : "below";
  const maxHeight = Math.max(0, side === "below" ? below : above);

  return side === "below"
    ? { side, left, width, maxHeight, top: anchor.bottom + gap }
    : { side, left, width, maxHeight, bottom: Math.max(margin, viewport.height - anchor.top + gap) };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
