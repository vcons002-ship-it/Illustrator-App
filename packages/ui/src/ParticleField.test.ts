import { describe, expect, it } from "vitest";
import {
  DEPTH,
  MAX_SPARKS,
  baseDrift,
  attractVelocity,
  emitSparks,
  caretXFromWidth,
  impulseVelocity,
  pickLastTextNode,
  project,
  seedParticles,
  refitParticles,
  stepParticle,
  sparkToParticle,
  stepSpark,
  wrapCaret,
  PULSE_RADIUS,
  SCROLL_CLAMP,
  cometVelocity,
  cometTrail,
  cometAlive,
  spawnComet,
  stepComet,
  COMET_RADIUS,
  COMET_MAX_AGE,
  COMET_GAP_MIN_MS,
  TRAIL_CONVERT_CHANCE,
  TRAIL_PER_FRAME,
  TRAIL_DECAY_MIN,
  type Comet,
  MAX_SPEED,
  WRAP_MARGIN,
  DRIFT_MIN,
  DRIFT_MAX,
  scrollVelocity,
  type Particle,
  type Spark,
} from "./ParticleField.js";
import { BACKDROP_DENSITY } from "./ParticleBackdrop.js";

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
  x, y, z, vx, vy, vz: 0, r: 1, a: 0.3, ph: 0.4, spd: 0.25,
});

const W = 1200;
const H = 800;
/** Advance a mote through the real step, with a clock, in a screen-sized box. */
const run = (p: Particle, frames: number, dt = 1): Particle => {
  let q = p;
  for (let i = 0; i < frames; i++) q = stepParticle(q, dt, i * 16.7, W, H);
  return q;
};
/** Distance travelled without letting a wrap read as a giant jump. */
const near = (a: number, b: number, size: number): number => {
  const d = Math.abs(a - b) % size;
  return Math.min(d, size - d);
};

const rndSeq = (seed = 7) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

describe("the field always settles", () => {
  /**
   * "SETTLES" NO LONGER MEANS "COMES HOME". It means the disturbance bleeds off and the mote is
   * cruising again — from wherever the shove left it. The old version of this test asserted a
   * pushed mote returned to within half a pixel of its start, which is precisely the property that
   * was reported, three separate times, as the particles behaving like jello.
   */
  it("bleeds a shove off and returns to its own cruising speed", () => {
    const p = run({ ...at(600, 400), vx: 9, vy: -7 }, 600);
    expect(Math.hypot(p.vx, p.vy, p.vz), "still carrying the shove").toBeLessThan(DRIFT_MAX * 1.3);
    expect(Math.hypot(p.vx, p.vy, p.vz), "stopped dead instead of drifting on").toBeGreaterThan(0.01);
  });

  it("keeps the shove — a settled mote is somewhere new, not back where it started", () => {
    const start = at(600, 400);
    const p = run({ ...start, vx: 9, vy: -7 }, 600);
    const moved = Math.hypot(near(p.x, start.x, W + 2 * WRAP_MARGIN), near(p.y, start.y, H + 2 * WRAP_MARGIN));
    expect(moved, `sprang back to within ${moved.toFixed(0)}px of home — this is the jello`).toBeGreaterThan(150);
  });

  it("cannot accumulate energy, however hard or often it is hit", () => {
    // The clamp is the only thing standing between a per-frame force and a mote at escape velocity,
    // now that there is no spring to balance one. Hit it every frame for ten seconds.
    let p: Particle = at(600, 400);
    for (let i = 0; i < 600; i++) {
      const { vx, vy } = impulseVelocity(p, 605, 405, 3);
      p = stepParticle({ ...p, vx: p.vx + vx, vy: p.vy + vy }, 1, i * 16.7, W, H);
      expect(Math.hypot(p.vx, p.vy, p.vz)).toBeLessThanOrEqual(MAX_SPEED + 1e-9);
    }
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it("survives a backgrounded tab without flinging particles off screen", () => {
    // dt is clamped by the caller, and this is why: an unclamped delta after a tab regains focus
    // integrates one enormous step. Wrapping means it can never leave the box regardless.
    const p = run({ ...at(50, 50), vx: 4, vy: 4 }, 500, 3);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(-WRAP_MARGIN);
    expect(p.x).toBeLessThanOrEqual(W + WRAP_MARGIN);
    expect(p.y).toBeGreaterThanOrEqual(-WRAP_MARGIN);
    expect(p.y).toBeLessThanOrEqual(H + WRAP_MARGIN);
  });

  it("wraps rather than piling up against an edge", () => {
    // The spring used to keep the volume together. Wrapping is what replaced it, and a mote that
    // stuck at the boundary instead would leave a bright rim and an emptying middle.
    const p = run({ ...at(W - 10, 400), vx: 6 }, 120);
    expect(p.x, "stalled at the right-hand edge instead of coming back round").toBeLessThan(W / 2);
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

  it("puts every particle inside the box, at rest, with a pace of its own", () => {
    const ps = seedParticles(400, 200, 60, rnd);
    expect(ps.length).toBe(60);
    for (const p of ps) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.spd).toBeGreaterThanOrEqual(DRIFT_MIN);
      expect(p.spd).toBeLessThanOrEqual(DRIFT_MAX);
    }
    expect(new Set(ps.map((p) => p.spd)).size, "the whole field moves at one pace").toBeGreaterThan(20);
  });

  it("does not collapse when the container has no height yet", () => {
    // First paint hands over a 0-height box more often than not; a divide by it yields NaN
    // positions, and every particle is then invisible forever with nothing logged.
    const ps = seedParticles(300, 0, 20, rnd);
    for (const p of ps) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it("stays sparse — this is atmosphere, not a screensaver", () => {
    const DENSITY = 0.00007;
    expect(Math.round(1600 * 700 * DENSITY)).toBeLessThan(120);
  });
});
describe("ambient drift", () => {
  /**
   * "> 0.5px" WAS A USELESS BAR AND THAT TEST PASSED WHILE THE EFFECT DID NOT EXIST.
   *
   * The first drift constant produced a measured steady-state wander of 1.3 pixels — mathematically
   * moving, visually a still image, and reported as "no particle movement at all" after it shipped.
   * The bar has to be a distance a person can actually watch a dot travel.
   */
  it("actually goes somewhere, rather than wandering around one spot", () => {
    const start = at(600, 400);
    const p = run(start, 900); // fifteen seconds
    const moved = Math.hypot(near(p.x, start.x, W + 2 * WRAP_MARGIN), near(p.y, start.y, H + 2 * WRAP_MARGIN));
    expect(moved, `travelled ${moved.toFixed(0)}px in fifteen seconds`).toBeGreaterThan(60);
  });

  /**
   * THE SAFETY PROPERTY OF A HEADING RATHER THAN AN ACCELERATION. An ambient acceleration on top of
   * this drag would settle at 66x its own value; a heading carries the mote's speed by construction,
   * so no wander constant can ever make the volume take off.
   */
  it("never changes a mote's speed, only its direction", () => {
    const p = { ph: 1.1, spd: 0.3 };
    for (let i = 0; i < 4000; i++) {
      const { dx, dy, dz } = baseDrift(p, i * 16.7);
      expect(Math.hypot(dx, dy, dz)).toBeLessThanOrEqual(p.spd + 1e-9);
    }
  });

  it("curves, so the field is not a sheet of straight lines", () => {
    const early = baseDrift({ ph: 0.7, spd: 0.3 }, 0);
    const late = baseDrift({ ph: 0.7, spd: 0.3 }, 40000);
    expect(Math.abs(early.dx - late.dx) + Math.abs(early.dy - late.dy)).toBeGreaterThan(0.05);
  });

  it("gives neighbouring particles different phases, so the field does not pulse as one", () => {
    const a = baseDrift({ ph: 0.2, spd: 0.3 }, 5000);
    const b = baseDrift({ ph: 4.1, spd: 0.3 }, 5000);
    expect(Math.abs(a.dx - b.dx) + Math.abs(a.dy - b.dy), "the volume breathes as one body").toBeGreaterThan(
      0.05,
    );
  });
});
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
    for (const p of ps) expect(Math.abs(p.z)).toBeLessThanOrEqual(DEPTH);
  });

  it("pushes in three dimensions, not two", () => {
    const v = impulseVelocity(at(0, 0, 0, 0, 30), 0, 0, 5);
    expect(v.vz, "an impulse does nothing in depth").not.toBe(0);
  });
});

