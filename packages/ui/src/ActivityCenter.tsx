import { t } from "./design/tokens.js";
import { memo, useState, type CSSProperties } from "react";
import { activitySummary, orderActivities, type Activity } from "@visual-reader/core";

/**
 * The app's status center: a compact header pill that says, at a glance, what the app is doing
 * right now ("Searching email & calendar (+2 more)"), and expands to the full numbered queue —
 * what's active, what's lined up behind it, and what just finished. Pure presentation; the live
 * list comes from the app's activity log. Renders nothing when idle.
 */
export interface ActivityCenterProps {
  activities: Activity[];
}

const dot = (status: Activity["status"]): string =>
  status === "active" ? "🔄" : status === "queued" ? "⏳" : status === "error" ? "⚠️" : "✓";

export const ActivityCenter = memo(function ActivityCenter({ activities }: ActivityCenterProps) {
  const [open, setOpen] = useState(false);
  const summary = activitySummary(activities);
  // Nothing happening and nothing recently finished → show nothing.
  if (activities.length === 0) return null;
  const ordered = orderActivities(activities);

  return (
    <div style={wrap}>
      <button
        style={{ ...pill, ...(summary.busy ? pillBusy : pillIdle) }}
        onClick={() => setOpen((v) => !v)}
        title="What the app is working on (and what's queued)"
      >
        <span aria-hidden>{summary.busy ? "🔄" : "✓"}</span>
        <span>{summary.busy ? summary.text : "Done"}</span>
        <span aria-hidden style={{ opacity: 0.6 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={panel}>
          <div style={panelHead}>Activity{summary.busy ? "" : " — idle"}</div>
          <ol style={list}>
            {ordered.map((act) => (
              <li key={act.id} style={{ ...row, opacity: act.status === "done" ? 0.6 : 1 }}>
                <span aria-hidden style={{ width: 18, textAlign: "center" }}>{dot(act.status)}</span>
                <span style={{ flex: 1 }}>
                  {act.label}
                  {act.status === "active" ? <span style={{ opacity: 0.6 }}> — active</span> : null}
                  {act.status === "queued" ? <span style={{ opacity: 0.6 }}> — queued</span> : null}
                  {act.detail ? <span style={{ display: "block", opacity: 0.65, fontSize: 11 }}>{act.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
});

const wrap: CSSProperties = { position: "relative", display: "inline-block" };
const pill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 10px",
  borderRadius: 999,
  border: `1px solid ${t.border.input}`,
  background: t.fill.subtle,
  color: "inherit",
  fontSize: 12,
  cursor: "pointer",
};
const pillBusy: CSSProperties = { borderColor: "rgba(120,170,255,0.5)", color: t.accent.text };
const pillIdle: CSSProperties = { color: t.state.good, borderColor: t.state.good };
const panel: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  zIndex: 60,
  width: "min(360px, 80vw)",
  background: t.surface.card,
  border: `1px solid ${t.border.input}`,
  borderRadius: 10,
  padding: "10px 12px",
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
};
const panelHead: CSSProperties = { fontSize: 12, opacity: 0.7, marginBottom: 6, fontWeight: 600 };
const list: CSSProperties = { listStyle: "decimal", margin: 0, paddingLeft: 22, display: "flex", flexDirection: "column", gap: 6 };
const row: CSSProperties = { display: "flex", gap: 6, alignItems: "flex-start", fontSize: 13 };
