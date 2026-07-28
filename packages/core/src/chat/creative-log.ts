import type { VisualReaderStore } from "../storage/store.js";
import { type NoteEntry, type NoteStoreSpec, loadNotes, rememberIn, saveNotes } from "./note-store.js";
import { loadMemory, saveMemory } from "./reader-memory.js";

/**
 * What the assistant has already explored on its own — the ledger behind "go somewhere new".
 *
 * This used to live in READER MEMORY: the creative prompt asked the assistant to `remember` a note
 * prefixed "explored: …", and the next run grepped for that prefix. Two things were wrong with it.
 *
 *  1. Reader memory holds MAX_MEMORY_NOTES (40) notes and evicts the oldest. A few runs an hour,
 *     each adding one, quietly deletes everything the assistant knows about the reader inside a day
 *     — the feature ate the memory it was sitting next to.
 *  2. The ledger only existed if the model REMEMBERED to write it. When it didn't (a long prompt, a
 *     run that ended at the document), the next run saw an empty "you've recently written about"
 *     list and picked its favourite subject again. Which is exactly what happened: every piece
 *     circled the same first interest.
 *
 * So it's its own store, and the HOST writes it from what was actually created rather than asking
 * the model to keep its own diary. A run that produces a document is on the ledger whether or not
 * the model cooperates.
 */

export const CREATIVE_LOG_KEY = "creative-log";
/** Roughly a month of exploring at a few pieces a day. Cheap (a topic is a few words) and the only
 * cost of keeping more is the JSON memo; only the newest handful ever reaches a prompt. */
export const MAX_CREATIVE_LOG = 120;
/** A topic is a phrase, not an essay. */
export const MAX_TOPIC_CHARS = 200;
/** How many past topics ride the creative prompt. Enough to steer away from a rut without turning
 * the instruction into a wall of text the model skims. */
export const RECENT_TOPICS_SHOWN = 12;

const SPEC: NoteStoreSpec = { key: CREATIVE_LOG_KEY, maxNotes: MAX_CREATIVE_LOG, maxChars: MAX_TOPIC_CHARS };

/** One thing it went and explored. */
export type CreativeEntry = NoteEntry;

export function loadCreativeLog(store: VisualReaderStore): Promise<CreativeEntry[]> {
  return loadNotes(store, SPEC);
}

/** Record a topic (deduped case-insensitively, oldest evicted past the cap). */
export function recordExplored(store: VisualReaderStore, topic: string): Promise<CreativeEntry[]> {
  return rememberIn(store, SPEC, topic);
}

/** Replace the whole list — for a panel, or the migration below. */
export function saveCreativeLog(store: VisualReaderStore, entries: readonly CreativeEntry[]): Promise<CreativeEntry[]> {
  return saveNotes(store, SPEC, entries);
}

/** The most recent topics, newest LAST (reading order), for the creative prompt. */
export function recentTopics(entries: readonly CreativeEntry[], limit = RECENT_TOPICS_SHOWN): string[] {
  return entries.slice(-limit).map((e) => e.text);
}

/** True for a note the old build wrote into reader memory as its explore ledger. */
export function isExploredNote(text: string): boolean {
  return /^explored:/i.test(text.trim());
}

/**
 * Move any "explored: …" notes the old build left in READER MEMORY into this log, and take them out
 * of memory. Idempotent, and a no-op when there are none, so it can run on every startup.
 *
 * This isn't only tidiness: those notes are still occupying slots in a 40-note list that evicts the
 * oldest, so until they're out they go on displacing real memories about the reader. Returns how
 * many were moved.
 */
export async function migrateExploredNotes(store: VisualReaderStore): Promise<number> {
  const memory = await loadMemory(store);
  const stale = memory.filter((n) => isExploredNote(n.text));
  if (stale.length === 0) return 0;
  const existing = await loadCreativeLog(store);
  const seen = new Set(existing.map((e) => e.text.toLowerCase()));
  const moved: CreativeEntry[] = [];
  for (const n of stale) {
    const text = n.text.trim().replace(/^explored:\s*/i, "").slice(0, MAX_TOPIC_CHARS);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    moved.push({ text, at: n.at });
  }
  // Sorted by time so the merged list stays in the order things actually happened — `recentTopics`
  // takes the tail, and an out-of-order splice would make it show the wrong "recently".
  if (moved.length > 0) await saveCreativeLog(store, [...existing, ...moved].sort((a, b) => a.at - b.at));
  await saveMemory(store, memory.filter((n) => !isExploredNote(n.text)));
  return stale.length;
}
