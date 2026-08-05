import { memo, useMemo, useState } from "react";
import { formatStepLines, weekdayOf, type ScheduledTask } from "@visual-reader/core";

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
   * in its OWN workspace, which is the default now that every action has one. Neither is cold any
   * more — the choice is whose history it resumes with: the task's, or the action's own. Actions made
   * before binding existed are all loose, and there's no safe way to guess which task they belong to,
   * so this is how they get attached. */
  onBindTask?: (id: string, planId: string | undefined) => void;
  /** Change WHEN an action runs. Editing beats delete-and-recreate: a recurring action's last-run
   * time is the window each run is given ("only what's new since then"), so recreating one throws
   * away everything it already handled and the next run re-reports it all. */
  onReschedule?: (id: string, when: { rule?: ScheduledTask["rule"]; time?: string; weekday?: number; dayOfMonth?: number }) => void;
  /** Fire an action now, as WELL as on its schedule — the cadence is computed from the rule, so a
   * Monday action run by hand on a Saturday still comes back round to Monday. Absent → no button. */
  onRunNow?: (id: string) => void;
  /** Change WHAT the action does — its title, the job, and its checklist. The panel could pause,
   * delete, rebind, reschedule and run an action, but never change what it actually did: the only
   * way to fix a wrong instruction was to delete it and describe a new one, which throws away the
   * last-run time every run depends on for "what's new since". Editing keeps all of that. */
  onEdit?: (id: string, patch: { title: string; prompt: string; stepText: string }) => void;
  /** Open this action's OWN workspace — the chat it lives and works in. Kept out of the chat
   * switcher deliberately (it belongs to the action, not to the reader's conversations), so this
   * button is how it is reached: to read what past runs did, or to work in it by hand. Absent → no
   * button, which is what a linked phone gets while the desktop owns the sessions. */
  onOpenWorkspace?: (id: string) => void;
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
  onReschedule,
  onRunNow,
  onOpenWorkspace,
  onEdit,
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
  // Which action's editor is open, and its draft. Held per-open rather than per-task so the form is
  // seeded from the task each time it opens: a draft kept across a run would quietly overwrite a
  // change the task made to ITSELF (update_scheduled_task) with whatever was on screen beforehand.
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState<{ title: string; prompt: string; stepText: string }>({ title: "", prompt: "", stepText: "" });
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
                        {onEdit ? (
                          <button
                            style={btn}
                            onClick={() => {
                              if (editing === t.id) {
                                setEditing(undefined);
                                return;
                              }
                              // Seed from the task AS STORED, every time it opens — see the note on
                              // `draft`. `formatStepLines` is the exact inverse of the parser the
                              // host uses on save, so what is shown round-trips unchanged.
                              setDraft({ title: t.title, prompt: t.prompt, stepText: formatStepLines(t.steps) });
                              setEditing(t.id);
                            }}
                            title="Change what this task does — its job and its checklist"
                          >
                            {editing === t.id ? "Cancel" : "✎ Edit"}
                          </button>
                        ) : null}
                        {onOpenWorkspace ? (
                          <button
                            style={btn}
                            onClick={() => onOpenWorkspace(t.id)}
                            title="Open this task's own workspace — see what its runs did, or work in it yourself"
                          >
                            ⌸ Open
                          </button>
                        ) : null}
                        {onRunNow && t.enabled ? (
                          <button
                            style={btn}
                            onClick={() => onRunNow(t.id)}
                            title="Run this now, as well as on its schedule"
                          >
                            ▶ Run now
                          </button>
                        ) : null}
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
                    {/* The CHECKLIST, shown always — not just while editing. An action that quietly
                        does four things looked identical to one that does one, which is how a job
                        could go on missing a step without anyone being able to see that the step was
                        never there. A stepless action shows nothing, because it genuinely has none. */}
                    {t.steps?.length && editing !== t.id ? (
                      <ol style={{ fontSize: 11, opacity: 0.7, margin: "4px 0 0", paddingLeft: 20 }}>
                        {t.steps.map((st, i) => (
                          <li key={i}>
                            {st.do}
                            {st.needs ? <span style={{ opacity: 0.6 }}> · {st.needs}</span> : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {onEdit && editing === t.id ? (
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                        <input
                          style={inputStyle}
                          value={draft.title}
                          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                          placeholder="Title"
                          aria-label="Task title"
                        />
                        <textarea
                          style={{ ...inputStyle, minHeight: 48, resize: "vertical" }}
                          value={draft.prompt}
                          onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
                          placeholder="What the job is, as a whole"
                          aria-label="What the job is"
                        />
                        <textarea
                          style={{ ...inputStyle, minHeight: 72, resize: "vertical", fontFamily: "ui-monospace, monospace" }}
                          value={draft.stepText}
                          onChange={(e) => setDraft((d) => ({ ...d, stepText: e.target.value }))}
                          placeholder={"One step per line, e.g.\nResearch the venue options\nAdd the shortlist to my calendar | create_event"}
                          aria-label="Checklist, one step per line"
                        />
                        <span style={{ fontSize: 10, opacity: 0.55 }}>
                          One step per line, in order. Add <code>| needs</code> after a step to say what proves it done
                          (<code>text</code>, <code>file</code>, <code>image</code>, or a tool name). Include the step that
                          RECORDS the result — the calendar event, the saved note — it's the one that gets left out.
                          Leave this empty to run the job as a single instruction.
                        </span>
                        <span style={{ display: "flex", gap: 6 }}>
                          <button
                            style={btn}
                            onClick={() => {
                              onEdit(t.id, draft);
                              setEditing(undefined);
                            }}
                          >
                            Save
                          </button>
                          <span style={{ fontSize: 10, opacity: 0.55, alignSelf: "center" }}>
                            Its schedule, workspace and run history are kept.
                          </span>
                        </span>
                      </div>
                    ) : null}
                    {/* WHERE this action runs, on every action, always. Never hidden behind "are there
                        tasks to pick from" — where an action runs is the single thing that decides
                        whether it resumes with the TASK's history or its own workspace's, and an
                        invisible control reads as a missing feature. Falls back to plain text when there's
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
                            Nothing — its own workspace
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
                            : "its own workspace"}
                        </span>
                      )}
                    </label>
                    {onReschedule ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, opacity: 0.5 }}>Runs</span>
                        <select
                          value={t.rule}
                          onChange={(e) => onReschedule(t.id, { rule: e.target.value as ScheduledTask["rule"] })}
                          style={editStyle}
                        >
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                          <option value="monthly">Monthly</option>
                          <option value="once">Once</option>
                        </select>
                        {t.rule === "weekly" ? (
                          <select
                            value={String(weekdayOf(t) ?? 1)}
                            onChange={(e) => onReschedule(t.id, { weekday: Number(e.target.value) })}
                            style={editStyle}
                          >
                            {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => (
                              <option key={d} value={String(i)}>
                                {d}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {t.rule === "monthly" ? (
                          <select
                            value={String(t.dayOfMonth ?? 1)}
                            onChange={(e) => onReschedule(t.id, { dayOfMonth: Number(e.target.value) })}
                            style={editStyle}
                          >
                            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                              <option key={d} value={String(d)}>
                                day {d}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <input
                          type="time"
                          value={t.time}
                          onChange={(e) => onReschedule(t.id, { time: e.target.value })}
                          style={editStyle}
                          aria-label="Time of day"
                        />
                      </div>
                    ) : null}
                    <div style={{ fontSize: 11, opacity: 0.5, marginTop: 3 }}>
                      Next:{" "}
                      {t.enabled
                        ? new Date(t.nextDueIso).toLocaleString()
                        : "—"}
                      {t.lastRunIso
                        ? ` · last ran ${new Date(t.lastRunIso).toLocaleString()}${t.lastRunNote ? ` — ${t.lastRunNote}` : ""}`
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

/** The inline cadence editors — small, so a row of them doesn't dominate the action it belongs to. */
const editStyle: React.CSSProperties = {
  fontSize: 11,
  background: "#1e2128",
  color: "#e6e6e6",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 5,
  padding: "2px 4px",
};

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
/** The edit form's fields — same surface as the buttons beside them, sized to be typed into. */
const inputStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.25)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 12,
  width: "100%",
  boxSizing: "border-box",
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
