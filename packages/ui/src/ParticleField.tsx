import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

/**
 * A 3D PARTICLE FIELD THAT THE CONVERSATION LIVES INSIDE.
 *
 * Two populations, because they answer two different questions:
 *
 *   AMBIENT — a volume of FREE motes filling the screen's depth. Each cruises at its own slow
 *   drift, takes every push in full, coasts, decelerates on drag, and stays wherever it ends up.
 *   Nothing pulls it back. This is the room the words are spoken in.
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

/**
 * A mote of the ambient volume. It has a position, a velocity, and NO HOME.
 *
 * THE HOME WAS THE JELLO. Every earlier version tethered each mote to a fixed point with a spring,
 * and then tried to buy travel back with plasticity, released tethers and decaying slack. It never
 * worked, and it never could have: the strongest impulse in the app — sending a message — threw a
 * mote 86px in half a second and had it back within 12px by frame 60 and 1px by frame 300. Out and
 * straight back to exactly where it started, every time, which is the definition of a wobble. Three
 * separate rounds of "the particles just wiggle" were all this one decision.
 *
 * A mote now travels at its own slow drift, takes a push in full, coasts, decelerates on drag, and
 * simply stays wherever it ends up. Coverage is kept by WRAPPING at the edges of the volume rather
 * than by a restoring force, which is the part the spring was really there for.
 */
export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** World-space radius and base alpha, before perspective scales them. */
  r: number;
  a: number;
  /** Phase offset: seeds this mote's heading and its wander, so no two travel in step. */
  ph: number;
  /** Its own cruising speed, in px per frame. What it returns to after being disturbed. */
  spd: number;
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

/**
 * HOW FAST A DISTURBED MOTE BLEEDS BACK TO ITS CRUISING SPEED.
 *
 * The only thing opposing an impulse now — there is no spring. 0.985 gives a time constant of about
 * 67 frames, so a shove takes just over a second to fade and carries the mote roughly 66× the
 * velocity it was given: ~350px for a send, ~100px for a keystroke. That is a mote being thrown
 * across the screen and coasting to a stop, which is what was asked for four times.
 */
const DRAG = 0.985;
/**
 * Terminal velocity, and not a decoration. Without a spring there is nothing to bound a force that
 * arrives repeatedly — streaming fires a pulse per token, and a mote sitting near the caret would
 * otherwise integrate them into the hundreds of px per frame and vanish. 66× amplification is what
 * makes the field feel alive and is exactly what makes an unbounded sum dangerous.
 */
export const MAX_SPEED = 7;
/** How far outside the box a mote travels before it reappears on the opposite side. Wide enough
 * that the wrap happens off screen rather than as a dot blinking out mid-air. */
export const WRAP_MARGIN = 60;
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
/** Cruising speed, in px per frame. 0.25 crosses a 1080p screen in about two minutes — clearly
 * moving, never busy. Each mote gets its own value in this band so the field has no single pace. */
export const DRIFT_MIN = 0.12;
export const DRIFT_MAX = 0.45;
const CURSOR_RADIUS = 150;
/**
 * 0.05, down from 0.42. The cursor pushes EVERY FRAME it is inside the radius, and with the spring
 * gone there is nothing to balance it: at the old value a mote parked near the pointer would reach
 * 0.42 × 66 = 28px per frame and be gone. The clamp would have caught the disaster; it would not
 * have caught the field quietly evacuating wherever the pointer rests.
 */
const CURSOR_PUSH = 0.05;

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

/**
 * The velocity this mote WANTS to be travelling at — its cruising drift.
 *
 * A heading rather than an acceleration, and that distinction is what keeps the field safe. An
 * ambient acceleration added on top of a drag would settle at `a / (1 - DRAG)`, which at this drag
 * is 66× whatever looked like a small number; a heading has the mote's own speed by construction,
 * so no tuning of the wander can ever make the volume take off.
 *
 * The heading swings slowly on two incommensurate frequencies, so paths curve and no two motes
 * travel in step, but the SPEED never changes.
 */
