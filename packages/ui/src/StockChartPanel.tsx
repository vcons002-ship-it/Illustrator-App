import { memo, useEffect, useRef, useState } from "react";
import type { StockQuote } from "@visual-reader/core";

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
  onClose: () => void;
}

const TV_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

export const StockChartPanel = memo(function StockChartPanel({
  symbol,
  onSymbol,
  quote,
  loading,
  onAnalyze,
  onClose,
}: StockChartPanelProps) {
  const [draft, setDraft] = useState(symbol);
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
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 6 }}>
          Charts by TradingView (free, no account). Quotes from Stooq (keyless). Not investment advice.
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
