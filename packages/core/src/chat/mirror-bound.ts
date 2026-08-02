import type { StoredChatMessage } from "../storage/store.js";

/**
 * How many bytes of inline image data the chat MIRROR may carry across the active session's history.
 * The `vrsync:chat` frame rides ONE WebSocket message; a tunnel (Cloudflare) silently drops an
 * oversized frame and the desktop relay hard-caps a message at 4 MiB, and on the phone the cached
 * bytes can exhaust the storage quota (which evicts the saved pairing token → the phone drops back to
 * a local app).
 *
 * Counted in RAW bytes, but they travel base64 — ~4/3 the size — so the budget must be derived from
 * the on-the-wire ceiling, not set equal to it. At the old 3 MB this produced a ~4 MB frame: over the
 * tunnel's limit and at the relay's cap, so a chat carrying its full allowance of images was dropped
 * outright and the phone showed nothing. 2 MB raw ≈ 2.7 MB on the wire, leaving real headroom for the
 * message text/structure in the same frame while still keeping the most-recent images.
 */
export const CHAT_MIRROR_IMAGE_BUDGET = 2_000_000;

/** Total media-byte weight a single message carries: the inline image, the inline VIDEO clip, PLUS every
 * file-card attachment (a generated image/clip is surfaced both inline AND as a universal file card, so
 * its bytes appear twice — counted twice here, and both copies drop together when trimmed). Video clips
 * dwarf images, so counting them here is what actually keeps the frame tunnel-safe. */
function messageImageBytes(m: StoredChatMessage): number {
  let n = 0;
  if (m.image && "bytes" in m.image) n += m.image.bytes.byteLength;
  if (m.video && "bytes" in m.video) n += m.video.bytes.byteLength;
  for (const a of m.attachments ?? []) if (a.bytes) n += a.bytes.byteLength;
  return n;
}

/**
 * Bound the chat history mirrored to a phone so its frame stays tunnel-safe AND can't fill the phone's
 * storage quota. Keeps EVERY message's text/structure and EVERY file CARD (name/kind/actions) intact,
 * but carries inline + attachment image BYTES only for the most-recent messages within the budget —
 * older generated images become a text/card-only bubble on the phone (untouched on the desktop, which
 * keeps the real bytes). Walks newest→oldest so recent images survive; strips both the inline `image`
 * and any file-card `attachments[].bytes` once the budget is spent, under ONE shared budget (so the
 * same image counted twice doesn't double-spend the allowance unfairly — both copies drop together).
 *
 * Returns the SAME array reference when nothing was trimmed (stable for a memo).
 */
export function boundChatHistoryForMirror(
  messages: StoredChatMessage[],
  budgetBytes = CHAT_MIRROR_IMAGE_BUDGET,
): StoredChatMessage[] {
  let budget = budgetBytes;
  let changed = false;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    const weight = messageImageBytes(m);
    if (weight === 0) continue;
    if (weight <= budget) {
      budget -= weight; // keep this message's image bytes whole
      continue;
    }
    // Over budget: keep the bubble + card metadata, drop the heavy bytes (inline image, inline video clip,
    // and attachments). The phone shows the text/card; the clip stays whole on the desktop.
    budget = 0;
    let next = m;
    if (m.image && "bytes" in m.image) {
      const { image: _drop, ...rest } = next;
      next = rest;
    }
    if (next.video && "bytes" in next.video) {
      const { video: _drop, ...rest } = next;
      next = rest;
    }
    if (next.attachments?.some((a) => a.bytes)) {
      next = { ...next, attachments: next.attachments.map((a) => (a.bytes ? stripBytes(a) : a)) };
    }
    out[i] = next;
    changed = true;
  }
  return changed ? out : messages;
}

/** A file-card ref with its heavy `bytes` removed (the card still shows name/kind + relayed actions). */
function stripBytes<T extends { bytes?: ArrayBuffer }>(ref: T): T {
  const { bytes: _drop, ...rest } = ref;
  return rest as T;
}

/**
 * The most a single phone→desktop COMMAND may weigh. Most commands are an id or a settings object and
 * come nowhere near it, but a few carry a whole document — "Add to library" on a chat file card sends
 * the imported book, because the desktop owns the library and a phone-local add lands in a store
 * nothing reads.
 *
 * The ceiling exists because an oversized frame does not fail loudly: a tunnel (Cloudflare) drops it
 * and the desktop relay hard-caps a message at 4 MiB, so the command simply never arrives and the
 * phone has no way to know. Unlike the mirror, a command can't be trimmed — half a book is not a book
 * — so the only honest move is to measure it first and say so. 3 MB of JSON leaves room for the frame
 * envelope and base64 growth under the relay's cap.
 */
export const MAX_RELAY_COMMAND_BYTES = 3_000_000;

/**
 * Will this command payload survive one relay frame? Measured on its serialized form, which is what
 * actually travels. Returns false for anything that can't be serialized at all (a cycle, a value the
 * encoder rejects) — that can't cross either, and finding out here beats finding out by silence. PURE.
 */
export function fitsOneRelayFrame(value: unknown, max = MAX_RELAY_COMMAND_BYTES): boolean {
  try {
    const json = JSON.stringify(value);
    return json !== undefined && json.length <= max;
  } catch {
    return false;
  }
}

/**
 * Bytes per chunk when a file is fetched over the phone↔desktop tunnel ON DEMAND. The mirror snapshot
 * must fit ONE frame (hence CHAT_MIRROR_IMAGE_BUDGET strips big images), but an on-demand fetch can be
 * SPLIT across many frames — so any-size file syncs in pieces instead of being dropped for exceeding a
 * single frame. ~1 MB of raw bytes (~1.4 MB once base64-serialised) sits well under the tunnel's frame
 * limit (the 3 MB mirror budget is already known-safe), with margin for the message envelope.
 */
export const FILE_CHUNK_BYTES = 1_000_000;

/** Split an ArrayBuffer into <= FILE_CHUNK_BYTES pieces (one piece when it already fits). PURE. */
export function chunkArrayBuffer(buf: ArrayBuffer, size = FILE_CHUNK_BYTES): ArrayBuffer[] {
  if (buf.byteLength <= size) return [buf];
  const out: ArrayBuffer[] = [];
  for (let off = 0; off < buf.byteLength; off += size) {
    out.push(buf.slice(off, Math.min(off + size, buf.byteLength)));
  }
  return out;
}

/** Reassemble chunks (in order) back into one ArrayBuffer. PURE. */
export function concatArrayBuffers(parts: ArrayBuffer[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  return out.buffer;
}
