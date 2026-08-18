/**
 * A COMPOSER THAT GROWS WITH WHAT'S IN IT.
 *
 * Both chat fields were a fixed two rows with `resize: none`, so pasting a page of code into one
 * showed two lines of it and read as though the paste had been cut off — the reader could not see
 * what they were about to send, and had no handle to drag the field bigger either.
 *
 * It grows to a share of the viewport and then scrolls. The cap matters as much as the growth: a
 * field that grew without limit would eat the conversation it belongs to on the way to sending one
 * message, and on a phone it would push the send button off the screen entirely.
 */

/** The tallest a composer may grow before it scrolls instead, as a share of the viewport. */
export const COMPOSER_MAX_VIEWPORT_SHARE = 0.35;
/** Never smaller than roughly the two rows it started as, even in a very short window. */
export const COMPOSER_MIN_PX = 52;

/** Height cap in pixels for a given viewport height. PURE, so the rule is testable. */
export function composerMaxHeight(viewportPx: number): number {
  return Math.max(COMPOSER_MIN_PX, Math.round(viewportPx * COMPOSER_MAX_VIEWPORT_SHARE));
}

/**
 * Size a textarea to its content, up to the cap. Measuring `scrollHeight` requires collapsing the
 * height first — a textarea already tall enough for its content reports the height it HAS, not the
 * height it needs, so without the reset the field could only ever grow and never shrink back.
 */
export function growTextarea(ta: HTMLTextAreaElement | null | undefined): void {
  if (!ta) return;
  ta.style.height = "auto";
  const cap = composerMaxHeight(typeof window === "undefined" ? 800 : window.innerHeight);
  ta.style.height = `${Math.min(ta.scrollHeight, cap)}px`;
  ta.style.overflowY = ta.scrollHeight > cap ? "auto" : "hidden";
}
