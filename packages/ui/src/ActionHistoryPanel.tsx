import { t } from "./design/tokens.js";
import { memo, type CSSProperties } from "react";
import type { ActionEntry } from "@visual-reader/core";
import { ModalShell } from "./ModalShell.js";

/**
 * A scrollable log of what the assistant did on its own or for the reader (scans, planning,
 * scheduled-task runs, tasks created) — so they can catch up on activity since they last looked.
 * Pure presentation; the persistent entries come from the app's action history.
 */
export interface ActionHistoryPanelProps {
  entries: ActionEntry[];
  /** Entries at/after this ms-epoch are shown as "new". */
  newSince: number;
  onClear: () => void;
  onClose: () => void;
}

const ICON: Record<string, string> = {
  scan: "🔍",
  plan: "🧩",
  create_task: "🗂️",
  scheduled_run: "⏰",
  calendar: "📅",
  other: "•",
};

function when(at: number): string {
  const d = new Date(at);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export const ActionHistoryPanel = memo(function ActionHistoryPanel({ entries, newSince, onClear, onClose }: ActionHistoryPanelProps) {
  return (
    <ModalShell
      title="Agent activity"
      onClose={onClose}
      overlayStyle={overlay}
      cardStyle={panel}
    >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <strong style={{ fontSize: 15 }}>🗒️ Agent activity</strong>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {entries.length > 0 && (
              <button style={btn} onClick={onClear} title="Clear the activity log">
                Clear
              </button>
            )}
            <button style={btn} onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        {entries.length === 0 ? (
          <div style={{ fontSize: 13, opacity: 0.6, padding: "12px 0" }}>
            Nothing yet. Background scans, planning, scheduled tasks, and tasks the assistant creates show up here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: "60vh", overflowY: "auto" }}>
            {entries.map((e) => {
              const isNew = e.at > newSince;
              return (
                <div key={e.id} style={{ ...row, ...(isNew ? rowNew : {}) }}>
                  <span aria-hidden style={{ width: 20, textAlign: "center" }}>{ICON[e.kind] ?? "•"}</span>
                  <span style={{ flex: 1 }}>
                    {e.label}
                    {e.detail ? <span style={{ opacity: 0.6 }}> — {e.detail}</span> : null}
                  </span>
                  {isNew ? <span style={newDot} title="New since you last looked" /> : null}
                  <span style={{ fontSize: 11, opacity: 0.5, whiteSpace: "nowrap" }}>{when(e.at)}</span>
                </div>
              );
            })}
          </div>
        )}
    </ModalShell>
  );
});

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: t.surface.overlay,
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};
const panel: CSSProperties = {
  width: "min(520px, 100%)",
  background: t.surface.card,
  color: t.text.base,
  border: `1px solid ${t.border.subtle}`,
  borderRadius: 12,
  padding: 16,
  fontFamily: "system-ui, sans-serif",
};
const row: CSSProperties = { display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "5px 6px", borderRadius: 6 };
const rowNew: CSSProperties = { background: t.accent.fill };
const newDot: CSSProperties = { width: 7, height: 7, borderRadius: "50%", background: t.accent.base, flexShrink: 0 };
const btn: CSSProperties = {
  background: t.fill.base,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
