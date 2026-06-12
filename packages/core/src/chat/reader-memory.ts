import type { VisualReaderStore } from "../storage/store.js";

/**
 * Long-term reader memory — the chat's `MEMORY.md`. A small, bounded list of
 * durable notes ("prefers oil-painting style", "reading the Empyrean series",
 * "never spoil endings") that BOTH chats inject into every system prompt and
 * maintain through `remember`/`forget` tool calls. Persisted as one JSON memo
 * in the store, so it survives sessions and applies across books.
 *
 * Deliberately bounded and note-shaped (not a free-form document): a cap keeps
 * the prompt cost flat, dedup keeps repeated "remember"s from accumulating, and
 * short notes keep a model from using memory as scratch space.
 */

export const READER_MEMORY_KEY = "reader-memory";
export const MAX_MEMORY_NOTES = 40;
export const MAX_NOTE_CHARS = 200;

export interface MemoryNote {
  text: string;
  /** ms epoch when remembered (recency drives eviction at the cap). */
  at: number;
}

export async function loadMemory(store: VisualReaderStore): Promise<MemoryNote[]> {
  try {
    const raw = await store.getMemo?.(READER_MEMORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n): n is MemoryNote => typeof (n as MemoryNote)?.text === "string")
      .slice(0, MAX_MEMORY_NOTES);
  } catch {
    return [];
  }
}

async function save(store: VisualReaderStore, notes: MemoryNote[]): Promise<void> {
  await store.putMemo?.(READER_MEMORY_KEY, JSON.stringify(notes.slice(-MAX_MEMORY_NOTES)));
}

/** Add a note (deduped case-insensitively; oldest evicted past the cap). */
export async function rememberNote(store: VisualReaderStore, text: string): Promise<MemoryNote[]> {
  const note = text.trim().slice(0, MAX_NOTE_CHARS);
  if (!note) throw new Error("nothing to remember");
  const notes = await loadMemory(store);
  const key = note.toLowerCase();
  const kept = notes.filter((n) => n.text.toLowerCase() !== key);
  kept.push({ text: note, at: Date.now() });
  const bounded = kept.slice(-MAX_MEMORY_NOTES);
  await save(store, bounded);
  return bounded;
}

/** Remove every note containing `match` (case-insensitive); returns what's left.
 * Throws when nothing matched so the model learns the wording was off. */
export async function forgetNote(store: VisualReaderStore, match: string): Promise<MemoryNote[]> {
  const needle = match.trim().toLowerCase();
  if (!needle) throw new Error("nothing to forget");
  const notes = await loadMemory(store);
  const kept = notes.filter((n) => !n.text.toLowerCase().includes(needle));
  if (kept.length === notes.length) {
    throw new Error(`no memory note contains "${match.trim()}"`);
  }
  await save(store, kept);
  return kept;
}

/** The system-prompt block both chats inject ("" when memory is empty). */
export function memoryPromptBlock(notes: readonly MemoryNote[]): string {
  if (notes.length === 0) return "";
  return (
    "READER MEMORY (durable notes you keep across conversations — apply them without being asked; " +
    "update with the remember/forget tools when the reader states a lasting preference):\n" +
    notes.map((n) => `- ${n.text}`).join("\n")
  );
}
