import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * "Contextual Bloom" reveal (spec Module 3). Instead of snapping in, the image
 * fades opacity + sharpness toward a target via a requestAnimationFrame loop,
 * so it appears to be painted into place as the reader arrives.
 *
 * `target` is 0..1 — the front-end drives it from scroll velocity / proximity;
 * the component eases the rendered value toward it each frame.
 */
export interface BloomTransitionProps {
  /** Desired bloom level, 0 (hidden/blurred) → 1 (fully revealed). */
  target: number;
  /** Easing factor per frame (0..1). Lower = slower bloom. Default 0.12. */
  easing?: number;
  children: ReactNode;
}

export function BloomTransition({ target, easing = 0.12, children }: BloomTransitionProps) {
  const [value, setValue] = useState(0);
  const valueRef = useRef(0);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const next = valueRef.current + (target - valueRef.current) * easing;
      const settled = Math.abs(target - next) < 0.001;
      valueRef.current = settled ? target : next;
      setValue(valueRef.current);
      frame.current = settled ? null : requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [target, easing]);

  return (
    <div
      style={{
        opacity: value,
        filter: `blur(${(1 - value) * 12}px)`,
        transition: "none",
        willChange: "opacity, filter",
      }}
    >
      {children}
    </div>
  );
}
