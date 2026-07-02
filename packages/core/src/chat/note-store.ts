import type { VisualReaderStore } from "../storage/store.js";

/**
 * A small, bounded list of durable text notes persisted as ONE JSON memo in the shared
 * store. This is the shared machinery behind reader-memory, and the two identity "souls"
 * (what the assistant knows about itself / about the reader) — each is the same note list
 * under a DIFFERENT memo key, with its own caps. Keeping the logic here (deterministic
 * dedupe, trim, eviction) means every note store behaves identically and is tested once.
 */

export interface NoteEntry {
  text: string;
  /** ms epoch when written (recency drives eviction at the cap). */
  at: number;
}

/** Identifies one note store: its memo key and bounds. */
export interface NoteStoreSpec {
  key: string;
  maxNotes: number;
  maxChars: number;
}

export async function loadNotes(store: VisualReaderStore, spec: NoteStoreSpec): Promise<NoteEntry[]> {
  try {
    const raw = await store.getMemo?.(spec.key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n): n is NoteEntry => typeof (n as NoteEntry)?.text === "string")
      // Keep the NEWEST notes (the list is append-ordered), matching persist/rememberIn's
      // slice(-maxNotes) eviction — slice(0, …) would drop the most recent notes instead.
      .slice(-spec.maxNotes);
  } catch {
    return [];
  }
}

async function persist(store: VisualReaderStore, spec: NoteStoreSpec, notes: NoteEntry[]): Promise<void> {
  await store.putMemo?.(spec.key, JSON.stringify(notes.slice(-spec.maxNotes)));
}

/**
 * Replace the WHOLE list — for the editable panels (the reader manages the array directly).
 * Trims each note to the char cap, drops blanks, de-dupes case-insensitively (keeping the
 * first occurrence + its order), and bounds to the cap. Returns the cleaned, persisted list.
 */
export async function saveNotes(
  store: VisualReaderStore,
  spec: NoteStoreSpec,
  notes: readonly NoteEntry[],
): Promise<NoteEntry[]> {
  const seen = new Set<string>();
  const cleaned: NoteEntry[] = [];
  for (const n of notes) {
    const text = (n?.text ?? "").trim().slice(0, spec.maxChars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ text, at: typeof n?.at === "number" ? n.at : Date.now() });
  }
  const bounded = cleaned.slice(-spec.maxNotes);
  await persist(store, spec, bounded);
  return bounded;
}

/** Add a note (deduped case-insensitively; oldest evicted past the cap). */
export async function rememberIn(store: VisualReaderStore, spec: NoteStoreSpec, text: string): Promise<NoteEntry[]> {
  const note = text.trim().slice(0, spec.maxChars);
  if (!note) throw new Error("nothing to remember");
  const notes = await loadNotes(store, spec);
  const key = note.toLowerCase();
  const kept = notes.filter((n) => n.text.toLowerCase() !== key);
  kept.push({ text: note, at: Date.now() });
  const bounded = kept.slice(-spec.maxNotes);
  await persist(store, spec, bounded);
  return bounded;
}

/** Remove every note containing `match` (case-insensitive); returns what's left.
 * Throws when nothing matched so the caller learns the wording was off. `label` names the
 * store in the error ("memory note", "self-soul note") so the message reads naturally. */
export async function forgetIn(
  store: VisualReaderStore,
  spec: NoteStoreSpec,
  match: string,
  label = "memory note",
): Promise<NoteEntry[]> {
  const needle = match.trim().toLowerCase();
  if (!needle) throw new Error("nothing to forget");
  const notes = await loadNotes(store, spec);
  const kept = notes.filter((n) => !n.text.toLowerCase().includes(needle));
  if (kept.length === notes.length) {
    throw new Error(`no ${label} contains "${match.trim()}"`);
  }
  await persist(store, spec, kept);
  return kept;
}
