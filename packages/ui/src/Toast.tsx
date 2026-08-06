import { t } from "./design/tokens.js";
/** One transient notification. The HOST owns the list and its lifetimes (auto-dismiss timers live
 * there); this component only renders and forwards dismiss clicks. */
export interface ToastItem {
  id: number;
  text: string;
  tone?: "error" | "info" | "success";
}

export interface ToastHostProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

/**
 * The app-wide toast stack — errors and confirmations that must be visible no matter which view is
 * open (the old status line only rendered on the bookless home screen, so mid-reading failures were
 * silent). Fixed under the header, above modals' backdrop; each toast dismisses on click.
 */
export function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  if (toasts.length === 0) return null;
  return (
    <div style={stackStyle} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} style={{ ...toastStyle, ...toneStyles[t.tone ?? "info"] }}>
          <span style={{ flexShrink: 0 }}>{t.tone === "error" ? "⚠" : t.tone === "success" ? "✓" : "ℹ"}</span>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{t.text}</span>
          <button style={dismissStyle} aria-label="Dismiss notification" onClick={() => onDismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

const stackStyle = {
  position: "fixed",
  top: 58,
  right: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  // Above every modal overlay (ModalShell 100, OrderReviewModal 120) so an error toast fired while any
  // modal is open stays legible instead of being dimmed under the backdrop blur.
  zIndex: 130,
  width: "min(380px, calc(100vw - 24px))",
  pointerEvents: "none",
} as const;

const toastStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "10px 12px",
  borderRadius: 10,
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
  color: t.text.base,
  background: t.surface.sunken,
  border: `1px solid ${t.border.button}`,
  boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
  pointerEvents: "auto",
} as const;

const toneStyles = {
  error: { borderColor: t.state.danger, background: t.state.dangerWash },
  success: { borderColor: "rgba(120,220,150,0.5)", background: t.state.goodWash },
  info: {},
} as const;

const dismissStyle = {
  background: "transparent",
  border: "none",
  color: "inherit",
  opacity: 0.6,
  cursor: "pointer",
  fontSize: 12,
  padding: "0 2px",
  flexShrink: 0,
} as const;
