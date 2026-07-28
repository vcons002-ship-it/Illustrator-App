import { memo, useMemo } from "react";
import type { ScheduledTask } from "@visual-reader/core";

/**
 * Manage scheduled / periodic tasks — recurring actions the assistant runs on a cadence
 * while the app is open. Presentational: the host owns the store + the runner. Create
 * new ones by asking the assistant ("every morning summarise my unread email"); this
 * panel lists them with their cadence + next run, and lets you pause/resume or delete.
 */
export interface ScheduledTasksPanelProps {
  tasks: ScheduledTask[];
  /** Human cadence label per task (host passes describeSchedule). */
  describe: (task: ScheduledTask) => string;
  /** Title per bound task plan (`planId` → title), so an action that maintains a task is shown under
   * it instead of floating in one undifferentiated list. A `planId` missing from this map means the
   * task was deleted — surfaced as such, since that action now has nothing to maintain. */
  taskTitles?: Record<string, string>;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  /** Move an action onto a task (or off one, with `undefined`). Where an action is bound decides
   * WHERE it runs — on its task, it resumes in that task's chat with its history; loose, it starts
   * cold in the shared Scheduled chat. Actions made before binding existed are all loose, and there's
   * no safe way to guess which task they belong to, so this is how they get attached. */
  onBindTask?: (id: string, planId: string | undefined) => void;
  /** Tasks that an action can be bound to (id + title), for the picker. */
  taskOptions?: { id: string; title: string }[];
  onClose: () => void;
}

/** A heading + the actions under it. Task-bound groups come first (alphabetical, so the list is
 * stable as actions are added), standalone actions last. PURE. */
