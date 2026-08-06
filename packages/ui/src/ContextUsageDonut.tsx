import { t } from "./design/tokens.js";
import { memo } from "react";
import { approxTokens, donutArcs, type ContextUsage } from "@visual-reader/core";

/**
 * Context-usage donut for the chat panels: where the model's window is going
 * this turn (book / visual bible / chat history / your message / instructions),
 * and how full it is. Token figures are estimates (the real tokenizer isn't
 * available client-side) — labelled "approx" so the proportions, not the exact
 * count, are the point.
 */

export interface ContextUsageDonutProps {
  usage: ContextUsage;
}

/** Stable colour per segment key (dark-theme palette, matches the app accents). */
const COLORS: Record<string, string> = {
  book: t.accent.base,
  bible: "#5ad19b",
  instructions: "#c8a2ff",
  history: "#ffc14d",
  message: "#ff8f6b",
};
const FALLBACK = "#8893a8";

export const ContextUsageDonut = memo(function ContextUsageDonut({ usage }: ContextUsageDonutProps) {
  const layout = { cx: 50, cy: 50, outerR: 46, innerR: 28 };
  const arcs = donutArcs(
    usage.segments.map((s) => ({ key: s.key, value: s.chars })),
    layout,
  );
  const used = usage.approxTokens;
  const max = usage.maxTokens;
  const pctOfMax = max ? Math.min(100, Math.round((used / max) * 100)) : undefined;
  const near = pctOfMax !== undefined && pctOfMax >= 85;

  return (
    <div style={wrapStyle}>
      <div style={{ position: "relative", width: 100, height: 100, flexShrink: 0 }}>
        <svg viewBox="0 0 100 100" width={100} height={100} role="img" aria-label="Context usage">
          {arcs.length === 0 ? (
            <circle cx={50} cy={50} r={37} fill="none" stroke={t.fill.base} strokeWidth={18} />
          ) : (
            arcs.map((a) => <path key={a.key} d={a.path} fill={COLORS[a.key] ?? FALLBACK} />)
          )}
        </svg>
        <div style={centerStyle}>
          <strong style={{ fontSize: 13 }}>{formatTokens(used)}</strong>
          <span style={{ fontSize: 9, opacity: 0.6 }}>approx tokens</span>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
          {max ? (
            <>
              <span style={{ color: near ? "#ff8f6b" : "inherit" }}>
                {pctOfMax}% of the model’s ~{formatTokens(max)}-token window
              </span>
              {near ? " · near the limit — Compact to free space" : ""}
            </>
          ) : (
            "Context this turn (the model’s window size is unknown)"
          )}
        </div>
        <ul style={legendStyle}>
          {usage.segments.map((s) => (
            <li key={s.key} style={legendItemStyle}>
              <span style={{ ...swatchStyle, background: COLORS[s.key] ?? FALLBACK }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.label}
              </span>
              <span style={{ opacity: 0.6 }}>
                {Math.round((s.chars / Math.max(1, usage.totalChars)) * 100)}% · {formatTokens(approxTokens(s.chars))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
});

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

const wrapStyle = {
  display: "flex",
  gap: 14,
  alignItems: "center",
  padding: "10px 12px",
  background: t.fill.subtle,
  border: `1px solid ${t.border.faint}`,
  borderRadius: 8,
} as const;

const centerStyle = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
} as const;

const legendStyle = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
  fontSize: 11,
} as const;

const legendItemStyle = { display: "flex", alignItems: "center", gap: 6 } as const;

const swatchStyle = { width: 10, height: 10, borderRadius: 2, flexShrink: 0 } as const;
