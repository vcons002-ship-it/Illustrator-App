import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

/**
 * A 3D PARTICLE FIELD THAT THE CONVERSATION LIVES INSIDE.
 *
 * Two populations, because they answer two different questions:
 *
 *   AMBIENT — a tethered volume of motes filling the chat's depth. Always drifting, pushed by the
 *   cursor, pulled back by a spring. This is the room the words are spoken in.
 *
 *   SPARKS — emitted AT the caret as letters arrive, thrown outward with real velocity, dancing on
 *   a slow orbit while they fade. These are the words themselves scattering the air. The earlier
 *   version only ever shoved ambient motes, which is why it read as "wiggle in place": nothing was
 *   ever born at the text.
 *
 * WHY THIS IS 3D WITHOUT WebGL. `packages/ui` ships raw TypeScript into three separate Vite builds,
 * and a WebGL library is several hundred kilobytes for a background. So the physics is genuinely
 * three-dimensional — position, velocity and every force carry a z — and the renderer projects it
 * through a pinhole camera: `scale = FOCAL / (FOCAL + z)`. That single division buys perspective,
 * parallax (near motes sweep further across the screen for the same world motion), size and alpha
 * falloff with distance, and depth-of-field. Painter's algorithm for occlusion: sort far to near.
 *
 * WHY A CANVAS AND AN IMPERATIVE HANDLE. Several hundred particles at 60fps is tens of thousands of
 * updates a second. Through React state that is 60 re-renders a second of a subtree containing the
 * whole chat — the cost `BloomTransition` already exists to avoid here. React renders this once.
 */

/** A mote of the ambient volume: where it is in space, and the home it is tethered to. */
export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  hx: number;
  hy: number;
  hz: number;
  /** World-space radius and base alpha, before perspective scales them. */
  r: number;
  a: number;
  /** Phase offset for the ambient drift, so no two motes wander in step. */
  ph: number;
  /** Where this mote was SEEDED. The home drifts when the field is disturbed; this is what it
   * eventually creeps back toward, and what keeps the volume evenly covered over hours. */
  sx: number;
  sy: number;
  sz: number;
}

/**
 * A spark thrown off the text. Untethered and mortal — it has no home to return to and dies when
 * its life runs out, which is what lets emission be continuous without the field ever filling up.
 */
export interface Spark {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 1 at birth, 0 at death. Drives both alpha and size, so a spark shrinks as it fades. */
  life: number;
  /** Life lost per frame. */
  decay: number;
  r: number;
  /** Orbit phase and radius — the "dance" — applied as a force, not a position, so a spark still
   * obeys its own momentum rather than being teleported onto a circle. */
  ph: number;
  spin: number;
}

/** Camera distance. Larger = weaker perspective; this is tuned so a mote at the back plane is
 * roughly half the size of one at the front. */
const FOCAL = 520;
/** How deep the volume is, in world units, either side of the screen plane. */
export const DEPTH = 260;

const SPRING = 0.018;
/** 0.97 rather than 0.94: a disturbed mote coasts ~6s instead of ~3s before it settles, which is
 * the difference between being nudged and drifting away. Measured, not chosen by feel. */
const DAMPING = 0.97;

/**
 * HOW MUCH A DISTURBANCE DRAGS A MOTE'S HOME ALONG WITH IT.
 *
 * A purely elastic tether means every mote returns to exactly where it started, so however hard the
 * field is disturbed it looks identical a few seconds later — "pushed around" for a moment and then
 * unchanged. Making the tether PLASTIC is what lets the field actually be rearranged: a strong shove
 * carries the home with it, and the mote settles somewhere new.
 *
 * It cannot be unbounded. Left alone, plasticity migrates the whole volume toward wherever the text
 * usually appears and the corners empty out, so homes are clamped to the box and creep back toward
 * the seed over a long timescale.
 */
export const PLASTICITY = 0.55;
/** Per-frame pull of a displaced home back to where it was seeded. ~40s to undo a full displacement
 * — slow enough to read as permanent, fast enough that the field never permanently thins. */
