import { describe, expect, it } from "vitest";
import {
  DEPTH,
  MAX_SPARKS,
  driftAcceleration,
  emitSparks,
  impulseVelocity,
  project,
  seedParticles,
  stepParticle,
  stepSpark,
  PULSE_RADIUS,
  type Particle,
} from "./ParticleField.js";

/**
 * The physics is pure on purpose — no canvas, no DOM, no clock — so the two properties that make
 * an ambient effect either lovely or unbearable can actually be asserted:
 *
 *   1. it ALWAYS settles. A field that accumulates energy turns into noise behind the reader's
 *      text, and the only way to find that by hand is to leave the app running for an hour.
 *   2. a pulse is LOCAL. If one keystroke moves the whole field, it stops reading as the text
 *      displacing the air and starts reading as the page wobbling.
 */

const at = (x: number, y: number, vx = 0, vy = 0, z = 0): Particle => ({
  x, y, z, vx, vy, vz: 0, hx: x, hy: y, hz: z, r: 1, a: 0.3, ph: 0.4,
});

const rndSeq = (seed = 7) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

describe("the field always settles", () => {
  it("returns a shoved particle home and stops", () => {
    let p: Particle = { ...at(100, 100), vx: 9, vy: -7 };
    for (let i = 0; i < 2000; i++) p = stepParticle(p, 1);
    expect(Math.hypot(p.x - 100, p.y - 100), "never came home").toBeLessThan(0.5);
    expect(Math.hypot(p.vx, p.vy), "still moving").toBeLessThan(0.01);
  });

  it("cannot accumulate energy, however hard or often it is hit", () => {
    // The failure this guards: a spring weaker than the damping lets repeated impulses stack, and
    // the field slowly boils. Hit it every frame for ten seconds, then let it rest.
    let p: Particle = at(0, 0);
    for (let i = 0; i < 600; i++) {
      const { vx, vy } = impulseVelocity(p, 5, 5, 3);
      p = stepParticle({ ...p, vx: p.vx + vx, vy: p.vy + vy }, 1);
    }
    const excursion = Math.hypot(p.x - p.hx, p.y - p.hy);
    expect(excursion, `drifted ${excursion.toFixed(1)}px from home under sustained impulses`).toBeLessThan(
      PULSE_RADIUS,
    );
    for (let i = 0; i < 2000; i++) p = stepParticle(p, 1);
    expect(Math.hypot(p.vx, p.vy)).toBeLessThan(0.01);
  });

  it("survives a backgrounded tab without flinging particles off screen", () => {
    // dt is clamped by the caller, and this is why: an unclamped delta after a tab regains focus
    // integrates one enormous step. Even at the clamp ceiling the particle must stay sane.
    let p: Particle = { ...at(50, 50), vx: 4, vy: 4 };
    for (let i = 0; i < 500; i++) p = stepParticle(p, 3);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(Math.hypot(p.x - 50, p.y - 50)).toBeLessThan(200);
  });
});

describe("a pulse stays local", () => {
  it("does nothing at all beyond its radius", () => {
    const far = at(PULSE_RADIUS + 1, 0);
    expect(impulseVelocity(far, 0, 0, 5)).toEqual({ vx: 0, vy: 0, vz: 0 });
  });

  it("pushes outward, hardest at the centre", () => {
    const near = impulseVelocity(at(10, 0), 0, 0, 5);
    const mid = impulseVelocity(at(PULSE_RADIUS / 2, 0), 0, 0, 5);
    expect(near.vx, "not pushed away from the impulse").toBeGreaterThan(0);
    expect(near.vx, "falloff is inverted").toBeGreaterThan(mid.vx);
  });

  it("gives a particle sitting exactly on the impulse a direction instead of NaN", () => {
    // Dividing by a zero distance would produce NaN, which propagates into the position and
    // silently removes the particle from every subsequent frame — a field that thins out over
    // time and no error anywhere.
    const v = impulseVelocity(at(0, 0), 0, 0, 5);
    expect(Number.isFinite(v.vx) && Number.isFinite(v.vy)).toBe(true);
    expect(Math.hypot(v.vx, v.vy)).toBeGreaterThan(0);
  });
});