export function baseDrift(
  p: Pick<Particle, "ph" | "spd">,
  t: number,
): { dx: number; dy: number; dz: number } {
  const a = p.ph + Math.sin(t * 0.00013 + p.ph) * 1.7;
  const b = p.ph * 1.7 + Math.cos(t * 0.00011 + p.ph * 2.3) * 1.3;
  // A proper spherical heading, not an xy unit vector with a z bolted on: that version reached
  // 1.17x the mote's own speed at the extremes, which is small, invisible, and exactly the kind of
  // slow leak that only shows up as "the field is faster than it should be" months later.
  // Elevation is deliberately shallow — the volume drifts ACROSS the screen far more than through it.
  const el = Math.sin(b) * 0.55;
  const flat = Math.cos(el) * p.spd;
  return { dx: Math.cos(a) * flat, dy: Math.sin(a) * flat, dz: Math.sin(el) * p.spd };
}

/**
 * Bring a mote back into the volume by carrying it out the opposite side.
 *
 * This is what replaced the spring. Coverage used to be maintained by pulling every mote back to a
 * fixed home, which is also precisely what made a push impossible to see through. Wrapping keeps
 * the volume statistically even — a uniform distribution stays uniform under a wrapping flow — and
 * costs a disturbed mote nothing: it keeps its velocity and simply carries on somewhere else.
 */
export function wrapPosition(p: Particle, w: number, h: number): Particle {
  const span = (v: number, lo: number, hi: number): number => {
    const size = hi - lo;
    if (size <= 0) return v;
    return lo + (((v - lo) % size) + size) % size;
  };
  return {
    ...p,
    x: span(p.x, -WRAP_MARGIN, Math.max(1, w) + WRAP_MARGIN),
    y: span(p.y, -WRAP_MARGIN, Math.max(1, h) + WRAP_MARGIN),
    z: span(p.z, -DEPTH, DEPTH),
  };
}

/** Advance one free mote. PURE — the reason the physics is testable with no canvas or clock. */
export function stepParticle(p: Particle, dt: number, t: number, w: number, h: number): Particle {
  const d = DRAG ** dt;
  const { dx, dy, dz } = baseDrift(p, t);
  // Velocity relaxes toward the DRIFT, not toward zero. A mote that has been thrown decelerates
  // until it is cruising again — from wherever the throw left it, with nothing pulling it back.
  let vx = dx + (p.vx - dx) * d;
  let vy = dy + (p.vy - dy) * d;
  let vz = dz + (p.vz - dz) * d;
  const speed = Math.hypot(vx, vy, vz);
  if (speed > MAX_SPEED) {
    const k = MAX_SPEED / speed;
    vx *= k;
    vy *= k;
    vz *= k;
  }
  return wrapPosition(
    { ...p, vx, vy, vz, x: p.x + vx * dt, y: p.y + vy * dt, z: p.z + vz * dt },
    w,
    h,
  );
}

/**
 * Advance one spark. It drags, recedes into depth, and orbits its own axis. Motes and sparks are
 * both free now, so the only real difference left is that a spark is mortal — which is what lets
 * emission run continuously without the field growing without bound.
 *
 * Returns null when it dies, so the caller can filter in one pass.
 */