export const HOME_RECOVERY = 0.0004;
export const PULSE_RADIUS = 200;
/**
 * HOW MUCH DEPTH COUNTS TOWARD AN IMPULSE'S DISTANCE, and the reason the background stopped
 * reacting when this field became 3D.
 *
 * The volume is seeded across ±DEPTH (260) in z, and the impulse measured a plain 3D distance —
 * so any mote at |z| ≥ the radius was unreachable no matter where it sat on screen. That was HALF
 * of them, and the rest had a shrinking on-screen radius: 83px at z=100, 16px at z=129. The field
 * was doing exactly what it was told and almost none of it could be touched.
 *
 * The text is a PLANE in this scene, so its wake should be a flattened ellipsoid — wide across the
 * screen, shallow through depth — not a sphere. At 0.35 the reach is 200px at the screen plane and
 * still 178px at the very back.
 */
export const PULSE_Z_WEIGHT = 0.35;
/** Measured against this spring and damping: steady-state wander is ~79px per unit of drift. */
const DRIFT = 0.18;
const CURSOR_RADIUS = 150;
const CURSOR_PUSH = 0.42;

/** Hard ceiling on live sparks. Emission is per-keystroke and a model can stream for minutes, so
 * without this a long reply would grow the array without bound and take the frame rate with it. */
export const MAX_SPARKS = 320;

/**
 * Perspective projection through a pinhole at z = -FOCAL.
 *
 * Returns the screen position and the scale factor everything else is multiplied by — radius,
 * alpha, and the parallax that makes near motes sweep further than far ones for the same motion.
 * Clamped: a particle at or behind the camera would divide by zero or invert, turning the field
 * inside out for one frame.
 */
export function project(
  p: { x: number; y: number; z: number },
  cx: number,
  cy: number,
): { sx: number; sy: number; scale: number } {
  const scale = FOCAL / Math.max(FOCAL + p.z, 1);
  return { sx: cx + (p.x - cx) * scale, sy: cy + (p.y - cy) * scale, scale };
}

/** Ambient wander, on three incommensurate frequencies so the volume breathes in every axis. */
export function driftAcceleration(
  p: Pick<Particle, "ph">,
  t: number,
): { ax: number; ay: number; az: number } {
  return {
    ax: Math.cos(t * 0.00042 + p.ph) * DRIFT,
    ay: Math.sin(t * 0.00031 + p.ph * 1.7) * DRIFT,
    az: Math.sin(t * 0.00023 + p.ph * 2.3) * DRIFT * 0.8,
  };
}

/** Advance one tethered mote. PURE — the reason the physics is testable with no canvas or clock. */
export function stepParticle(p: Particle, dt: number): Particle {
  const d = DAMPING ** dt;
  const vx = (p.vx + (p.hx - p.x) * SPRING * dt) * d;
  const vy = (p.vy + (p.hy - p.y) * SPRING * dt) * d;
  const vz = (p.vz + (p.hz - p.z) * SPRING * dt) * d;
  // The home creeps back toward where this mote was seeded, undoing accumulated displacement over
  // roughly forty seconds. Without it the field slowly migrates to wherever the text appears.
  const k = HOME_RECOVERY * dt;
  return {
    ...p,
    vx,
    vy,
    vz,
    x: p.x + vx * dt,
    y: p.y + vy * dt,
    z: p.z + vz * dt,
    hx: p.hx + (p.sx - p.hx) * k,
    hy: p.hy + (p.sy - p.hy) * k,
    hz: p.hz + (p.sz - p.hz) * k,
  };
}

/**
 * Drag a mote's home toward where it currently is, in proportion to how hard it was hit.
 *
 * This is what turns a shove into a rearrangement. Clamped to the box so a mote displaced near an
 * edge cannot be pushed out of the field and stranded off screen, invisible but still simulated.
 */
export function displaceHome(p: Particle, hit: number, w: number, h: number): Particle {
  const k = Math.min(1, hit) * PLASTICITY;
  if (k <= 0) return p;
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));
  return {
    ...p,
    hx: clamp(p.hx + (p.x - p.hx) * k, 0, Math.max(0, w)),
    hy: clamp(p.hy + (p.y - p.hy) * k, 0, Math.max(0, h)),
    hz: clamp(p.hz + (p.z - p.hz) * k, -DEPTH, DEPTH),
  };
}

/**
 * Advance one spark. No spring — a spark is free — but it drags, drifts back toward the screen
 * plane so the dance stays legible rather than vanishing into depth, and orbits its own axis.
 *
 * Returns null when it dies, so the caller can filter in one pass.
 */