/**
 * WHERE THE SPARKS ARE BORN IS THE WHOLE EFFECT.
 *
 * The emission measured the BUBBLE — a box up to 85% of the panel wide — so every spark spawned at
 * its bottom-right corner: nowhere near the words, and stationary until the box grew a line.
 * Reported as "the particles don't really seem to react to the text", which is exactly what it was.
 *
 * The DOM walk is three lines of TreeWalker; the bug lives in WHICH node gets picked, so that is
 * what is split out and tested. Markdown routinely leaves trailing whitespace-only text nodes, and
 * choosing one puts the caret out in the margin — the same class of miss as measuring the bubble.
 */
describe("finding the newest character", () => {
  it("picks the last node that actually has characters in it", () => {
    const nodes = [{ data: "Hello" }, { data: " world" }];
    expect(pickLastTextNode(nodes)?.data).toBe(" world");
  });

  it("skips the whitespace-only nodes markdown leaves behind", () => {
    const nodes = [{ data: "the answer" }, { data: "\n  " }, { data: "   " }];
    expect(pickLastTextNode(nodes)?.data, "picked a whitespace node — sparks land in the margin").toBe(
      "the answer",
    );
  });

  it("returns null rather than a bogus node when there is no text at all", () => {
    // An image-only or empty bubble. The caller falls back to the element's own box; returning a
    // whitespace node instead would silently emit at a meaningless point forever.
    expect(pickLastTextNode([])).toBeNull();
    expect(pickLastTextNode([{ data: "" }, { data: "\n" }])).toBeNull();
  });
});

/**
 * THE BACKGROUND HAS TO BE REACHABLE, AT EVERY DEPTH IT IS SEEDED AT.
 *
 * Making the field 3D silently broke the thing it was meant to improve. The volume is seeded across
 * ±DEPTH in z, and the impulse measured a plain 3D distance — so a mote at |z| ≥ the pulse radius
 * could never be touched however close it was on screen. That was HALF of them, and the survivors
 * had a collapsing on-screen reach: 83px at z=100, 16px at z=129.
 *
 * Every existing test passed. They all place particles at z = 0, which is the one depth where the
 * bug does not exist. Reported as "the background particles aren't reacting", which is exactly what
 * the geometry says should have happened.
 */
describe("a pulse reaches the whole volume, not just the screen plane", () => {
  it.each([0, DEPTH / 2, DEPTH * 0.9, DEPTH])("moves a mote seeded at z=%i", (z) => {
    // Directly "under" the impulse on screen — if this cannot be reached, nothing at that depth can.
    const v = impulseVelocity({ x: 0, y: 0, z }, 0, 0, 3.4);
    expect(
      Math.hypot(v.vx, v.vy, v.vz),
      `a mote at z=${z} is unreachable — half the field would never react`,
    ).toBeGreaterThan(0.2);
  });

  it("still keeps a pulse local across the screen", () => {
    // The flattening must not turn into "the whole field moves at once", which reads as the page
    // wobbling rather than as the text disturbing the air near it.
    const far = impulseVelocity({ x: PULSE_RADIUS + 60, y: 0, z: 0 }, 0, 0, 3.4);
    expect(far).toEqual({ vx: 0, vy: 0, vz: 0 });
  });

  it("pushes hard enough for the movement to be seen", () => {
    // Measured through the real step rather than asserted on the impulse alone: an impulse that
    // produces a sub-pixel excursion is the 1.3px drift bug wearing a different hat.
    const start = { ...at(600, 400), z: 60 };
    const v = impulseVelocity({ x: 600, y: 460, z: 60 }, 600, 400, 3.4);
    const p = run({ ...start, vx: v.vx, vy: v.vy, vz: v.vz }, 600);
    const moved = Math.hypot(near(p.x, start.x, W + 2 * WRAP_MARGIN), near(p.y, start.y, H + 2 * WRAP_MARGIN));
    expect(moved, `one keystroke moved a mote ${moved.toFixed(1)}px — too small to notice`).toBeGreaterThan(
      30,
    );
  });
});

