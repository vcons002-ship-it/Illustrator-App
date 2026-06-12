import { useEffect, useRef, type ReactNode } from "react";

/**
 * "Contextual Bloom" reveal (spec Module 3). Instead of snapping in, the image
 * fades opacity + sharpness toward a target via a requestAnimationFrame loop,
 * so it appears to be painted into place as the reader arrives.
 *
 * `target` is 0..1 — the front-end drives it from scroll velocity / proximity;
 * the component eases the rendered value toward it each frame.
 *
 * The eased value is written straight to the wrapper div's style (not React
 * state): `target` changes on virtually every scroll frame while reading, and a
 * setState per animation frame re-rendered the subtree — up to 9 panels' worth —
 * for a value React never needs to see. Visuals are identical.
 */
export interface BloomTransitionProps {
  /** Desired bloom level, 0 (hidden/blurred) → 1 (fully revealed). */
  target: number;
  /** Easing factor per frame (0..1). Lower = slower bloom. Default 0.12. */
  easing?: number;
  children: ReactNode;
}

export function BloomTransition({ target, easing = 0.12, children }: BloomTransitionProps) {
  const el = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(0);
  const targetRef = useRef(target);
  const easingRef = useRef(easing);
  const frame = useRef<number | null>(null);
  targetRef.current = target;
  easingRef.current = easing;

  const apply = (value: number): void => {
    if (!el.current) return;
    el.current.style.opacity = String(value);
    el.current.style.filter = `blur(${(1 - value) * 12}px)`;
  };

  // One persistent loop per mount; a new target just updates the ref the loop
  // reads (no effect teardown/re-schedule per scroll frame). The loop parks
  // itself when settled and is woken by the target-change effect below.
  const ensureRunning = useRef<() => void>(() => {});
  useEffect(() => {
    const tick = (): void => {
      const target = targetRef.current;
      const next = valueRef.current + (target - valueRef.current) * easingRef.current;
      const settled = Math.abs(target - next) < 0.001;
      valueRef.current = settled ? target : next;
      apply(valueRef.current);
      frame.current = settled ? null : requestAnimationFrame(tick);
    };
    ensureRunning.current = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
    };
    ensureRunning.current();
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, []);

  useEffect(() => {
    ensureRunning.current();
  }, [target, easing]);

  return (
    <div
      ref={(node) => {
        el.current = node;
        // Paint the current value immediately on mount, before the first tick.
        if (node) apply(valueRef.current);
      }}
      style={{
        opacity: valueRef.current,
        filter: `blur(${(1 - valueRef.current) * 12}px)`,
        transition: "none",
        willChange: "opacity, filter",
      }}
    >
      {children}
    </div>
  );
}
