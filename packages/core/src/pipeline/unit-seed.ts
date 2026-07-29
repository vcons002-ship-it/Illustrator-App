/**
 * The noise seed for ONE rendered unit.
 *
 * A character's `anchor.seed` is a hash of their name — one number, the same for every picture they
 * appear in. It was doing double duty: an identity anchor (same noise → vaguely similar faces) AND
 * the sampler seed for every image in the book, because extraction never writes a per-unit seed and
 * the backends fall back to `anchors[0].seed`.
 *
 * That makes a whole book one draw from the lottery. When the draw is poor, EVERY first render is
 * poor in the same way, and the only recourse is re-rolling each image by hand — which is precisely
 * what the reader was doing, and why the redo always looked better: `regenerateCurrentImage` writes a
 * fresh random seed, so it was the only render that ever escaped that one number.
 *
 * Mixing the unit's index in keeps everything the anchor was actually buying — the same book renders
 * the same way twice, a re-render of unit N reproduces unit N — while giving each image its own
 * noise. Identity does not depend on this: it comes from the bible's descriptors and, where the
 * reader has locked a look, IP-Adapter reference images.
 */

/**
 * Mix a unit index into a base seed. A 32-bit avalanche (xorshift-multiply, as in splitmix32), so
 * neighbouring units get unrelated seeds rather than adjacent ones — consecutive integers can
 * produce visibly related noise on some samplers. Deterministic and pure.
 */
export function unitSeed(baseSeed: number, unitIndex: number): number {
  let h = (baseSeed ^ Math.imul(unitIndex + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}