/**
 * A <textarea>'s value lives in its `value`, not in text nodes, so a Range cannot select it the way
 * it can a reply. The first version multiplied character COUNT by an assumed ~0.52em advance, which
 * is wrong per glyph and — the part that actually bit — wrong CUMULATIVELY: the error compounds
 * along the line, so the sparks landed about a tab too far right after a few words.
 *
 * Real measurement replaced the estimate, so what is left to test is the clamp: the origin must
 * stay inside the field whatever the measurement says, because a burst appearing past the end of a
 * long line is worse than one a few pixels off.
 */
describe("placing the composer caret", () => {
  it("advances along the line as the text gets wider", () => {
    expect(caretXFromWidth(80, 100, 900)).toBeGreaterThan(caretXFromWidth(10, 100, 900));
  });

  it("never escapes the field, however wide the text measures", () => {
    for (const w of [0, 200, 5000, 1e9]) {
      const x = caretXFromWidth(w, 100, 900);
      expect(x, `width ${w} put the origin outside the box`).toBeGreaterThanOrEqual(100);
      expect(x).toBeLessThanOrEqual(900);
    }
  });

  it("survives a zero-width field without producing a backwards range", () => {
    // First paint, or a collapsed composer: right - 8 is less than left, and an unclamped min/max
    // pair returns the wrong bound and emits outside the element.
    const x = caretXFromWidth(50, 500, 500);
    expect(Number.isFinite(x)).toBe(true);
    expect(x).toBe(500);
  });
});

/**
 * THE FIELD HAS TO BE REARRANGEABLE, OR A DISTURBANCE IS ONLY EVER A FLINCH.
 *
 * A purely elastic tether returns every mote to exactly where it started, so however hard the field
 * is pushed it looks identical a few seconds later. Plasticity is what lets typing and arriving
 * messages actually move the field — and it is also the thing that, unbounded, migrates the whole
 * volume toward wherever the text appears and empties the corners.
 */
describe("a disturbance rearranges the field", () => {
  /**
   * THIS USED TO TEST `displaceHome`, WHICH NO LONGER EXISTS.
   *
   * Rearranging the field was a whole mechanism — plastic tethers, clamped homes, a slow creep back
   * to a seed — built to work around the fact that every mote was on a spring. With the spring gone
   * it is not a mechanism at all: a mote goes where it is pushed and stays there. All three of the
   * things that machinery existed to guarantee still have to hold, so they are asserted directly on
   * the outcome instead of on the parts.
   */
  it("leaves a hard-pushed mote somewhere genuinely new", () => {
    const start = at(600, 400);
    const v = impulseVelocity(start, 600, 440, 11);
    const p = run({ ...start, vx: v.vx, vy: v.vy, vz: v.vz }, 600);
    const moved = Math.hypot(near(p.x, start.x, W + 2 * WRAP_MARGIN), near(p.y, start.y, H + 2 * WRAP_MARGIN));
    expect(moved, `a send moved a mote ${moved.toFixed(0)}px and it did not stay moved`).toBeGreaterThan(200);
  });

  it("never strands a mote outside the box", () => {
    const p = run({ ...at(10, 10), vx: -40, vy: -40 }, 400);
    expect(p.x).toBeGreaterThanOrEqual(-WRAP_MARGIN);
    expect(p.y).toBeGreaterThanOrEqual(-WRAP_MARGIN);
    expect(p.x).toBeLessThanOrEqual(W + WRAP_MARGIN);
    expect(p.y).toBeLessThanOrEqual(H + WRAP_MARGIN);
  });

  it("does nothing at all for a glancing touch", () => {
    const start = at(600, 400);
    const v = impulseVelocity(start, 600 + PULSE_RADIUS - 1, 400, 2.6);
    expect(Math.hypot(v.vx, v.vy, v.vz), "the far edge of a pulse still shoves").toBeLessThan(0.01);
  });
});
describe("finding the caret when the field wraps", () => {
  const measure = (s: string): number => s.length * 10;

  it("stays on the first line while the text still fits", () => {
    expect(wrapCaret("abc", measure, 200)).toEqual({ line: 0, x: 30 });
  });

  it("moves to the next line when the words no longer fit", () => {
    // "aaaa bbbb " is 100 wide; "cccc" would take it past 120, so the caret is on line 1.
    const r = wrapCaret("aaaa bbbb cccc", measure, 120);
    expect(r.line, "the caret never left the first line — sparks would stick at the edge").toBe(1);
    expect(r.x, "x did not reset at the line break").toBeLessThan(120);
  });

  it("counts an explicit newline as a break", () => {
    expect(wrapCaret("ab\ncd", measure, 500)).toEqual({ line: 1, x: 20 });
  });

  it("breaks a word longer than the whole line instead of looping forever", () => {
    // Without character-level breaking the greedy loop cannot advance: the token never fits, the
    // line never ends, and the caret runs off the right of the field permanently.
    const r = wrapCaret("x".repeat(25), measure, 100);
    expect(r.line).toBeGreaterThan(0);
    expect(r.x).toBeLessThanOrEqual(100);
  });

  it("never reports a negative line, whatever it is given", () => {
    for (const s of ["", "\n", "\n\n\n", "   "]) {
      expect(wrapCaret(s, measure, 100).line, JSON.stringify(s)).toBeGreaterThanOrEqual(0);
    }
  });

  it("survives a zero-width field rather than dividing into an infinite loop", () => {
    const r = wrapCaret("hello world", measure, 0);
    expect(Number.isFinite(r.line) && Number.isFinite(r.x)).toBe(true);
  });
});

/**
 * "THEY JUST WIGGLE" WAS A STRUCTURAL COMPLAINT, NOT A TUNING ONE.
 *
 * With the tether at full grip a shoved mote peaks 16px away after TEN frames and is already on its
 * way back — the spring catches it before the eye registers a direction. No amount of extra impulse
 * fixes that shape; it just makes a faster wiggle.
 *
 * Releasing the tether on impact is the fix: the mote coasts, decelerating on drag alone, and the
 * spring fades back in as the slack decays. Same push travels ~40px over half a second.
 */
