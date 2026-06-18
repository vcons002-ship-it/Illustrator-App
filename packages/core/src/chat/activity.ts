/**
 * ACTIVITY LOG — the data behind the app's "what's it doing right now" status center: a small,
 * ordered queue of background operations (searching email, planning a task, creating a task…),
 * each with a live status. The app shows it app-wide so long-running work (especially the task
 * planner, which keeps going after you leave the Tasks window) is never invisible. This module is
 * the PURE core: the shape, a stable ordering (what's active, then what's queued, then what just
 * finished), and a one-line summary for the header pill. The React store on top is in the app.
 */

export type ActivityStatus = "active" | "queued" | "done" | "error";

export interface Activity {
  id: string;
  /** A short human label, e.g. "Searching email & calendar" or "Planning: Flight to Iowa". */
  label: string;
  status: ActivityStatus;
  /** Optional extra line, e.g. "found 2 items" or an error message. */
  detail?: string;
  startedAt: number;
  endedAt?: number;
}

const rank = (s: ActivityStatus): number => (s === "active" ? 0 : s === "queued" ? 1 : 2);

/**
 * Stable display order: ACTIVE first, then QUEUED (FIFO — oldest first, so the queue reads like a
 * to-do list), then finished (DONE/ERROR, most-recent first). Pure.
 */
export function orderActivities(list: readonly Activity[]): Activity[] {
  return [...list].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    // Finished items: newest first. In-flight (active/queued): oldest first (queue order).
    if (a.status === "done" || a.status === "error") return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
    return a.startedAt - b.startedAt;
  });
}

/** A one-line summary for the header pill: the lead in-flight label + how many more are waiting. */
export function activitySummary(list: readonly Activity[]): {
  busy: boolean;
  text: string;
  activeCount: number;
  queuedCount: number;
} {
  const active = list.filter((a) => a.status === "active");
  const queued = list.filter((a) => a.status === "queued");
  if (active.length === 0 && queued.length === 0) return { busy: false, text: "Idle", activeCount: 0, queuedCount: 0 };
  const head = active[0]?.label ?? queued[0]?.label ?? "Working";
  const extra = active.length + queued.length - 1;
  return {
    busy: true,
    text: extra > 0 ? `${head} (+${extra} more)` : head,
    activeCount: active.length,
    queuedCount: queued.length,
  };
}

/** Drop finished (done/error) items older than `ttlMs`, keeping in-flight ones forever. Pure. */
export function pruneActivities(list: readonly Activity[], now: number, ttlMs = 8000): Activity[] {
  return list.filter((a) => a.status === "active" || a.status === "queued" || now - (a.endedAt ?? a.startedAt) < ttlMs);
}
