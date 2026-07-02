import type { StoredChatMessage } from "../storage/store.js";

/**
 * The Creations gallery — pure helpers that walk persisted chat histories and surface every piece of
 * media the app GENERATED (assistant images, image-to-video clips) as one flat, browsable list, and
 * that remove a single creation from a history when the user deletes it from the gallery. The host
 * supplies the histories (buddy sessions + per-book chats) and the blob store for byte hydration;
 * these helpers stay storage-agnostic and unit-tested.
 */

/** One gallery entry. Bytes are carried inline when the source message still holds them, otherwise
 * `blobId` names the externalized blob in the chat blob store (keyed by `chatId`) to hydrate from. */
export interface CreationItem {
  /** The chat the media lives in — the blob store's key scope AND where deletion edits history. */
  chatId: string;
  /** Human label for that chat (book title, session label, "Assistant chat"). */
  chatLabel: string;
  /** ms epoch of the message that produced it (gallery sort key). */
  at: number;
  kind: "image" | "video";
  mimeType: string;
  /** Externalized blob id (hydrate via `getImageBlob(chatId, blobId)`) — absent when bytes are inline. */
  blobId?: string;
  /** Inline bytes — present only when the stored message still carries them (legacy / small media). */
  bytes?: ArrayBuffer;
  /** Short caption: the attachment's filename, else a snippet of the message text. */
  label?: string;
}

/** A creation's identity within its chat — blob id when externalized, else message-time + kind
 * (inline bytes have no stable id; a message carries at most one inline image and one video). */
export function creationKey(item: Pick<CreationItem, "chatId" | "at" | "kind" | "blobId">): string {
  return `${item.chatId}::${item.blobId ?? `${item.at}:${item.kind}`}`;
}

/** First non-empty line of a message's text, clipped for a thumbnail caption. */
function captionFrom(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/**
 * Collect every ASSISTANT-generated image/video in a chat history. Inline media and its file-card
 * attachment share one externalized blob id (see externalizeChatImages' de-dup), so each creation
 * appears ONCE — the inline copy wins, and attachments only add entries for ids/buffers not already
 * seen (a multi-image turn). Web-retrieved `sourceUrl` hotlinks are skipped: they're finds, not
 * creations. Returned in message order; callers sort as they like.
 */
export function collectCreations(chatId: string, chatLabel: string, messages: StoredChatMessage[]): CreationItem[] {
  const out: CreationItem[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const caption = captionFrom(m.text);
    // Ids/buffers already emitted for THIS message, so its attachment copy doesn't double-list.
    const seenIds = new Set<string>();
    const seenBuffers = new Set<ArrayBuffer>();
    const push = (kind: "image" | "video", mimeType: string, blobId: string | undefined, bytes: ArrayBuffer | undefined, label: string | undefined) => {
      if (blobId) {
        if (seenIds.has(blobId)) return;
        seenIds.add(blobId);
      }
      if (bytes) {
        if (seenBuffers.has(bytes)) return;
        seenBuffers.add(bytes);
      }
      out.push({
        chatId,
        chatLabel,
        at: m.at,
        kind,
        mimeType,
        ...(blobId ? { blobId } : {}),
        ...(bytes ? { bytes } : {}),
        ...(label ? { label } : {}),
      });
    };
    if (m.image && "bytes" in m.image) push("image", m.image.mimeType, m.image.id, m.image.bytes, caption);
    else if (m.image && "id" in m.image) push("image", m.image.mimeType, m.image.id, undefined, caption);
    if (m.video && "bytes" in m.video) push("video", m.video.mimeType, m.video.id, m.video.bytes, caption);
    else if (m.video && "id" in m.video) push("video", m.video.mimeType, m.video.id, undefined, caption);
    for (const a of m.attachments ?? []) {
      if (a.kind !== "image" && a.kind !== "video") continue;
      if (!a.id && !a.bytes) continue; // path-only reference — nothing stored to show
      push(a.kind, a.mime || (a.kind === "image" ? "image/png" : "video/mp4"), a.id, a.bytes, a.name || caption);
    }
  }
  return out;
}

/**
 * Strip ONE creation out of a chat history (the gallery's Delete): the matching inline image/video
 * field is dropped and the matching attachment removed, leaving the message text intact. Matches by
 * blob id when the item has one, else by message time + kind (how inline-bytes items are keyed).
 * Returns the SAME array reference when nothing matched, so callers can skip a no-op re-persist.
 */
export function removeCreationFromMessages(
  messages: StoredChatMessage[],
  item: Pick<CreationItem, "at" | "kind" | "blobId">,
): StoredChatMessage[] {
  const matchesInline = (media: { id?: string } | undefined, at: number, kind: "image" | "video"): boolean => {
    if (item.blobId) return media?.id === item.blobId;
    return at === item.at && kind === item.kind;
  };
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "assistant") return m;
    let next = m;
    if (next.image && !("sourceUrl" in next.image) && item.kind === "image" && matchesInline(next.image, m.at, "image")) {
      const { image: _drop, ...rest } = next;
      next = rest;
      changed = true;
    }
    if (next.video && item.kind === "video" && matchesInline(next.video, m.at, "video")) {
      const { video: _drop, ...rest } = next;
      next = rest;
      changed = true;
    }
    if (next.attachments?.length) {
      const kept = next.attachments.filter((a) => {
        if (a.kind !== item.kind) return true;
        if (item.blobId) return a.id !== item.blobId;
        return m.at !== item.at; // inline-bytes key: the message's media of this kind goes together
      });
      if (kept.length !== next.attachments.length) {
        next = kept.length > 0 ? { ...next, attachments: kept } : (({ attachments: _drop, ...rest }) => rest)(next);
        changed = true;
      }
    }
    return next;
  });
  return changed ? out : messages;
}