export function stepSpark(s: Spark, dt: number, t: number): Spark | null {
  const life = s.life - s.decay * dt;
  if (life <= 0) return null;
  // 0.985, not 0.955: a spark thrown off a letter should CARRY. At the old drag it lost almost all
  // its speed within a few frames and danced on the spot, which is not what being thrown looks like.
  const drag = 0.985 ** dt;
  // The dance rides on top of the travel rather than replacing it — a small circular force, each
  // spark on its own phase, so a burst spreads instead of moving as one clump.
  const ox = Math.cos(t * 0.004 + s.ph) * s.spin;
  const oy = Math.sin(t * 0.004 + s.ph) * s.spin;
  const vx = (s.vx + ox * dt) * drag;
  /**
   * NO LIFT. There was a constant -0.012/frame here, described as "a whisper" — against this drag
   * that is a terminal speed of 0.8px per frame, so every spark rose 57–134px before it converted.
   *
   * A whisper applied to EVERY spark is not a whisper, it is a current. The burst acquired a net
   * upward flow, and because spent sparks become motes where they land, the field accumulated them
   * up there too. From the outside that reads exactly as a centre of gravity hanging above the
   * chat — an attractor nobody wrote, made of a bias nobody would notice in one particle.
   *
   * A spark now carries only what it was thrown with, its own orbit, and drag. It shoots away and
   * slows down, which is all it was ever supposed to do.
   */
  const vy = (s.vy + oy * dt) * drag;
  // Receding INTO the volume rather than being pulled back to the screen plane. This is what makes
  // the letters look like they are throwing material into the background instead of sprinkling it
  // in front of the text.
  const vz = (s.vz + 0.06 * dt) * drag;
  return { ...s, life, vx, vy, vz, x: s.x + vx * dt, y: s.y + vy * dt, z: s.z + vz * dt };
}

/**
 * A spent spark becomes part of the background it flew into.
 *
 * Sparks used to simply vanish, so the field they were thrown through was never actually changed by
 * the typing — the words scattered some light and the room went back to exactly how it was. Handing
 * the spark's final position AND ITS VELOCITY to a new mote is what makes typing add to the
 * background rather than decorate it: the mote carries on along the spark's last trajectory and
 * decelerates into the drift, so there is no seam where one becomes the other.
 *
 * Nothing to seed and nothing to recover any more. A free mote is even coverage by construction —
 * it wanders, it wraps, and where it happened to be born stops mattering within seconds.
 */
export function sparkToParticle(s: Spark, rnd: () => number): Particle {
  const z = Math.max(-DEPTH, Math.min(s.z, DEPTH));
  return {
    x: s.x,
    y: s.y,
    z,
    vx: s.vx,
    vy: s.vy,
    vz: s.vz,
    r: 0.7 + rnd() * 1.2,
    a: 0.16 + rnd() * 0.3,
    ph: rnd() * Math.PI * 2,
    spd: DRIFT_MIN + rnd() * (DRIFT_MAX - DRIFT_MIN),
  };
}

/**
 * The pull a newly-formed bubble exerts, drawing nearby motes toward it.
 *
 * The mirror of `impulseVelocity` — inward rather than outward, weakest at the centre so nothing
 * piles up in a point, and reaching further because a message landing is a larger event than a
 * keystroke. A bubble condensing out of loose text ought to gather the air around it.
 */
export function attractVelocity(
  p: Pick<Particle, "x" | "y" | "z">,
  cx: number,
  cy: number,
  strength: number,
  radius: number,
): { vx: number; vy: number; vz: number } {
  const dx = cx - p.x;
  const dy = cy - p.y;
  const dz = -p.z * PULSE_Z_WEIGHT;
  const d = Math.hypot(dx, dy, dz);
  if (d > radius || d < 0.001) return { vx: 0, vy: 0, vz: 0 };
  // Ramps UP with distance inside the radius, so motes already close are barely touched and the
  // gather reads as a sweep inward rather than a collapse.
  const f = (d / radius) * (1 - d / radius) * 4 * strength;
  return { vx: (dx / d) * f, vy: (dy / d) * f, vz: (dz / d) * f };
}

/**
 * HOW MUCH OF A FRAME'S SCROLL A MOTE TAKES ON, and a number that had to be cut to a third when the
 * spring came out.
 *
 * Scroll is the only SUSTAINED force in this field — everything else lasts a single frame — so it
 * is the only one that integrates. At 0.028, tuned against a spring that used to balance it, even
 * a gentle 8px-per-frame scroll pinned every mote at the MAX_SPEED clamp within a couple of
 * seconds: not a room leaning with the page, a stampede. At 0.009 an ordinary reading flick lifts
 * the field to about 1px per frame over its 0.25 cruise — a visible lean — and only a sustained
 * fling reaches the clamp, where wrapping turns it into a sweep rather than an escape.
 */
