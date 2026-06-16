import type { Transport } from "./transport/transport.js";
import type { VisualReaderStore } from "../storage/store.js";

/**
 * Charles Schwab Trader API integration (the platform behind thinkorswim) — real
 * quotes, **option chains with Greeks + implied volatility**, account positions, and
 * order PREP. OAuth 2.0 against the user's OWN registered Schwab app (client id +
 * secret); the desktop shell runs the consent + loopback redirect, this module does the
 * token exchange/refresh and the API calls through the Transport seam (so the desktop
 * CORS proxy carries them).
 *
 * Safety: this never auto-submits an order. It exposes builders that PREP an order for
 * the reader to review + place themselves, matching the orchestrator's "never pay/
 * submit on the user's behalf" boundary. The PARSERS (quote, option chain, positions)
 * are pure and unit-tested; the network functions take an injected Transport.
 */

const AUTH_ENDPOINT = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.schwabapi.com/v1/oauth/token";
const MARKETDATA = "https://api.schwabapi.com/marketdata/v1";
const TRADER = "https://api.schwabapi.com/trader/v1";

export interface SchwabTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch when the access token expires (Schwab access tokens last ~30 min). */
  expiresAt: number;
}

// ----------------------------------------------------------------- OAuth

/** The Schwab consent URL to open in the browser (authorization-code flow). */
export function buildSchwabAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: "readonly",
    state: opts.state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function tokenRequest(
  transport: Transport,
  clientId: string,
  clientSecret: string,
  fields: Record<string, string>,
): Promise<SchwabTokens> {
  const res = await transport.send({
    url: TOKEN_ENDPOINT,
    method: "POST",
    headers: { authorization: basicAuth(clientId, clientSecret) },
    formEncoded: fields,
  });
  const json = await res.json<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }>();
  if (!res.ok || !json.access_token) {
    throw new Error(`Schwab auth failed: ${json.error_description || json.error || res.status}`);
  }
  return {
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    expiresAt: Date.now() + (json.expires_in ?? 1800) * 1000,
  };
}

