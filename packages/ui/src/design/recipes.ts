import type { CSSProperties } from "react";
import { t } from "./tokens.js";

/**
 * Composite style objects shared across panels — the modal frame and the chat frame.
 *
 * These came from the old `tokens.ts`, whose header recorded that they were hand-copied
 * duplicates that had drifted (`MemoriesPanel` ≡ `SoulPanel` verbatim; `ChatBuddyPanel` ≡
 * `ChatPanel`). Same objects, same shapes, same exported names — every value now points at a
 * token instead of a literal, so the palette can change without touching this file.
 *
 * Kept as inline-style objects rather than folded into CSS classes because ten components
 * already import them and several tests assert on their fields; converting them to classes
 * would be a structural change, and the whole point of this migration is that tokenising is
 * not one.
 */

/* ---- Scalars, kept for the components that import them by name --------------------- */
export const SUCCESS_GREEN = t.state.good;
export const ACCENT_BLUE = t.accent.text;
export const DANGER_RED = t.state.danger;
export const OVERLAY_BG = t.surface.overlay;
export const CARD_BG = t.surface.card;
export const BORDER_FAINT = t.border.faint;
export const BORDER_SUBTLE = t.border.subtle;
export const BORDER_INPUT = t.border.input;
export const BORDER_BUTTON = t.border.button;

/* ---- Modal family ------------------------------------------------------------------ */

export const modalOverlayStyle: CSSProperties = {
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

export const modalCardStyle: CSSProperties = {
  width: "min(620px, 100%)",
  maxHeight: "92vh",
  overflowY: "auto",
  background: t.surface.card,
  color: t.text.base,
  border: `1px solid ${t.border.subtle}`,
  borderRadius: 12,
  padding: 18,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontFamily: t.font.ui,
};

export const modalHeaderRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

export const modalInputStyle: CSSProperties = {
  background: t.fill.subtle,
  color: "inherit",
  border: `1px solid ${t.border.input}`,
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
  border: `1px solid ${t.border.faint}`,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
};

export const modalEditRowStyle: CSSProperties = {
  ...modalNoteRowStyle,
  border: `1px solid ${t.accent.edge}`,
  background: t.accent.wash,
};

export const modalBtnStyle: CSSProperties = {
  background: t.fill.base,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 13,
  cursor: "pointer",
};

export const modalBtnPrimaryStyle: CSSProperties = {
  ...modalBtnStyle,
  background: t.accent.fill,
  border: `1px solid ${t.accent.edge}`,
};

/* ---- Chat family ------------------------------------------------------------------- */

export const chatHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  borderBottom: `1px solid ${t.border.faint}`,
};

export const chatScrollStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  // The browser's scroll anchoring is a SECOND owner of this element's scrollTop: when content
  // above the viewport changes size — a bubble settling out of its arrival animation, a thinking
  // block collapsing, a picture arriving — it moves the scroll position to hold its chosen anchor
  // node still, which pushes the view up and off the newest message. `useStickToBottom` owns this
  // scroller's position; two owners produced the drift reported as "it keeps jumping higher".
  overflowAnchor: "none",
};

export const chatInputRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: 10,
  borderTop: `1px solid ${t.border.faint}`,
  alignItems: "flex-end",
};

export const chatTextareaStyle: CSSProperties = {
  flex: 1,
  resize: "none",
  background: t.fill.subtle,
  color: "inherit",
  border: `1px solid ${t.border.input}`,
  borderRadius: 6,
  padding: 8,
  fontSize: 13,
  fontFamily: "inherit",
};

export const smallButtonStyle: CSSProperties = {
  background: t.fill.base,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
};

export const approvalStyle: CSSProperties = {
  alignSelf: "flex-start",
  border: `1px solid ${t.accent.edge}`,
  borderRadius: 8,
  padding: 10,
  background: t.accent.wash,
};

/**
 * The strip the approval cards sit in — between the scrolling message list and the composer.
 *
 * Deliberately NOT inside the list: a card that is holding up the run must not be scrollable away.
 * It carries its own ceiling and its own scroll instead, so a long command or a stack of agent
 * approvals takes a share of a short phone dock rather than all of it.
 */
export const approvalDockStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: "6px 10px",
  maxHeight: "min(45vh, 340px)",
  overflowY: "auto",
  flex: "0 0 auto",
  borderTop: `1px solid ${t.border.faint}`,
};

/** The command / expression / payload read-out inside an approval card — the thing the reader is
 * actually being asked to judge, so it wraps rather than truncating. */
export const approvalCodeStyle: CSSProperties = {
  display: "block",
  marginTop: 4,
  padding: "6px 8px",
  borderRadius: 6,
  background: t.surface.sunken,
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};
