import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

/**
 * A DRIFTING PARTICLE FIELD THAT THE ASSISTANT'S TYPING PUSHES AROUND.
 *
 * Sits behind the conversation, full-bleed, `pointer-events: none`. Every few characters the model
 * emits, the caret's screen position is handed to `pulse()` and the particles near it are shoved
 * outward, then drawn back by a spring. The text appears to displace the air around it.
 *
 * WHY A CANVAS AND AN IMPERATIVE HANDLE. A hundred particles at 60fps is 6,000 position updates a
 * second. Through React state that is 60 re-renders a second of a subtree containing the entire
 * chat — the exact cost `BloomTransition` already exists to avoid in this codebase. So the field
 * owns a canvas, runs its own rAF loop, and exposes one method. React renders it once.
 *
 * WHY IT STAYS CALM. "Beautiful but not overwhelming" is a constraint on the physics, not a note on
 * the palette: low density, slow drift, a spring that always wins, and an impulse that decays with
 * distance. Nothing here can build up energy over time — every particle is permanently tethered to
 * a home position, so the field always settles back to stillness after the model stops typing.
 */

/** One particle: where it is, how fast, and the home it is always pulled back toward. */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Home position — the tether that guarantees the field settles. */
  hx: number;
  hy: number;
  /** Per-particle size and base alpha, so the field has depth rather than reading as a grid. */
  r: number;
  a: number;
}

/** Spring constant pulling a particle home. Higher = snappier return, less lingering drift. */
const SPRING = 0.018;
/** Velocity retained per frame. Below ~0.9 the motion dies before it reads as physics. */
const DAMPING = 0.94;
/** How far an impulse reaches, in CSS pixels. */
export const PULSE_RADIUS = 130;

/**
 * Advance one particle by one frame. PURE — the whole reason the physics is testable without a
 * canvas, a DOM, or a clock.
 *
 * `dt` is in frames (1 = a 60fps frame), not milliseconds, so a dropped frame scales the step
 * instead of freezing the field. Clamped by the caller: a backgrounded tab returns dt in the
 * hundreds, which would fling every particle off screen on the first frame back.
 */
export function stepParticle(p: Particle, dt: number): Particle {
  const ax = (p.hx - p.x) * SPRING;
  const ay = (p.hy - p.y) * SPRING;
  const vx = (p.vx + ax * dt) * DAMPING ** dt;
  const vy = (p.vy + ay * dt) * DAMPING ** dt;
  return { ...p, vx, vy, x: p.x + vx * dt, y: p.y + vy * dt };
}

/**
 * The velocity an impulse at (cx, cy) adds to a particle: outward, falling off to nothing at the
 * radius. Returns zero beyond it, so a pulse can never reach the whole field at once.
 *
 * Quadratic falloff rather than linear — linear makes the whole disc move as a slab, which reads
 * as a UI element sliding rather than as air being displaced.
 */
export function impulseVelocity(
  p: Pick<Particle, "x" | "y">,
  cx: number,
  cy: number,
  strength: number,
  radius = PULSE_RADIUS,
): { vx: number; vy: number } {
  const dx = p.x - cx;
  const dy = p.y - cy;
  const d = Math.hypot(dx, dy);
  if (d > radius) return { vx: 0, vy: 0 };
  // A particle sitting exactly on the impulse has no direction to go; pick one deterministically
  // rather than dividing by zero and producing NaN, which would silently blank the whole field.
  const ux = d < 0.001 ? 0 : dx / d;
  const uy = d < 0.001 ? -1 : dy / d;
  const falloff = (1 - d / radius) ** 2;
  return { vx: ux * strength * falloff, vy: uy * strength * falloff };
}

/** Lay particles out on a jittered grid: even coverage without the visible rows of a true grid. */
export function seedParticles(w: number, h: number, count: number, rnd: () => number): Particle[] {
  const out: Particle[] = [];
  const cols = Math.max(1, Math.round(Math.sqrt((count * w) / Math.max(h, 1))));
  const rows = Math.max(1, Math.ceil(count / cols));
  for (let i = 0; i < count; i++) {
    const cx = ((i % cols) + 0.5) * (w / cols) + (rnd() - 0.5) * (w / cols) * 0.8;
    const cy = (Math.floor(i / cols) + 0.5) * (h / rows) + (rnd() - 0.5) * (h / rows) * 0.8;
    out.push({
      x: cx,
      y: cy,
      vx: 0,
      vy: 0,
      hx: cx,
      hy: cy,
      r: 0.7 + rnd() * 1.5,
      a: 0.18 + rnd() * 0.34,
    });
  }
  return out;
}

export interface ParticleFieldHandle {
  /** Push the field outward from a point in VIEWPORT coordinates (what getBoundingClientRect
   * returns) — the component converts to its own canvas space. */
  pulse: (clientX: number, clientY: number, strength?: number) => void;
}

export function ParticleField({
  handleRef,
  density = 0.00007,
  className,
}: {
  handleRef?: Ref<ParticleFieldHandle>;
  /** Particles per square pixel. Deliberately sparse — this is atmosphere, not a screensaver. */
  density?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const partsRef = useRef<Particle[]>([]);
  const pendingRef = useRef<{ x: number; y: number; s: number }[]>([]);

  useImperativeHandle(handleRef, () => ({
    pulse: (clientX, clientY, strength = 2.4) => {
      const el = canvasRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Queued rather than applied here: pulses arrive on streaming updates, which can land
      // several times between frames. Applying each immediately would do the same work repeatedly
      // against a field that hasn't moved.
      pendingRef.current.push({ x: clientX - r.left, y: clientY - r.top, s: strength });
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Honour the OS setting. A field of drifting dots is exactly the kind of ambient motion that
    // setting exists for, so it is not merely slowed — it is never started.
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    // The accent, read from the cascade rather than hardcoded, so the field follows the palette.
    const accent =
      getComputedStyle(canvas).getPropertyValue("--vr-accent-rgb").trim() || "122 162 255";
    const [cr, cg, cb] = accent.split(/\s+/).map(Number);

    let raf = 0;
    let last = 0;
    let w = 0;
    let h = 0;

    const resize = (): void => {
      const dpr = Math.min(devicePixelRatio || 1, 2); // 3x on a phone is a lot of fill rate for atmosphere
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Deterministic seeding, so a resize doesn't reshuffle the whole field into a new pattern.
      let seed = 1;
      const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      partsRef.current = seedParticles(w, h, Math.round(w * h * density), rnd);
    };

    const frame = (now: number): void => {
      const dt = last ? Math.min((now - last) / 16.667, 3) : 1; // clamp: a backgrounded tab returns a huge delta
      last = now;

      const pending = pendingRef.current;
      pendingRef.current = [];
      const parts = partsRef.current;

      for (let i = 0; i < parts.length; i++) {
        let p = parts[i]!;
        for (const q of pending) {
          const { vx, vy } = impulseVelocity(p, q.x, q.y, q.s);
          if (vx || vy) p = { ...p, vx: p.vx + vx, vy: p.vy + vy };
        }
        parts[i] = stepParticle(p, dt);
      }

      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        // Moving particles brighten: the wake of the typing reads as light, not as displacement.
        const speed = Math.hypot(p.vx, p.vy);
        const alpha = Math.min(1, p.a + speed * 0.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + Math.min(speed * 0.6, 1.4), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    if (!reduced) raf = requestAnimationFrame(frame);
    else {
      // Draw the field once, still. Reduced motion means no ANIMATION, not a blank background.
      ctx.clearRect(0, 0, w, h);
      for (const p of partsRef.current) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${p.a})`;
        ctx.fill();
      }
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [density]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
