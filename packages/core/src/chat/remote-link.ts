/**
 * REMOTE LINK (LAN) — the foundations for driving the desktop assistant from a phone on the
 * same Wi-Fi, in real time, with **no cloud**. The desktop shell runs a small WebSocket relay
 * bound to the LAN; the phone opens a link (shown as text/QR on the desktop) and becomes a
 * thin client of the desktop engine. This module is the pure, testable core both ends share:
 * a pairing token, the link URL build/parse, and the frame envelope (token + a worker-protocol
 * message) that gates every frame. The Rust server + the phone client transport sit on top and
 * need real-device verification (no listening socket exists in this environment).
 *
 * Security: LAN-only, opt-in, and every frame must carry the current pairing token — a device
 * that can't present it is ignored. No data leaves the local network.
 */

/** Default port for the desktop LAN relay. */
export const REMOTE_LINK_PORT = 8787;

/** Crockford-ish alphabet (no 0/O/1/I/i/l look-alikes) for a short, typo-resistant token. */
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz";

/** A URL-safe pairing token. Uses Web Crypto when available, else falls back to Math.random. */
export function generatePairingToken(len = 24): string {
  const bytes = new Uint8Array(len);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (let i = 0; i < len; i++) out += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
  return out;
}

export interface LinkParams {
  host: string;
  port: number;
  token: string;
}

/** The URL the phone opens (the desktop shows it as text/QR); the token rides in the hash. */
export function buildLinkUrl(p: LinkParams): string {
  return `http://${p.host}:${p.port}/#vrlink=${encodeURIComponent(p.token)}`;
}

/** Pull the pairing token out of a link URL or hash (the phone reads this on load). */
export function parseLinkToken(urlOrHash: string): string | undefined {
  const m = /[#&?]vrlink=([^&]+)/.exec(urlOrHash);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

export interface RemoteFrame {
  token: string;
  payload: unknown;
}

/** Wrap a worker-protocol message with the pairing token for the socket. */
export function encodeFrame(token: string, payload: unknown): string {
  return JSON.stringify({ token, payload } satisfies RemoteFrame);
}

/** Unwrap a frame, returning its payload only when the token matches (else undefined). */
export function decodeFrame(data: string, expectedToken: string): unknown | undefined {
  try {
    const f = JSON.parse(data) as RemoteFrame;
    if (!f || typeof f.token !== "string" || f.token !== expectedToken) return undefined;
    return f.payload;
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------- thin client

/** When the app is opened via a `#vrlink=…` link (the phone), the relay URL + token to use. */
export interface RemoteMode {
  wsUrl: string;
  token: string;
}

/**
 * Detect "phone client" mode from the page URL: a `#vrlink=<token>` hash means this tab should
 * drive a remote desktop engine over the relay instead of a local Web Worker. `host` is the
 * page's host (e.g. "192.168.1.20:8787"); the relay listens on the same host as the served app.
 */
export function remoteModeFromHash(hash: string, host: string): RemoteMode | undefined {
  const token = parseLinkToken(hash);
  if (!token || !host) return undefined;
  return { wsUrl: `ws://${host}/`, token };
}

/**
 * Worker-protocol messages that must stay LOCAL to whichever side owns the engine — the
 * desktop host handles its own CORS-exempt fetches; they're never relayed to the phone.
 */
export const LOCAL_ONLY_MESSAGE_TYPES: ReadonlySet<string> = new Set(["corsFetch", "corsFetchResult"]);

/** True when a worker-protocol message should NOT cross the relay (handled on the engine side). */
export function isLocalOnlyMessage(msg: unknown): boolean {
  const t = (msg as { type?: string })?.type;
  return typeof t === "string" && LOCAL_ONLY_MESSAGE_TYPES.has(t);
}

// ArrayBuffers (image bytes) can't ride in JSON — tag them so the other side rebuilds them.
function abTag(b64: string): { __ab: string } {
  return { __ab: b64 };
}
function transform(value: unknown, fn: (v: unknown) => unknown): unknown {
  const v = fn(value);
  if (v === value && v && typeof v === "object") {
    if (Array.isArray(v)) return v.map((x) => transform(x, fn));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = transform(val, fn);
    return out;
  }
  return v;
}

/**
 * Make a worker-protocol message JSON-safe by base64-tagging any ArrayBuffer (image bytes
 * can't ride in JSON). Returns a VALUE, so it composes with `encodeFrame(token, …)`.
 */
export function serializeForRemote(msg: unknown, bytesToBase64: (b: ArrayBuffer) => string): unknown {
  return transform(msg, (v) => (v instanceof ArrayBuffer ? abTag(bytesToBase64(v)) : v));
}

/** Reverse `serializeForRemote`: a decoded frame payload → the message with real ArrayBuffers. */
export function deserializeFromRemote(value: unknown, base64ToBytes: (b: string) => ArrayBuffer): unknown {
  return transform(value, (v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const tag = (v as { __ab?: unknown }).__ab;
      if (typeof tag === "string") return base64ToBytes(tag);
    }
    return v;
  });
}
