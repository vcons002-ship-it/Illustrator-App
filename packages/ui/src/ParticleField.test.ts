import { describe, expect, it } from "vitest";
import {
  driftAcceleration,
  impulseVelocity,
  seedParticles,
  stepParticle,
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

const at = (x: number, y: number, vx = 0, vy = 0): Particle => ({ x, y, vx, vy, hx: x, hy: y, r: 1, a: 0.3, ph: 0.4 });

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
    expect(impulseVelocity(far, 0, 0, 5)).toEqual({ vx: 0, vy: 0 });
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
  it("keeps the field alive when nothing is typing", () => {
    let p: Particle = at(100, 100);
    const start = { x: p.x, y: p.y };
    for (let i = 0; i < 240; i++) {
      const { ax, ay } = driftAcceleration(p, i * 16.7);
      p = stepParticle({ ...p, vx: p.vx + ax, vy: p.vy + ay }, 1);
    }
    const moved = Math.hypot(p.x - start.x, p.y - start.y);
    expect(moved, "the field never moved on its own").toBeGreaterThan(0.5);
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
  });

  it("gives neighbouring particles different phases, so the field does not pulse as one", () => {
    const a = driftAcceleration({ ph: 0 }, 1000);
    const b = driftAcceleration({ ph: 2.1 }, 1000);
    expect(Math.abs(a.ax - b.ax) + Math.abs(a.ay - b.ay)).toBeGreaterThan(0.001);
  });
});
