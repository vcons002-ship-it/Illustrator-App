import { t } from "./design/tokens.js";
import { memo, useState } from "react";
import { ModalShell } from "./ModalShell.js";

/**
 * Review-and-place gate for a Schwab order the assistant composed. The assistant NEVER
 * submits — it preps the order; this modal shows exactly what will be sent, and the
 * order is only placed when the reader clicks "Place order". Presentational: the host
 * owns the Schwab call.
 */
export interface OrderReviewModalProps {
  /** A one-line human summary (host passes describeOrder). */
  summary: string;
  /** The raw order JSON, shown for full transparency. */
  order: Record<string, unknown>;
  connected: boolean;
  placing?: boolean;
  /** Outcome message after an attempt (success or error), or null. */
  result?: { ok: boolean; message: string } | null;
  onPlace: () => void;
  onClose: () => void;
}

export const OrderReviewModal = memo(function OrderReviewModal({ summary, order, connected, placing, result, onPlace, onClose }: OrderReviewModalProps) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    // A backdrop tap mid-placement must NOT dismiss a real-money flow — only the
    // explicit buttons (and Escape, which mirrors the always-enabled Close) do.
    <ModalShell title="Review order" onClose={onClose} disableBackdropClose={placing} overlayStyle={overlay} cardStyle={panel}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 15 }}>🧾 Review order</strong>
          <button style={{ ...btn, marginLeft: "auto" }} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 8px" }}>{summary}</div>
        <pre style={pre}>{JSON.stringify(order, null, 2)}</pre>

        {result ? (
          <div style={{ fontSize: 13, marginTop: 8, color: result.ok ? t.state.good : t.state.danger }}>{result.message}</div>
        ) : (
          <>
            {!connected ? (
              <div style={{ fontSize: 12, color: t.state.warn, marginTop: 8 }}>Connect your Schwab account first (📈 Markets → Connect Schwab).</div>
            ) : (
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, fontSize: 12 }}>
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>
                  I’ve reviewed this order and want to place it. The assistant did not submit it — I am.
                  <span style={{ display: "block", opacity: 0.55 }}>Real money. Not financial advice. Markets move; the fill price may differ.</span>
                </span>
              </label>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                style={{ ...btnPrimary, opacity: connected && confirmed && !placing ? 1 : 0.5 }}
                disabled={!connected || !confirmed || placing}
                onClick={onPlace}
              >
                {placing ? "Placing…" : "Place order"}
              </button>
              <button style={btn} onClick={onClose} disabled={placing}>
                Cancel
              </button>
            </div>
          </>
        )}
    </ModalShell>
  );
});

// Deltas from ModalShell's shared look (this modal predates the shell): a slightly
// darker backdrop above other overlays, a narrower block-flow card.
const overlay: React.CSSProperties = {
  background: "rgba(8,9,13,0.72)",
  zIndex: 120,
};
const panel: React.CSSProperties = {
  width: "min(540px, 100%)",
  maxHeight: "90vh",
  border: `1px solid ${t.border.input}`,
  display: "block",
  gap: 0,
};
const pre: React.CSSProperties = {
  background: t.surface.sunken,
  border: `1px solid ${t.border.faint}`,
  borderRadius: 8,
  padding: 10,
  fontSize: 11,
  overflowX: "auto",
  margin: 0,
};
const btn: React.CSSProperties = {
  background: t.fill.base,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "5px 12px",
  fontSize: 12,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: t.state.good,
  border: `1px solid ${t.state.good}`,
};
