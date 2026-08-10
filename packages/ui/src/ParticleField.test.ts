import { describe, expect, it } from "vitest";
import {
  DEPTH,
  MAX_SPARKS,
  driftAcceleration,
  attractVelocity,
  displaceHome,
  emitSparks,
  caretXFromWidth,
  impulseVelocity,
  pickLastTextNode,
  project,
  seedParticles,
  stepParticle,
  sparkToParticle,
  stepSpark,
  wrapCaret,
  PULSE_RADIUS,
  SCROLL_CLAMP,
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
  x, y, z, vx, vy, vz: 0, hx: x, hy: y, hz: z, r: 1, a: 0.3, ph: 0.4, sx: x, sy: y, sz: z, slack: 0,
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
    // Measured through the real spring and damping rather than asserted on the impulse alone: an
    // impulse that produces a sub-pixel excursion is the 1.3px drift bug wearing a different hat.
    const v = impulseVelocity({ x: 0, y: 0, z: 60 }, 0, 0, 3.4);
    let p: Particle = { ...at(0, 0), z: 60, hz: 60, vx: v.vx, vy: v.vy, vz: v.vz };
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      p = stepParticle(p, 1);
      worst = Math.max(worst, Math.hypot(p.x - p.hx, p.y - p.hy, p.z - p.hz));
    }
    expect(worst, `peaks at ${worst.toFixed(1)}px — too small to notice`).toBeGreaterThan(5);
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
  it("carries a mote's home along when it is pushed hard", () => {
    const p = { ...at(100, 100), x: 160, y: 100 };
    const moved = displaceHome(p, 1, 400, 300);
    expect(moved.hx, "the home did not move — the mote will snap back exactly").toBeGreaterThan(p.hx);
    expect(moved.hx).toBeLessThan(160); // and not all the way; it is a drag, not a teleport
  });

  it("never strands a mote outside the box", () => {
    // A mote displaced near an edge would otherwise be pushed out of the field: invisible, still
    // simulated, and gone from the volume for good.
    const p = { ...at(390, 290), x: 900, y: 900 };
    const moved = displaceHome(p, 1, 400, 300);
    expect(moved.hx).toBeLessThanOrEqual(400);
    expect(moved.hy).toBeLessThanOrEqual(300);
    expect(moved.hz).toBeGreaterThanOrEqual(-DEPTH);
  });

  it("does nothing at all for a glancing touch", () => {
    const p = at(100, 100);
    expect(displaceHome(p, 0, 400, 300)).toEqual(p);
  });

  it("creeps back toward where it was seeded, so the volume cannot migrate", () => {
    // Without recovery, every disturbance is permanent and the field slowly drains toward the
    // bottom of the panel where the composer is.
    let p: Particle = { ...at(100, 100), hx: 260, hy: 100 };
    for (let i = 0; i < 20000; i++) p = stepParticle(p, 1);
    expect(p.hx, "the home never returned to its seed").toBeLessThan(140);
  });
});

