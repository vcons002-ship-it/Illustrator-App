import { useEffect, useState } from "react";

/**
 * Reports whether the viewport is at most `maxPx` wide ("narrow" / phone-sized).
 *
 * Inline styles can't express media queries, and `isDesktop` is a Tauri flag —
 * not a width — so layout that must react to screen width (single-column reader,
 * auto-collapsed toolbar/chat history) reads this hook instead. Backed by
 * `matchMedia` so it only re-renders when the breakpoint is actually crossed,
 * rather than on every resize tick.
 */
export function useNarrow(maxPx = 760): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= maxPx,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width:${maxPx}px)`);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [maxPx]);
  return narrow;
}
