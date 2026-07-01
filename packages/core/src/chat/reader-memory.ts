import type { VisualReaderStore } from "../storage/store.js";
import { type NoteEntry, type NoteStoreSpec, loadNotes, saveNotes, rememberIn, forgetIn } from "./note-store.js";

/**
 * Long-term reader memory — the chat's `MEMORY.md`. A small, bounded list of
 * durable notes ("prefers oil-painting style", "reading the Empyrean series",
 * "never spoil endings") that BOTH chats inject into every system prompt and
 * maintain through `remember`/`forget` tool calls. Persisted as one JSON memo
 * in the store, so it survives sessions and applies across books.
 *
 * The note machinery (dedupe, trim, eviction) lives in `note-store.ts`, shared with
 * the identity "souls"; this module is the reader-memory store + its prompt block.
 */

export const READER_MEMORY_KEY = "reader-memory";
export const MAX_MEMORY_NOTES = 40;
/** Per-note character cap. Generous so a memory can hold several paragraphs (a preference with its
 * reasoning, a multi-part instruction) without being cut off. 40 notes × this is still bounded. */
export const MAX_NOTE_CHARS = 2000;

const SPEC: NoteStoreSpec = { key: READER_MEMORY_KEY, maxNotes: MAX_MEMORY_NOTES, maxChars: MAX_NOTE_CHARS };

/** A single durable memory note. */
export type MemoryNote = NoteEntry;

export function loadMemory(store: VisualReaderStore): Promise<MemoryNote[]> {
  return loadNotes(store, SPEC);
}

/** Replace the WHOLE memory list — for the editable Memory panel. */
export function saveMemory(store: VisualReaderStore, notes: readonly MemoryNote[]): Promise<MemoryNote[]> {
  return saveNotes(store, SPEC, notes);
}

/** Add a note (deduped case-insensitively; oldest evicted past the cap). */
export function rememberNote(store: VisualReaderStore, text: string): Promise<MemoryNote[]> {
  return rememberIn(store, SPEC, text);
}

/** Remove every note containing `match` (case-insensitive); throws when nothing matched. */
export function forgetNote(store: VisualReaderStore, match: string): Promise<MemoryNote[]> {
  return forgetIn(store, SPEC, match, "memory note");
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