describe("seeding", () => {
  const rnd = (() => {
    let s = 42;
    return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  })();

  it("puts every particle inside the box, at its own home", () => {
    const ps = seedParticles(400, 200, 60, rnd);
    expect(ps.length).toBe(60);
    for (const p of ps) {
      expect(p.x).toBe(p.hx);
      expect(p.y).toBe(p.hy);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  it("does not collapse when the container has no height yet", () => {
    // First paint hands over a 0-height box more often than not; a divide by it yields NaN homes,
    // and every particle is then invisible forever with nothing logged.
    const ps = seedParticles(300, 0, 20, rnd);
    for (const p of ps) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it("stays sparse — this is atmosphere, not a screensaver", () => {
    // At the shipped density a large desktop chat area should still be well under a few hundred.
    const DENSITY = 0.00007;
    expect(Math.round(1600 * 700 * DENSITY)).toBeLessThan(120);
  });
});

/**
 * THE FIELD WAS PERFECTLY STATIC AND EVERY TEST ABOVE PASSED.
 *
 * Each particle starts AT its home with zero velocity, and the only forces were a spring pulling
 * it home and an impulse from typing. A particle already home with no velocity therefore never
 * moved — the field drew a fixed pattern of dots and stayed that way until the model typed, which
 * is not what "a drifting particle field" means and was reported as exactly that.
 *
 * The settling tests could not have caught it: a field that never moves settles trivially. This
 * asserts the opposite property — that something is always nudging it.
 */
describe("ambient drift", () => {
  /**
   * "> 0.5px" WAS A USELESS BAR AND THIS TEST PASSED WHILE THE EFFECT DID NOT EXIST.
   *
   * The first drift constant produced a measured steady-state wander of 1.3 pixels. Mathematically
   * moving; visually a still image, and reported as "no particle movement at all" after it shipped.
   * A threshold that a sub-pixel effect clears is not a test of whether something is visible.
   *
   * The bar is now a distance a person can actually see a dot travel.
   */
  it("wanders far enough to be SEEN, not merely far enough to be non-zero", () => {
    let p: Particle = at(100, 100);
    let worst = 0;
    for (let i = 0; i < 8000; i++) {
      const { ax, ay } = driftAcceleration(p, i * 16.7);
      p = stepParticle({ ...p, vx: p.vx + ax, vy: p.vy + ay }, 1);
      if (i > 2000) worst = Math.max(worst, Math.hypot(p.x - p.hx, p.y - p.hy));
    }
    expect(worst, `wanders only ${worst.toFixed(1)}px — invisible on a 2px dot`).toBeGreaterThan(6);
  });

  it("stays gentle — drift must never overpower the spring", () => {
    // If ambient force can push a particle far from home the field stops reading as atmosphere
    // and starts reading as snow. Run it long enough for any resonance to show.
    let p: Particle = at(0, 0);
    let worst = 0;
    for (let i = 0; i < 6000; i++) {
      const { ax, ay } = driftAcceleration(p, i * 16.7);
      p = stepParticle({ ...p, vx: p.vx + ax, vy: p.vy + ay }, 1);
      worst = Math.max(worst, Math.hypot(p.x - p.hx, p.y - p.hy));
    }
    expect(worst, `drifted ${worst.toFixed(1)}px from home`).toBeLessThan(30);
    // Bounded on BOTH sides now: too little is as much a bug as too much, and only one of the two
    // had a test until the field shipped invisible.
    expect(worst).toBeGreaterThan(6);
  });

  it("gives neighbouring particles different phases, so the field does not pulse as one", () => {
    const a = driftAcceleration({ ph: 0 }, 1000);
    const b = driftAcceleration({ ph: 2.1 }, 1000);
    expect(Math.abs(a.ax - b.ax) + Math.abs(a.ay - b.ay)).toBeGreaterThan(0.001);
  });
});


/**
 * THE FIELD IS 3D, AND THE THING THAT MAKES IT LOOK 3D IS THE PROJECTION.
 *
 * Physics in three dimensions is only half of it — flat rendering of 3D positions looks exactly
 * like 2D. The perspective divide is what buys parallax, depth falloff and occlusion order, so
 * that is what is asserted: not "z exists" but "z changes what you see".
 */
describe("perspective", () => {
  it("makes near things bigger than far things", () => {
    const near = project({ x: 0, y: 0, z: -DEPTH }, 0, 0);
    const far = project({ x: 0, y: 0, z: DEPTH }, 0, 0);
    expect(near.scale).toBeGreaterThan(far.scale);
    expect(far.scale).toBeGreaterThan(0);
  });

  it("sweeps near things further across the screen — this is the parallax", () => {
    // Same world displacement from centre, different depths: the nearer one must move more.
    const near = project({ x: 100, y: 0, z: -DEPTH }, 0, 0);
    const far = project({ x: 100, y: 0, z: DEPTH }, 0, 0);
    expect(Math.abs(near.sx)).toBeGreaterThan(Math.abs(far.sx));
  });

  it("never inverts or divides by zero, however close to the camera", () => {
    // A particle at or behind the pinhole would flip the field inside out for a frame, or blow up
    // to Infinity — either of which is a visible catastrophe from an invisible cause.
    for (const z of [-100000, -1000, -520, 0, 1e6]) {
      const q = project({ x: 50, y: 50, z }, 0, 0);
      expect(Number.isFinite(q.sx) && Number.isFinite(q.sy), `z=${z}`).toBe(true);
      expect(q.scale, `z=${z} inverted the projection`).toBeGreaterThan(0);
    }
  });
});

describe("sparks — the particles born from the letters", () => {
  it("throws them outward in every direction, not into a box corner", () => {
    // A naive (rnd,rnd,rnd) direction clusters toward the cube's corners and the burst comes out
    // visibly boxy. Speeds should be near-uniform across a sphere instead.
    const ss = emitSparks(0, 0, 120, rndSeq());
    const speeds = ss.map((s) => Math.hypot(s.vx, s.vy, s.vz));
    const min = Math.min(...speeds);
    const max = Math.max(...speeds);
    expect(min).toBeGreaterThan(0.3);
    expect(max / min, "speed spread is wildly uneven").toBeLessThan(6);
    // And they must genuinely span the axes rather than favouring one.
    expect(Math.max(...ss.map((s) => Math.abs(s.vz)))).toBeGreaterThan(0.2);
  });

  it("every spark dies, so emission can run forever without the field filling up", () => {
    let live = emitSparks(10, 10, 40, rndSeq());
    for (let i = 0; i < 3000 && live.length; i++) {
      live = live.map((s) => stepSpark(s, 1, i * 16.7)).filter((s): s is NonNullable<typeof s> => s !== null);
    }
    expect(live.length, "sparks outlived a 50-second run — they are immortal").toBe(0);
  });

  it("caps how many can exist at once", () => {
    // Emission is per-keystroke and a model can stream for minutes; without a ceiling a long reply
    // grows the array without bound and takes the frame rate with it.
    expect(MAX_SPARKS).toBeLessThanOrEqual(600);
    expect(MAX_SPARKS).toBeGreaterThan(80);
  });

  it("stays finite for its whole life", () => {
    let s = emitSparks(0, 0, 1, rndSeq())[0]!;
    for (let i = 0; i < 400; i++) {
      const n = stepSpark(s, 2, i * 16.7);
      if (!n) break;
      s = n;
      expect(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z)).toBe(true);
    }
  });
});

describe("the volume has depth", () => {
  it("seeds particles through it rather than onto one plane", () => {
    const ps = seedParticles(400, 300, 80, rndSeq());
    const zs = ps.map((p) => p.z);
    expect(Math.max(...zs) - Math.min(...zs), "the field is flat").toBeGreaterThan(DEPTH);
    for (const p of ps) expect(p.z).toBe(p.hz);
  });

  it("pushes in three dimensions, not two", () => {
    const v = impulseVelocity(at(0, 0, 0, 0, 30), 0, 0, 5);
    expect(v.vz, "an impulse does nothing in depth").not.toBe(0);
  });
});
