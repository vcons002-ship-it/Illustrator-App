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
/**
 * Under this, the whole set is carried verbatim. Retrieval that changes nothing is pure risk — and
 * forty one-line preferences cost less than the machinery to choose between them.
 */
export const MEMORY_BLOCK_BUDGET_CHARS = 4_000;
/** How much of an unselected note still rides along. Enough to know it EXISTS and roughly what it
 * says, which is the difference between a note being deprioritised and a note being hidden. */
export const MEMORY_STUB_CHARS = 140;
/** Newest notes kept in full regardless of score: "remember this" is usually about right now, and a
 * preference stated a minute ago losing to one from March would be its own bug. */
const ALWAYS_RECENT = 3;
/** Notes selected by relevance, on top of the recent ones. */
const RELEVANT_KEEP = 8;

/** Words too common to carry a match. Small on purpose — real terms do the work. */
const MEMORY_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "when", "where", "why", "how", "does", "did",
  "was", "were", "are", "into", "from", "your", "you", "his", "her", "their", "they", "them",
  "about", "have", "has", "had", "but", "not", "all", "any", "can", "please", "would", "should",
]);

/**
 * A crude stem, and crude on purpose.
 *
 * Straight term overlap fails the first realistic query it meets: "what should I bake this weekend"
 * shares not one token with a note about BAKING. A reader does not phrase a request the way they
 * phrased the preference, and a retrieval that only matches identical words is a retrieval that
 * mostly does not fire.
 *
 * Four suffixes and a trailing `e` — bake/baking/bakes, read/reading, prefer/prefers. It is not a
 * stemmer and does not want to be: everything here is meant to be legible enough that a wrong match
 * can be read back and understood, which is the whole argument for not reaching for embeddings yet.
 */
function stem(token: string): string {
  if (token.length <= 3) return token;
  let w = token;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

function memoryTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .filter((t) => t && !MEMORY_STOPWORDS.has(t) && (t.length > 2 || /\P{ASCII}/u.test(t)))
      .map(stem),
  );
}

/**
 * WHICH MEMORIES THIS TURN ACTUALLY NEEDS — by index, so the caller can keep the original order.
 *
 * Every note went into every prompt. That is right for a handful of one-liners and wrong once a note
 * can hold two thousand characters: forty of those is most of a local model's whole input allowance,
 * spent on preferences about a book the reader is not reading today.
 *
 * Deliberately keyword-scored rather than semantic. When embedding retrieval returns the wrong note
 * nothing errors and the answer is quietly wrong, which is the failure mode this app has spent a week
 * digging out of; term overlap is dumber and legible — you can read why it matched. PURE.
 */
export function relevantMemoryIndices(
  notes: readonly MemoryNote[],
  query: string,
  keep = RELEVANT_KEEP,
): Set<number> {
  const out = new Set<number>();
  // Recency first, and unconditionally.
  for (let i = Math.max(0, notes.length - ALWAYS_RECENT); i < notes.length; i++) out.add(i);
  const want = memoryTerms(query);
  if (want.size === 0) return out;
  const scored = notes
    .map((n, i) => {
      const have = memoryTerms(n.text);
      let hit = 0;
      for (const t of want) if (have.has(t)) hit += 1;
      return { i, hit };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || b.i - a.i);
  for (const { i } of scored.slice(0, keep)) out.add(i);
  return out;
}

/**
 * The memory block. With a `query` and a set too big to carry whole, the notes this turn is about
 * arrive in full and the rest as their opening line.
 *
 * NOTHING IS HIDDEN, which is the property that matters. A retrieval that silently drops a note is
 * indistinguishable from the app having forgotten it — so every note is still listed, and the model
 * is told plainly which ones it is reading in abbreviated form. An index it can see beats a
 * selection it cannot.
 */
export function memoryPromptBlock(notes: readonly MemoryNote[], query = ""): string {
  if (notes.length === 0) return "";
  const header =
    "READER MEMORY (durable notes you keep across conversations — apply them without being asked; " +
    "update with the remember/forget tools when the reader states a lasting preference)";
  const total = notes.reduce((n, x) => n + x.text.length, 0);
  if (total <= MEMORY_BLOCK_BUDGET_CHARS || !query.trim()) {
    return `${header}:\n${notes.map((n) => `- ${n.text}`).join("\n")}`;
  }
  const keep = relevantMemoryIndices(notes, query);
  const lines = notes.map((n, i) =>
    keep.has(i) || n.text.length <= MEMORY_STUB_CHARS
      ? `- ${n.text}`
      : `- ${n.text.slice(0, MEMORY_STUB_CHARS).trimEnd()}… [shortened — not obviously about this turn]`,
  );
  return (
    `${header}. The ones that look relevant to what the reader just said are in full; the rest are ` +
    `shortened to their opening, and are still yours — if a shortened one turns out to matter, say so ` +
    `rather than acting on half of it:\n${lines.join("\n")}`
  );
}
