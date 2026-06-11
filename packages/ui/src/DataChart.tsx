import { useState } from "react";
import {
  DEFAULT_LAYOUT,
  barRects,
  computeStats,
  formatStat,
  linePath,
  niceTicks,
  plotArea,
  scatterDots,
  valueDomain,
  linearScale,
  type ChapterDataset,
} from "@visual-reader/core";

/**
 * A computed chart for one extracted dataset: real SVG drawn from the chapter's
 * actual numbers (exact axes/values — the thing a generated image can't deliver),
 * with a stats footer. The model suggests the chart kind; the reader can override
 * it per dataset, since "what reads best" is a human call.
 */
export interface DataChartProps {
  dataset: ChapterDataset;
}

const KINDS = ["bar", "line", "scatter"] as const;
const ACCENT = "#7aa2ff";
const GRID = "rgba(255,255,255,0.12)";
const TEXT = "rgba(255,255,255,0.75)";
const FAINT = "rgba(255,255,255,0.5)";

export function DataChart({ dataset }: DataChartProps) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>(dataset.kind);
  const layout = DEFAULT_LAYOUT;
  const area = plotArea(layout);
  const stats = computeStats(dataset.points);
  // Bars get the honest zero baseline; line/scatter fit the data's own range.
  const domain = valueDomain(dataset.points, kind === "bar");
  const yScale = linearScale(domain, [area.y + area.height, area.y]);
  const ticks = niceTicks(domain[0], domain[1], 4);
  const dots = scatterDots(dataset.points, layout);
  // Label x ticks from point labels for bars (categorical); thin them when crowded.
  const labelEvery = Math.max(1, Math.ceil(dataset.points.length / 6));

  return (
    <figure style={{ margin: "8px 0", fontSize: 11 }}>
      <figcaption style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <span style={{ color: TEXT, fontWeight: 600 }}>{dataset.title}</span>
        {dataset.unit ? <span style={{ color: FAINT }}>({dataset.unit})</span> : null}
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {KINDS.map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              style={{
                background: k === kind ? "rgba(122,162,255,0.25)" : "transparent",
                color: k === kind ? "#cdd9ff" : FAINT,
                border: `1px solid ${k === kind ? ACCENT : GRID}`,
                borderRadius: 4,
                padding: "1px 6px",
                fontSize: 10,
                cursor: "pointer",
              }}
            >
              {k}
            </button>
          ))}
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label={`${kind} chart: ${dataset.title}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={area.x} x2={area.x + area.width} y1={yScale(t)} y2={yScale(t)} stroke={GRID} strokeWidth={1} />
            <text x={area.x - 6} y={yScale(t) + 3} textAnchor="end" fontSize={9} fill={FAINT}>
              {formatStat(t)}
            </text>
          </g>
        ))}

        {kind === "bar" &&
          barRects(dataset.points, layout).map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.width} height={r.height} fill={ACCENT} opacity={0.85}>
              <title>{`${r.label}: ${formatStat(r.value)}${dataset.unit ? ` ${dataset.unit}` : ""}`}</title>
            </rect>
          ))}
        {kind === "line" && (
          <path d={linePath(dataset.points, layout)} fill="none" stroke={ACCENT} strokeWidth={2} />
        )}
        {(kind === "line" || kind === "scatter") &&
          dots.map((d, i) => (
            <circle key={i} cx={d.cx} cy={d.cy} r={kind === "scatter" ? 3.5 : 2.5} fill={ACCENT}>
              <title>{`${d.label}: ${formatStat(d.value)}${dataset.unit ? ` ${dataset.unit}` : ""}`}</title>
            </circle>
          ))}

        {kind === "bar" &&
          barRects(dataset.points, layout).map((r, i) =>
            i % labelEvery === 0 ? (
              <text
                key={`l${i}`}
                x={r.x + r.width / 2}
                y={layout.height - layout.margin.bottom + 12}
                textAnchor="middle"
                fontSize={9}
                fill={FAINT}
              >
                {truncateLabel(r.label)}
              </text>
            ) : null,
          )}
        {kind !== "bar" && dataset.xLabel ? (
          <text
            x={area.x + area.width / 2}
            y={layout.height - 6}
            textAnchor="middle"
            fontSize={9}
            fill={FAINT}
          >
            {dataset.xLabel}
          </text>
        ) : null}
      </svg>

      {stats ? (
        <div style={{ color: FAINT, marginTop: 2 }}>
          n={stats.count} · min {formatStat(stats.min)} · max {formatStat(stats.max)} · mean{" "}
          {formatStat(stats.mean)} · median {formatStat(stats.median)} · {stats.trend}
        </div>
      ) : null}
      {dataset.source ? (
        <div style={{ color: FAINT, marginTop: 2, fontStyle: "italic" }}>“{dataset.source}”</div>
      ) : null}
    </figure>
  );
}

function truncateLabel(s: string): string {
  return s.length > 10 ? `${s.slice(0, 9)}…` : s;
}
