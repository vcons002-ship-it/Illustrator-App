import type { VisualReaderStore } from "../storage/store.js";
import type { Indicators } from "../providers/market-data.js";

/**
 * In-app price alerts / watch levels — "tell me when AAPL crosses VWAP", "alert me if
 * TSLA drops below 200", "ping me when NVDA moves ±3%". The host's while-open runner
 * fetches each alert's indicators on an interval, evaluates the condition, and fires a
 * notification. Stored in the `memos` KV store (no always-on server; alerts run while
 * the app is open). Pure: entity, store helpers, and evaluation are unit-tested.
 */

export type AlertType = "above" | "below" | "cross_vwap" | "pct_move" | "rsi_above" | "rsi_below";

export interface PriceAlert {
  id: string;
  symbol: string;
  type: AlertType;
  /** The threshold for above/below (price), pct_move (percent), rsi_* (0–100). */
  value?: number;
  note?: string;
  enabled: boolean;
  createdAt: number;
  /** For cross_vwap: which side of VWAP price was last seen, to detect a flip. */
  lastSide?: "above" | "below";
  lastFiredIso?: string;
}

const KEY = "price-alerts";
const MAX = 60;

export function alertId(): string {
  return `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const NEEDS_VALUE: AlertType[] = ["above", "below", "pct_move", "rsi_above", "rsi_below"];

/** Build/normalise an alert from a partial (defaults + validation); undefined if invalid. */
export function normalizePriceAlert(input: Partial<PriceAlert> & { symbol: string; type: AlertType }): PriceAlert | undefined {
  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol) return undefined;
  if (NEEDS_VALUE.includes(input.type) && !(typeof input.value === "number" && Number.isFinite(input.value))) return undefined;
  return {
    id: input.id ?? alertId(),
    symbol,
    type: input.type,
    ...(typeof input.value === "number" ? { value: input.value } : {}),
    ...(input.note ? { note: input.note.slice(0, 200) } : {}),
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? Date.now(),
    ...(input.lastSide ? { lastSide: input.lastSide } : {}),
    ...(input.lastFiredIso ? { lastFiredIso: input.lastFiredIso } : {}),
  };
}

/** Human description of the condition (for the UI / confirmations). */
export function describeAlert(a: PriceAlert): string {
  switch (a.type) {
    case "above":
      return `${a.symbol} rises above ${a.value}`;
    case "below":
      return `${a.symbol} drops below ${a.value}`;
    case "cross_vwap":
      return `${a.symbol} crosses VWAP`;
    case "pct_move":
      return `${a.symbol} moves ±${a.value}%`;
    case "rsi_above":
      return `${a.symbol} RSI above ${a.value}`;
    case "rsi_below":
      return `${a.symbol} RSI below ${a.value}`;
  }
}

export interface AlertEval {
  fired: boolean;
  message?: string;
  /** Updated cross_vwap side, when applicable. */
  newSide?: "above" | "below";
}

/** Evaluate an alert against fresh indicators (does not mutate the alert). */
export function evaluateAlert(alert: PriceAlert, ind: Indicators): AlertEval {
  const last = ind.last;
  switch (alert.type) {
    case "above":
      return last >= (alert.value ?? Infinity) ? { fired: true, message: `${alert.symbol} is ${last}, above ${alert.value}` } : { fired: false };
    case "below":
      return last <= (alert.value ?? -Infinity) ? { fired: true, message: `${alert.symbol} is ${last}, below ${alert.value}` } : { fired: false };
    case "pct_move":
      return ind.changePct !== undefined && Math.abs(ind.changePct) >= (alert.value ?? Infinity)
        ? { fired: true, message: `${alert.symbol} moved ${ind.changePct}% (now ${last})` }
        : { fired: false };
    case "rsi_above":
      return ind.rsi14 !== undefined && ind.rsi14 >= (alert.value ?? Infinity)
        ? { fired: true, message: `${alert.symbol} RSI ${ind.rsi14} (above ${alert.value})` }
        : { fired: false };
    case "rsi_below":
      return ind.rsi14 !== undefined && ind.rsi14 <= (alert.value ?? -Infinity)
        ? { fired: true, message: `${alert.symbol} RSI ${ind.rsi14} (below ${alert.value})` }
        : { fired: false };
    case "cross_vwap": {
      if (ind.vwap === undefined) return { fired: false };
      const side: "above" | "below" = last >= ind.vwap ? "above" : "below";
      const flipped = alert.lastSide !== undefined && alert.lastSide !== side;
      return {
        fired: flipped,
        newSide: side,
        ...(flipped ? { message: `${alert.symbol} crossed ${side} VWAP (${ind.vwap}); price ${last}` } : {}),
      };
    }
  }
}

/**
 * Apply an evaluation result to an alert: stamp lastFired; for cross_vwap update the
 * side (stays enabled to catch future flips); for the threshold alerts, disable after
 * firing (one-shot) so it doesn't repeat every tick.
 */
export function advanceAlert(alert: PriceAlert, result: AlertEval, firedAtIso: string): PriceAlert {
  if (alert.type === "cross_vwap") {
    return { ...alert, ...(result.newSide ? { lastSide: result.newSide } : {}), ...(result.fired ? { lastFiredIso: firedAtIso } : {}) };
  }
  return result.fired ? { ...alert, enabled: false, lastFiredIso: firedAtIso } : alert;
}

// ---- Store -----------------------------------------------------------------

export async function loadPriceAlerts(store: VisualReaderStore): Promise<PriceAlert[]> {
  try {
    const raw = await store.getMemo?.(KEY);
    const arr = raw ? (JSON.parse(raw) as PriceAlert[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function persist(store: VisualReaderStore, alerts: PriceAlert[]): Promise<void> {
  await store.putMemo?.(KEY, JSON.stringify(alerts.slice(-MAX)));
}
export async function upsertPriceAlert(store: VisualReaderStore, alert: PriceAlert): Promise<PriceAlert[]> {
  const alerts = await loadPriceAlerts(store);
  const i = alerts.findIndex((a) => a.id === alert.id);
  if (i >= 0) alerts[i] = alert;
  else alerts.push(alert);
  await persist(store, alerts);
  return alerts;
}
export async function deletePriceAlert(store: VisualReaderStore, id: string): Promise<PriceAlert[]> {
  const alerts = (await loadPriceAlerts(store)).filter((a) => a.id !== id);
  await persist(store, alerts);
  return alerts;
}
