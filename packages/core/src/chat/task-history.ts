import type { VisualReaderStore } from "../storage/store.js";

/**
 * TASK HISTORY — a small, bounded log of the GOALS the buddy has completed multi-step turns for.
 * It exists so a skill is only auto-proposed when a similar task has **recurred**: the first time
 * you do something, it's just recorded; the second similar time, that recurrence is the signal
 * that a reusable playbook would actually pay off next time. Pure similarity over significant
 * words (no embeddings/model needed); stored like skills/memory in the shared KV.
 */

export const TASK_HISTORY_KEY = "task-history";
export const MAX_TASK_HISTORY = 80;
const MAX_GOAL_CHARS = 300;
/** A prior task counts as "the same kind" at this many shared significant words. */
export const RECURRENCE_MIN_SHARED = 2;

export interface TaskRecord {
  goal: string;
  at: number;
}

const STOP = new Set([
  "the", "and", "for", "with", "from", "into", "over", "under", "that", "this", "these", "those",
  "your", "you", "please", "could", "would", "should", "about", "what", "when", "where", "which",
  "how", "can", "make", "give", "find", "get", "show", "tell", "help", "want", "need", "have", "are",
  "use", "using", "based", "off",
]);

/** Significant lower-case word tokens of a goal (length ≥ 4, not a stop word). */
export function topicTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !STOP.has(t)),
  );
}

/** How many significant words two goals share. */
export function sharedTopicCount(a: string, b: string): number {
  const ta = topicTokens(a);
  const tb = topicTokens(b);
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n;
}

/** Whether any PRIOR task in the history is "the same kind" as `goal` (≥ RECURRENCE_MIN_SHARED words). */
export function taskRecurred(history: readonly TaskRecord[], goal: string): boolean {
  return history.some((h) => sharedTopicCount(h.goal, goal) >= RECURRENCE_MIN_SHARED);
}

export async function loadTaskHistory(store: VisualReaderStore): Promise<TaskRecord[]> {
  try {
    const raw = await store.getMemo?.(TASK_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((r): r is TaskRecord => !!r && typeof (r as TaskRecord).goal === "string").slice(-MAX_TASK_HISTORY)
      : [];
  } catch {
    return [];
  }
}

/** Append a completed task's goal (bounded). Returns the new history. */
export async function recordTask(store: VisualReaderStore, goal: string): Promise<TaskRecord[]> {
  const g = goal.trim().replace(/\s+/g, " ").slice(0, MAX_GOAL_CHARS);
  if (!g) return loadTaskHistory(store);
  const history = [...(await loadTaskHistory(store)), { goal: g, at: Date.now() }].slice(-MAX_TASK_HISTORY);
  await store.putMemo?.(TASK_HISTORY_KEY, JSON.stringify(history));
  return history;
}
