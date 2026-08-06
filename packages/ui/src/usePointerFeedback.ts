import { useEffect } from "react";

/**
 * INTERACTION FEEDBACK FOR EVERY `.vr-btn` AND `.vr-card`, FROM ONE LISTENER.
 *
 * Delegated at the document rather than wired per component: the app has ~48 components and
 * several hundred buttons, and attaching handlers to each would be the structural rewrite this
 * whole migration exists to avoid. A component opts in by carrying the class — nothing else.
 *
 * WHY THIS EXISTS AT ALL. `:hover` never fires on a finger, and this app is used on a linked
 * phone. Hover rules in components.css sit behind `@media (hover: hover)`, so without the
 * pointer path below a touch user gets *nothing* — the redesign would land on the device the
 * reader actually carries as no change whatsoever.
 *
 * TOUCH GETS ITS OWN GESTURES, NOT SIMULATED HOVER. Following a finger across a card means
 * competing with the browser for the scroll gesture, and losing — the only way to win is
 * `touch-action: none`, which would trap scrolling. So:
 *
 *   mouse  → the card glow tracks the pointer continuously
 *   touch  → a TAP blooms the glow from the point touched and plays itself out
 *
 * Both proven in a prototype, where the first attempt (follow the finger) did nothing but
 * scroll the page.
 */

/** A tap is ~60ms. Applying and removing the press state inside one frame shows nothing at all,
 * which is exactly how "tapping does nothing" happens — so the state is held after release. */
const PRESS_HOLD_MS = 220;

export function usePointerFeedback(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;

    /** Write the pointer's position into the element for the radial highlight. Straight to the
     * node, never through React state — the same technique BloomTransition uses to avoid
     * re-rendering up to nine panels a frame. */
    const place = (el: HTMLElement, e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--vr-mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--vr-my", `${e.clientY - r.top}px`);
    };

    const onMove = (e: PointerEvent): void => {
      if (e.pointerType !== "mouse") return; // a finger cannot hover; see the header
      const card = (e.target as Element | null)?.closest?.(".vr-card");
      if (card instanceof HTMLElement) place(card, e);
    };

    const onDown = (e: PointerEvent): void => {
      const target = e.target as Element | null;
      if (!target?.closest) return;

      const card = target.closest(".vr-card");
      if (card instanceof HTMLElement && e.pointerType !== "mouse") {
        place(card, e);
        card.classList.remove("is-tap");
        void card.offsetWidth; // restart the animation when the same card is tapped again
        card.classList.add("is-tap");
      }

      const btn = target.closest(".vr-btn");
      if (btn instanceof HTMLElement && e.pointerType !== "mouse") {
        if (releaseTimer) clearTimeout(releaseTimer);
        btn.classList.add("is-press");
      }
    };

    const onUp = (): void => {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        document.querySelectorAll(".vr-btn.is-press").forEach((b) => b.classList.remove("is-press"));
      }, PRESS_HOLD_MS);
    };

    /** The tap animation cleans up after itself, so a card never keeps the class. */
    const onAnimationEnd = (e: AnimationEvent): void => {
      if (e.animationName === "vr-tap-lift" && e.target instanceof HTMLElement) {
        e.target.classList.remove("is-tap");
      }
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointercancel", onUp, { passive: true });
    document.addEventListener("animationend", onAnimationEnd, true);
    return () => {
      if (releaseTimer) clearTimeout(releaseTimer);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("animationend", onAnimationEnd, true);
    };
  }, []);
}
