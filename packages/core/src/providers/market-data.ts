/**
 * Keyless market analytics: fetch OHLCV bars (Yahoo's public chart endpoint, no key)
 * over the CORS-exempt transport and compute the indicators a trader watches — VWAP,
 * moving averages, RSI, and recent-move stats — so the assistant can ground its read
 * (and in-app price alerts can trigger) without any account. Pure: URL building, JSON
 * parsing, and every indicator are unit-tested; the network call lives in the host.
 */

export interface Bar {
  /** Epoch seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Indicators {
  symbol: string;
  bars: number;
  last: number;
  vwap?: number;
  sma20?: number;
  sma50?: number;
  ema12?: number;
  ema26?: number;
  rsi14?: number;
  /** % change across the loaded window (first → last close). */
  changePct?: number;
  high?: number;
  low?: number;
}

/** Yahoo's keyless chart URL. interval e.g. "5m"/"15m"/"1d"; range e.g. "1d"/"5d"/"6mo". */
export function yahooChartUrl(symbol: string, opts: { interval: string; range: string }): string {
  const s = encodeURIComponent(symbol.trim().toUpperCase());
  return `https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=${opts.interval}&range=${opts.range}`;
}

/** Parse Yahoo's chart JSON into clean OHLCV bars (drops any incomplete rows). */
export function parseYahooChart(json: unknown): Bar[] {
  const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }
    | undefined;
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!ts || !q) return [];
  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i];
    if ([o, h, l, c, v].every((x) => typeof x === "number" && Number.isFinite(x))) {
      out.push({ t: ts[i]!, o: o as number, h: h as number, l: l as number, c: c as number, v: v as number });
    }
  }
  return out;
}

/** Volume-weighted average price over the bars (cumulative typical-price × volume). */
export function vwap(bars: Bar[]): number | undefined {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    pv += typical * b.v;
    vol += b.v;
  }
  return vol > 0 ? pv / vol : undefined;
}

/** Simple moving average of the LAST `period` values. */
export function sma(values: number[], period: number): number | undefined {
  if (period <= 0 || values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Exponential moving average (seeded with the first value). */
export function ema(values: number[], period: number): number | undefined {
  if (period <= 0 || values.length < period) return undefined;
  const k = 2 / (period + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

/** Wilder's RSI over the last `period` deltas (0–100). */
export function rsi(closes: number[], period = 14): number | undefined {
  if (closes.length < period + 1) return undefined;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Compute the watched indicators from a bar series. */
export function computeIndicators(symbol: string, bars: Bar[]): Indicators | undefined {
  if (bars.length === 0) return undefined;
  const closes = bars.map((b) => b.c);
  const last = closes[closes.length - 1]!;
  const first = closes[0]!;
  return {
    symbol: symbol.toUpperCase(),
    bars: bars.length,
    last,
    ...(vwap(bars) !== undefined ? { vwap: round(vwap(bars)!) } : {}),
    ...(sma(closes, 20) !== undefined ? { sma20: round(sma(closes, 20)!) } : {}),
    ...(sma(closes, 50) !== undefined ? { sma50: round(sma(closes, 50)!) } : {}),
    ...(ema(closes, 12) !== undefined ? { ema12: round(ema(closes, 12)!) } : {}),
    ...(ema(closes, 26) !== undefined ? { ema26: round(ema(closes, 26)!) } : {}),
    ...(rsi(closes, 14) !== undefined ? { rsi14: round(rsi(closes, 14)!, 1) } : {}),
    ...(first ? { changePct: round(((last - first) / first) * 100, 2) } : {}),
    high: round(Math.max(...bars.map((b) => b.h))),
    low: round(Math.min(...bars.map((b) => b.l))),
  };
}

function round(n: number, dp = 2): number {
  const p = Math.pow(10, dp);
  return Math.round(n * p) / p;
}

/** A short human summary of the indicators for the chat + the panel. */
export function formatIndicators(ind: Indicators): string {
  const parts = [`${ind.symbol} ${ind.last}`];
  if (ind.changePct !== undefined) parts.push(`${ind.changePct >= 0 ? "+" : ""}${ind.changePct}% over window`);
  if (ind.vwap !== undefined) parts.push(`VWAP ${ind.vwap} (${ind.last >= ind.vwap ? "above" : "below"})`);
  if (ind.sma20 !== undefined) parts.push(`SMA20 ${ind.sma20}`);
  if (ind.sma50 !== undefined) parts.push(`SMA50 ${ind.sma50}`);
  if (ind.rsi14 !== undefined) parts.push(`RSI ${ind.rsi14}`);
  if (ind.high !== undefined) parts.push(`H ${ind.high}/L ${ind.low}`);
  return parts.join(" · ");
}
