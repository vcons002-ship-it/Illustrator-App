import { useCallback, useEffect, useState } from "react";
import { pruneActivities, type Activity, type ActivityStatus } from "@visual-reader/core";

/** Handle to one logged operation — flip it active/done/error or update its label as it runs. */
export interface ActivityHandle {
  id: string;
  /** Move a queued item to active (it's now the thing being worked on). */
  activate: (label?: string) => void;
  /** Mark it finished; an `error` detail flags it red. Auto-prunes after a few seconds. */
  finish: (opts?: { status?: Extract<ActivityStatus, "done" | "error">; detail?: string }) => void;
  /** Update the live label/detail (e.g. a percentage) without changing status. */
  update: (patch: { label?: string; detail?: string }) => void;
}

export interface ActivityLog {
  activities: Activity[];
  /** Start an operation (active by default; pass "queued" for a not-yet-running queue item). */
  begin: (label: string, status?: ActivityStatus) => ActivityHandle;
}

let activitySeq = 0;

/**
 * App-wide activity log — the source of truth for the "what's it doing" status center. Holding it
 * at the app root (not inside any panel) is deliberate: background work like task planning keeps
 * running after you close the Tasks window, and this keeps it visible the whole time. Finished
 * items linger briefly (so a quick action still registers) then prune themselves.
 */
export function useActivityLog(): ActivityLog {
  const [activities, setActivities] = useState<Activity[]>([]);
  // Sweep expired (finished) items on a light timer whenever anything is showing.
  const hasItems = activities.length > 0;
  useEffect(() => {
    if (!hasItems) return;
    const t = setInterval(() => setActivities((prev) => pruneActivities(prev, Date.now())), 2000);
    return () => clearInterval(t);
  }, [hasItems]);

  const patch = useCallback((id: string, fn: (a: Activity) => Activity) => {
    setActivities((prev) => prev.map((a) => (a.id === id ? fn(a) : a)));
  }, []);

  const begin = useCallback(
    (label: string, status: ActivityStatus = "active"): ActivityHandle => {
      const id = `act-${Date.now().toString(36)}-${activitySeq++}`;
      setActivities((prev) => [...prev, { id, label, status, startedAt: Date.now() }]);
      return {
        id,
        activate: (newLabel) => patch(id, (a) => ({ ...a, status: "active", ...(newLabel ? { label: newLabel } : {}) })),
        finish: (opts) =>
          patch(id, (a) => ({ ...a, status: opts?.status ?? "done", endedAt: Date.now(), ...(opts?.detail ? { detail: opts.detail } : {}) })),
        update: (p) => patch(id, (a) => ({ ...a, ...(p.label ? { label: p.label } : {}), ...(p.detail !== undefined ? { detail: p.detail } : {}) })),
      };
    },
    [patch],
  );

  return { activities, begin };
}
