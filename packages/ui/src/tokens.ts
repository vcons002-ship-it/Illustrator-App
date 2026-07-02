import type { CSSProperties } from "react";

/**
 * Shared design tokens — the colors and small style objects that were hand-copied
 * across panels (MemoriesPanel ≡ SoulPanel verbatim; ChatBuddyPanel ≡ ChatPanel).
 * Deduplication only, no redesign: where copies had drifted, each token keeps the
 * value that was used in the most places. Internal to packages/ui — imported by
 * relative path, NOT exported from index.ts.
 */

// "✓ saved / connected / installed" green. Drifted copies unified: #7dd87f (8 uses)
// over #6ee7a8 (2) and #7ddf9a (1).
export const SUCCESS_GREEN = "#7dd87f";
// Link / accent blue. Drifted copies unified: #9db8ff (8 uses) over #9db4ff (5).
export const ACCENT_BLUE = "#9db8ff";
// Inline error text red.
export const DANGER_RED = "#ff9b9b";

// The standard centered-modal backdrop + card surface (MemoriesPanel's pattern).
export const OVERLAY_BG = "rgba(8,9,13,0.7)";
export const CARD_BG = "#16181d";
// The recurring hairline borders, weakest → strongest.
export const BORDER_FAINT = "rgba(255,255,255,0.1)";
export const BORDER_SUBTLE = "rgba(255,255,255,0.12)";
export const BORDER_INPUT = "rgba(255,255,255,0.15)";
export const BORDER_BUTTON = "rgba(255,255,255,0.18)";

/* ------------------------------------------------------------------------- *
 * Modal-family styles (were verbatim copies in MemoriesPanel + SoulPanel).
 * ------------------------------------------------------------------------- */

export const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: OVERLAY_BG,
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};

export const modalCardStyle: CSSProperties = {
  width: "min(620px, 100%)",
  maxHeight: "92vh",
  overflowY: "auto",
  background: CARD_BG,
  color: "#e6e6e6",
  border: `1px solid ${BORDER_SUBTLE}`,
  borderRadius: 12,
  padding: 18,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontFamily: "system-ui, sans-serif",
};

export const modalHeaderRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

export const modalInputStyle: CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  border: `1px solid ${BORDER_INPUT}`,
  borderRadius: 6,
  padding: 8,
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

export const modalAddRowStyle: CSSProperties = { display: "flex", gap: 6 };

export const modalNoteRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  border: `1px solid ${BORDER_FAINT}`,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
};

export const modalEditRowStyle: CSSProperties = {
  ...modalNoteRowStyle,
  border: "1px solid rgba(122,162,255,0.4)",
  background: "rgba(122,162,255,0.06)",
};

export const modalBtnStyle: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: `1px solid ${BORDER_BUTTON}`,
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 13,
  cursor: "pointer",
};

export const modalBtnPrimaryStyle: CSSProperties = {
  ...modalBtnStyle,
  background: "rgba(122,162,255,0.25)",
  border: "1px solid rgba(122,162,255,0.6)",
};

/* ------------------------------------------------------------------------- *
 * Chat-family styles (were verbatim copies in ChatPanel + ChatBuddyPanel).
 * ------------------------------------------------------------------------- */

export const chatHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  borderBottom: `1px solid ${BORDER_FAINT}`,
};

export const chatScrollStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
};

export const chatInputRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: 10,
  borderTop: `1px solid ${BORDER_FAINT}`,
  alignItems: "flex-end",
};

export const chatTextareaStyle: CSSProperties = {
  flex: 1,
  resize: "none",
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  border: `1px solid ${BORDER_INPUT}`,
  borderRadius: 6,
  padding: 8,
  fontSize: 13,
  fontFamily: "inherit",
};

export const smallButtonStyle: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
};

export const approvalStyle: CSSProperties = {
  alignSelf: "flex-start",
  border: "1px solid rgba(122,162,255,0.5)",
  borderRadius: 8,
  padding: 10,
  background: "rgba(122,162,255,0.08)",
};
