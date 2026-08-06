import { useEffect, useState } from "react";

/**
 * Does the reader want motion reduced?
 *
 * The CSS side is handled globally in styles/motion.css, but two things animate from
 * JavaScript and cannot see a media query: `BloomTransition`'s requestAnimationFrame easing,
 * and the dock's automatic promotion. Both need to know.
 *
 * Mirrors the matchMedia pattern in useMediaQuery.ts — subscribe to changes, and re-render
 * only when the answer actually flips.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReduced(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
