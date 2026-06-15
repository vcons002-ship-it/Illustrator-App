import { memo, type ReactNode } from "react";
import type { JsonValue } from "@visual-reader/core";

/**
 * A collapsible tree for nested/irregular JSON — the view that fits data that DOESN'T
 * normalise to a table (an API response, a config). Built on native `<details>` so
 * expand/collapse needs no state, it's keyboard-accessible, and deep blobs stay cheap
 * (collapsed branches render their children lazily on open). Self-contained scroll
 * surface so a big object can't run off the page.
 */
export interface JsonTreeViewProps {
  value: JsonValue;
  /** Levels open on first render (default 1 — the top level expanded, the rest folded). */
  defaultExpandedDepth?: number;
  /** Cap children rendered per node; a marker notes how many more (default 200). */
  maxChildren?: number;
  /** Cap the scroll area's height in px (default 420). */
  maxHeight?: number;
}

export const JsonTreeView = memo(function JsonTreeView({
  value,
  defaultExpandedDepth = 1,
  maxChildren = 200,
  maxHeight = 420,
}: JsonTreeViewProps) {
  return (
    <div style={{ ...scrollStyle, maxHeight }}>
      <Node label={undefined} value={value} depth={0} open={defaultExpandedDepth} max={maxChildren} />
    </div>
  );
});

function Node({
  label,
  value,
  depth,
  open,
  max,
}: {
  label: string | undefined;
  value: JsonValue;
  depth: number;
  open: number;
  max: number;
}): ReactNode {
  const key = label !== undefined ? <span style={keyStyle}>{label}: </span> : null;

  if (value === null || typeof value !== "object") {
    return (
      <div style={{ ...rowStyle, paddingLeft: depth * INDENT }}>
        {key}
        <span style={valueStyle(value)}>{formatPrimitive(value)}</span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, JsonValue][] = isArray
    ? (value as JsonValue[]).map((v, i) => [String(i), v])
    : Object.entries(value);
  const shown = entries.slice(0, max);
  const hidden = entries.length - shown.length;
  const count = isArray ? `[${entries.length}]` : `{${entries.length}}`;

  return (
    <details open={depth < open} style={{ paddingLeft: depth * INDENT }}>
      <summary style={summaryStyle}>
        {label !== undefined ? <span style={keyStyle}>{label} </span> : null}
        <span style={countStyle}>{isArray ? "Array" : "Object"} {count}</span>
      </summary>
      {shown.map(([k, v]) => (
        <Node key={k} label={k} value={v} depth={depth + 1} open={open} max={max} />
      ))}
      {hidden > 0 ? (
        <div style={{ ...rowStyle, paddingLeft: (depth + 1) * INDENT, opacity: 0.5 }}>
          …{hidden.toLocaleString("en-US")} more
        </div>
      ) : null}
    </details>
  );
}

function formatPrimitive(v: null | boolean | number | string): string {
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

function valueStyle(v: JsonValue) {
  const color =
    v === null ? "#8b93a7" : typeof v === "number" ? "#7aa2ff" : typeof v === "boolean" ? "#bb9af7" : "#9ece6a";
  return { color, wordBreak: "break-word" as const };
}

const INDENT = 14;

const scrollStyle = {
  overflow: "auto",
  background: "#13161e",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: "6px 8px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  lineHeight: 1.5,
} as const;

const rowStyle = { whiteSpace: "pre-wrap" } as const;
const summaryStyle = { cursor: "pointer" } as const;
const keyStyle = { color: "#7dcfff" } as const;
const countStyle = { color: "#8b93a7" } as const;
