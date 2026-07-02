import { useState, type CSSProperties } from "react";
import { ModalShell } from "./ModalShell.js";

/**
 * A small "name this file before saving" modal. Opened with a content-derived default (e.g. a
 * slug of the book/table title); the reader can edit it, then Save with that name or Cancel. Pure
 * presentation — the caller resolves a promise with the chosen name (or null on cancel).
 */
export interface RenameExportModalProps {
  /** The proposed filename (already includes its extension). */
  defaultName: string;
  /** A short note about what's being saved (e.g. "Illustrated HTML"). */
  what?: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function RenameExportModal({ defaultName, what, onConfirm, onCancel }: RenameExportModalProps) {
  const [name, setName] = useState(defaultName);
  const confirm = () => {
    const n = name.trim();
    onConfirm(n || defaultName);
  };
  return (
    <ModalShell title="Save as" onClose={onCancel} overlayStyle={overlay} cardStyle={panel}>
        <strong style={{ fontSize: 15 }}>💾 Save as…</strong>
        {what ? <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{what}</div> : null}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
            // Escape is handled by ModalShell.
          }}
          onFocus={(e) => {
            // Pre-select the stem (not the extension) so a quick rename keeps the type.
            const dot = name.lastIndexOf(".");
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length);
          }}
          style={input}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          <button style={btn} onClick={onCancel}>Cancel</button>
          <button style={btnPrimary} onClick={confirm} disabled={!name.trim()}>Save</button>
        </div>
    </ModalShell>
  );
}

// Deltas from ModalShell's shared look: above other overlays, a narrow block-flow card.
const overlay: CSSProperties = { zIndex: 120 };
const panel: CSSProperties = {
  width: "min(440px, 100%)",
  display: "block",
  gap: 0,
  maxHeight: "none",
  overflowY: "visible",
};
const input: CSSProperties = {
  width: "100%",
  marginTop: 12,
  background: "rgba(0,0,0,0.3)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 13,
  boxSizing: "border-box",
};
const btn: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
};
const btnPrimary: CSSProperties = { ...btn, background: "rgba(122,162,255,0.3)", borderColor: "rgba(122,162,255,0.6)" };
