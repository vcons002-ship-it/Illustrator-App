import { memo, useState } from "react";

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
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 15 }}>🧾 Review order</strong>
          <button style={{ ...btn, marginLeft: "auto" }} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 8px" }}>{summary}</div>
        <pre style={pre}>{JSON.stringify(order, null, 2)}</pre>

        {result ? (
          <div style={{ fontSize: 13, marginTop: 8, color: result.ok ? "#5dd19b" : "#ff8c8c" }}>{result.message}</div>
        ) : (
          <>
            {!connected ? (
              <div style={{ fontSize: 12, color: "#ffcf8b", marginTop: 8 }}>Connect your Schwab account first (📈 Markets → Connect Schwab).</div>
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
      </div>
    </div>
  );
});

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(8,9,13,0.72)",
  backdropFilter: "blur(6px)",
  zIndex: 120,
  padding: 20,
};
const panel: React.CSSProperties = {
  width: "min(540px, 100%)",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "#16181d",
  color: "#e6e6e6",
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 12,
  padding: 18,
  fontFamily: "system-ui, sans-serif",
};
const pre: React.CSSProperties = {
  background: "#0d1017",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: 10,
  fontSize: 11,
  overflowX: "auto",
  margin: 0,
};
const btn: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "5px 12px",
  fontSize: 12,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "rgba(90,209,155,0.25)",
  border: "1px solid rgba(90,209,155,0.6)",
};
