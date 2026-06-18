import { memo, useMemo, useState } from "react";
import { dayToIso, ganttRowRef, needsPlanning, plansToGanttRows, type TaskPlan, type TaskStep } from "@visual-reader/core";
import { GanttChart } from "./GanttChart.js";

/**
 * The Task Orchestrator's panel — the durable plans the assistant built, shown two ways:
 * a **Timeline** (a Gantt of every task and its sub-tasks on one calendar, the headline
 * view) and a **List** of detail cards. You add a task with a due date and the assistant
 * researches it and lays the steps out across the timeline; click a task to open its detail,
 * tick a step right on the Gantt to complete it, or open it in chat to work it. Pure
 * presentation (create/open/advance/delete injected); plans are the same store the worker reads.
 */
export interface TasksPanelProps {
  plans: TaskPlan[];
  /** How many inbox-found tasks are being auto-planned right now (a notice). */
  planning?: number;
  /** A user-entered task is being researched + planned right now (the AI builds its Gantt). */
  creatingTask?: boolean;
  /** Open a plan to work it in a preloaded chat session. */
  onOpenTask: (planId: string) => void;
  /** Mark the current step done and advance the plan (best-effort Google write-back). */
  onAdvanceStep: (planId: string, stepId: string) => Promise<void> | void;
  /** Toggle ONE specific step done/undone — the timeline checkbox + detail ticks. */
  onToggleStepDone: (planId: string, stepId: string, done: boolean) => Promise<void> | void;
  /** Add a task with an optional due date; the assistant plans it into dated sub-tasks. */
  onCreateTask: (title: string, dueIso?: string) => void;
  /** Plan (or re-plan) ONE task now — research it + fill its sub-tasks. */
  onPlanTask: (planId: string) => void;
  /** On-demand: scan email + calendar for tasks now (and refresh the calendar). Shown when present. */
  onScanNow?: () => void;
  /** An on-demand scan is running right now (the button shows a spinner + disables). */
  scanning?: boolean;
  /** The last scan's outcome (count found/imported/synced, or an error) — shown under the button. */
  scanMessage?: string;
  /** "Don't surface this again" — add an ignore rule (the item, else its sender, else its title)
   * so future scans skip it, and delete the plan. Shown on auto-surfaced (scan/email/calendar) tasks. */
  onIgnoreTask?: (planId: string) => void;
  /** Soft-remove a task (archives it to the undoable "Removed" list). */
  onDelete: (planId: string) => Promise<void> | void;
  /** Restore a removed/ignored task back to active (undo). */
  onRestore?: (planId: string) => void;
  /** Permanently delete a task from the Removed list. */
  onDeleteForever?: (planId: string) => void;
  onClose: () => void;
}

function statusDot(status: TaskStep["status"]): string {
  return status === "done" ? "✓" : status === "ready" ? "▶" : status === "blocked" ? "⛔" : status === "in_progress" ? "…" : "○";
}

