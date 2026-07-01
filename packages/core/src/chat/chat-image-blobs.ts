import type { StoredChatMessage } from "../storage/store.js";

/**
 * Externalizing chat image bytes — pure helpers that move an image's bytes OUT of a chat message into a
 * keyed blob store so the persisted/in-RAM message array stays small (a long image-heavy session no
 * longer re-writes megabytes every turn, and reload starts lean), with the bytes re-hydrated on demand
 * and bounded by an LRU. Shared by the host (App.tsx) and unit-tested here.
 */

/**
 * The externalized blob id for a message whose image bytes were moved out (phone-stripped OR desktop
 * blob-externalized): a byte-less inline `{ id }` image, or — when there's no inline image — the first
 * byte-less image file-card attachment. `undefined` when the message already carries its bytes (or has
 * none, or is a `sourceUrl` hotlink). The caller fetches the bytes back keyed by this id.
 */
export function externalizedImageId(m: StoredChatMessage): string | undefined {
  if (m.image && "bytes" in m.image) return undefined; // already loaded — nothing to fetch
  if (m.image && "id" in m.image) return m.image.id;
  if (m.image) return undefined; // a sourceUrl hotlink — no bytes to restore
  return m.attachments?.find((a) => a.kind === "image" && a.id && !a.bytes)?.id;
}

/** The externalized blob id for a message's inline VIDEO clip whose bytes were moved out (a byte-less
 * `{ id }` video). `undefined` when the clip still carries its bytes or the message has none. */
export function externalizedVideoId(m: StoredChatMessage): string | undefined {
  if (m.video && "bytes" in m.video) return undefined; // already loaded
  if (m.video && "id" in m.video) return m.video.id;
  return undefined;
}

/**
 * Put back inline image bytes fetched on demand for messages whose bytes were stripped — the PHONE
 * mirror path (keyed by file-card attachment id) AND the DESKTOP blob-externalized path (keyed by a
 * byte-less inline `{ id }` image). The re-inlined image keeps its `id` so a later re-persist reuses
 * the same blob (no churn). Returns the SAME array reference when nothing changed.
 */
export function restoreInlineImages(
  msgs: StoredChatMessage[],
  cache: Map<string, { bytes: ArrayBuffer; mimeType: string }>,
): StoredChatMessage[] {
  if (cache.size === 0) return msgs;
  let changed = false;
  const out = msgs.map((m) => {
    let next = m;
    // Inline image (unless it already has its bytes).
    if (!(next.image && "bytes" in next.image)) {
      const id = externalizedImageId(next);
      const got = id ? cache.get(id) : undefined;
      if (got && id) {
        next = { ...next, image: { ...got, id } };
        changed = true;
      }
    }
    // Inline video clip (same treatment — its bytes were externalized to the blob store).
    const vid = externalizedVideoId(next);
    const gotVid = vid ? cache.get(vid) : undefined;
    if (gotVid && vid) {
      next = { ...next, video: { ...gotVid, id: vid } };
      changed = true;
    }
    return next;
  });
  return changed ? out : msgs;
}

/** A blob to write to the chat blob store: stable `id`, raw `bytes`, and `mimeType`. */
export interface ChatImageBlob {
  id: string;
  bytes: ArrayBuffer;
  mimeType: string;
}

/**
 * Move a chat message's image bytes OUT into externally-stored blobs. Returns the stripped message
 * (inline image → byte-less `{ id, mimeType }`; each attachment's `bytes` dropped, `id` kept) plus the
 * blobs to write. De-dups a SHARED ArrayBuffer — a generated image's inline copy and its file-card copy
 * reference the same buffer, so they collapse to ONE id / ONE blob. An inline image that already
 * carries an `id` (it was re-hydrated from that blob) reuses it instead of minting, so re-persisting the
 * same message never orphans a blob. Messages without inline/attachment bytes pass through unchanged
 * (same reference). PURE.
 */
export function externalizeChatImages(
  msg: StoredChatMessage,
  genId: () => string,
): { message: StoredChatMessage; blobs: ChatImageBlob[] } {
  const hasInline = !!(msg.image && "bytes" in msg.image);
  const hasVideo = !!(msg.video && "bytes" in msg.video);
  const hasAttachmentBytes = !!msg.attachments?.some((a) => a.bytes);
  if (!hasInline && !hasVideo && !hasAttachmentBytes) return { message: msg, blobs: [] };

  const blobs: ChatImageBlob[] = [];
  const idByBuffer = new Map<ArrayBuffer, string>();
  const emit = (bytes: ArrayBuffer, mimeType: string, preferId?: string): string => {
    const existing = idByBuffer.get(bytes);
    if (existing) return existing; // same buffer already externalized — reuse its id, no second blob
    const id = preferId ?? genId();
    idByBuffer.set(bytes, id);
    blobs.push({ id, bytes, mimeType });
    return id;
  };

  let out = msg;
  // Attachments first so a buffer shared with the inline image reuses the attachment's STABLE id.
  if (hasAttachmentBytes) {
    const attachments = msg.attachments!.map((a) => {
      if (!a.bytes) return a;
      const id = emit(a.bytes, a.mime || "application/octet-stream", a.id);
      const { bytes: _drop, ...rest } = a;
      return { ...rest, id };
    });
    out = { ...out, attachments };
  }
  if (hasInline) {
    const img = msg.image as { bytes: ArrayBuffer; mimeType: string; id?: string };
    const id = emit(img.bytes, img.mimeType, img.id);
    out = { ...out, image: { id, mimeType: img.mimeType } };
  }
  // The inline video clip shares its buffer with its file-card attachment (surfaced both ways), so
  // `emit` de-dups to the attachment's stable id — no second blob. Byte-less `{ id }` is what persists.
  if (hasVideo) {
    const vid = msg.video as { bytes: ArrayBuffer; mimeType: string; id?: string };
    const id = emit(vid.bytes, vid.mimeType, vid.id);
    out = { ...out, video: { id, mimeType: vid.mimeType } };
  }
  return { message: out, blobs };
}
