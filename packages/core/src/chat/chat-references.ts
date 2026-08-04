/**
 * The pictures a chat draws from, and the one rule for adding to the set.
 *
 * Two routes in — the paperclip, and adopting one already in the chat (a search hit, a photo opened
 * from the computer) — and they disagreed about what "add" meant. Adopting APPENDED; attaching
 * ASSIGNED, wiping whatever was there. So search → adopt → then attach one of your own left you
 * with only the attachment, and the render silently drew from one picture instead of four. Neither
 * route is more of a choice than the other: both are the reader pointing at a picture and saying
 * use this. They share this now.
 *
 * PURE — no I/O, no DOM. The bytes ride through untouched; callers own copying them.
 */
export interface ChatReferenceImage {
  bytes: ArrayBuffer;
  mimeType: string;
  /** What to call it in the model-facing ledger — a filename, or a searched picture's title. */
  label?: string;
}

/**
 * Add `incoming` to `existing`, keeping the set within `max`.
 *
 * Same label replaces rather than duplicates: re-adopting a picture is the reader pointing at the
 * one they already chose, and two copies of it would condition the render on that face twice,
 * weighting it against everything else in the picture. An UNLABELLED reference never dedupes —
 * there is nothing to match it on, and quietly dropping one would be worse than keeping both.
 *
 * The cap keeps the NEWEST. When the set is over what a render can use, the pictures chosen most
 * recently are the ones most likely to be what the reader means now.
 */
export function mergeChatReferences(
  existing: readonly ChatReferenceImage[],
  incoming: readonly ChatReferenceImage[],
  max: number,
): ChatReferenceImage[] {
  // `slice(-0)` is `slice(0)` — the WHOLE array, not none of it. A zero cap has to be its own branch
  // or "keep the last max" silently means "keep everything" at exactly the value that asked for none.
  if (max <= 0) return [];
  const replacing = new Set(incoming.map((r) => r.label).filter((l): l is string => !!l));
  const kept = existing.filter((r) => !r.label || !replacing.has(r.label));
  return [...kept, ...incoming].slice(-max);
}
