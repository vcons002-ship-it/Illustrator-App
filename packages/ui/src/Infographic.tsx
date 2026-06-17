import { memo, useRef } from "react";
import { layoutFlowchart, type ChapterInfographic, type GanttRow, type InfographicSpec } from "@visual-reader/core";
import { GanttChart } from "./GanttChart.js";

/**
 * Render a structured info-graphic extracted from a technical chapter: a **summary** card, a
 * labeled **diagram** card, or a **flowchart** drawn as SVG (laid out by the pure
 * `layoutFlowchart` in core — exact, no diffusion, downloadable). Anchored near its source
 * paragraph by the reader, mirroring the data charts + concept cards.
 */
export const Infographic = memo(function Infographic({ data }: { data: ChapterInfographic }) {
  const { spec, title } = data;
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>
        {ICON[spec.kind]} {title}
      </div>
      {spec.kind === "summary" && (
        <ul style={listStyle}>
          {spec.bullets.map((b, i) => (
            <li key={i} style={itemStyle}>
              {b}
            </li>
          ))}
        </ul>
      )}
      {spec.kind === "diagram" && (
        <>
          <ul style={listStyle}>
            {spec.parts.map((p, i) => (
              <li key={i} style={itemStyle}>
                <strong>{p.label}</strong>
                {p.note ? ` — ${p.note}` : ""}
              </li>
            ))}
          </ul>
          {spec.caption ? <div style={captionStyle}>{spec.caption}</div> : null}
        </>
      )}
      {spec.kind === "flowchart" && <Flowchart spec={spec} title={title} />}
      {spec.kind === "gantt" && <GanttView spec={spec} title={title} />}
    </div>
  );
});

const ICON: Record<InfographicSpec["kind"], string> = { summary: "📝", diagram: "🧩", flowchart: "🔀", gantt: "📅" };

/** A `gantt` info-graphic: the chapter's described timeline/schedule, drawn with the shared
 * Gantt renderer. Read-only (no due dates to tick) — `start`/`end` are unitless positions. */
function GanttView({ spec, title }: { spec: Extract<InfographicSpec, { kind: "gantt" }>; title: string }) {
  const rows: GanttRow[] = spec.tasks.map((t) => ({ id: t.id, label: t.label, start: t.start, end: t.end, depth: 0 }));
  const unit = spec.unit.trim();
  return (
    <div>
      <GanttChart rows={rows} title={title} fileBase={title} {...(unit ? { tickLabel: (u: number) => `${u}` } : {})} />
      {unit ? <div style={captionStyle}>axis: {unit}</div> : null}
    </div>
  );
}

function Flowchart({ spec, title }: { spec: Extract<InfographicSpec, { kind: "flowchart" }>; title: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const layout = layoutFlowchart(spec);

  const standaloneSvg = (): string => {
    const node = svgRef.current;
    if (!node) return "";
    const clone = node.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("width", String(layout.width));
    bg.setAttribute("height", String(layout.height));
    bg.setAttribute("fill", "#13161e");
    clone.insertBefore(bg, clone.firstChild);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  };
  const base = (title || "flowchart").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "flowchart";
  const download = (url: string, name: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const downloadSvg = () => {
    const svg = standaloneSvg();
    if (svg) download(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), `${base}.svg`);
  };

  return (
    <div>
      <svg ref={svgRef} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={title}>
        <defs>
          <marker id="vr-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L6,3 L0,6 Z" fill="#7f8aa3" />
          </marker>
        </defs>
        {layout.edges.map((e, i) => (
          <g key={i}>
            <path d={e.path} fill="none" stroke="#7f8aa3" strokeWidth={1.4} markerEnd="url(#vr-arrow)" />
            {e.label && e.labelPos ? (
              <text x={e.labelPos.x} y={e.labelPos.y} fontSize={11} fill="#9aa3b8">
                {e.label}
              </text>
            ) : null}
          </g>
        ))}
        {layout.nodes.map((n) => (
          <Node key={n.id} node={n} />
        ))}
      </svg>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button onClick={downloadSvg} title="Download this flowchart as an SVG file" style={exportBtnStyle}>
          ↓ SVG
        </button>
      </div>
    </div>
  );
}

function Node({ node }: { node: ReturnType<typeof layoutFlowchart>["nodes"][number] }) {
  const { x, y, w, h, label, shape } = node;
  const fill = shape === "start" || shape === "end" ? "#1f3a2e" : shape === "decision" ? "#3a2f1f" : "#1c2230";
  const stroke = shape === "start" || shape === "end" ? "#5dd19b" : shape === "decision" ? "#e0b96a" : "#4a5470";
  const lines = wrapLabel(label, 28);
  const textY = y + h / 2 - ((lines.length - 1) * 16) / 2;
  return (
    <g>
      {shape === "decision" ? (
        <polygon
          points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.4}
        />
      ) : (
        <rect x={x} y={y} width={w} height={h} rx={shape === "start" || shape === "end" ? h / 2 : 8} fill={fill} stroke={stroke} strokeWidth={1.4} />
      )}
      <text x={x + w / 2} y={textY} textAnchor="middle" dominantBaseline="middle" fontSize={13} fill="#e6e6e6">
        {lines.map((ln, i) => (
          <tspan key={i} x={x + w / 2} dy={i === 0 ? 0 : 16}>
            {ln}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function wrapLabel(label: string, perLine: number): string[] {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > perLine) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [label];
}

const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "10px 12px",
  margin: "8px 0",
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
};
const titleStyle: React.CSSProperties = { fontWeight: 600, marginBottom: 6, fontSize: 13 };
const listStyle: React.CSSProperties = { margin: "0 0 0 1.1em", padding: 0 };
const itemStyle: React.CSSProperties = { margin: "0.25em 0", lineHeight: 1.5 };
const captionStyle: React.CSSProperties = { fontSize: 11, opacity: 0.6, marginTop: 6 };
const exportBtnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 5,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
};