describe("a push travels instead of springing back", () => {
  /**
   * THE MEASUREMENT THAT ENDED THE SPRING.
   *
   * The strongest impulse in the app — sending a message — threw a mote 86px in half a second and
   * had it back within 12px of its start by frame 60 and 1px by frame 300. Out and straight back,
   * every time. Two rounds of trying to buy travel back from a tether (plasticity, then released
   * slack) both failed, because the tether was the problem.
   */
  it("carries far enough, and long enough, to read as being thrown", () => {
    const start = at(600, 400);
    const v = impulseVelocity(start, 600, 430, 11);
    let p: Particle = { ...start, vx: v.vx, vy: v.vy, vz: v.vz };
    const dist = (): number =>
      Math.hypot(near(p.x, start.x, W + 2 * WRAP_MARGIN), near(p.y, start.y, H + 2 * WRAP_MARGIN));
    p = run(p, 30);
    expect(dist(), "barely moved in the first half second").toBeGreaterThan(60);
    p = run(p, 90);
    expect(dist(), "did not keep coasting after the force stopped").toBeGreaterThan(180);
  });

  it("decelerates rather than coasting forever", () => {
    const v0 = 6;
    const a = run({ ...at(600, 400), vx: v0 }, 60);
    const b = run(a, 60);
    const first = Math.abs(a.vx);
    expect(first, "no deceleration at all").toBeLessThan(v0 * 0.6);
    expect(Math.abs(b.vx), "still travelling at speed after two seconds").toBeLessThan(first);
  });
});
describe("sparks carry, and then become the background", () => {
  it("keeps most of its speed rather than stopping on the spot", () => {
    let s = emitSparks(0, 0, 1, rndSeq())[0]!;
    const v0 = Math.hypot(s.vx, s.vy, s.vz);
    for (let i = 0; i < 30; i++) s = stepSpark(s, 1, i * 16.7)!;
    expect(Math.hypot(s.vx, s.vy, s.vz) / v0, "a thrown spark stalled immediately").toBeGreaterThan(0.4);
  });

  it("recedes into the volume rather than being pulled back to the screen", () => {
    // Sparks that hug the screen plane read as sprinkles in front of the text; the ask was for
    // material thrown INTO the background.
    let s = { ...emitSparks(0, 0, 1, rndSeq())[0]!, z: 0, vz: 0 };
    for (let i = 0; i < 60; i++) s = stepSpark(s, 1, i * 16.7)!;
    expect(s.z, "sparks never travelled into depth").toBeGreaterThan(0);
  });

  it("takes over the spark's trajectory, so there is no seam", () => {
    const s = { ...emitSparks(40, 60, 1, rndSeq())[0]!, x: 120, y: 90, z: 40, vx: 1.4, vy: -0.8 };
    const p = sparkToParticle(s, rndSeq());
    expect(p.x, "a spent spark should become a mote where it flew to").toBe(120);
    expect(p.y).toBe(90);
    expect(p.vx, "the mote stopped dead where the spark died").toBe(1.4);
    expect(p.vy).toBe(-0.8);
    expect(p.spd, "the new mote has no cruising speed and will coast to a halt").toBeGreaterThan(0);
  });

  it("clamps a converted spark into the volume's depth", () => {
    const s = { ...emitSparks(0, 0, 1, rndSeq())[0]!, z: DEPTH * 10 };
    expect(sparkToParticle(s, rndSeq()).z).toBeLessThanOrEqual(DEPTH);
  });

  it("does not empty the volume it is thrown through", () => {
    /**
     * THE GATE FOR A BUG THE OWNER ACTUALLY SAW. Fifteen seconds of typing at the composer once
     * left the top 60% of the field with literally zero motes — measured [0, 0, 0, 31, 69] across
     * five horizontal bands — because spent sparks were seeded at the caret and the retirement pass
     * consumed the original evenly-spread motes oldest-first. Nothing attracted anything; the clump
     * was simply all that was left. Free motes disperse on their own now, but the retirement rule
     * is still there, so the outcome is still worth asserting.
     */
    const w = 620;
    const h = 520;
    const rnd = rndSeq(11);
    const n = Math.round(w * h * 0.00019);
    const parts = seedParticles(w, h, n, rnd);
    const seedCount = parts.length;
    const maxAmbient = Math.round(n * 1.6);
    let sparks: Spark[] = [];

    for (let f = 0; f < 900; f++) {
      if (f % 8 === 0) sparks.push(...emitSparks(120 + (f % 300), h - 52, 4, rnd));
      for (let i = 0; i < parts.length; i++) parts[i] = stepParticle(parts[i]!, 1, f * 16.667, w, h);
      const live: Spark[] = [];
      for (const s of sparks) {
        const nx = stepSpark(s, 1, f * 16.667);
        if (nx) live.push(nx);
        else if (s.x > 0 && s.x < w && s.y > 0 && s.y < h) {
          parts.push(sparkToParticle(s, rnd));
          if (parts.length > maxAmbient) parts.splice(seedCount, parts.length - maxAmbient);
        }
      }
      sparks = live;
    }

    const bands = [0, 0, 0, 0, 0];
    for (const p of parts) bands[Math.max(0, Math.min(4, Math.floor((p.y / h) * 5)))]! += 1;
    const topHalf = bands[0]! + bands[1]!;
    expect(topHalf / parts.length, `typing hollowed the field out: bands ${bands.join(",")}`).toBeGreaterThan(
      0.2,
    );
  });
});

