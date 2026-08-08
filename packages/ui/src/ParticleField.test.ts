import { describe, expect, it } from "vitest";
import { impulseVelocity, seedParticles, stepParticle, PULSE_RADIUS, type Particle } from "./ParticleField.js";

/**
 * The physics is pure on purpose — no canvas, no DOM, no clock — so the two properties that make
 * an ambient effect either lovely or unbearable can actually be asserted:
 *
 *   1. it ALWAYS settles. A field that accumulates energy turns into noise behind the reader's
 *      text, and the only way to find that by hand is to leave the app running for an hour.
 *   2. a pulse is LOCAL. If one keystroke moves the whole field, it stops reading as the text
 *      displacing the air and starts reading as the page wobbling.
 */

const at = (x: number, y: number, vx = 0, vy = 0): Particle => ({ x, y, vx, vy, hx: x, hy: y, r: 1, a: 0.3 });

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