/** Exchange the consent `code` for tokens. */
export function exchangeSchwabCode(opts: {
  transport: Transport;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<SchwabTokens> {
  return tokenRequest(opts.transport, opts.clientId, opts.clientSecret, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
}

/** Refresh an expired access token with the (7-day) refresh token. */
export function refreshSchwabToken(opts: {
  transport: Transport;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<SchwabTokens> {
  return tokenRequest(opts.transport, opts.clientId, opts.clientSecret, {
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
}

const TOKENS_KEY = "schwab-tokens";

export async function loadSchwabTokens(store: VisualReaderStore): Promise<SchwabTokens | undefined> {
  try {
    const raw = await store.getMemo?.(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as SchwabTokens) : undefined;
  } catch {
    return undefined;
  }
}
export async function saveSchwabTokens(store: VisualReaderStore, tokens: SchwabTokens): Promise<void> {
  await store.putMemo?.(TOKENS_KEY, JSON.stringify(tokens));
}
export async function clearSchwabTokens(store: VisualReaderStore): Promise<void> {
  await store.deleteMemo?.(TOKENS_KEY);
}

/** A valid access token, refreshing (and persisting) when it's within 60s of expiry. */
export async function getFreshSchwabToken(
  store: VisualReaderStore,
  opts: { clientId: string; clientSecret: string; transport: Transport },
): Promise<string> {
  const tokens = await loadSchwabTokens(store);
  if (!tokens) throw new Error("Schwab isn't connected.");
  if (Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error("Schwab session expired — reconnect.");
  const refreshed = await refreshSchwabToken({ transport: opts.transport, clientId: opts.clientId, clientSecret: opts.clientSecret, refreshToken: tokens.refreshToken });
  const merged: SchwabTokens = { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
  await saveSchwabTokens(store, merged);
  return merged.accessToken;
}

function authGet(transport: Transport, url: string, token: string) {
  return transport.send({ url, method: "GET", headers: { authorization: `Bearer ${token}` } });
}

// ----------------------------------------------------------------- Quotes

export interface SchwabQuote {
  symbol: string;
  last?: number;
  bid?: number;
  ask?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  netChange?: number;
  netPercentChange?: number;
  volume?: number;
}

/** Parse Schwab's `/quotes` response (keyed by symbol) for one symbol. */
export function parseSchwabQuote(json: unknown, symbol: string): SchwabQuote | undefined {
  const entry = (json as Record<string, { quote?: Record<string, number>; regular?: Record<string, number> }>)?.[symbol.toUpperCase()];
  const q = entry?.quote;
  if (!q) return undefined;
  const num = (k: string): number | undefined => (typeof q[k] === "number" && Number.isFinite(q[k]) ? q[k] : undefined);
  const out: SchwabQuote = { symbol: symbol.toUpperCase() };
  const map: [keyof SchwabQuote, string][] = [
    ["last", "lastPrice"], ["bid", "bidPrice"], ["ask", "askPrice"], ["open", "openPrice"],
    ["high", "highPrice"], ["low", "lowPrice"], ["close", "closePrice"], ["netChange", "netChange"],
    ["netPercentChange", "netPercentChange"], ["volume", "totalVolume"],
  ];
  for (const [field, key] of map) {
    const v = num(key);
    if (v !== undefined) (out as unknown as Record<string, number | string>)[field] = v;
  }
  return out;
}

export async function schwabQuote(transport: Transport, token: string, symbol: string): Promise<SchwabQuote | undefined> {
  const res = await authGet(transport, `${MARKETDATA}/quotes?symbols=${encodeURIComponent(symbol.toUpperCase())}`, token);
  return parseSchwabQuote(await res.json(), symbol);
}

// ----------------------------------------------------------------- Option chains

export interface OptionContract {
  type: "CALL" | "PUT";
  symbol?: string;
  strike: number;
  expiration?: string;
  bid?: number;
  ask?: number;
  last?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  /** Implied volatility (percent). */
  iv?: number;
  openInterest?: number;
  volume?: number;
  inTheMoney?: boolean;
}

export interface OptionChain {
  symbol: string;
  underlyingPrice?: number;
  contracts: OptionContract[];
}

function flattenExpMap(map: Record<string, Record<string, unknown[]>> | undefined, type: "CALL" | "PUT"): OptionContract[] {
  const out: OptionContract[] = [];
  for (const strikes of Object.values(map ?? {})) {
    for (const list of Object.values(strikes)) {
      for (const raw of list as Record<string, number | string | boolean>[]) {
        const n = (k: string): number | undefined => (typeof raw[k] === "number" && Number.isFinite(raw[k] as number) ? (raw[k] as number) : undefined);
        const strike = n("strikePrice");
        if (strike === undefined) continue;
        const c: OptionContract = { type, strike };
        if (typeof raw["symbol"] === "string") c.symbol = raw["symbol"] as string;
        if (typeof raw["expirationDate"] === "string") c.expiration = raw["expirationDate"] as string;
        if (typeof raw["inTheMoney"] === "boolean") c.inTheMoney = raw["inTheMoney"] as boolean;
        const numFields: [keyof OptionContract, string][] = [
          ["bid", "bid"], ["ask", "ask"], ["last", "last"], ["delta", "delta"], ["gamma", "gamma"],
          ["theta", "theta"], ["vega", "vega"], ["rho", "rho"], ["iv", "volatility"],
          ["openInterest", "openInterest"], ["volume", "totalVolume"],
        ];
        for (const [field, key] of numFields) {
          const v = n(key);
          if (v !== undefined) (c as unknown as Record<string, number | string | boolean>)[field] = v;
        }
        out.push(c);
      }
    }
  }
  return out;
}

/** Parse Schwab's `/chains` response into a flat contract list with Greeks + IV. */
export function parseOptionChain(json: unknown): OptionChain | undefined {
  const j = json as { symbol?: string; underlyingPrice?: number; callExpDateMap?: Record<string, Record<string, unknown[]>>; putExpDateMap?: Record<string, Record<string, unknown[]>> };
  if (!j || (!j.callExpDateMap && !j.putExpDateMap)) return undefined;
  return {
    symbol: (j.symbol ?? "").toUpperCase(),
    ...(typeof j.underlyingPrice === "number" ? { underlyingPrice: j.underlyingPrice } : {}),
    contracts: [...flattenExpMap(j.callExpDateMap, "CALL"), ...flattenExpMap(j.putExpDateMap, "PUT")],
  };
}

export async function schwabOptionChain(
  transport: Transport,
  token: string,
  symbol: string,
  opts: { contractType?: "CALL" | "PUT" | "ALL"; strikeCount?: number; fromDate?: string; toDate?: string } = {},
): Promise<OptionChain | undefined> {
  const params = new URLSearchParams({ symbol: symbol.toUpperCase() });
  if (opts.contractType) params.set("contractType", opts.contractType);
  if (opts.strikeCount) params.set("strikeCount", String(opts.strikeCount));
  if (opts.fromDate) params.set("fromDate", opts.fromDate);
  if (opts.toDate) params.set("toDate", opts.toDate);
  const res = await authGet(transport, `${MARKETDATA}/chains?${params.toString()}`, token);
  return parseOptionChain(await res.json());
}

// ----------------------------------------------------------------- Accounts

export interface SchwabPosition {
  symbol: string;
  quantity: number;
  marketValue?: number;
  averagePrice?: number;
}

/** Parse Schwab's `/accounts?fields=positions` response into flat positions. */
export function parseSchwabPositions(json: unknown): SchwabPosition[] {
  const accounts = (json as { securitiesAccount?: { positions?: unknown[] } }[]) ?? [];
  const out: SchwabPosition[] = [];
  for (const a of accounts) {
    for (const p of (a.securitiesAccount?.positions ?? []) as Record<string, unknown>[]) {
      const inst = p["instrument"] as { symbol?: string } | undefined;
      const long = typeof p["longQuantity"] === "number" ? (p["longQuantity"] as number) : 0;
      const short = typeof p["shortQuantity"] === "number" ? (p["shortQuantity"] as number) : 0;
      const qty = long - short;
      if (!inst?.symbol || qty === 0) continue;
      out.push({
        symbol: inst.symbol,
        quantity: qty,
        ...(typeof p["marketValue"] === "number" ? { marketValue: p["marketValue"] as number } : {}),
        ...(typeof p["averagePrice"] === "number" ? { averagePrice: p["averagePrice"] as number } : {}),
      });
    }
  }
  return out;
}

export async function schwabPositions(transport: Transport, token: string): Promise<SchwabPosition[]> {
  const res = await authGet(transport, `${TRADER}/accounts?fields=positions`, token);
  return parseSchwabPositions(await res.json());
}

// ----------------------------------------------------------------- Watchlists

export interface SchwabWatchlistItem {
  symbol: string;
  assetType?: string;
}

export interface SchwabWatchlist {
  name: string;
  id?: string;
  accountNumber?: string;
  items: SchwabWatchlistItem[];
}

/**
 * Parse Schwab's `/accounts/watchlists` response — the reader's saved lists of symbols,
 * i.e. their **tracked trade ideas** (thinkorswim watchlists sync to the same Schwab
 * backend). Flattens each list to its name + symbols.
 */
export function parseSchwabWatchlists(json: unknown): SchwabWatchlist[] {
  if (!Array.isArray(json)) return [];
  const out: SchwabWatchlist[] = [];
  for (const w of json as Record<string, unknown>[]) {
    if (!w || typeof w !== "object") continue;
    const items: SchwabWatchlistItem[] = [];
    for (const it of (w["watchlistItems"] as Record<string, unknown>[] | undefined) ?? []) {
      const inst = it?.["instrument"] as { symbol?: string; assetType?: string } | undefined;
      if (!inst?.symbol) continue;
      items.push({ symbol: inst.symbol, ...(typeof inst.assetType === "string" ? { assetType: inst.assetType } : {}) });
    }
    const acct = w["accountNumber"];
    out.push({
      name: typeof w["name"] === "string" ? (w["name"] as string) : "",
      ...(typeof w["watchlistId"] === "string" ? { id: w["watchlistId"] as string } : {}),
      ...(typeof acct === "string" || typeof acct === "number" ? { accountNumber: String(acct) } : {}),
      items,
    });
  }
  return out;
}

/** The reader's watchlists across their linked accounts (their tracked trade ideas). */
export async function schwabWatchlists(transport: Transport, token: string): Promise<SchwabWatchlist[]> {
  const res = await authGet(transport, `${TRADER}/accounts/watchlists`, token);
  return parseSchwabWatchlists(await res.json());
}

// ----------------------------------------------------------------- Order PREP

/**
 * Build a Schwab order payload for the reader to REVIEW + place themselves (never
 * auto-submitted). A single-leg equity or option order.
 */
export function buildEquityOrder(opts: { symbol: string; quantity: number; instruction: "BUY" | "SELL"; orderType: "MARKET" | "LIMIT"; price?: number }): Record<string, unknown> {
  return {
    orderType: opts.orderType,
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    ...(opts.orderType === "LIMIT" && opts.price !== undefined ? { price: opts.price } : {}),
    orderLegCollection: [
      {
        instruction: opts.instruction,
        quantity: opts.quantity,
        instrument: { symbol: opts.symbol.toUpperCase(), assetType: "EQUITY" },
      },
    ],
  };
}

export type OptionInstruction = "BUY_TO_OPEN" | "SELL_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_CLOSE";

/** Build a single-leg OPTION order for review (never auto-submitted). `optionSymbol`
 * is Schwab's OSI symbol, e.g. "AAPL  260620C00200000". */
export function buildOptionOrder(opts: { optionSymbol: string; quantity: number; instruction: OptionInstruction; orderType: "MARKET" | "LIMIT" | "NET_DEBIT" | "NET_CREDIT"; price?: number }): Record<string, unknown> {
  return {
    orderType: opts.orderType,
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    complexOrderStrategyType: "NONE",
    ...(opts.orderType !== "MARKET" && opts.price !== undefined ? { price: opts.price } : {}),
    orderLegCollection: [
      {
        instruction: opts.instruction,
        quantity: opts.quantity,
        instrument: { symbol: opts.optionSymbol, assetType: "OPTION" },
      },
    ],
  };
}

/** A one-line human summary of a built order, for the review modal + the chat. */
export function describeOrder(order: Record<string, unknown>): string {
  const leg = (order.orderLegCollection as { instruction?: string; quantity?: number; instrument?: { symbol?: string; assetType?: string } }[] | undefined)?.[0];
  const type = order.orderType as string;
  const price = order.price !== undefined ? ` @ ${order.price}` : "";
  return `${leg?.instruction ?? "?"} ${leg?.quantity ?? "?"} ${leg?.instrument?.symbol ?? "?"} (${leg?.instrument?.assetType ?? "?"}) — ${type}${price}, DAY`;
}

export interface SchwabAccountRef {
  accountNumber: string;
  hashValue: string;
}

/** Account numbers + their hash values (orders are placed against the hash). */
export async function schwabAccountNumbers(transport: Transport, token: string): Promise<SchwabAccountRef[]> {
  const res = await authGet(transport, `${TRADER}/accounts/accountNumbers`, token);
  const arr = (await res.json<{ accountNumber?: string; hashValue?: string }[]>()) ?? [];
  return arr.filter((a): a is SchwabAccountRef => !!a.accountNumber && !!a.hashValue);
}

/**
 * Place an order against an account hash. Called ONLY from the host's explicit
 * "Place order" review action — never auto-run by the assistant. Returns ok + status.
 */
export async function placeSchwabOrder(transport: Transport, token: string, accountHash: string, order: Record<string, unknown>): Promise<{ ok: boolean; status: number }> {
  const res = await transport.send({
    url: `${TRADER}/accounts/${encodeURIComponent(accountHash)}/orders`,
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: order,
  });
  return { ok: res.ok, status: res.status };
}