function PlanCard({
  plan,
  detailed = false,
  onOpen,
  onPlan,
  onAdvance,
  onToggleStep,
  onIgnoreTask,
  onDelete,
}: {
  plan: TaskPlan;
  /** The single-task detail view — show the captured work (step details, research, drafts) in full. */
  detailed?: boolean;
  onOpen: () => void;
  onPlan: () => void;
  onAdvance: (stepId: string) => void;
  onToggleStep: (stepId: string, done: boolean) => void;
  onIgnoreTask?: () => void;
  onDelete: () => void;
}) {
  const doneCount = plan.steps.filter((s) => s.status === "done").length;
  const current = plan.steps.find((s) => s.status === "ready") ?? plan.steps.find((s) => s.status !== "done");
  const noSteps = plan.steps.length === 0; // a simple to-do or a scan stub — no step-by-step plan yet
  const autoPlanning = needsPlanning(plan); // a scan stub the background sweep will plan on its own
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{plan.title}</strong>
        {plan.deadlineIso ? <span style={{ fontSize: 11, color: "#ffcf8b" }}>due {plan.deadlineIso}</span> : null}
        {noSteps ? <span style={{ fontSize: 10, padding: "0 5px", borderRadius: 4, background: "rgba(255,207,139,0.2)", color: "#ffcf8b" }}>no plan yet</span> : null}
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
          {noSteps ? "no steps" : `${doneCount}/${plan.steps.length} done${plan.status === "completed" ? " · complete" : ""}`}
        </span>
      </div>
      {plan.summary ? <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>{plan.summary}</div> : null}
      {noSteps ? (
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          {autoPlanning
            ? "Surfaced from your inbox/calendar — it'll be broken into steps automatically on the next background sweep, or hit ⚡ Plan now."
            : "A simple to-do. Hit ⚡ Plan it to research it and break it into a step-by-step plan (with your files, the web, etc.)."}
        </div>
      ) : null}
      {plan.clarifyingQuestions?.length ? (
        <div style={questionsBox}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>❔ Needs your input to finalize:</div>
          <ul style={{ margin: "0 0 0 1.1em", padding: 0 }}>
            {plan.clarifyingQuestions.map((q, i) => (
              <li key={i} style={{ margin: "1px 0" }}>
                {q}
              </li>
            ))}
          </ul>
          <div style={{ opacity: 0.7, marginTop: 2 }}>Open &amp; work it to answer — the assistant refines the plan.</div>
        </div>
      ) : null}
      <ol style={{ margin: "8px 0 0", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
        {plan.steps.map((s) => {
          const ready = s.status === "ready";
          return (
            <li
              key={s.id}
              style={{
                fontSize: 12,
                padding: "4px 8px",
                borderRadius: 6,
                background: ready ? "rgba(122,162,255,0.14)" : "transparent",
                border: ready ? "1px solid rgba(122,162,255,0.4)" : "1px solid transparent",
                opacity: s.status === "done" ? 0.55 : 1,
              }}
            >
              <button
                onClick={() => onToggleStep(s.id, s.status !== "done")}
                title={s.status === "done" ? "Mark not done" : "Mark done"}
                style={checkBtn}
              >
                {statusDot(s.status)}
              </button>
              <span style={{ textDecoration: s.status === "done" ? "line-through" : "none" }}>{s.title}</span>
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  padding: "0 5px",
                  borderRadius: 4,
                  background: s.actor === "ai_prep" ? "rgba(90,209,155,0.2)" : "rgba(255,255,255,0.08)",
                }}
              >
                {s.actor === "ai_prep" ? "AI preps" : "you do"}
              </span>
              {s.dueIso ? <span style={{ opacity: 0.5 }}> · {s.dueIso}</span> : null}
              {s.docs.length ? <span style={{ opacity: 0.5 }}> · 📄{s.docs.length}</span> : null}
              {s.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer" style={{ color: "#9db8ff", marginLeft: 6 }}>
                  {l.official ? "official ↗" : "link ↗"}
                </a>
              ))}
              {/* The actual work: what to do for this step + (in the detail view) any research note. */}
              {s.detail ? <div style={{ marginLeft: 26, opacity: 0.75, marginTop: 1 }}>{s.detail}</div> : null}
              {detailed && s.researchNotes ? (
                <div style={{ marginLeft: 26, marginTop: 2, fontSize: 11, opacity: 0.6, whiteSpace: "pre-wrap" }}>🔬 {s.researchNotes}</div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {/* The work the planner captured — research it gathered and any documents it drafted — shown
          here so you can read it WITHOUT opening the task in chat. */}
      {detailed && plan.researchNotes ? (
        <details style={workBox}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>🔬 Research notes</summary>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 4, opacity: 0.85 }}>{plan.researchNotes}</div>
        </details>
      ) : null}
      {detailed
        ? plan.steps.flatMap((s) => s.docs.map((d) => ({ step: s.title, doc: d }))).map(({ step, doc }, i) => (
            <details key={`${doc.title}-${i}`} style={workBox}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                📄 {doc.title} <span style={{ opacity: 0.5, fontWeight: 400 }}>· {doc.kind} · for “{step}”</span>
              </summary>
              <pre style={draftPre}>{doc.body}</pre>
            </details>
          ))
        : null}
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        <button style={noSteps ? btnPrimary : btn} onClick={onPlan} title={noSteps ? "Research it and break it into steps" : "Re-plan from scratch"}>
          {noSteps ? "⚡ Plan it" : "↻ Refresh plan"}
        </button>
        <button style={btnPrimary} onClick={onOpen}>
          Open &amp; work it →
        </button>
        {current ? (
          <button style={btn} onClick={() => onAdvance(current.id)} title={`Mark "${current.title}" done`}>
            ✓ Mark step done
          </button>
        ) : null}
        {onIgnoreTask && (plan.source.kind === "scan" || plan.source.kind === "email" || plan.source.kind === "calendar") ? (
          <button style={btn} onClick={onIgnoreTask} title="Don't surface this again — also tells future scans/imports to skip it. Undo from the Removed list.">
            🚫 Ignore
          </button>
        ) : null}
        <button style={btn} onClick={onDelete} title="Remove this task (kept in the Removed list — you can undo)">
          ✕ Remove
        </button>
      </div>
    </div>
  );
}

export const TasksPanel = memo(function TasksPanel({
  plans,
  planning = 0,
  creatingTask = false,
  onOpenTask,
  onAdvanceStep,
  onToggleStepDone,
  onCreateTask,
  onPlanTask,
  onScanNow,
  scanning = false,
  scanMessage,
  onIgnoreTask,
  onDelete,
  onRestore,
  onDeleteForever,
  onClose,
}: TasksPanelProps) {
  const active = useMemo(
    () => plans.filter((p) => p.status !== "archived").sort((a, b) => b.updatedAt - a.updatedAt),
    [plans],
  );
  // Removed/ignored tasks — the undoable trash, newest first.
  const removed = useMemo(
    () => plans.filter((p) => p.status === "archived").sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt)),
    [plans],
  );
  const [showRemoved, setShowRemoved] = useState(false);
  const [view, setView] = useState<"timeline" | "list">("timeline");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  // Which parent tasks are expanded to show their sub-tasks inline in the all-tasks Gantt.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");

  const selected = active.find((p) => p.id === selectedId);
  // All-tasks Gantt: a parent bar per task, expanded ones revealing their sub-task bars inline.
  const rows = useMemo(() => plansToGanttRows(active, { expandedPlanIds: expanded }), [active, expanded]);
  // Individual-task Gantt: just the selected task with all its sub-tasks shown.
  const selectedRows = useMemo(() => (selected ? plansToGanttRows([selected], { expandedPlanIds: "all" }) : []), [selected]);
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandAll = () => setExpanded(new Set(active.map((p) => p.id)));
  const collapseAll = () => setExpanded(new Set());

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onCreateTask(t, due || undefined);
    setTitle("");
    setDue("");
    setAdding(false);
  };

  const cardFor = (p: TaskPlan, detailed = false) => (
    <PlanCard
      key={p.id}
      plan={p}
      detailed={detailed}
      onOpen={() => onOpenTask(p.id)}
      onPlan={() => onPlanTask(p.id)}
      onAdvance={(stepId) => void onAdvanceStep(p.id, stepId)}
      onToggleStep={(stepId, done) => void onToggleStepDone(p.id, stepId, done)}
      {...(onIgnoreTask ? { onIgnoreTask: () => onIgnoreTask(p.id) } : {})}
      onDelete={() => void onDelete(p.id)}
    />
  );

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <strong>📋 Tasks — your to-do timeline</strong>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {(["timeline", "list"] as const).map((v) => (
              <button
                key={v}
                onClick={() => {
                  setView(v);
                  setSelectedId(undefined);
                }}
                style={view === v ? toggleOn : toggleOff}
              >
                {v === "timeline" ? "📊 Timeline" : "☰ List"}
              </button>
            ))}
            <button style={btn} onClick={onClose}>
              Close
            </button>
          </span>
        </div>

        {/* Add a task → the assistant plans it into a Gantt. */}
        {adding ? (
          <div style={addBox}>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="What do you need to get done? e.g. renew my passport"
              style={addInput}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.85 }}>
              Due
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} style={dateInput} />
            </label>
            <button style={btnPrimary} onClick={submit} disabled={!title.trim()}>
              Plan it →
            </button>
            <button style={btn} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <button style={btnPrimary} onClick={() => setAdding(true)}>
              + Add task
            </button>
            {onScanNow ? (
              <button style={btn} onClick={onScanNow} disabled={scanning} title="Scan recent email + your calendar for tasks now">
                {scanning ? "🔄 Scanning…" : "🔄 Scan email & calendar"}
              </button>
            ) : null}
            <span style={{ fontSize: 12, opacity: 0.65 }}>
              The assistant researches it and lays the steps out on your timeline.
            </span>
          </div>
        )}

        {scanMessage && (
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8, color: scanMessage.startsWith("⚠") ? "#ff9b9b" : "#9be8c0" }}>
            {scanMessage}
          </div>
        )}

        {creatingTask && (
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>🔄 Researching &amp; building your Gantt…</div>
        )}
        {planning > 0 && (
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            🔄 Auto-planning {planning} task{planning === 1 ? "" : "s"} found in your inbox/calendar…
          </div>
        )}

        {active.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 13, padding: "16px 0" }}>
            No tasks yet. Click <strong>+ Add task</strong> (with a due date) and the assistant will plan it — or in chat
            say “plan my car registration renewal”.
          </div>
        ) : selected ? (
          // Individual task view — the one task's sub-tasks on their own Gantt + the detail card.
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button style={btn} onClick={() => setSelectedId(undefined)}>
              ← Back to all tasks
            </button>
            {view === "timeline" ? (
              <div style={{ overflowX: "auto" }}>
                <GanttChart
                  rows={selectedRows}
                  title={selected.title}
                  tickLabel={(u) => dayToIso(u).slice(5)}
                  width={620}
                  onToggleDone={(id, done) => {
                    const { planId, stepId } = ganttRowRef(id);
                    if (stepId) void onToggleStepDone(planId, stepId, done);
                  }}
                />
              </div>
            ) : null}
            {cardFor(selected, true)}
          </div>
        ) : view === "timeline" ? (
          <div>
            <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              <button style={btn} onClick={expandAll} title="Show every task's sub-tasks">
                ▾ Expand all
              </button>
              <button style={btn} onClick={collapseAll} title="Show only the main tasks">
                ▸ Collapse all
              </button>
            </div>
            <div style={{ overflowX: "auto" }}>
              <GanttChart
                rows={rows}
                tickLabel={(u) => dayToIso(u).slice(5)}
                width={620}
                onRowClick={(id) => setSelectedId(ganttRowRef(id).planId)}
                onToggleExpand={toggleExpand}
                onToggleDone={(id, done) => {
                  const { planId, stepId } = ganttRowRef(id);
                  if (stepId) void onToggleStepDone(planId, stepId, done);
                }}
              />
            </div>
            <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>
              ▸ expand a task to show its sub-tasks · click a task to open it · tick a sub-task to complete it.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{active.map((p) => cardFor(p))}</div>
        )}

        {/* Removed/ignored tasks — the undoable trash. Restore brings one back (and un-ignores it);
            Delete forever drops it for good. */}
        {removed.length > 0 ? (
          <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 8 }}>
            <button style={{ ...btn, fontSize: 12 }} onClick={() => setShowRemoved((v) => !v)}>
              🗑 Removed ({removed.length}) {showRemoved ? "▾" : "▸"}
            </button>
            {showRemoved ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                {removed.map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, opacity: 0.85 }}>
                    <span style={{ flex: 1 }}>
                      {p.archivedReason === "ignored" ? "🚫 " : "✕ "}
                      {p.title}
                      <span style={{ opacity: 0.5 }}> · {p.archivedReason === "ignored" ? "ignored" : "removed"}</span>
                    </span>
                    {onRestore ? (
                      <button style={btn} onClick={() => onRestore(p.id)} title="Bring this task back (and un-ignore it)">
                        ↩ Restore
                      </button>
                    ) : null}
                    {onDeleteForever ? (
                      <button style={btn} onClick={() => onDeleteForever(p.id)} title="Delete permanently (cannot undo)">
                        Delete forever
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
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
  width: "min(680px, 100%)",
  maxHeight: "92vh",
  overflowY: "auto",
  background: "#16181d",
  color: "#e6e6e6",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 18,
  fontFamily: "system-ui, sans-serif",
};
const card: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "10px 12px",
};
const btn: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "rgba(122,162,255,0.25)",
  border: "1px solid rgba(122,162,255,0.6)",
};
const toggleOff: React.CSSProperties = { ...btn, padding: "4px 8px" };
const toggleOn: React.CSSProperties = { ...btnPrimary, padding: "4px 8px" };
const questionsBox: React.CSSProperties = {
  marginTop: 6,
  padding: "6px 8px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid rgba(255,207,139,0.4)",
  background: "rgba(255,207,139,0.08)",
};
const workBox: React.CSSProperties = {
  marginTop: 6,
  padding: "6px 8px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.03)",
};
const draftPre: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  margin: "6px 0 0",
  maxHeight: 280,
  overflow: "auto",
  fontSize: 11,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  opacity: 0.9,
};
const checkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
  marginRight: 6,
  opacity: 0.75,
};
const addBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginBottom: 8,
  padding: 10,
  border: "1px solid rgba(122,162,255,0.4)",
  background: "rgba(122,162,255,0.06)",
  borderRadius: 8,
};
const addInput: React.CSSProperties = {
  flex: 1,
  minWidth: 220,
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
};
const dateInput: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  padding: "5px 6px",
  fontSize: 12,
  colorScheme: "dark",
};
