import { linearScale, niceTicks } from "../charts/chart-geometry.js";

/**
 * Pure, deterministic layout for a GANTT chart — horizontal bars on one shared numeric
 * axis (days, weeks, phases…), one row each, with an optional indent `depth` so a task
 * and its sub-tasks group visually. Mirrors `charts/chart-geometry.ts` and
 * `infographic-geometry.ts`: the math lives in core (no React, no DOM, unit-testable) and
 * the UI maps these coordinates straight into SVG. Shared by the To-Do task timeline (real
 * dates mapped to day numbers) and the technical `gantt` info-graphic (unitless positions
 * like week numbers), so both draw from one renderer.
 *
 * `start`/`end` are INCLUSIVE axis positions: a bar covers [start, end + 1) so a
 * single-unit item (start === end) still has width.
 */

export type GanttAccent = "todo" | "active" | "done" | "blocked" | "group" | "milestone";

export interface GanttRow {
  id: string;
  label: string;
  /** Inclusive start position on the shared axis. */
  start: number;
  /** Inclusive end position (clamped to ≥ start). */
  end: number;
  /** 0 = a top-level task/group, 1 = an indented sub-task. */
  depth?: number;
  done?: boolean;
  accent?: GanttAccent;
}

export interface GanttBar {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Vertical centre of the row (label baseline anchor). */
  midY: number;
  depth: number;
  done: boolean;
  accent: GanttAccent;
}
export interface GanttTick {
  x: number;
  label: string;
}
export interface GanttLayout {
  bars: GanttBar[];
  ticks: GanttTick[];
  width: number;
  height: number;
  /** Left gutter where row labels are drawn; the plotted bars start here. */
  labelWidth: number;
  rowHeight: number;
}

export interface GanttOptions {
  /** Map an axis position to a tick label (a date for tasks, "5" for week indices). */
  tickLabel?: (unit: number) => string;
  /** Total SVG width (default 600). */
  width?: number;
  labelWidth?: number;
  rowHeight?: number;
  /** Roughly how many axis ticks to aim for (default 5). */
  targetTicks?: number;
}

const TOP = 24; // header band for the axis ticks
const BOTTOM = 10;
const RIGHT = 12;
const BAR_PAD = 5; // vertical padding inside a row band

/** Lay rows out as Gantt bars on a shared axis covering every row's [start, end]. */
export function layoutGantt(rows: readonly GanttRow[], opts: GanttOptions = {}): GanttLayout {
  const width = opts.width ?? 600;
  const labelWidth = opts.labelWidth ?? 158;
  const rowHeight = opts.rowHeight ?? 26;
  const chartW = Math.max(1, width - labelWidth - RIGHT);

  // Axis domain spans every bar; pad a degenerate (all-equal) range so it has width.
  const starts = rows.map((r) => r.start).filter((n) => Number.isFinite(n));
  const ends = rows.map((r) => r.end).filter((n) => Number.isFinite(n));
  const d0 = starts.length ? Math.min(...starts) : 0;
  // End is inclusive, so the axis runs one unit past the last end (a 1-unit bar is visible).
  let d1 = (ends.length ? Math.max(...ends) : d0) + 1;
  if (d1 - d0 < 1) d1 = d0 + 1;

  const xScale = linearScale([d0, d1], [labelWidth, labelWidth + chartW]);

  const bars: GanttBar[] = rows.map((r, i) => {
    const start = Number.isFinite(r.start) ? r.start : d0;
    const end = Number.isFinite(r.end) ? Math.max(r.end, start) : start;
    const x = xScale(start);
    const w = Math.max(3, xScale(end + 1) - x);
    const y = TOP + i * rowHeight + BAR_PAD;
    const h = rowHeight - BAR_PAD * 2;
    const depth = r.depth ?? 0;
    return {
      id: r.id,
      label: r.label,
      x,
      y,
      w,
      h,
      midY: y + h / 2,
      depth,
      done: !!r.done,
      accent: r.accent ?? (r.done ? "done" : depth === 0 ? "group" : "todo"),
    };
  });

  const ticks: GanttTick[] = niceTicks(d0, d1, opts.targetTicks ?? 5)
    .filter((t) => t >= d0 && t <= d1)
    .map((t) => ({ x: xScale(t), label: opts.tickLabel ? opts.tickLabel(t) : String(t) }));

  return {
    bars,
    ticks,
    width,
    height: TOP + rows.length * rowHeight + BOTTOM,
    labelWidth,
    rowHeight,
  };
}