export function stepSpark(s: Spark, dt: number, t: number): Spark | null {
  const life = s.life - s.decay * dt;
  if (life <= 0) return null;
  const drag = 0.955 ** dt;
  // The dance: a slow circular force, each spark on its own phase.
  const ox = Math.cos(t * 0.004 + s.ph) * s.spin;
  const oy = Math.sin(t * 0.004 + s.ph) * s.spin;
  const vx = (s.vx + ox * dt) * drag;
  const vy = (s.vy + oy * dt - 0.012 * dt) * drag; // a whisper of lift, so sparks rise as they fade
  const vz = (s.vz - s.z * 0.004 * dt) * drag;
  return { ...s, life, vx, vy, vz, x: s.x + vx * dt, y: s.y + vy * dt, z: s.z + vz * dt };
}

/**
 * Velocity an impulse adds: outward in 3D, falling off quadratically to nothing at the radius.
 * Linear falloff moves the whole disc as a slab, which reads as a UI element sliding rather than
 * as air being displaced.
 */
export function impulseVelocity(
  p: Pick<Particle, "x" | "y" | "z">,
  cx: number,
  cy: number,
  strength: number,
  radius = PULSE_RADIUS,
): { vx: number; vy: number; vz: number } {
  const dx = p.x - cx;
  const dy = p.y - cy;
  // Depth counts for less than screen distance — see PULSE_Z_WEIGHT. The push it receives is still
  // in true 3D; only the reach is flattened.
  const dz = p.z * PULSE_Z_WEIGHT;
  const d = Math.hypot(dx, dy, dz);
  if (d > radius) return { vx: 0, vy: 0, vz: 0 };
  // A particle exactly on the impulse has no direction; pick one rather than dividing by zero and
  // producing NaN, which would silently remove it from every later frame with nothing logged.
  const [ux, uy, uz] = d < 0.001 ? [0, -1, 0] : [dx / d, dy / d, dz / d];
  const f = (1 - d / radius) ** 2 * strength;
  return { vx: ux * f, vy: uy * f, vz: uz * f };
}

/** Sparks born at a point: thrown outward on a random 3D direction, with spread in life and size. */
export function emitSparks(x: number, y: number, n: number, rnd: () => number): Spark[] {
  const out: Spark[] = [];
  for (let i = 0; i < n; i++) {
    // Uniform on a sphere — a naive (rnd, rnd, rnd) direction clusters toward the cube's corners
    // and the burst comes out visibly boxy.
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    const speed = 0.9 + rnd() * 2.4;
    out.push({
      x,
      y,
      z: (rnd() - 0.5) * 40,
      vx: Math.sin(ph) * Math.cos(th) * speed,
      vy: Math.sin(ph) * Math.sin(th) * speed,
      vz: Math.cos(ph) * speed * 0.6,
      life: 1,
      decay: 0.006 + rnd() * 0.008,
      r: 0.8 + rnd() * 1.6,
      ph: rnd() * Math.PI * 2,
      spin: 0.02 + rnd() * 0.05,
    });
  }
  return out;
}

/** Lay the ambient volume out on a jittered 3D grid: even coverage, no visible rows. */
export function seedParticles(w: number, h: number, count: number, rnd: () => number): Particle[] {
  const out: Particle[] = [];
  const cols = Math.max(1, Math.round(Math.sqrt((count * w) / Math.max(h, 1))));
  const rows = Math.max(1, Math.ceil(count / cols));
  for (let i = 0; i < count; i++) {
    const cx = ((i % cols) + 0.5) * (w / cols) + (rnd() - 0.5) * (w / cols) * 0.9;
    const cy = (Math.floor(i / cols) + 0.5) * (h / rows) + (rnd() - 0.5) * (h / rows) * 0.9;
    const cz = (rnd() - 0.5) * 2 * DEPTH;
    out.push({
      x: cx,
      y: cy,
      z: cz,
      vx: 0,
      vy: 0,
      vz: 0,
      hx: cx,
      hy: cy,
      hz: cz,
      r: 0.7 + rnd() * 1.6,
      a: 0.16 + rnd() * 0.36,
      ph: rnd() * Math.PI * 2,
      sx: cx,
      sy: cy,
      sz: cz,
    });
  }
  return out;
}

/**
 * Choose the text node a caret would sit at the end of: the LAST one with actual characters.
 *
 * Split out from the DOM walk so the decision is testable — the walk itself is three lines of
 * TreeWalker, but "which node" is where the bugs live. Trailing whitespace-only nodes are the
 * common case markdown leaves behind, and picking one puts the caret in the margin.
 */