describe("scrolling stirs the room", () => {
  it("carries the front of the volume further than the back", () => {
    const front = scrollVelocity({ z: -DEPTH, ph: 0 }, 30);
    const back = scrollVelocity({ z: DEPTH, ph: 0 }, 30);
    // A rigid translation would read as the background scrolling too. The gradient is the effect.
    expect(Math.abs(front.vy)).toBeGreaterThan(Math.abs(back.vy) * 2);
    expect(front.vy, "the field moved WITH the content instead of against it").toBeLessThan(0);
  });

  it("ignores the excess on a fling or a jump to a chapter", () => {
    const fast = scrollVelocity({ z: 0, ph: 0 }, SCROLL_CLAMP * 100);
    const clamped = scrollVelocity({ z: 0, ph: 0 }, SCROLL_CLAMP);
    expect(fast.vy).toBeCloseTo(clamped.vy, 6);
  });

  it("scatters rather than sliding as one sheet", () => {
    const a = scrollVelocity({ z: 0, ph: 0.3 }, 30);
    const b = scrollVelocity({ z: 0, ph: 2.9 }, 30);
    expect(a.vx, "every mote took the same sideways push").not.toBeCloseTo(b.vx, 3);
  });

  /**
   * THE GATE FOR A BUG THAT EVERY SETTLING TEST WOULD HAVE PASSED, TWICE OVER.
   *
   * Scroll is the only SUSTAINED force here; everything else lasts a single frame, so it is the only
   * one that integrates. Against the old spring, feeding it into the released tether left nothing
   * opposing a force arriving every frame: ten seconds of ordinary scrolling reached 47,000px per
   * frame and four million pixels off screen. It still came home afterwards and still settled to
   * zero, so "the field always settles" was true the whole time and the background would simply have
   * been absent while you read.
   *
   * With the spring gone the same coefficient failed the other way — every scroll speed, down to a
   * gentle 8px per frame, pinned the entire field at the MAX_SPEED clamp within two seconds. Not an
   * escape, a stampede. Both are bugs in what happens DURING the force, which no settling test can
   * see, and this is the only test of it.
   */
  it("leans the field without stampeding it", () => {
    const cruise = (p: Particle): number => Math.hypot(p.vx, p.vy, p.vz);
    // A realistic reading flick: 25 frames of scrolling, then let go.
    let p: Particle = { ...at(600, 400), z: -DEPTH }; // front plane: carried the most
    let peak = 0;
    for (let f = 0; f < 300; f++) {
      const sv = f < 25 ? scrollVelocity(p, 15) : { vx: 0, vy: 0, vz: 0 };
      p = stepParticle({ ...p, vx: p.vx + sv.vx, vy: p.vy + sv.vy, vz: p.vz + sv.vz }, 1, f * 16.7, W, H);
      peak = Math.max(peak, cruise(p));
    }
    expect(peak, `a scroll flick lifted the field to ${peak.toFixed(2)}px/frame — a stampede`).toBeLessThan(
      MAX_SPEED / 3,
    );
    expect(peak, "scrolling barely moved the field").toBeGreaterThan(DRIFT_MAX * 1.5);
    expect(cruise(p), "the flow never bled off after the scroll stopped").toBeLessThan(DRIFT_MAX * 1.3);
  });

  it("stays inside the volume even under a fling held down for fifteen seconds", () => {
    let p: Particle = { ...at(600, 400), z: -DEPTH };
    for (let i = 0; i < 900; i++) {
      const sv = scrollVelocity(p, SCROLL_CLAMP);
      p = stepParticle({ ...p, vx: p.vx + sv.vx, vy: p.vy + sv.vy, vz: p.vz + sv.vz }, 1, i * 16.7, W, H);
      expect(Math.hypot(p.vx, p.vy, p.vz)).toBeLessThanOrEqual(MAX_SPEED + 1e-9);
    }
    expect(p.y).toBeGreaterThanOrEqual(-WRAP_MARGIN);
    expect(p.y).toBeLessThanOrEqual(H + WRAP_MARGIN);
  });
});

describe("the field is the screen, not one panel", () => {
  /**
   * THE MEASUREMENT BEHIND MOVING IT. The field used to fill the chat panel with `inset: 0`. A
   * docked chat is about 620x320, so at panel density the entire volume was ~38 motes — and most of
   * that box is header and composer. "The only particles on screen are directly above the chat
   * window, and they hover in a group" was an accurate description of thirty-eight dots in a strip.
   * No amount of physics could have spread them; there was nowhere else for a mote to be.
   */
  it("holds enough motes at viewport scale to read as a room", () => {
    const n = Math.round(1920 * 1080 * BACKDROP_DENSITY);
    expect(n, `${n} motes across a 1080p screen is a handful of dots`).toBeGreaterThan(150);
    expect(n, `${n} motes plus ${MAX_SPARKS} sparks is a screensaver, and two fills each`).toBeLessThan(400);
  });

  it("covers the whole screen rather than clustering", () => {
    const ps = seedParticles(1920, 1080, Math.round(1920 * 1080 * BACKDROP_DENSITY), rndSeq(5));
    const bands = [0, 0, 0, 0, 0];
    for (const p of ps) bands[Math.min(4, Math.floor((p.y / 1080) * 5))]! += 1;
    for (const b of bands) expect(b / ps.length, `bands ${bands.join(",")}`).toBeGreaterThan(0.12);
  });
});

/**
 * THE BUG: SCROLLING THE PAGE PUT EVERY MOTE BACK WHERE IT STARTED.
 *
 * The box changes size far more often than it looks like it should — a phone hiding its URL bar
 * during a scroll resizes a viewport-fixed canvas on nearly every frame of the gesture. `resize`
 * called `seedParticles` unconditionally, and its PRNG restarted from a constant, so the field was
 * not merely reset, it was reset to the IDENTICAL arrangement every time: minutes of drift, every
 * comet trail and every mote the typing had thrown, gone mid-scroll and always to the same picture.
 */
