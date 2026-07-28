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
 * applies. ComfyUI's `ConditioningSetAreaPercentage` scopes a piece of conditioning to a rectangle of
 * the canvas; combined with the whole-scene conditioning, each character's own description is only
 * active where they stand. That is a real mechanism rather than a wording trick, and it needs no
 * custom nodes.
 *
 * This module is the PURE half: given the cast, work out the rectangles and the text for each. The
 * graph half lives in the ComfyUI backend, and every other provider ignores it (a cloud API takes one
 * prompt string and offers no way to say this).
 */

/** One character's patch of canvas, in fractions of the whole (0..1). */
export interface CastRegion {
  /** Who it's for — used for tests, logging, and the caption; never sent as prompt text. */
  name: string;
  /** The conditioning text active inside this rectangle. */
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Beyond this many people, columns are too narrow to hold a figure and the split does more harm than
 * the bleed it prevents — a crowd scene is left to the whole-scene prompt. (Four across a 1024-wide
 * canvas is already only ~256px per person.)
 */
export const MAX_REGIONS = 4;
/**
 * How much neighbouring columns overlap, as a fraction of the canvas. A hard seam between regions
 * shows up as a visible join down the picture; a little overlap lets the sampler blend across it.
 */
export const REGION_OVERLAP = 0.06;
/** Conditioning strength inside a region. The whole-scene conditioning is still present underneath,
 * so this is an emphasis within it, not a replacement. */
export const REGION_STRENGTH = 1;

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
