/**
 * Regional conditioning — giving each character their own patch of the canvas.
 *
 * WHY THIS EXISTS. Every diffusion text encoder mixes attributes between people in the same picture,
 * and it gets worse with each person added: three characters in a scene and one ends up wearing
 * another's hair or coat. The usual remedy elsewhere is a negative prompt per subject, which is
 * unavailable here — the natural-language families (Flux, Flux.2, Z-Image, Qwen-Image) run at CFG 1
 * with embedded guidance, so the negative branch is never evaluated at all (see `samplerFor` and
 * `resolveNegative`). Anything written there is inert.
 *
 * What DOES bind an attribute to a person is telling the sampler WHERE that person's description
 * applies. The graph half (see `addRegionalConditioning`) weights each description towards its own
 * rectangle with a MASK, leaving the sampler working across the whole canvas.
 *
 * It emphatically must not CROP to the rectangle. The first version used
 * `ConditioningSetAreaPercentage`, which does exactly that — it renders each region's conditioning to
 * fill its box — and the result was every figure misshapen and at a different scale from its
 * neighbours, because a whole person was being composed inside a one-third-wide strip. That is the
 * failure this module's shape is designed around.
 *
 * OFF BY DEFAULT, and it should stay that way until it's shown to help on a real box: it is a
 * composition constraint on a process that is already doing its own composing, and it made things
 * worse once already.
 *
 * This module is the PURE half: given the cast, work out the rectangles and the text for each. The
 * graph half lives in the ComfyUI backend, and every other provider ignores it (a cloud API takes one
 * prompt string and offers no way to say this).
 */

/** One character's patch of canvas, in fractions of the whole (0..1) — where their description is
 * weighted, NOT a box the picture is cut into. */
export interface CastRegion {
  /** Who it's for — used for tests, logging, and the caption; never sent as prompt text. */
  name: string;
  /** The conditioning text weighted towards this rectangle. */
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Beyond this many people the columns are too narrow to mean anything and the split does more harm
 * than the bleed it prevents — a crowd scene is left to the whole-scene prompt. (Four across a
 * 1024-wide canvas is already only ~256px each.)
 */
export const MAX_REGIONS = 4;
/**
 * How much neighbouring columns overlap, as a fraction of the canvas. Masks with hard edges meeting
 * exactly can leave a visible join down the picture; a little overlap blends across it.
 */
export const REGION_OVERLAP = 0.06;
/**
 * Conditioning strength inside a region. The whole-scene conditioning is still present underneath, so
 * this is an emphasis within it, not a replacement — and deliberately below 1: at full strength the
 * region competes with the scene for what that part of the canvas is, rather than saying who's
 * standing in it.
 */
export const REGION_STRENGTH = 0.75;

/**
 * Lay the cast out left-to-right across the canvas, one column each.
 *
 * Returns [] — meaning "don't do this" — when there's nothing to separate (fewer than two described
 * characters) or too many to place ({@link MAX_REGIONS}). The caller then renders exactly as before,
 * so this can only ever apply where it plausibly helps.
 *
 * Order is the cast order given, which is the scene's stable present-order, so a character doesn't
 * jump from one side of the frame to the other between beats.
 *
 * `style` (the book's world style) is appended to each region: a region carries its own conditioning,
 * and without the style the patch of canvas under a character can drift away from the look of the
 * rest of the picture. PURE.
 */
export function castRegions(
  cast: readonly { name: string; descriptor: string }[],
  opts: { style?: string } = {},
): CastRegion[] {
  const people = cast
    .map((c) => ({ name: c.name.trim(), descriptor: c.descriptor.trim() }))
    .filter((c) => c.name && c.descriptor);
  if (people.length < 2 || people.length > MAX_REGIONS) return [];
  const style = (opts.style ?? "").trim();
  const share = 1 / people.length;
  return people.map((p, i) => {
    // Widen each column by the overlap on the sides that have a neighbour, then clamp to the canvas.
    const left = Math.max(0, i * share - (i > 0 ? REGION_OVERLAP / 2 : 0));
    const right = Math.min(1, (i + 1) * share + (i < people.length - 1 ? REGION_OVERLAP / 2 : 0));
    return {
      name: p.name,
      text: style ? `${p.name}, ${p.descriptor}. ${style}` : `${p.name}, ${p.descriptor}`,
      x: round(left),
      y: 0,
      width: round(right - left),
      height: 1,
    };
  });
}

/** Two decimal places — the percentages are a layout hint, and long floats only make the graph
 * harder to read when someone inspects it. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A short note for the image caption, so the reader can see the picture was composed this way (and
 * why a character is on the left rather than wherever the prose implies). "" when no regions. PURE.
 */
export function describeRegions(regions: readonly CastRegion[]): string {
  if (regions.length === 0) return "";
  return `Placed left to right: ${regions.map((r) => r.name).join(", ")}.`;
}