export function pickLastTextNode<T extends { data: string }>(nodes: readonly T[]): T | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (n.data.trim().length > 0) return n;
  }
  return null;
}

/**
 * Where the newest character actually is, in viewport coordinates.
 *
 * The reason this exists: the emission used to measure the BUBBLE, which is a wide box, so sparks
 * spawned at its bottom-right corner — nowhere near the text, and barely moving as words arrived.
 * A collapsed Range would give a zero-width rect in some engines, so this selects the final
 * character and takes the last of its client rects, which is a real box on a real line.
 */
export function lastCharRect(el: Element): DOMRect | null {
  if (typeof document === "undefined") return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const node = pickLastTextNode(nodes);
  if (!node) return null;
  const range = document.createRange();
  range.setStart(node, Math.max(0, node.data.length - 1));
  range.setEnd(node, node.data.length);
  const rects = range.getClientRects();
  return rects.length ? rects[rects.length - 1]! : null;
}

/**
 * Where the caret sits in a plain text field, in viewport x.
 *
 * A <textarea>'s value lives in its `value`, not in text nodes, so a Range cannot select it the way
 * `lastCharRect` does for a reply. The first version of this multiplied the character count by an
 * assumed ~0.52em advance — which is wrong per glyph and, worse, wrong CUMULATIVELY: the error
 * compounds along the line, so it landed about a tab too far right by the time you had typed a few
 * words.
 *
 * `measureText` with the field's own computed font has no such drift. The caller supplies the width,
 * because measuring belongs to the DOM and this stays a pure clamp: text origin plus advance, held
 * inside the box so a long line still emits somewhere real.
 */
export function caretXFromWidth(
  textWidth: number,
  textLeft: number,
  right: number,
): number {
  return Math.max(textLeft, Math.min(textLeft + textWidth, right - 8));
}

/** One reusable measuring context. Creating a canvas per keystroke is an allocation and a layout. */
let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Advance width of `text` in the exact font `el` renders with, or null if canvas is unavailable. */
export function measureTextWidth(text: string, el: Element): number | null {
  if (typeof document === "undefined") return null;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return null;
  const cs = getComputedStyle(el);
  // The `font` shorthand can come back empty in some engines; rebuild it when it does.
  measureCtx.font = cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return measureCtx.measureText(text).width;
}

export interface ParticleFieldHandle {
  /** Push the volume outward from a point in VIEWPORT coordinates. */
  pulse: (clientX: number, clientY: number, strength?: number) => void;
  /** Throw sparks off the text at a point in VIEWPORT coordinates. */
  emit: (clientX: number, clientY: number, count?: number) => void;
}

