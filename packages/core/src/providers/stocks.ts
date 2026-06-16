/**
 * Keyless stock-quote support. Quotes come from Stooq's free CSV endpoint (no API
 * key), fetched through the app's CORS-exempt transport (desktop/extension) so the
 * assistant can ground its market analysis in real numbers, and the Markets panel can
 * show a live snapshot. Charts themselves are TradingView's free embeddable widget
 * (UI side) — also keyless. A broker account (thinkorswim / Schwab) is a separate,
 * keyed, deferred enhancement; this module is the no-setup baseline.
 *
 * Pure: URL building + CSV parsing, unit-tested. The network call lives in the host.
 */

export interface StockQuote {
  symbol: string;
  date?: string;
  time?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

/** Normalise a ticker for Stooq: lower-case, and US equities take a ".us" suffix. */
export function stooqSymbol(symbol: string): string {
  const s = symbol.trim().toLowerCase().replace(/\s+/g, "");
  return s.includes(".") || s.includes("^") ? s : `${s}.us`;
}

/** Stooq's keyless "last quote" CSV URL for a symbol. */
export function stooqQuoteUrl(symbol: string): string {
  return `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol(symbol))}&f=sd2t2ohlcv&h&e=csv`;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse Stooq's CSV (header row + one data row) into a quote. Returns undefined when
 * there's no usable close (e.g. an unknown symbol yields "N/D").
 */
export function parseStooqQuote(csv: string, requested: string): StockQuote | undefined {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return undefined;
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const cells = lines[1]!.split(",");
  const get = (name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? cells[i]?.trim() : undefined;
  };
  const close = num(get("close"));
  if (close === undefined) return undefined; // "N/D" → unknown symbol
  const date = get("date");
  const time = get("time");
  const open = num(get("open"));
  const high = num(get("high"));
  const low = num(get("low"));
  const volume = num(get("volume"));
  return {
    symbol: (get("symbol") || requested).toUpperCase().replace(/\.US$/i, ""),
    ...(date ? { date } : {}),
    ...(time ? { time } : {}),
    ...(open !== undefined ? { open } : {}),
    ...(high !== undefined ? { high } : {}),
    ...(low !== undefined ? { low } : {}),
    close,
    ...(volume !== undefined ? { volume } : {}),
  };
}

/** A short human summary of a quote (for the chat + the panel). */
export function formatQuote(q: StockQuote): string {
  const parts = [`${q.symbol}: ${q.close}`];
  if (q.open !== undefined && q.close !== undefined) {
    const chg = q.close - q.open;
    const pct = q.open ? (chg / q.open) * 100 : 0;
    parts.push(`${chg >= 0 ? "+" : ""}${chg.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs open)`);
  }
  if (q.high !== undefined && q.low !== undefined) parts.push(`H ${q.high} / L ${q.low}`);
  if (q.volume !== undefined) parts.push(`vol ${q.volume.toLocaleString("en-US")}`);
  if (q.date) parts.push(`@ ${q.date}${q.time ? ` ${q.time}` : ""}`);
  return parts.join(" · ");
}
