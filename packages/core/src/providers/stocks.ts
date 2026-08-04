/**
 * Keyless stock-quote support. Quotes come from Yahoo's free chart endpoint (no API key,
 * the same source the market-analysis indicators use), fetched through the app's CORS-exempt
 * transport (desktop/extension) so the assistant can ground its market analysis in real
 * numbers, and the Markets panel can show a live snapshot. Charts themselves are TradingView's
 * free embeddable widget (UI side) — also keyless. A broker account (thinkorswim / Schwab) is a
 * separate, keyed, deferred enhancement; this module is the no-setup baseline.
 *
 * (Stooq's CSV was the original source but blocks non-browser User-Agents — it times out from
 * the desktop proxy — and rate-limits even with one, so quotes now ride Yahoo. The Stooq
 * URL/parse helpers are kept for the extension/tests.)
 *
 * Pure: URL building + parsing, unit-tested. The network call lives in the host.
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

/**
 * Why a Yahoo response is unusable, in words — or undefined when the response is fine.
 *
 * No call site checked the status. Yahoo's failures don't come back as JSON (a rate-limit is the
 * plain text "Edge: Too Many Requests"), so the response went straight to `.json()` and the reader
 * — and the model — got a JSON parse error. "Unexpected token E" says nothing about waiting a minute
 * or about the symbol being wrong, and it reads like a bug in the app rather than a throttle at a
 * free endpoint we don't own.
 *
 * Rate limiting is the one to name explicitly: it is temporary, it is per-IP, and the fix is to wait
 * or to use an entitled feed — none of which is guessable from a parse error. PURE.
 */
export function yahooFetchError(status: number): string | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 429) {
    return "Yahoo is rate-limiting the free quote feed right now (HTTP 429). Wait a minute and try again — or connect Schwab in Settings for entitled quotes.";
  }
  if (status === 404) return "Yahoo doesn't recognise that symbol (HTTP 404) — check the ticker.";
  if (status === 401 || status === 403) return `Yahoo refused the request (HTTP ${status}) — the free feed may be blocking this connection.`;
  if (status >= 500) return `Yahoo's quote feed is having problems right now (HTTP ${status}) — try again shortly.`;
  return `Yahoo returned HTTP ${status} for that quote.`;
}

/** Yahoo's keyless chart URL for a single-day quote (works with the desktop proxy's UA,
 * unlike Stooq). The `meta` block carries the live price + day range we surface. */
export function yahooQuoteUrl(symbol: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.trim().toUpperCase())}?interval=1d&range=1d`;
}

function fin(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse Yahoo's chart JSON into a quote from its `meta` block (live price, day high/low,
 * volume, time), with the session open pulled from the day's bar. Returns undefined when
 * there's no usable price (unknown/blank symbol).
 */
export function parseYahooQuote(json: unknown, requested: string): StockQuote | undefined {
  const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | {
        meta?: {
          symbol?: string;
          regularMarketPrice?: number;
          regularMarketOpen?: number;
          regularMarketDayHigh?: number;
          regularMarketDayLow?: number;
          regularMarketVolume?: number;
          regularMarketTime?: number;
        };
        indicators?: { quote?: { open?: (number | null)[] }[] };
      }
    | undefined;
  const m = result?.meta;
  const close = fin(m?.regularMarketPrice);
  if (!m || close === undefined) return undefined;
  const openArr = result?.indicators?.quote?.[0]?.open ?? [];
  const open = fin(m.regularMarketOpen) ?? fin(openArr[openArr.length - 1]);
  const t = fin(m.regularMarketTime);
  const iso = t !== undefined ? new Date(t * 1000).toISOString() : undefined;
  return {
    symbol: (m.symbol || requested).toUpperCase(),
    ...(iso ? { date: iso.slice(0, 10), time: iso.slice(11, 16) } : {}),
    ...(open !== undefined ? { open } : {}),
    ...(fin(m.regularMarketDayHigh) !== undefined ? { high: m.regularMarketDayHigh } : {}),
    ...(fin(m.regularMarketDayLow) !== undefined ? { low: m.regularMarketDayLow } : {}),
    close,
    ...(fin(m.regularMarketVolume) !== undefined ? { volume: m.regularMarketVolume } : {}),
  };
}

/** A short human summary of a quote (for the chat + the panel). */
/**
 * WHERE A NUMBER CAME FROM — carried with the number itself.
 *
 * The app has four places a price can come from and they are not interchangeable: a keyless Yahoo
 * feed that is delayed on most exchanges, a broker account whose freshness is the reader's own
 * entitlement, a TradingView chart showing whatever that reader's plan carries, and — the one that
 * matters most — the model's own memory, which is not a source at all. Printed bare, "MSFT: 512.30"
 * looks identical in all four cases, and a reader who cannot tell a live quote from a half-remembered
 * one has no way to know which they are acting on.
 *
 * `memory` exists here deliberately. Naming it is what makes an unsourced number sayable, and
 * therefore refusable.
 */
export type QuoteSource = "yahoo" | "schwab" | "tradingview" | "web" | "memory";

export function sourceLabel(source: QuoteSource): string {
  switch (source) {
    case "yahoo":
      return "Yahoo (keyless — delayed on most exchanges)";
    case "schwab":
      return "your Schwab account (real-time where your entitlements allow)";
    case "tradingview":
      return "your TradingView chart (as it is displaying it)";
    case "web":
      return "a web page — UNVERIFIED, and as of whatever date that page carries";
    case "memory":
      return "NOT A SOURCE — this is recalled, not fetched, and must not be given as a price";
  }
}

/** The source line appended to a formatted number. PURE. */
export function sourceNote(source: QuoteSource): string {
  return `\nSource: ${sourceLabel(source)}`;
}

export function formatQuote(q: StockQuote, source?: QuoteSource): string {
  const parts = [`${q.symbol}: ${q.close}`];
  if (q.open !== undefined && q.close !== undefined) {
    const chg = q.close - q.open;
    const pct = q.open ? (chg / q.open) * 100 : 0;
    parts.push(`${chg >= 0 ? "+" : ""}${chg.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs open)`);
  }
  if (q.high !== undefined && q.low !== undefined) parts.push(`H ${q.high} / L ${q.low}`);
  if (q.volume !== undefined) parts.push(`vol ${q.volume.toLocaleString("en-US")}`);
  if (q.date) parts.push(`@ ${q.date}${q.time ? ` ${q.time}` : ""}`);
  return parts.join(" · ") + (source ? sourceNote(source) : "");
}
