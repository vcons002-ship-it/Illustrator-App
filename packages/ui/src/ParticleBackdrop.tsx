import { useEffect, useRef, useSyncExternalStore } from "react";
import { cx } from "./design/classes.js";
import { ParticleField, type ParticleFieldHandle } from "./ParticleField.js";

/**
 * THE PARTICLE FIELD AS THE WHOLE SCREEN, NOT AS ONE PANEL'S BACKGROUND.
 *
 * The field used to live inside the chat panel, filling it with `inset: 0`. At the shipped density
 * that is the entire problem in one number: a docked chat is about 620×320, so the volume was
 * ~38 motes — and most of that box is header and composer, so what you actually saw was a small
 * group hovering in the strip above the input. Not a room the conversation lives in; a decoration
 * sitting on top of one widget, and nothing about the physics could have fixed it, because there
 * was nowhere else for a mote to be.
 *
 * At full viewport the same density gives ~250 on a 1080p screen, spread over everything, and the
 * chat's own forces become what they were always described as: local disturbances in a large room.
 *
 * WHY A MODULE-LEVEL REGISTRY RATHER THAN A CONTEXT PROVIDER. There is exactly one screen, so there
 * is exactly one field — and threading a provider through would mean wrapping ~4000 lines of JSX in
 * `App.tsx` to move one canvas, which is a far larger and riskier edit than the thing it enables.
 * The registry is subscribable, so a panel re-renders when the backdrop appears or goes away.
 *
 * It is also OPTIONAL on purpose. `apps/extension` mounts these same components into arbitrary
 * websites with no shadow DOM, where a fixed full-viewport canvas over someone else's page would be
 * indefensible. No backdrop mounted means `useSharedParticleField` returns null and the chat panel
 * falls back to filling itself, exactly as before.
 */

let shared: ParticleFieldHandle | null = null;
const listeners = new Set<() => void>();

function publish(h: ParticleFieldHandle | null): void {
  shared = h;
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The app-wide field, or null when no backdrop is mounted. */
export function useSharedParticleField(): ParticleFieldHandle | null {
  return useSyncExternalStore(
    subscribe,
    () => shared,
    () => null, // no field during SSR/prerender; the panel just renders its own
  );
}

/**
 * Density for a full-viewport field. Lower than the panel's, because the area is fifteen times
 * larger: 0.00012 puts ~250 motes on a 1080p screen, which is atmosphere. The panel's 0.00019 across
 * a whole screen would be ~400 plus up to 320 live sparks, and the halo pass makes every one of
 * those two fills.
 */
export const BACKDROP_DENSITY = 0.00012;

/**
 * Mount ONE of these inside the app shell. It paints behind everything and publishes its handle so
 * the chat can throw sparks into it.
 *
 * It must be a descendant of `.vr-app` and not a sibling: the shell paints an opaque background, and
 * `.vr-app { isolation: isolate }` plus a negative z-index is what puts the canvas above that
 * background but below the content, without having to give every child of the shell a z-index.
 */
export function ParticleBackdrop({ density = BACKDROP_DENSITY }: { density?: number }) {
  const ref = useRef<ParticleFieldHandle | null>(null);

  useEffect(() => {
    publish(ref.current);
    return () => publish(null);
  }, []);

  /**
   * SCROLLING STIRS THE ROOM.
   *
   * Listened for in the CAPTURE phase on the document, because scroll does not bubble: the reader,
   * the chat list and every panel scroller are separate elements, and capture is the only way to
   * hear all of them without wiring a handler into each one. Deltas are tracked per scroller, so
   * two of them moving at once add up rather than fighting over one number.
   *
   * The stir itself is a release, not a displacement — see `scrollVelocity`. A long read must not
   * slowly drag the entire volume down the page with it.
   */
  useEffect(() => {
    const lastTop = new WeakMap<EventTarget, number>();
    const onScroll = (e: Event): void => {
      const t = e.target;
      const top =
        t === document || t === document.documentElement
          ? scrollY
          : t instanceof Element
            ? t.scrollTop
            : null;
      if (top === null || !e.currentTarget) return;
      const key = t as EventTarget;
      const prev = lastTop.get(key);
      lastTop.set(key, top);
      if (prev !== undefined && prev !== top) ref.current?.stir(top - prev);
    };
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => document.removeEventListener("scroll", onScroll, true);
  }, []);

  return <ParticleField className={cx.backdrop} handleRef={ref} density={density} />;
}