export function ParticleField({
  handleRef,
  density = 0.00019,
  className,
}: {
  handleRef?: Ref<ParticleFieldHandle>;
  /** Motes per square pixel of the chat area. */
  density?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const partsRef = useRef<Particle[]>([]);
  const sparksRef = useRef<Spark[]>([]);
  const pendingRef = useRef<{ x: number; y: number; s: number }[]>([]);
  const emitRef = useRef<{ x: number; y: number; n: number }[]>([]);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);

  /** Deterministic PRNG — a shared one, so nothing here depends on Math.random. */
  const rndRef = useRef<() => number>(() => 0);
  if (rndRef.current() === 0) {
    let seed = 20260812;
    rndRef.current = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }

  useImperativeHandle(handleRef, () => {
    const toLocal = (cxp: number, cyp: number): { x: number; y: number } | null => {
      const el = canvasRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: cxp - r.left, y: cyp - r.top };
    };
    return {
      // Both queue rather than act: they are called from streaming updates, which can land several
      // times between frames, and the loop drains the queue once per frame.
      pulse: (clientX, clientY, strength = 2.4) => {
        const l = toLocal(clientX, clientY);
        if (l) pendingRef.current.push({ ...l, s: strength });
      },
      emit: (clientX, clientY, count = 7) => {
        const l = toLocal(clientX, clientY);
        if (l) emitRef.current.push({ ...l, n: count });
      },
    };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rnd = rndRef.current;

    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const accent =
      getComputedStyle(canvas).getPropertyValue("--vr-accent-rgb").trim() || "122 162 255";
    const [cr, cg, cb] = accent.split(/\s+/).map(Number);

    let raf = 0;
    let last = 0;
    let w = 0;
    let h = 0;

    const resize = (): void => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      let s = 1;
      const seeded = (): number => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
      };
      partsRef.current = seedParticles(w, h, Math.round(w * h * density), seeded);
    };

    const draw = (): void => {
      const midX = w / 2;
      const midY = h / 2;
      // Painter's algorithm: far to near, so nearer motes occlude the ones behind them.
      const all: { z: number; sx: number; sy: number; rad: number; alpha: number; hot: number }[] = [];
      for (const p of partsRef.current) {
        const { sx, sy, scale } = project(p, midX, midY);
        const speed = Math.hypot(p.vx, p.vy, p.vz);
        all.push({
          z: p.z,
          sx,
          sy,
          rad: Math.max(0.2, (p.r + Math.min(speed * 0.6, 1.4)) * scale),
          alpha: Math.min(1, (p.a + speed * 0.45) * scale),
          hot: Math.min(1, speed * 0.5),
        });
      }
      for (const s of sparksRef.current) {
        const { sx, sy, scale } = project(s, midX, midY);
        all.push({
          z: s.z,
          sx,
          sy,
          rad: Math.max(0.2, s.r * scale * (0.4 + s.life * 0.9)),
          alpha: Math.min(1, s.life * s.life * 0.95 * scale),
          hot: 1,
        });
      }
      all.sort((a, b) => b.z - a.z);

      ctx.clearRect(0, 0, w, h);
      for (const d of all) {
        // Hot particles get a halo — the wake of the typing reads as light rather than as motion.
        if (d.hot > 0.35) {
          ctx.beginPath();
          ctx.arc(d.sx, d.sy, d.rad * 3.2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${d.alpha * 0.13 * d.hot})`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(d.sx, d.sy, d.rad, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${d.alpha})`;
        ctx.fill();
      }
    };

    const frame = (now: number): void => {
      const dt = last ? Math.min((now - last) / 16.667, 3) : 1;
      last = now;

      const pending = pendingRef.current;
      pendingRef.current = [];
      const births = emitRef.current;
      emitRef.current = [];

      for (const b of births) {
        const room = MAX_SPARKS - sparksRef.current.length;
        if (room > 0) sparksRef.current.push(...emitSparks(b.x, b.y, Math.min(b.n, room), rnd));
      }

      const parts = partsRef.current;
      for (let i = 0; i < parts.length; i++) {
        let p = parts[i]!;
        let hit = 0;
        for (const q of pending) {
          const v = impulseVelocity(p, q.x, q.y, q.s);
          if (v.vx || v.vy || v.vz) {
            hit += Math.hypot(v.vx, v.vy, v.vz);
            p = { ...p, vx: p.vx + v.vx, vy: p.vy + v.vy, vz: p.vz + v.vz };
          }
        }
        const { ax, ay, az } = driftAcceleration(p, now);
        let vx = p.vx + ax * dt;
        let vy = p.vy + ay * dt;
        const vz = p.vz + az * dt;
        const cur = cursorRef.current;
        if (cur) {
          const cv = impulseVelocity(p, cur.x, cur.y, CURSOR_PUSH * dt, CURSOR_RADIUS);
          vx += cv.vx;
          vy += cv.vy;
        }
        // Only a real disturbance rearranges the field — ambient drift and the cursor's constant
        // nudge must not, or the volume would slowly migrate wherever the pointer spends its time.
        if (hit > 0.35) p = displaceHome({ ...p, vx, vy, vz }, hit / 3, w, h);
        parts[i] = stepParticle({ ...p, vx, vy, vz }, dt);
      }

      const live: Spark[] = [];
      for (const s of sparksRef.current) {
        const n = stepSpark(s, dt, now);
        if (n) live.push(n);
      }
      sparksRef.current = live;

      draw();
      raf = requestAnimationFrame(frame);
    };

    const onPointer = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      cursorRef.current = x < -40 || y < -40 || x > r.width + 40 || y > r.height + 40 ? null : { x, y };
    };
    const onLeave = (): void => {
      cursorRef.current = null;
    };
    if (!reduced) {
      document.addEventListener("pointermove", onPointer, { passive: true });
      document.addEventListener("pointerleave", onLeave, { passive: true });
    }

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    if (!reduced) raf = requestAnimationFrame(frame);
    else draw(); // reduced motion means no ANIMATION, not a blank background

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("pointermove", onPointer);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, [density]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
