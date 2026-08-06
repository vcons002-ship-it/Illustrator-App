import { t } from "./design/tokens.js";
import { useState } from "react";
import { activeDownloads, type DownloadStatusInput } from "./download-status.js";

/**
 * A small, app-wide indicator of every in-flight download (image/video/LoRA models + Ollama text-model
 * pulls), folded from the host's existing progress state via activeDownloads. Floats bottom-left, hides
 * itself when nothing is downloading, and collapses to a one-line summary. Lets the reader start a big
 * model download and navigate away while still seeing it progress.
 */
export function DownloadStatus(props: DownloadStatusInput): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  const items = activeDownloads(props);
  if (items.length === 0) return null;
  const overall = Math.round(items.reduce((s, it) => s + it.percent, 0) / items.length);
  return (
    <div
      style={{
        position: "fixed",
        left: 12,
        bottom: 12,
        zIndex: 90,
        width: collapsed ? "auto" : 300,
        maxWidth: "calc(100vw - 24px)",
        background: "rgba(18,20,28,0.96)",
        border: `1px solid ${t.border.subtle}`,
        borderRadius: 10,
        boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
        color: "#e8eaf0",
        fontSize: 12,
        overflow: "hidden",
      }}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Show downloads" : "Hide downloads"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 10px",
          background: "none",
          border: "none",
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        <span aria-hidden>⬇</span>
        <span style={{ fontWeight: 600 }}>
          {items.length} download{items.length > 1 ? "s" : ""}
          {collapsed ? ` · ${overall}%` : ""}
        </span>
        <span style={{ marginLeft: "auto", opacity: 0.7 }} aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
      </button>
      {!collapsed && (
        <div style={{ padding: "0 10px 10px" }}>
          {items.map((it) => (
            <div key={`${it.kind}:${it.key}`} style={{ marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.label}>
                  {it.label}
                </span>
                <span style={{ opacity: 0.7, flexShrink: 0 }}>{Math.round(it.percent)}%</span>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: t.fill.strong, marginTop: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.round(it.percent)}%`, background: "#6ea8fe", transition: "width 0.2s" }} />
              </div>
              {it.stage || it.detail ? (
                <div
                  style={{ opacity: 0.55, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={it.stage ?? it.detail}
                >
                  {it.stage ?? it.detail}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
