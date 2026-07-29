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

/**
 * How many pieces in a row have stayed on the same thread — used to nudge, NOT to forbid.
 *
 * Reading on around something for a few pieces is what following a thread looks like, and the point
 * of the feature is that it gets to. What isn't interesting is never leaving: this counts the run so
 * the brief can ask for a change of scene once it's gone on a while, and say nothing until then.
 */
export const MAX_THREAD_RUN = 3;
/** Shortest word worth matching on — below this it's grammar, not subject. */
const MIN_WORD = 4;
const STOPWORDS = new Set([
  "about", "after", "again", "against", "because", "been", "before", "being", "between", "both", "does",
  "down", "during", "each", "from", "further", "have", "having", "here", "into", "just", "more", "most",
  "once", "only", "other", "over", "same", "some", "such", "than", "that", "their", "them", "then",
  "there", "these", "they", "this", "those", "through", "under", "until", "very", "were", "what", "when",
  "where", "which", "while", "with", "your",
]);

/** The subject-bearing words of a topic, lowercased. PURE. */
export function topicWords(topic: string): string[] {
  return topic
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= MIN_WORD && !STOPWORDS.has(w));
}

/**
 * Whether two topics are plainly on the same thread: they share a subject word, counting one word as
 * a match for another it prefixes ("marsh"/"marshes", "tuning"/"tunings"). Deliberately crude — it
 * decides whether to add one sentence of encouragement to move on, so a false positive costs nothing
 * and a stemmer would be more machinery than the job needs. PURE.
 */
export function sameThread(a: string, b: string): boolean {
  const wordsB = topicWords(b);
  return topicWords(a).some((x) => wordsB.some((y) => x.startsWith(y) || y.startsWith(x)));
}

/**
 * How many topics at the END of the list are on the same thread as the newest one (1 when the last
 * piece stands alone, 0 for an empty list). PURE.
 */
export function threadRun(topics: readonly string[]): number {
  const last = topics[topics.length - 1];
  if (!last) return 0;
  let run = 1;
  for (let i = topics.length - 2; i >= 0; i--) {
    if (!sameThread(last, topics[i]!)) break;
    run++;
  }
  return run;
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

/**
 * A persisted "when did the last creative run finish" stamp, sanitised. Returns 0 (meaning "never
 * ran") for anything unusable — including a stamp in the FUTURE.
 *
 * The future case is the important one. Eligibility is decided by `now - lastRun >= gap`, so a
 * stamp ahead of the clock makes that difference negative and the run is never due again. The stamp
 * is persisted, so that state survives restarts: creative work switches itself off permanently and
 * silently, which is indistinguishable from the feature having been temporary. Clocks do move
 * backwards — an NTP correction, a dual-boot machine writing local time to the RTC, or someone
 * simply fixing a wrong date — so nothing keyed to wall-clock time may assume they only go
 * forwards. PURE.
 */
export function sanitizeLastRun(stamp: unknown, now: number): number {
  const n = Number(stamp);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > now ? 0 : n;
}

/**
 * Has the quiet period between creative runs elapsed? Never-run (0) is always eligible, and a
 * stamp the clock has moved behind counts as elapsed rather than blocking forever — for the same
 * reason as {@link sanitizeLastRun}, but for a stamp already read into memory this session. PURE.
 */
export function creativeGapElapsed(lastRunAt: number, now: number, gapMs: number): boolean {
  if (lastRunAt <= 0) return true;
  const since = now - lastRunAt;
  if (since < 0) return true; // the clock went backwards — don't treat that as "just ran"
  return since >= gapMs;
}
