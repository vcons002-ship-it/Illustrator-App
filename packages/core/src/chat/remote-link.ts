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

/** Crockford-ish alphabet (no look-alikes) for a short, typo-resistant token. */
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";

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
