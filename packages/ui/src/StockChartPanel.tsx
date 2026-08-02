import { memo, useEffect, useRef, useState } from "react";
import type { PriceAlert, StockQuote } from "@visual-reader/core";

/**
 * A Markets panel: TradingView's free, keyless **advanced chart** widget for a symbol,
 * plus a live quote snapshot (fetched by the host through the CORS-exempt transport) and
 * a one-click handoff to ask the assistant for analysis/ideas on that ticker. The chart
 * is an embedded TradingView widget — no API key, no account. (A broker account like
 * thinkorswim/Schwab is a separate, deferred, keyed integration.)
 */
export interface StockChartPanelProps {
  /** The symbol shown (e.g. "AAPL"); the panel owns a search box to change it. */
  symbol: string;
  onSymbol: (symbol: string) => void;
  /** Latest quote for the symbol (fetched by the host), or null while loading/none. */
  quote?: StockQuote | null;
  loading?: boolean;
  /** "Ask the assistant to analyse SYMBOL" — seeds a buddy message. */
  onAnalyze: (symbol: string) => void;
  /** In-app price alerts (all symbols) + add/remove. The host runs + describes them. */
  alerts?: PriceAlert[];
  describeAlert?: (a: PriceAlert) => string;
  onAddAlert?: (symbol: string, type: PriceAlert["type"], value?: number) => void;
  onRemoveAlert?: (id: string) => void;
  /** Schwab account (real quotes / option chains + Greeks / positions) connect state. */
  schwabConnected?: boolean;
  onConnectSchwab?: () => void;
  /** Whether THIS device can complete the Schwab connection. The token exchange is a cross-origin
   * POST to Schwab, which only the desktop app's CORS-exempt transport can make — a phone browser is
   * refused by the browser itself. Absent/false → say so instead of offering a button that can't work. */
  canConnectSchwab?: boolean;
  /** TradingView Desktop bridge (when enabled): connection status + a re-check. */
  tvBridge?: { status: string | null; onTest: () => void };
  onClose: () => void;
}

const TV_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