export function groupByTask(
  tasks: ScheduledTask[],
  taskTitles: Record<string, string>,
): {
  key: string;
  label?: string;
  missing?: boolean;
  items: ScheduledTask[];
}[] {
  const bound = new Map<string, ScheduledTask[]>();
  const loose: ScheduledTask[] = [];
  for (const t of tasks) {
    if (!t.planId) loose.push(t);
    else bound.set(t.planId, [...(bound.get(t.planId) ?? []), t]);
  }
  const groups = [...bound.entries()]
    .map(([planId, items]) => ({
      key: planId,
      label: taskTitles[planId] ?? "Task no longer exists",
      missing: !taskTitles[planId],
      items,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return loose.length ? [...groups, { key: "", items: loose }] : groups;
}

export const ScheduledTasksPanel = memo(function ScheduledTasksPanel({
  tasks,
  describe,
  taskTitles = {},
  onToggle,
  onDelete,
  onBindTask,
  taskOptions,
  onClose,
}: ScheduledTasksPanelProps) {
  const groups = useMemo(
    () => groupByTask(tasks, taskTitles),
    [tasks, taskTitles],
  );
  // Headings only earn their space once something IS tied to a task — with none, this is the same
  // flat list it always was.
  const showHeadings = groups.some((g) => g.key !== "");
  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 10,
          }}
        >
          <strong style={{ fontSize: 15 }}>⏰ Scheduled tasks</strong>
          <span style={{ fontSize: 12, opacity: 0.6 }}>· {tasks.length}</span>
          <button style={{ ...btn, marginLeft: "auto" }} onClick={onClose}>
            Close
          </button>
        </div>

        {tasks.length === 0 ? (
          <div style={{ fontSize: 13, opacity: 0.65, padding: "8px 2px" }}>
            No scheduled tasks yet. Ask the assistant something like{" "}
            <em>“every morning summarise my unread email”</em> or
            <em> “every Friday at 4pm give me a market recap”</em> and it’ll
            create one here. They run automatically while the app is open.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {groups.map((g) => (
              <div
                key={g.key || "__loose__"}
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                {showHeadings ? (
                  <div
                    style={{
                      fontSize: 11,
                      opacity: g.missing ? 0.75 : 0.6,
                      marginTop: 4,
                      color: g.missing ? "#ffcf8b" : undefined,
                    }}
                  >
                    {g.key
                      ? `📋 ${g.label}${g.missing ? " — delete these, or they'll keep running" : ""}`
                      : "Not tied to a task"}
                  </div>
                ) : null}
                {g.items.map((t) => (
                  <div
                    key={t.id}
                    style={{ ...card, opacity: t.enabled ? 1 : 0.55 }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                      }}
                    >
                      <strong style={{ fontSize: 13 }}>{t.title}</strong>
                      <span style={{ fontSize: 11, opacity: 0.7 }}>
                        {describe(t)}
                      </span>
                      {t.enabled ? null : (
                        <span style={{ fontSize: 11, color: "#ffcf8b" }}>
                          paused
                        </span>
                      )}
                      <span
                        style={{ marginLeft: "auto", display: "flex", gap: 6 }}
                      >
                        <button
                          style={btn}
                          onClick={() => onToggle(t.id, !t.enabled)}
                        >
                          {t.enabled ? "Pause" : "Resume"}
                        </button>
                        <button
                          style={{ ...btn, color: "#ff9c9c" }}
                          onClick={() => onDelete(t.id)}
                        >
                          Delete
                        </button>
                      </span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                      {t.prompt}
                    </div>
                    {/* WHERE this action runs, on every action, always. Never hidden behind "are there
                        tasks to pick from" — where an action runs is the single thing that decides
                        whether it resumes with a task's history or starts cold, and an invisible
                        control reads as a missing feature. Falls back to plain text when there's
                        nothing to pick, so the detail still shows. */}
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 6,
                        fontSize: 11,
                        opacity: 0.75,
                        marginTop: 5,
                      }}
                    >
                      Runs on:
                      {onBindTask && (taskOptions?.length ?? 0) > 0 ? (
                        <select
                          value={t.planId ?? ""}
                          onChange={(e) =>
                            onBindTask(t.id, e.target.value || undefined)
                          }
                          style={{
                            background: "#1b1b1b",
                            color: "inherit",
                            border: "1px solid #3a3a3a",
                            borderRadius: 5,
                            fontSize: 11,
                            padding: "2px 4px",
                            maxWidth: "100%",
                          }}
                        >
                          <option value="">
                            Nothing — the shared ⏰ Scheduled chat
                          </option>
                          {taskOptions!.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.title}
                            </option>
                          ))}
                          {/* Bound to a task that's since been finished or discarded. The picker only
                              offers ACTIVE tasks, so without this entry the select would fall back to
                              showing "Nothing" — reading as unattached when it isn't, and quietly
                              re-binding on the next change. Shown, labelled, and still selectable so
                              it can be moved off deliberately. */}
                          {t.planId && !taskOptions!.some((o) => o.id === t.planId) ? (
                            <option value={t.planId}>
                              {taskTitles[t.planId] ?? "a task that no longer exists"} (finished — it
                              won't run)
                            </option>
                          ) : null}
                        </select>
                      ) : (
                        <span style={{ opacity: 0.9 }}>
                          {t.planId
                            ? (taskTitles[t.planId] ??
                              "a task that no longer exists")
                            : "the shared ⏰ Scheduled chat"}
                        </span>
                      )}
                    </label>
                    <div style={{ fontSize: 11, opacity: 0.5, marginTop: 3 }}>
                      Next:{" "}
                      {t.enabled
                        ? new Date(t.nextDueIso).toLocaleString()
                        : "—"}
                      {t.lastRunIso
                        ? ` · last ran ${new Date(t.lastRunIso).toLocaleString()}`
                        : ""}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 10 }}>
          Scheduled tasks run while the app is open (there’s no always-on
          server). For phone-side reminders, ask the assistant to also add a
          Google Calendar/Tasks reminder.
        </div>
      </div>
    </div>
  );
});

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(8,9,13,0.7)",
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};
const panel: React.CSSProperties = {
  width: "min(640px, 100%)",
  maxHeight: "88vh",
  overflowY: "auto",
  background: "#16181d",
  color: "#e6e6e6",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 18,
  fontFamily: "system-ui, sans-serif",
};
const card: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "8px 10px",
};
const btn: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "3px 9px",
  fontSize: 12,
  cursor: "pointer",
};
