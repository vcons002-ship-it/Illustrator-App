/**
 * Donut/pie arc geometry — pure maths, no SVG strings, so it's unit-testable and
 * the UI owns rendering. Used by the chat context-usage donut; kept generic
 * (value → arc) in case other proportion views want it.
 */

export interface PieInput {
  value: number;
  /** Stable id for colour assignment / keys. */
  key: string;
}

export interface PieArc {
  key: string;
  value: number;
  /** Fraction of the whole (0..1). */
  fraction: number;
  /** Radians, clockwise from 12 o'clock (−π/2 in standard math angles). */
  startAngle: number;
  endAngle: number;
  /** SVG path `d` for a donut segment (ring slice) at the given geometry. */
  path: string;
}

export interface DonutLayout {
  /** Centre + outer/inner radii in SVG user units. */
  cx: number;
  cy: number;
  outerR: number;
  innerR: number;
}

/**
 * Lay out values as donut arcs, in input order, starting at 12 o'clock and going
 * clockwise. Zero/negative values are skipped. An all-zero input yields no arcs.
 */
export function donutArcs(values: readonly PieInput[], layout: DonutLayout): PieArc[] {
  const total = values.reduce((a, v) => a + Math.max(0, v.value), 0);
  if (total <= 0) return [];
  const arcs: PieArc[] = [];
  let angle = -Math.PI / 2; // 12 o'clock
  for (const v of values) {
    const value = Math.max(0, v.value);
    if (value <= 0) continue;
    const fraction = value / total;
    const start = angle;
    const end = angle + fraction * Math.PI * 2;
    angle = end;
    arcs.push({
      key: v.key,
      value,
      fraction,
      startAngle: start,
      endAngle: end,
      path: donutSegmentPath(layout, start, end),
    });
  }
  return arcs;
}

/** SVG path for one ring segment between two angles (radians, clockwise). */
export function donutSegmentPath(layout: DonutLayout, start: number, end: number): string {
  const { cx, cy, outerR, innerR } = layout;
  // A single arc can't draw a full circle (start==end); nudge so a lone 100%
  // segment still renders as a ring.
  const sweep = end - start;
  const e = sweep >= Math.PI * 2 ? start + Math.PI * 2 - 1e-3 : end;
  const largeArc = e - start > Math.PI ? 1 : 0;
  const [ox1, oy1] = point(cx, cy, outerR, start);
  const [ox2, oy2] = point(cx, cy, outerR, e);
  const [ix2, iy2] = point(cx, cy, innerR, e);
  const [ix1, iy1] = point(cx, cy, innerR, start);
  return [
    `M ${r(ox1)} ${r(oy1)}`,
    `A ${r(outerR)} ${r(outerR)} 0 ${largeArc} 1 ${r(ox2)} ${r(oy2)}`,
    `L ${r(ix2)} ${r(iy2)}`,
    `A ${r(innerR)} ${r(innerR)} 0 ${largeArc} 0 ${r(ix1)} ${r(iy1)}`,
    "Z",
  ].join(" ");
}

function point(cx: number, cy: number, radius: number, angle: number): [number, number] {
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

/** Round to 2 dp to keep path strings compact + stable for snapshot tests. */
function r(n: number): number {
  return Math.round(n * 100) / 100;
}