export const StockChartPanel = memo(function StockChartPanel({
  symbol,
  onSymbol,
  quote,
  loading,
  onAnalyze,
  alerts,
  describeAlert,
  onAddAlert,
  onRemoveAlert,
  schwabConnected,
  onConnectSchwab,
  canConnectSchwab,
  tvBridge,
  onClose,
}: StockChartPanelProps) {
  const [draft, setDraft] = useState(symbol);
  const [levelDraft, setLevelDraft] = useState("");
  const holder = useRef<HTMLDivElement>(null);

  // (Re)mount the TradingView widget whenever the symbol changes. The embed script reads
  // its JSON config from a <script> child, so we rebuild the subtree each time.
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    el.innerHTML = "";
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    container.appendChild(widget);
    const script = document.createElement("script");
    script.src = TV_SRC;
    script.async = true;
    script.innerHTML = JSON.stringify({
      symbol,
      autosize: true,
      interval: "D",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      hide_side_toolbar: false,
      allow_symbol_change: true,
      withdateranges: true,
      // Preload the watch studies so the chart matches the assistant's analysis.
      studies: ["STD;VWAP", "STD;RSI"],
    });
    container.appendChild(script);
    el.appendChild(container);
    return () => {
      el.innerHTML = "";
    };
  }, [symbol]);

  const submit = () => {
    const s = draft.trim().toUpperCase();
    if (s) onSymbol(s);
  };
  const chg = quote && quote.open !== undefined && quote.close !== undefined ? quote.close - quote.open : undefined;
  const pct = quote && chg !== undefined && quote.open ? (chg / quote.open) * 100 : undefined;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 15 }}>📈 Markets</strong>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Ticker (e.g. AAPL)"
            style={tickerInput}
          />
          <button style={btn} onClick={submit}>
            Show
          </button>
          <button style={btn} onClick={() => onAnalyze(symbol)} title="Ask the assistant for analysis + ideas on this ticker">
            🤖 Analyse {symbol}
          </button>
          <a style={{ ...btn, textDecoration: "none" }} href={`https://www.tradingview.com/symbols/${encodeURIComponent(symbol)}/`} target="_blank" rel="noreferrer">
            Open in TradingView ↗
          </a>
          {onConnectSchwab ? (
            schwabConnected ? (
              <span style={{ ...btn, borderColor: "rgba(90,209,155,0.6)", color: "#9be8c0" }}>✓ Schwab</span>
            ) : canConnectSchwab ? (
              <button style={btn} onClick={onConnectSchwab} title="Connect your Schwab account for real quotes, option chains + Greeks, and positions">
                Connect Schwab
              </button>
            ) : (
              // Not a button that fails when pressed: swapping Schwab's code for a token is a
              // cross-origin POST the browser refuses on a phone. Say where it CAN be done.
              <span style={{ fontSize: 11, color: "#ffcf8b" }}>
                Connect Schwab on the desktop app — the sign-in can’t finish from a phone. Once it’s connected there,
                quotes and positions work here.
              </span>
            )
          ) : null}
          <button style={{ ...btn, marginLeft: "auto" }} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ minHeight: 22, marginBottom: 8, fontSize: 13 }}>
          {loading ? (
            <span style={{ opacity: 0.6 }}>Loading {symbol} quote…</span>
          ) : quote ? (
            <span>
              <strong>{quote.symbol}</strong> {quote.close}
              {chg !== undefined ? (
                <span style={{ color: chg >= 0 ? "#5dd19b" : "#ff8c8c", marginLeft: 8 }}>
                  {chg >= 0 ? "+" : ""}
                  {chg.toFixed(2)}
                  {pct !== undefined ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}
                </span>
              ) : null}
              {quote.high !== undefined ? <span style={{ opacity: 0.6, marginLeft: 10 }}>H {quote.high} · L {quote.low}</span> : null}
              {quote.volume !== undefined ? <span style={{ opacity: 0.6, marginLeft: 10 }}>vol {quote.volume.toLocaleString("en-US")}</span> : null}
              {quote.date ? <span style={{ opacity: 0.45, marginLeft: 10 }}>{quote.date}</span> : null}
            </span>
          ) : (
            <span style={{ opacity: 0.55 }}>
              No quote (the keyless quote feed needs the desktop app or extension; the chart still works here).
            </span>
          )}
        </div>

        <div ref={holder} style={chartHolder} />

        {onAddAlert ? (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>⏿ Alerts</span>
              <button style={miniBtn} onClick={() => onAddAlert(symbol, "cross_vwap")} title={`Notify when ${symbol} crosses VWAP`}>
                {symbol} crosses VWAP
              </button>
              <input
                value={levelDraft}
                onChange={(e) => setLevelDraft(e.target.value)}
                placeholder="level"
                inputMode="decimal"
                style={{ ...tickerInput, width: 70, textTransform: "none" }}
              />
              <button
                style={miniBtn}
                onClick={() => {
                  const v = Number(levelDraft);
                  if (Number.isFinite(v)) {
                    onAddAlert(symbol, "above", v);
                    setLevelDraft("");
                  }
                }}
              >
                above
              </button>
              <button
                style={miniBtn}
                onClick={() => {
                  const v = Number(levelDraft);
                  if (Number.isFinite(v)) {
                    onAddAlert(symbol, "below", v);
                    setLevelDraft("");
                  }
                }}
              >
                below
              </button>
              <span style={{ fontSize: 11, opacity: 0.5 }}>or ask the assistant (“alert me when … moves ±3% / RSI &gt; 70”)</span>
            </div>
            {alerts && alerts.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>
                {alerts.map((a) => (
                  <div key={a.id} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, opacity: a.enabled ? 1 : 0.5 }}>
                    <span>🔔 {describeAlert ? describeAlert(a) : a.symbol}</span>
                    {a.enabled ? null : <span style={{ fontSize: 10, color: "#ffcf8b" }}>triggered</span>}
                    {onRemoveAlert ? (
                      <button style={{ ...miniBtn, marginLeft: "auto", color: "#ff9c9c" }} onClick={() => onRemoveAlert(a.id)}>
                        ✕
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {tvBridge ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12 }}>
            <span style={{ fontWeight: 600 }}>🔌 TV bridge</span>
            <span style={{ opacity: 0.75, color: tvBridge.status?.startsWith("Connected") ? "#5dd19b" : "#ffcf8b" }}>
              {tvBridge.status ?? "—"}
            </span>
            <button style={miniBtn} onClick={tvBridge.onTest}>
              Test bridge
            </button>
            <span style={{ fontSize: 11, opacity: 0.5 }}>
              Launch TradingView Desktop with remote debugging — see MARKETS-BRIDGE.md. Then ask the assistant to set up
              your chart.
            </span>
          </div>
        ) : null}
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 6 }}>
          Charts by TradingView (free, no account). Quotes from Stooq (keyless). Alerts run while the app is open. Not
          investment advice.
        </div>
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
  background: "rgba(8,9,13,0.7)",
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};
const panel: React.CSSProperties = {
  width: "min(1040px, 100%)",
  height: "min(88vh, 760px)",
  display: "flex",
  flexDirection: "column",
  background: "#16181d",
  color: "#e6e6e6",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 18,
  fontFamily: "system-ui, sans-serif",
};
const chartHolder: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  borderRadius: 8,
  overflow: "hidden",
  background: "#0d1017",
};
const tickerInput: React.CSSProperties = {
  background: "#0d1017",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "5px 9px",
  fontSize: 13,
  width: 150,
  textTransform: "uppercase",
};
const btn: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const miniBtn: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
};