/**
 * A <textarea> WRAPS WITHOUT PUTTING ANYTHING IN ITS VALUE.
 *
 * Splitting on "\n" therefore says a wrapped message is one enormous line: its measured width
 * exceeds the field, the clamp pins it to the right edge, and every spark sticks there from the
 * moment you reach the second line. Reported as exactly that.
 *
 * `measure` is injected, so these run on arithmetic rather than a font: ten pixels a character
 * makes every expectation something you can check by counting.
 */
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
  const push = (slack: number): { peak: number; frame: number } => {
    let p: Particle = { ...at(0, 0), vx: 2.6, slack };
    let peak = 0;
    let frame = 0;
    for (let i = 0; i < 900; i++) {
      p = stepParticle(p, 1);
      const d = Math.abs(p.x - p.hx);
      if (d > peak) {
        peak = d;
        frame = i;
      }
    }
    return { peak, frame };
  };

  it("carries far enough, and long enough, to read as being pushed", () => {
    const free = push(1);
    expect(free.peak, `only travelled ${free.peak.toFixed(1)}px`).toBeGreaterThan(30);
    expect(free.frame, "peaked too fast to see a direction").toBeGreaterThan(18);
  });

  it("travels much further released than gripped — this is the whole difference", () => {
    expect(push(1).peak).toBeGreaterThan(push(0).peak * 2);
  });

  it("still comes to rest, so slack cannot leave a mote adrift", () => {
    let p: Particle = { ...at(0, 0), vx: 2.6, slack: 1 };
    for (let i = 0; i < 6000; i++) p = stepParticle(p, 1);
    expect(p.slack).toBeLessThan(0.01);
    expect(Math.hypot(p.vx, p.vy, p.vz), "never settled").toBeLessThan(0.05);
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

  it("settles where it landed", () => {
    const s = { ...emitSparks(40, 60, 1, rndSeq())[0]!, x: 120, y: 90, z: 40 };
    const p = sparkToParticle(s, rndSeq(), 600, 400);
    expect(p.hx, "a spent spark should come to rest where it flew to").toBe(120);
    expect(p.hy).toBe(90);
    expect(p.slack, "it should coast a moment before the volume claims it").toBeGreaterThan(0);
  });

  it("is seeded into the room rather than at the caret", () => {
    // The inverse of this assertion is what emptied the top of the field: seeding a converted spark
    // where it landed meant HOME_RECOVERY pulled it back to the clump forever, so the clump was
    // permanent. Its long-term home has to be the volume, not the spot the words were typed.
    const seeds = Array.from({ length: 40 }, (_, i) => {
      const s = { ...emitSparks(0, 0, 1, rndSeq(i + 1))[0]!, x: 120, y: 390, z: 0 };
      return sparkToParticle(s, rndSeq(i + 1), 600, 400).sy;
    });
    expect(
      Math.min(...seeds),
      "every converted spark seeded down by the caret; the field will pile up there",
    ).toBeLessThan(150);
    expect(Math.max(...seeds), "no converted spark seeded in the top of the volume").toBeGreaterThan(250);
  });

  it("clamps a converted spark into the volume's depth", () => {
    const s = { ...emitSparks(0, 0, 1, rndSeq())[0]!, z: DEPTH * 10 };
    expect(sparkToParticle(s, rndSeq(), 600, 400).z).toBeLessThanOrEqual(DEPTH);
  });

  it("does not empty the volume it is thrown through", () => {
    /**
     * THE GATE FOR THE BUG THE OWNER ACTUALLY SAW. Fifteen seconds of typing at the composer used to
     * leave the top 60% of the field with literally zero motes — measured [0, 0, 0, 31, 69] across
     * five horizontal bands — because spent sparks were seeded at the caret and the retirement pass
     * consumed the original seeds oldest-first. Nothing attracts anything here; the clump is simply
     * all that is left. This asserts on the OUTCOME rather than on any one force, which is the only
     * form that could have caught it.
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
      for (let i = 0; i < parts.length; i++) parts[i] = stepParticle(parts[i]!, 1);
      const live: Spark[] = [];
      for (const s of sparks) {
        const nx = stepSpark(s, 1, f * 16.667);
        if (nx) live.push(nx);
        else if (s.x > 0 && s.x < w && s.y > 0 && s.y < h) {
          parts.push(sparkToParticle(s, rnd, w, h));
          if (parts.length > maxAmbient) parts.splice(seedCount, parts.length - maxAmbient);
        }
      }
      sparks = live;
    }

    const bands = [0, 0, 0, 0, 0];
    for (const p of parts) bands[Math.min(4, Math.floor((p.y / h) * 5))]! += 1;
    const topHalf = bands[0]! + bands[1]!;
    expect(
      topHalf / parts.length,
      `typing hollowed the field out: bands ${bands.join(",")}`,
    ).toBeGreaterThan(0.2);
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
   * THE GATE FOR A BUG THAT EVERY SETTLING TEST WOULD HAVE PASSED.
   *
   * Scroll is the only SUSTAINED force in this field; everything else is a single frame. The first
   * version fed it into the slack, the way a pulse and a gather do — and slack releases the spring,
   * so a force arriving every frame had nothing opposing it but drag. Ten seconds of ordinary
   * scrolling reached 47,000px per frame and four million pixels off screen. It still came home
   * afterwards, and it still settled to zero velocity, so "the field always settles" was perfectly
   * true the whole time and the background would have been simply absent while you read.
   *
   * The excursion DURING the force is the property that matters, and this is the only test of it.
   */
  it("never leaves the screen, however long the scroll goes on", () => {
    let p: Particle = { ...at(500, 500), z: -DEPTH }; // front plane: carried the most
    let worst = 0;
    for (let i = 0; i < 900; i++) {
      const sv = scrollVelocity(p, SCROLL_CLAMP);
      p = stepParticle({ ...p, vx: p.vx + sv.vx, vy: p.vy + sv.vy, vz: p.vz + sv.vz }, 1);
      worst = Math.max(worst, Math.abs(p.y - p.hy));
    }
    expect(worst, `fifteen seconds of scrolling threw a mote ${worst.toFixed(0)}px from home`).toBeLessThan(
      400,
    );
    // And it must be a lean, not a nudge: too small and scrolling does visibly nothing.
    expect(worst, "scrolling barely moved the field").toBeGreaterThan(60);
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
