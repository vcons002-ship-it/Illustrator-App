import type { InfographicSpec } from "../types/bible.js";

/**
 * Pure, deterministic layout for a flowchart info-graphic — a single top-to-bottom column of
 * nodes with arrow paths between them (mirrors `charts/chart-geometry.ts`: geometry in core, SVG
 * in the UI, no DOM, unit-testable). Simple by design: linear processes, cycles, light branching
 * and decisions render cleanly; a tangle of arbitrary edges just routes via right-side elbows.
 */

type Flow = Extract<InfographicSpec, { kind: "flowchart" }>;
type NodeShape = Flow["nodes"][number]["shape"];

export interface LaidNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  shape: NodeShape;
}
export interface LaidEdge {
  from: string;
  to: string;
  /** SVG path `d` from the source node to the target. */
  path: string;
  label?: string;
  labelPos?: { x: number; y: number };
}
export interface FlowLayout {
  nodes: LaidNode[];
  edges: LaidEdge[];
  width: number;
  height: number;
}

const NODE_W = 210;
const LINE_H = 18;
const ROW_GAP = 38;
const MARGIN = 16;
const ELBOW = 26;
const CHARS_PER_LINE = 28;

function nodeHeight(label: string): number {
  const lines = Math.max(1, Math.ceil(label.length / CHARS_PER_LINE));
  return lines * LINE_H + 16;
}

/**
 * Order nodes for a single column: start at roots (no incoming edge) and follow edges
 * DEPTH-FIRST (so the main chain stays contiguous, A→B→C→D), then any leftovers (disconnected
 * nodes / cycle members). `seen` guards cycles.
 */
function orderNodes(spec: Flow): Flow["nodes"] {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const incoming = new Set(spec.edges.map((e) => e.to));
  const roots = spec.nodes.filter((n) => !incoming.has(n.id));
  const seen = new Set<string>();
  const order: Flow["nodes"] = [];
  const visit = (n: Flow["nodes"][number] | undefined): void => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    order.push(n);
    for (const e of spec.edges) if (e.from === n.id && byId.has(e.to)) visit(byId.get(e.to));
  };
  for (const r of roots.length > 0 ? roots : spec.nodes.slice(0, 1)) visit(r);
  for (const n of spec.nodes) visit(n);
  return order;
}

export function layoutFlowchart(spec: Flow): FlowLayout {
  const nodes: LaidNode[] = [];
  let y = MARGIN;
  const cx = MARGIN + NODE_W / 2;
  for (const n of orderNodes(spec)) {
    const h = nodeHeight(n.label);
    nodes.push({ id: n.id, x: MARGIN, y, w: NODE_W, h, label: n.label, shape: n.shape });
    y += h + ROW_GAP;
  }
  const pos = new Map(nodes.map((n, i) => [n.id, { n, row: i }]));
  const edges: LaidEdge[] = [];
  let usedElbow = false;
  for (const e of spec.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    let path: string;
    if (b.row === a.row + 1) {
      path = `M ${cx} ${a.n.y + a.n.h} L ${cx} ${b.n.y}`; // straight down to the next node
    } else {
      usedElbow = true;
      const rx = MARGIN + NODE_W + ELBOW;
      const fy = a.n.y + a.n.h / 2;
      const ty = b.n.y + b.n.h / 2;
      path = `M ${MARGIN + NODE_W} ${fy} L ${rx} ${fy} L ${rx} ${ty} L ${MARGIN + NODE_W} ${ty}`;
    }
    edges.push({
      from: e.from,
      to: e.to,
      path,
      ...(e.label ? { label: e.label, labelPos: { x: cx + 8, y: (a.n.y + a.n.h + b.n.y) / 2 } } : {}),
    });
  }
  return {
    nodes,
    edges,
    width: MARGIN + NODE_W + (usedElbow ? ELBOW + MARGIN : MARGIN),
    height: Math.max(MARGIN * 2, y - ROW_GAP + MARGIN),
  };
}