export const SCROLL_DRAG = 0.009;
/** Scroll faster than this in one frame — a fling, a jump to a chapter — and the excess is ignored.
 * Without it a single wheel event would hand the whole field its terminal velocity. */
export const SCROLL_CLAMP = 60;

/**
 * WHAT SCROLLING DOES TO THE ROOM.
 *
 * The field sits behind the page, so moving the page ought to drag the air with it — and unevenly,
 * because the volume has depth. Motes near the front are carried nearly the full amount, ones at the
 * back barely notice. That difference is the whole effect: a rigid translation would just look like
 * the background scrolling too, whereas a parallax gradient makes the volume shear and mix.
 *
 * The lateral and depth components come from each mote's own phase, so a burst of scrolling
 * scatters the field rather than sliding it as one sheet.
 */
export function scrollVelocity(
  p: Pick<Particle, "z" | "ph">,
  dy: number,
): { vx: number; vy: number; vz: number } {
  const d = Math.max(-SCROLL_CLAMP, Math.min(dy, SCROLL_CLAMP));
  // 1 at the front plane, 0 at the back.
  const near = 1 - (p.z + DEPTH) / (2 * DEPTH);
  const push = -d * (0.35 + near) * SCROLL_DRAG;
  return {
    vx: Math.cos(p.ph * 3.1) * push * 0.35,
    vy: push,
    vz: Math.sin(p.ph * 2.3) * push * 0.2,
  };
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
    out.push({
      x: ((i % cols) + 0.5) * (w / cols) + (rnd() - 0.5) * (w / cols) * 0.9,
      y: (Math.floor(i / cols) + 0.5) * (h / rows) + (rnd() - 0.5) * (h / rows) * 0.9,
      z: (rnd() - 0.5) * 2 * DEPTH,
      vx: 0,
      vy: 0,
      vz: 0,
      r: 0.7 + rnd() * 1.6,
      a: 0.16 + rnd() * 0.36,
      ph: rnd() * Math.PI * 2,
      spd: DRIFT_MIN + rnd() * (DRIFT_MAX - DRIFT_MIN),
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

/**
 * WHERE THE CARET IS WHEN THE FIELD SOFT-WRAPS.
 *
 * A <textarea> wraps VISUALLY without inserting anything into its value, so splitting on "\n" says
 * a wrapped message is one enormous line. Its measured width then exceeds the field and the clamp
 * pins every spark to the right-hand edge — which is exactly what happens the moment you reach the
 * second line.
 *
 * So the wrap has to be reproduced: greedy, breaking at the last word that fits, exactly as the
 * browser does. A word longer than the whole line breaks by character, or the loop would never
 * advance and the count would run away.
 *
 * `measure` is injected rather than taken from a canvas here, which is what makes this testable
 * with an arithmetic stand-in instead of a font.
 */
export function wrapCaret(
  before: string,
  measure: (s: string) => number,
  maxWidth: number,
): { line: number; x: number } {
  let line = 0;
  let cur = "";
  const width = Math.max(1, maxWidth);

  for (const para of before.split("\n")) {
    cur = "";
    // Words carry their trailing whitespace so the measurement matches what is actually drawn.
    for (const token of para.match(/\S+\s*|\s+/g) ?? []) {
      let t = token;
      // A single token wider than the line: consume it a character at a time.
      while (cur === "" && measure(t) > width && t.length > 1) {
        let fit = 1;
        while (fit < t.length && measure(t.slice(0, fit + 1)) <= width) fit++;
        line++;
        t = t.slice(fit);
      }
      if (cur !== "" && measure(cur + t) > width) {
        line++;
        cur = t;
      } else {
        cur += t;
      }
    }
    line++; // an explicit newline always starts one
  }
  // The loop counts a break after the final paragraph too; the caret sits on the line before it.
  return { line: Math.max(0, line - 1), x: measure(cur) };
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
  /** Draw nearby motes IN toward a point — a bubble condensing gathers the air around it. */
  gather: (clientX: number, clientY: number, strength?: number, radius?: number) => void;
  /** Drag the volume along with a scroll, with parallax by depth so it shears rather than slides. */
  stir: (deltaY: number) => void;
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
  const pullRef = useRef<{ x: number; y: number; s: number; r: number }[]>([]);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const scrollRef = useRef(0);

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
      gather: (clientX, clientY, strength = 3, radius = 340) => {
        const l = toLocal(clientX, clientY);
        if (l) pullRef.current.push({ ...l, s: strength, r: radius });
      },
      // Accumulated rather than queued: several scroll events commonly land between two frames, and
      // what matters is the total distance travelled in that frame, not how many events carried it.
      stir: (deltaY) => {
        scrollRef.current += deltaY;
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
    let maxAmbient = 0;
    /** How many motes at the front of the array are original seeds. They are never retired. */
    let seedCount = 0;

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
      const n = Math.round(w * h * density);
      maxAmbient = Math.round(n * 1.6); // headroom for sparks that settle, without unbounded growth
      partsRef.current = seedParticles(w, h, n, seeded);
      seedCount = partsRef.current.length;
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
      const pulls = pullRef.current;
      pullRef.current = [];
      const scrolled = scrollRef.current;
      scrollRef.current = 0;

      for (const b of births) {
        const room = MAX_SPARKS - sparksRef.current.length;
        if (room > 0) sparksRef.current.push(...emitSparks(b.x, b.y, Math.min(b.n, room), rnd));
      }

      const parts = partsRef.current;
      for (let i = 0; i < parts.length; i++) {
        let vx = parts[i]!.vx;
        let vy = parts[i]!.vy;
        let vz = parts[i]!.vz;
        const p = parts[i]!;
        // Every force is now just velocity added to a free mote. No slack to release, no home to
        // drag, no distinction between a disturbance that rearranges the field and one that does
        // not — a mote goes where it is pushed and stays there, which is the entire point.
        for (const q of pending) {
          const v = impulseVelocity(p, q.x, q.y, q.s);
          vx += v.vx;
          vy += v.vy;
          vz += v.vz;
        }
        for (const g of pulls) {
          const av = attractVelocity(p, g.x, g.y, g.s, g.r);
          vx += av.vx;
          vy += av.vy;
          vz += av.vz;
        }
        if (scrolled !== 0) {
          const sv = scrollVelocity(p, scrolled);
          vx += sv.vx;
          vy += sv.vy;
          vz += sv.vz;
        }
        const cur = cursorRef.current;
        if (cur) {
          const cv = impulseVelocity(p, cur.x, cur.y, CURSOR_PUSH * dt, CURSOR_RADIUS);
          vx += cv.vx;
          vy += cv.vy;
        }
        parts[i] = stepParticle({ ...p, vx, vy, vz }, dt, now, w, h);
      }

      const live: Spark[] = [];
      for (const s of sparksRef.current) {
        const n = stepSpark(s, dt, now);
        if (n) live.push(n);
        // A spent spark becomes background — typing ADDS to the field rather than decorating it.
        // Only inside the box: one that flew off the edge would be simulated forever, unseen.
        else if (s.x > 0 && s.x < w && s.y > 0 && s.y < h) {
          parts.push(sparkToParticle(s, rnd));
          /**
           * THE SEEDED VOLUME IS IMMORTAL. Retirement starts at `seedCount`, so it can only ever
           * consume spark-born motes — the ones appended after it — in the order they arrived.
           *
           * This used to splice from 0, described as "a long conversation gradually replaces the
           * starting field with one the words themselves built". It does exactly that, and the
           * result is that the evenly-distributed volume is gone within about fifteen seconds of
           * typing, leaving only motes born beside the caret. The room the words are spoken in has
           * to outlive the words; sparks are allowed to furnish it, never to become it.
           */
          if (parts.length > maxAmbient) parts.splice(seedCount, parts.length - maxAmbient);
        }
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
    // Under reduced motion there is no frame loop to repaint after a reseed, so the canvas would
    // stay blank from the first window resize onward — now that this is the whole screen, that is
    // every time anyone resizes the window.
    const ro = new ResizeObserver(() => {
      resize();
      if (reduced) draw();
    });
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
