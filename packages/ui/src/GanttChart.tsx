import { memo, useRef } from "react";
import { layoutGantt, type GanttRow } from "@visual-reader/core";

/**
 * Shared SVG Gantt renderer — one row per bar on a numeric axis, laid out by the pure
 * `layoutGantt` in core (geometry there, drawing here; no DOM math, downloadable). Used in
 * two places: the To-Do task timeline (real dates, interactive — click a task to open it,
 * tick a step to complete it) and the technical `gantt` info-graphic (read-only week/phase
 * positions). Pure presentation: callers pass rows + handlers.
 */
export interface GanttChartProps {
  rows: GanttRow[];
  title?: string;
  /** Format an axis position as a tick label (a date for tasks, the raw index otherwise). */
  tickLabel?: (unit: number) => string;
  width?: number;
  /** Click a bar — the row id maps back to a plan/step via `ganttRowRef`. */
  onRowClick?: (id: string) => void;
  /** When set, depth-1 (sub-task) rows show a checkbox to toggle done. */
  onToggleDone?: (id: string, done: boolean) => void;
  /** When set, collapsible parent rows show a ▸/▾ chevron that toggles their sub-tasks. */
  onToggleExpand?: (id: string) => void;
  /** Download file base name (defaults to the title). */
  fileBase?: string;
}

const ACCENT: Record<string, { fill: string; stroke: string }> = {
  group: { fill: "rgba(122,162,255,0.16)", stroke: "#7aa2ff" },
  todo: { fill: "#2a3146", stroke: "#4a5470" },
  active: { fill: "rgba(122,162,255,0.5)", stroke: "#9db8ff" },
  done: { fill: "rgba(90,209,155,0.28)", stroke: "#5dd19b" },
  blocked: { fill: "rgba(224,160,120,0.28)", stroke: "#e0a078" },
  milestone: { fill: "rgba(122,162,255,0.5)", stroke: "#9db8ff" },
};

function truncate(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `${s.slice(0, Math.max(1, maxChars - 1))}…`;
}

export const GanttChart = memo(function GanttChart({
  rows,
  title,
  tickLabel,
  width = 600,
  onRowClick,
  onToggleDone,
  onToggleExpand,
  fileBase,
}: GanttChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const layout = layoutGantt(rows, { width, ...(tickLabel ? { tickLabel } : {}) });
  const { labelWidth } = layout;

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
  const base = (fileBase || title || "gantt").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "gantt";
  const triggerDownload = (url: string, name: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const downloadSvg = () => {
    const svg = standaloneSvg();
    if (svg) triggerDownload(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), `${base}.svg`);
  };
  const downloadPng = () => {
    const svg = standaloneSvg();
    if (!svg) return;
    const svgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    const scale = 2;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = layout.width * scale;
      canvas.height = layout.height * scale;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob) triggerDownload(URL.createObjectURL(blob), `${base}.png`);
        }, "image/png");
      }
      URL.revokeObjectURL(svgUrl);
    };
    img.onerror = () => URL.revokeObjectURL(svgUrl);
    img.src = svgUrl;
  };

  return (
    <div>
      <svg
        ref={svgRef}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={title || "timeline"}
        style={{ maxWidth: "100%" }}
      >
        {/* Axis ticks: a faint gridline + a date/index label at the top of each. */}
        {layout.ticks.map((t, i) => (
          <g key={`tick-${i}`}>
            <line x1={t.x} y1={18} x2={t.x} y2={layout.height} stroke="rgba(255,255,255,0.07)" strokeWidth={1} />
            <text x={t.x} y={12} textAnchor="middle" fontSize={9} fill="#8a93a8">
              {t.label}
            </text>
          </g>
        ))}
        {/* Gutter divider. */}
        <line x1={labelWidth} y1={18} x2={labelWidth} y2={layout.height} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />

        {layout.bars.map((bar) => {
          const colors = ACCENT[bar.accent] ?? ACCENT.todo!;
          const indent = 6 + bar.depth * 12;
          const hasChevron = !!onToggleExpand && bar.collapsible;
          const hasBox = !!onToggleDone && bar.depth === 1;
          const labelX = indent + (hasChevron ? 14 : 0) + (hasBox ? 16 : 0);
          const maxChars = Math.max(4, Math.floor((labelWidth - labelX - 6) / 6.1));
          return (
            <g
              key={bar.id}
              onClick={onRowClick ? () => onRowClick(bar.id) : undefined}
              style={{ cursor: onRowClick ? "pointer" : "default" }}
            >
              <rect x={0} y={bar.y - 5} width={layout.width} height={bar.h + 10} fill="transparent" />
              {hasChevron ? (
                <text
                  x={indent}
                  y={bar.midY}
                  dominantBaseline="middle"
                  fontSize={10}
                  fill="#9aa3b8"
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand!(bar.id);
                  }}
                >
                  {bar.collapsed ? "▸" : "▾"}
                </text>
              ) : null}
              {hasBox ? (
                <text
                  x={indent}
                  y={bar.midY}
                  dominantBaseline="middle"
                  fontSize={12}
                  fill={bar.done ? "#5dd19b" : "#8a93a8"}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleDone!(bar.id, !bar.done);
                  }}
                >
                  {bar.done ? "☑" : "☐"}
                </text>
              ) : null}
              <text
                x={labelX}
                y={bar.midY}
                dominantBaseline="middle"
                fontSize={bar.depth === 0 ? 12 : 11}
                fontWeight={bar.depth === 0 ? 600 : 400}
                fill="#d7dbe4"
                style={{ textDecoration: bar.done ? "line-through" : "none", opacity: bar.done ? 0.6 : 1 }}
              >
                {truncate(bar.label, maxChars)}
              </text>
              <rect
                x={bar.x}
                y={bar.y}
                width={bar.w}
                height={bar.h}
                rx={4}
                fill={colors.fill}
                stroke={colors.stroke}
                strokeWidth={1.3}
                opacity={bar.done ? 0.7 : 1}
              />
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button onClick={downloadSvg} title="Download this timeline as an SVG file" style={exportBtn}>
          ⬇ SVG
        </button>
        <button onClick={downloadPng} title="Download this timeline as a PNG image" style={exportBtn}>
          ⬇ PNG
        </button>
      </div>
    </div>
  );
});

const exportBtn: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 5,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
};