describe("a resize carries the field rather than restarting it", () => {
  const box = { w: 1200, h: 800 };

  it("keeps every mote, and its motion, through a resize", () => {
    const parts = seedParticles(box.w, box.h, 40, rndSeq(2)).map((p, i) => ({
      ...p,
      vx: 1 + i * 0.01,
      x: 100 + i * 20,
    }));
    const out = refitParticles(parts, box, { w: 1200, h: 700 }, 40, rndSeq(3));
    expect(out.length).toBe(40);
    for (let i = 0; i < parts.length; i++) {
      expect(out[i]!.vx, "a resize stopped a mote dead").toBe(parts[i]!.vx);
      expect(out[i]!.spd).toBe(parts[i]!.spd);
    }
  });

  it("rescales into the new box instead of leaving a bare strip", () => {
    const parts = seedParticles(box.w, box.h, 40, rndSeq(2));
    const wide = refitParticles(parts, box, { w: 2400, h: 800 }, 40, rndSeq(3));
    // Doubling the width has to spread the arrangement, or the whole field bunches on the left.
    const before = Math.max(...parts.map((p) => p.x));
    const after = Math.max(...wide.map((p) => p.x));
    expect(after / before).toBeCloseTo(2, 1);
  });

  it("tops up to the new box's count without touching what is already there", () => {
    const parts = seedParticles(600, 400, 20, rndSeq(2));
    const out = refitParticles(parts, { w: 600, h: 400 }, box, 60, rndSeq(3));
    expect(out.length).toBe(60);
    for (let i = 0; i < 20; i++) expect(out[i]!.ph).toBe(parts[i]!.ph);
  });

  it("does not depend on a fixed seed, so two resizes cannot converge on one picture", () => {
    // The heart of it: the old code reseeded from `s = 1` every time, so a hundred resizes all
    // produced byte-identical layouts. Successive top-ups have to differ.
    const rnd = rndSeq(4);
    const a = refitParticles([], box, box, 30, rnd);
    const b = refitParticles([], box, box, 30, rnd);
    expect(a.map((p) => p.ph)).not.toEqual(b.map((p) => p.ph));
  });

  it("survives a box that has never been measured", () => {
    const out = refitParticles([], { w: 0, h: 0 }, box, 30, rndSeq(5));
    expect(out.length).toBe(30);
    for (const p of out) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});

describe("a comet flies by", () => {
  const W2 = 1200;
  const H2 = 800;
  const track = (spin: 1 | -1 = 1): Comet => ({
    x: 400, y: 400, z: 0, vx: 6, vy: 0, vz: 0, age: 0, spin,
  });

  it("starts outside the box and is aimed through it, not at a corner", () => {
    // A random heading from a random edge point clips the corner or misses entirely most of the
    // time, and a comet nobody sees is the same as no comet.
    for (let i = 0; i < 60; i++) {
      let c = spawnComet(W2, H2, rndSeq(i + 1));
      const outside = c.x < 0 || c.x > W2 || c.y < 0 || c.y > H2;
      expect(outside, "spawned inside the box, so it pops into existence mid-screen").toBe(true);
      let crossed = false;
      for (let f = 0; f < COMET_MAX_AGE && cometAlive(c, W2, H2); f++) {
        c = stepComet(c, 1);
        if (c.x > W2 * 0.2 && c.x < W2 * 0.8 && c.y > H2 * 0.2 && c.y < H2 * 0.8) crossed = true;
      }
      expect(crossed, `comet ${i} never reached the middle of the screen`).toBe(true);
    }
  });

  it("dies once it is gone, so one cannot linger forever", () => {
    let c = spawnComet(W2, H2, rndSeq(3));
    let f = 0;
    while (cometAlive(c, W2, H2) && f < COMET_MAX_AGE * 2) {
      c = stepComet(c, 1);
      f++;
    }
    expect(f, "still alive after twice its age cap").toBeLessThan(COMET_MAX_AGE * 2);
  });

  it("does nothing at all outside its reach", () => {
    const v = cometVelocity({ x: 400, y: 400 + COMET_RADIUS + 1, z: 0 }, track());
    expect(v).toEqual({ vx: 0, vy: 0, vz: 0 });
  });

  it("carries a mote along its track — this is the pull", () => {
    const v = cometVelocity({ x: 400, y: 410, z: 0 }, track());
    expect(v.vx, "a mote in the wake was not dragged forward").toBeGreaterThan(0);
  });

  /**
   * THE SWIRL, AND WHY IT IS A CROSS PRODUCT.
   *
   * Entrainment alone is a plough: everything gets shunted forward and the wake reads as a
   * bulldozer. Rotating about the AXIS OF TRAVEL is what makes it a vortex — which means motes on
   * opposite sides of the track must be pushed in opposite directions across it. If they are not,
   * there is no rotation, only a shove.
   */
  it("rotates about its track, so opposite sides go opposite ways", () => {
    const above = cometVelocity({ x: 400, y: 400, z: 90 }, track());
    const below = cometVelocity({ x: 400, y: 400, z: -90 }, track());
    expect(above.vy * below.vy, "both sides swept the same way — that is a plough, not a swirl")
      .toBeLessThan(0);
  });

  it("swirls the other way round when it spins the other way", () => {
    const cw = cometVelocity({ x: 400, y: 400, z: 90 }, track(1));
    const ccw = cometVelocity({ x: 400, y: 400, z: 90 }, track(-1));
    expect(cw.vy * ccw.vy, "every comet turns the same way").toBeLessThan(0);
  });

  /**
   * A comet is a SUSTAINED force, like scroll and the cursor — the two that have already had to be
   * cut by 3x and 8x since the spring came out. It is self-limiting only because the head moves on,
   * so this measures the whole pass rather than the force at one instant.
   */
  it("catches motes hard, and lets every one of them go", () => {
    let c = track();
    c = { ...c, x: -COMET_RADIUS };
    const offsets = [0, 40, 90, 150];
    let motes = offsets.map((o) => ({ ...at(400, 400 + o), z: o === 0 ? 0 : 60 }));
    const peaks = offsets.map(() => 0);
    for (let f = 0; f < 500; f++) {
      motes = motes.map((m, i) => {
        const v = cometVelocity(m, c);
        const n = stepParticle({ ...m, vx: m.vx + v.vx, vy: m.vy + v.vy, vz: m.vz + v.vz }, 1, f * 16.7, W2, H2);
        peaks[i] = Math.max(peaks[i]!, Math.hypot(n.vx, n.vy, n.vz));
        return n;
      });
      c = stepComet(c, 1);
    }
    expect(Math.max(...peaks), "the wake barely moved anything").toBeGreaterThan(DRIFT_MAX * 4);
    expect(Math.max(...peaks), "the wake flung motes at terminal velocity").toBeLessThan(MAX_SPEED);
    for (const m of motes) {
      expect(Math.hypot(m.vx, m.vy, m.vz), "a mote never let go of the wake").toBeLessThan(DRIFT_MAX * 1.3);
    }
  });

  it("drops a trail that marks the path instead of spraying off it", () => {
    const c = track();
    const trail = cometTrail(c, 20, rndSeq(9));
    for (const s of trail) {
      expect(Math.hypot(s.x - c.x, s.y - c.y), "the trail scattered instead of marking the path")
        .toBeLessThan(30);
      // Slow enough to stay where it fell — an emission-speed spark would fly off the track.
      expect(Math.hypot(s.vx, s.vy, s.vz)).toBeLessThan(Math.hypot(c.vx, c.vy, c.vz) * 0.4);
    }
    // SHORT-lived, and this assertion used to say the exact opposite — "long-lived, so the tail is
    // still there after the head has gone". That is the bug, written down as a requirement: a spark
    // becomes a mote only when it dies, so a long life is a long delay before the trail exists.
    expect(Math.min(...trail.map((s) => s.decay))).toBeGreaterThanOrEqual(TRAIL_DECAY_MIN);
    expect(
      1 / Math.min(...trail.map((s) => s.decay)),
      "a trail spark outlives the comet's own crossing",
    ).toBeLessThan(90);
  });

  /**
   * THE TRAIL HAS TO BE LAID DOWN WHILE THE COMET IS STILL FLYING.
   *
   * A trail spark becomes a mote only when it DIES, so its lifetime is the lag between the comet
   * passing a spot and the trail actually existing there. At the original decay that lag was two to
   * four seconds: measured over one pass, not one mote had formed by the time the head was a fifth
   * of the way across, eight by halfway, and two thirds of them landed after the comet had left the
   * screen entirely. Every static assertion about `cometTrail` passed the whole time — the fault was
   * only ever visible in WHEN things happened, which is what this measures.
   */
  it("lays its trail down behind the head, not after it has gone", () => {
    const rnd = rndSeq(7);
    let c: Comet = { x: -COMET_RADIUS, y: H2 / 2, z: 0, vx: 6, vy: 0, vz: 0, age: 0, spin: 1 };
    let sparks: Spark[] = [];
    let converted = 0;
    let convertedByQuarterWay = -1;
    for (let f = 0; f < 400 && cometAlive(c, W2, H2); f++) {
      c = stepComet(c, 1);
      if (sparks.length < MAX_SPARKS * 0.7) sparks.push(...cometTrail(c, 2, rnd));
      const live: Spark[] = [];
      for (const s of sparks) {
        const n = stepSpark(s, 1, f * 16.7);
        if (n) live.push(n);
        else converted++;
      }
      sparks = live;
      if (convertedByQuarterWay < 0 && c.x > W2 * 0.25) convertedByQuarterWay = converted;
    }
    expect(
      convertedByQuarterWay,
      "the comet was a quarter of the way across before its trail began to exist",
    ).toBeGreaterThan(20);
  });

  it("keeps the bright tail a tail, not a stripe across the screen", () => {
    // The same lifetime governs how far the visible tail reaches. Long-lived sparks stretched it to
    // 1100px on a 1600px screen, at which point the head reads as the tip of a line rather than as
    // something with a tail behind it.
    const rnd = rndSeq(8);
    let c: Comet = { x: -COMET_RADIUS, y: H2 / 2, z: 0, vx: 6, vy: 0, vz: 0, age: 0, spin: 1 };
    let sparks: Spark[] = [];
    let reach = 0;
    for (let f = 0; f < 300; f++) {
      c = stepComet(c, 1);
      if (sparks.length < MAX_SPARKS * 0.7) sparks.push(...cometTrail(c, 2, rnd));
      const live: Spark[] = [];
      for (const s of sparks) {
        const n = stepSpark(s, 1, f * 16.7);
        if (n) live.push(n);
      }
      sparks = live;
      for (const s of sparks) {
        if (s.life * s.life > 0.05) reach = Math.max(reach, Math.hypot(s.x - c.x, s.y - c.y));
      }
    }
    expect(reach, `the visible tail reached ${reach.toFixed(0)}px behind the head`).toBeLessThan(500);
    expect(reach, "there is barely a tail at all").toBeGreaterThan(80);
  });

  /**
   * THE TRAIL HAS TO STAY WHERE THE COMET PASSED.
   *
   * Two separate things were erasing it as fast as it was written, and only measuring a whole pass
   * showed either. A comet drops 640 trail sparks across a 1080p screen against a field with
   * headroom for 149, so retirement ate the oldest continuously: the surviving motes spanned
   * x 1426–1920 of 1920 — three quarters of the path already deleted before the comet reached the
   * far side, which is why the trail appeared to follow the head around.
   */
  it("leaves a trail down the whole path, not just behind the head", () => {
    const rnd = rndSeq(12);
    const w = 1920;
    const h = 1080;
    const n = Math.round(w * h * BACKDROP_DENSITY);
    const parts = seedParticles(w, h, n, rnd);
    const seedCount = parts.length;
    const maxAmbient = Math.round(n * 1.6);
    let c: Comet = { x: -COMET_RADIUS, y: h / 2, z: 0, vx: 6, vy: 0, vz: 0, age: 0, spin: 1 };
    let sparks: Spark[] = [];

    for (let f = 0; f < 420; f++) {
      c = stepComet(c, 1);
      if (sparks.length < MAX_SPARKS * 0.7) sparks.push(...cometTrail(c, TRAIL_PER_FRAME, rnd));
      const live: Spark[] = [];
      for (const s of sparks) {
        const nx = stepSpark(s, 1, f * 16.7);
        if (nx) live.push(nx);
        else if (s.x > 0 && s.x < w && s.y > 0 && s.y < h) {
          if (s.settles && rnd() >= TRAIL_CONVERT_CHANCE) continue;
          parts.push(sparkToParticle(s, rnd));
          if (parts.length > maxAmbient) parts.splice(seedCount, parts.length - maxAmbient);
        }
      }
      sparks = live;
      for (let i = 0; i < parts.length; i++) parts[i] = stepParticle(parts[i]!, 1, f * 16.7, w, h);
    }

    const trail = parts.slice(seedCount);
    expect(trail.length, "the comet left nothing behind").toBeGreaterThan(30);
    const xs = trail.map((p) => p.x);
    expect(Math.min(...xs), "the start of the path had already been retired").toBeLessThan(w * 0.15);
    expect(Math.max(...xs), "nothing survived near the end of the path").toBeGreaterThan(w * 0.85);
  });

  it("settles the trail in place instead of letting it wander off", () => {
    // A free mote wanders — that is the point of them, and it is also what would erase a trail
    // within seconds. A trail mote gets a tenth of the field's cruising speed so the line holds.
    const s: Spark = { ...cometTrail({ x: 500, y: 400, z: 0, vx: 6, vy: 0, vz: 0, age: 0, spin: 1 }, 1, rndSeq(4))[0]! };
    expect(s.settles, "a trail spark is not marked as one").toBe(true);
    const settled = sparkToParticle(s, rndSeq(5));
    expect(settled.spd, "a trail mote cruises like any other and will drift off the path")
      .toBeLessThan(DRIFT_MIN / 2);

    // A typing spark must NOT settle — it belongs to the room and should join its drift.
    const thrown = sparkToParticle(emitSparks(500, 400, 1, rndSeq(6))[0]!, rndSeq(7));
    expect(thrown.spd, "a spark thrown off the text was frozen in place").toBeGreaterThanOrEqual(DRIFT_MIN);
  });

  it("keeps the dropped trail from dancing away before it lands", () => {
    // The orbit that makes a typing spark feel alive is exactly wrong on a trail: measured over a
    // minute it scattered the settled line across 142px, more than the settle drift and the birth
    // jitter combined. It has to fall where it was dropped.
    const c: Comet = { x: 500, y: 400, z: 0, vx: 6, vy: 0, vz: 0, age: 0, spin: 1 };
    const trail = cometTrail(c, 30, rndSeq(13));
    const thrown = emitSparks(500, 400, 30, rndSeq(14));
    expect(
      Math.max(...trail.map((s) => s.spin)),
      "a trail spark orbits as hard as one thrown off a letter",
    ).toBeLessThan(Math.min(...thrown.map((s) => s.spin)) / 2);
  });

  it("stays an occasion rather than the weather", () => {
    // A comet every few seconds is ambience; the whole appeal is that it is rare.
    expect(COMET_GAP_MIN_MS).toBeGreaterThan(15000);
  });
});

describe("a forming bubble gathers the air", () => {
  it("pulls a nearby mote toward it", () => {
    const v = attractVelocity({ x: 200, y: 0, z: 0 }, 0, 0, 3, 340);
    expect(v.vx, "pushed away instead of drawn in").toBeLessThan(0);
  });

  it("does nothing beyond its reach", () => {
    expect(attractVelocity({ x: 400, y: 0, z: 0 }, 0, 0, 3, 340)).toEqual({ vx: 0, vy: 0, vz: 0 });
  });

  it("is weakest at the centre, so nothing collapses into a point", () => {
    const near = Math.abs(attractVelocity({ x: 8, y: 0, z: 0 }, 0, 0, 3, 340).vx);
    const mid = Math.abs(attractVelocity({ x: 170, y: 0, z: 0 }, 0, 0, 3, 340).vx);
    expect(mid, "the pull is strongest where the motes already are").toBeGreaterThan(near);
  });

  it("never divides by zero for a mote sitting exactly on the bubble", () => {
    const v = attractVelocity({ x: 0, y: 0, z: 0 }, 0, 0, 3, 340);
    expect(Number.isFinite(v.vx) && Number.isFinite(v.vy) && Number.isFinite(v.vz)).toBe(true);
  });
});

/**
 * A BURST MUST NOT HAVE A PREFERRED DIRECTION ON SCREEN.
 *
 * `stepSpark` carried a constant upward acceleration, commented as "a whisper of lift". Against its
 * drag that is a terminal 0.8px per frame — 57 to 134px of rise over a spark's life — and it
 * applied to every spark equally. A bias shared by every member of a population is not a whisper,
 * it is a current: the burst flowed upward, spent sparks became motes where they landed, and the
 * field grew a clump above the composer.
 *
 * Reported as gravity existing in the space above the chat window, which is exactly what an
 * unintended uniform force looks like from the outside. Nothing in a single particle's motion would
 * have shown it; only the centroid of many does.
 */
describe("a burst has no centre of attraction", () => {
  const centroid = (ss: readonly { x: number; y: number }[]): { x: number; y: number } => ({
    x: ss.reduce((a, s) => a + s.x, 0) / ss.length,
    y: ss.reduce((a, s) => a + s.y, 0) / ss.length,
  });

  it("does not drift systematically up or down the screen", () => {
    let ss = emitSparks(0, 0, 400, rndSeq());
    for (let i = 0; i < 120; i++) {
      ss = ss.map((s) => stepSpark(s, 1, i * 16.7)).filter((s): s is NonNullable<typeof s> => s !== null);
    }
    const c = centroid(ss);
    const spread = Math.max(...ss.map((s) => Math.hypot(s.x, s.y)));
    // The centroid should stay near the origin relative to how far the burst has spread. A uniform
    // force shows up here and nowhere else.
    expect(Math.abs(c.y) / spread, `burst drifted ${c.y.toFixed(0)}px vertically`).toBeLessThan(0.2);
    expect(Math.abs(c.x) / spread).toBeLessThan(0.2);
  });

  it("still recedes into depth, which is the one direction that IS wanted", () => {
    // Depth is deliberate — the letters throw material into the background. Screen-plane bias is
    // not. This pins the distinction so removing one does not quietly remove the other.
    let ss = emitSparks(0, 0, 200, rndSeq());
    for (let i = 0; i < 120; i++) {
      ss = ss.map((s) => stepSpark(s, 1, i * 16.7)).filter((s): s is NonNullable<typeof s> => s !== null);
    }
    expect(ss.reduce((a, s) => a + s.z, 0) / ss.length).toBeGreaterThan(20);
  });
});
