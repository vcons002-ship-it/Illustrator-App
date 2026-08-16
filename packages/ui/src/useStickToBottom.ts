import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * FOLLOW THE CONVERSATION — keep a chat log pinned to its newest message, but only while the reader
 * is actually following it.
 *
 * Both chat panels grew their own copy of this, and both copies had the same two holes.
 *
 * The first is the dependency list. "Scroll to the bottom when X changes" needs X to enumerate every
 * element that can grow the column, and that list is an approximation maintained by hand: the
 * thinking disclosure, the plan checklist and the live step log all had to be added after the fact,
 * each one found by noticing the view stranded above the newest content. It cannot cover growth that
 * happens AFTER the render commits at all — a picture finishing its load, a file card measuring
 * itself, a font swapping in. A ResizeObserver measures the thing itself instead of predicting it.
 *
 * The second is the browser's own scroll anchoring, which is a competing owner of the same
 * scrollTop. When content ABOVE the viewport changes size, Chrome moves the scroll position to hold
 * its chosen anchor node still — so a bubble settling, a thinking block collapsing, or an image
 * arriving pushes the view up and away from the bottom, and nothing re-runs to pull it back. That is
 * the drift reported as "it keeps jumping higher in the chat". The scroller manages its own position
 * here, so anchoring is turned off in `chatScrollStyle` (`overflow-anchor: none`) and this is the
 * only owner left.
 *
 * What the flag means is unchanged, and it is the whole point: "was the reader at the bottom when
 * this arrived?" A reader who scrolled up to re-read is never yanked back — including when the dock
 * resizes underneath them.
 */

/** How close to the bottom still counts as following along, in pixels. */
const NEAR_BOTTOM_PX = 80;

/**
 * How many trailing children to watch for late growth.
 *
 * Only the newest content can strand the view — with anchoring off, something resizing a hundred
 * messages up moves the whole column and the reader's position with it, which is correct. Watching a
 * 500-message backlog would cost far more than it could ever fix.
 */
const WATCHED_TAIL = 12;

export interface StickToBottom {
  /** Attach to the scrolling element. */
  ref: RefObject<HTMLDivElement>;
  /** Attach to that element's `onScroll` — this is what records whether the reader is following. */
  onScroll: () => void;
}

/**
 * @param deps Render-time signals that new content has arrived (message count, streaming text, …).
 *   The observer covers everything these miss; they are kept because they fire in the same commit
 *   as the content, which is a frame earlier than a resize callback.
 */
export function useStickToBottom(deps: readonly unknown[]): StickToBottom {
  const ref = useRef<HTMLDivElement>(null);
  // Captured in the scroll handler, not in the effect: the effect runs AFTER render, when
  // scrollHeight has already grown, so by then it can no longer measure the pre-update position.
  const nearBottomRef = useRef(true);

  const onScroll = useCallback((): void => {
    const el = ref.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  const stick = useCallback((): void => {
    const el = ref.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  // The caller owns this list by design — see the note above on why it is kept at all.
  useEffect(stick, deps);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // The element resizing is either the column growing (new/taller content) or the viewport
    // changing under it (the dock switching modes, an approval strip appearing, a phone keyboard
    // opening). Neither fires a scroll event, and both move where "the bottom" is.
    const ro = new ResizeObserver(() => stick());
    ro.observe(el);
    for (const child of Array.from(el.children).slice(-WATCHED_TAIL)) ro.observe(child);
    return () => ro.disconnect();
    // `deps` is spread in so the observed TAIL is refreshed as messages arrive — a child observed
    // once would stop being the newest one.
  }, [stick, ...deps]);

  return { ref, onScroll };
}
