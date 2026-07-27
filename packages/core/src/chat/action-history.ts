import type { VisualReaderStore } from "../storage/store.js";

/**
 * AGENT ACTION HISTORY — a persistent, bounded log of what the assistant did on its own or on the
 * reader's behalf (inbox/calendar scans, task planning, scheduled-task runs, tasks it created), so
 * the reader can review "what happened since I last looked". Distinct from the TRANSIENT activity
 * log (`activity.ts`, in-memory + TTL-pruned, the live status pill): this survives reloads in the
 * shared KV store. Newest-first, capped; "new since last viewed" is a separate stored timestamp.
 * Pure store helpers + selectors, unit-tested.
 */

export const ACTION_HISTORY_KEY = "action-history";
export const ACTION_HISTORY_VIEWED_KEY = "action-history-viewed-at";
export const MAX_ACTION_HISTORY = 200;

/** `task_auto` = a step the assistant worked on its own (unattended task automation). */
export type ActionKind = "scan" | "plan" | "create_task" | "scheduled_run" | "task_auto" | "calendar" | "other";

export interface ActionEntry {
  id: string;
  /** ms epoch when it ran. */
  at: number;
  kind: ActionKind;
  /** A short human label, e.g. "Scanned email & calendar" or "Planned: Flight to Iowa". */
  label: string;
  /** Optional outcome detail, e.g. "5 steps" or an error. */
  detail?: string;
}

function isActionEntry(v: unknown): v is ActionEntry {
  const e = v as ActionEntry;
  return e != null && typeof e.id === "string" && typeof e.at === "number" && typeof e.label === "string";
}

/** Load the log, newest-first, bounded. Tolerates a corrupt memo (→ []). */
export async function loadActionHistory(store: VisualReaderStore): Promise<ActionEntry[]> {
  try {
    const raw = await store.getMemo?.(ACTION_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isActionEntry).slice(0, MAX_ACTION_HISTORY);
  } catch {
    return [];
  }
}

/** Append an action (prepended newest-first, oldest evicted past the cap). Read-modify-write, so
 * concurrent callers are last-writer-wins (it's a log — acceptable). */
export async function recordAction(
  store: VisualReaderStore,
  action: { kind: ActionKind; label: string; detail?: string },
): Promise<void> {
  const entry: ActionEntry = {
    id: `ah-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    kind: action.kind,
    label: action.label,
    ...(action.detail ? { detail: action.detail } : {}),
  };
  const next = [entry, ...(await loadActionHistory(store))].slice(0, MAX_ACTION_HISTORY);
  await store.putMemo?.(ACTION_HISTORY_KEY, JSON.stringify(next));
}

/** Clear the whole log. */
export async function clearActionHistory(store: VisualReaderStore): Promise<void> {
  await store.putMemo?.(ACTION_HISTORY_KEY, JSON.stringify([]));
}

/** The last time the reader opened the history (ms epoch), or 0 if never. */
export async function getActionsViewedAt(store: VisualReaderStore): Promise<number> {
  const raw = await store.getMemo?.(ACTION_HISTORY_VIEWED_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Mark the history viewed now (resets the "new" count). */
export async function markActionsViewed(store: VisualReaderStore): Promise<void> {
  await store.putMemo?.(ACTION_HISTORY_VIEWED_KEY, String(Date.now()));
}

/** How many entries ran after `viewedAt` — the "new since last looked" badge count. PURE. */
export function unseenCount(entries: readonly ActionEntry[], viewedAt: number): number {
  return entries.reduce((n, e) => (e.at > viewedAt ? n + 1 : n), 0);
}
