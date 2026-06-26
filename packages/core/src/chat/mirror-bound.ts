import type { StoredChatMessage } from "../storage/store.js";

/**
 * How many bytes of inline image data the chat MIRROR may carry across the active session's history.
 * The snapshot / `vrsync:chat` frame rides ONE WebSocket message; a tunnel (Cloudflare) silently
 * drops an oversized frame, and on the phone the cached bytes can exhaust the storage quota (which
 * evicts the saved pairing token → the phone drops back to a local app). ~3 MB keeps the most-recent
 * images and the full text/structure of every message.
 */
export const CHAT_MIRROR_IMAGE_BUDGET = 3_000_000;

/** Total image-byte weight a single message carries: the inline image PLUS every file-card attachment
 * (a generated image is surfaced both inline AND as a universal file card, so its bytes appear twice). */
function messageImageBytes(m: StoredChatMessage): number {
  let n = 0;
  if (m.image && "bytes" in m.image) n += m.image.bytes.byteLength;
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
    // Over budget: keep the bubble + card metadata, drop the heavy bytes (both inline and attachments).
    budget = 0;
    let next = m;
    if (m.image && "bytes" in m.image) {
      const { image: _drop, ...rest } = next;
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
