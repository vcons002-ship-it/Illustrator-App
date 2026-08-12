import { cx } from "./design/classes.js";
import { t } from "./design/tokens.js";
import { memo, useMemo, useState } from "react";
import { dayToIso, isoDay, describeRecurrence, ganttRowRef, needsAttention, needsPlanning, plansToGanttRows, sourceTag, type TaskPlan, type TaskRecurrence, type TaskStep } from "@visual-reader/core";
import { GanttChart } from "./GanttChart.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { ModalShell } from "./ModalShell.js";

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
  /** Mark a WHOLE task complete (true) or reopen it (false) — the per-card "✓ Complete task" button.
   * Works for a plain to-do with no steps as well as a multi-step plan. */
  onCompleteTask: (planId: string, complete: boolean) => Promise<void> | void;
  /** Add a task with an optional due date + repeat rule. `planNow` true → the assistant plans it
   * into dated sub-tasks; false → add a plain stub (no planning) the user can plan later. */
  onCreateTask: (title: string, dueIso?: string, recurrence?: TaskRecurrence, planNow?: boolean) => void;
  /** Plan (or re-plan) ONE task now — research it + fill its sub-tasks. */
  onPlanTask: (planId: string) => void;
  /** On-demand: scan email + calendar for tasks now (and refresh the calendar). Shown when present. */
  onScanNow?: () => void;
  /** An on-demand scan is running right now (the button shows a spinner + disables). */
  scanning?: boolean;
  /** Plan EVERY unplanned stub now (the same agentic planning the background sweep runs) + mirror to
   * Google Tasks — a manual way to run/verify the backlog planner without waiting for the idle sweep. */
  onPlanPending?: () => void;
  /** A plan is running right now (the button shows a spinner + disables). */
  planningPending?: boolean;
  /** The last scan's outcome (count found/imported/synced, or an error) — shown under the button. */
  scanMessage?: string;
  /** The last per-task plan's outcome (steps planned, or the actual error) — shown under the button. */
  planMessage?: string;
  /** "Don't surface this again" — add an ignore rule (the item, else its sender, else its title)
   * so future scans skip it, and delete the plan. Shown on auto-surfaced (scan/email/calendar) tasks. */
  onIgnoreTask?: (planId: string) => void;
  /** Add details/answers to a task — stored + re-planned with at the next background sweep. */
  onAddTaskDetails?: (planId: string, text: string) => void;
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

/** One step's row — the same renderer for the live list and the folded-away Done section, so a
 *  finished step keeps its tick (and can be un-ticked) instead of becoming a dead line of text. */
function StepRow({
  step: s,
  detailed,
  onToggleStep,
}: {
  step: TaskStep;
  detailed: boolean;
  onToggleStep: (stepId: string, done: boolean) => void;
}) {
  const ready = s.status === "ready";
  return (
    <li
      style={{
        fontSize: 12,
        padding: "4px 8px",
        borderRadius: 6,
        background: ready ? t.accent.fill : "transparent",
        border: ready ? `1px solid ${t.accent.edge}` : "1px solid transparent",
        opacity: s.status === "done" ? 0.55 : 1,
      }}
    >
      <button className={cx.btn} onClick={() => onToggleStep(s.id, s.status !== "done")} title={s.status === "done" ? "Mark not done" : "Mark done"} style={checkBtn}>
        {statusDot(s.status)}
      </button>
      <span style={{ textDecoration: s.status === "done" ? "line-through" : "none" }}>{s.title}</span>
      <span
        style={{
          marginLeft: 6,
          fontSize: 10,
          padding: "0 5px",
          borderRadius: 4,
          background: s.actor === "ai_prep" ? t.state.good : t.fill.base,
        }}
      >
        {s.actor === "ai_prep" ? "AI preps" : "you do"}
      </span>
      {s.dueIso ? <span style={{ opacity: 0.5 }}> · {s.dueIso}</span> : null}
      {/* WHEN it was finished — on a task worked across weeks, "done" with no date reads as though
          it all happened at once, and there's no telling this morning's work from last month's. */}
      {s.doneAt ? <span style={{ opacity: 0.5 }}> · done {isoDay(new Date(s.doneAt))}</span> : null}
      {s.docs.length ? <span style={{ opacity: 0.5 }}> · 📄{s.docs.length}</span> : null}
      {s.links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer" style={{ color: t.accent.text, marginLeft: 6 }}>
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
}

function PlanCard({
  plan,
  detailed = false,
  onOpen,
  onPlan,
  onAdvance,
  onToggleStep,
  onComplete,
  onIgnoreTask,
  onDelete,
  onAddDetails,
}: {
  plan: TaskPlan;
  /** The single-task detail view — show the captured work (step details, research, drafts) in full. */
  detailed?: boolean;
  onOpen: () => void;
  onPlan: () => void;
  onAdvance: (stepId: string) => void;
  onToggleStep: (stepId: string, done: boolean) => void;
  /** Mark the whole task complete (true) or reopen it (false). */
  onComplete: (complete: boolean) => void;
  onIgnoreTask?: () => void;
  onDelete: () => void;
  /** Add details/answers — stored on the task and re-planned with at the next sweep. */
  onAddDetails?: (text: string) => void;
}) {
  const [detailDraft, setDetailDraft] = useState("");
  const doneSteps = plan.steps.filter((s) => s.status === "done");
  const outstanding = plan.steps.filter((s) => s.status !== "done");
  const doneCount = doneSteps.length;
  const current = plan.steps.find((s) => s.status === "ready") ?? plan.steps.find((s) => s.status !== "done");
  const noSteps = plan.steps.length === 0; // a simple to-do or a scan stub — no step-by-step plan yet
  const autoPlanning = needsPlanning(plan); // a scan stub the background sweep will plan on its own
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={sourceTagStyle(plan.source ? sourceTag(plan.source) : "VR")}>{plan.source ? sourceTag(plan.source) : "VR"}</span>
        <strong style={{ fontSize: 14 }}>{plan.title}</strong>
        {plan.deadlineIso ? <span style={{ fontSize: 11, color: t.state.warn }}>due {plan.deadlineIso}</span> : null}
        {plan.recurrence ? (
          <span style={{ fontSize: 10, padding: "0 5px", borderRadius: 4, background: t.accent.fill, color: t.accent.text }}>
            🔁 {describeRecurrence(plan.recurrence)}
          </span>
        ) : null}
        {noSteps ? <span style={{ fontSize: 10, padding: "0 5px", borderRadius: 4, background: "rgba(255,207,139,0.2)", color: t.state.warn }}>no plan yet</span> : null}
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
          <div style={{ opacity: 0.7, marginTop: 2 }}>Answer below (or in the Google Task notes) — the assistant re-attacks the plan with it.</div>
        </div>
      ) : null}
      {onAddDetails && !noSteps ? (
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input className={cx.input}
            value={detailDraft}
            onChange={(e) => setDetailDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && detailDraft.trim()) {
                onAddDetails(detailDraft.trim());
                setDetailDraft("");
              }
            }}
            placeholder={plan.clarifyingQuestions?.length ? "Answer / add details — refines the plan" : "Add a detail or new info — refines the plan"}
            style={{ flex: 1, fontSize: 12, padding: "4px 8px`, borderRadius: 6, border: `1px solid ${t.fill.strong}`, background: t.fill.subtle, color: `inherit" }}
          />
          <button className={cx.btn}
            style={{ ...btn, fontSize: 12 }}
            disabled={!detailDraft.trim()}
            onClick={() => {
              onAddDetails(detailDraft.trim());
              setDetailDraft("");
            }}
            title="Save these details — the planner re-attacks the task with them at the next sweep"
          >
            ➕ Add
          </button>
        </div>
      ) : null}
      {/* OUTSTANDING work only. Finished steps fold away below — on a task worked over weeks the
          done ones outnumber the live ones and push what's actually next off the bottom, which is
          the opposite of what a plan is for. They're one click away, never deleted. */}
      <ol style={{ margin: "8px 0 0", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
        {outstanding.map((s) => (
          <StepRow key={s.id} step={s} detailed={detailed} onToggleStep={onToggleStep} />
        ))}
      </ol>
      {doneSteps.length ? (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.7 }}>
            ✓ Done ({doneSteps.length}) {outstanding.length === 0 ? "— everything on this task" : ""}
          </summary>
          <ol style={{ margin: "4px 0 0", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
            {doneSteps.map((s) => (
              <StepRow key={s.id} step={s} detailed={detailed} onToggleStep={onToggleStep} />
            ))}
          </ol>
        </details>
      ) : null}
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
        <button className={cx.btn} style={noSteps ? btnPrimary : btn} onClick={onPlan} title={noSteps ? "Research it and break it into steps" : "Re-plan from scratch"}>
          {noSteps ? "⚡ Plan it" : "↻ Refresh plan"}
        </button>
        <button className={cx.btn} style={btnPrimary} onClick={onOpen}>
          Open &amp; work it →
        </button>
        {current ? (
          <button className={cx.btn} style={btn} onClick={() => onAdvance(current.id)} title={`Mark "${current.title}" done`}>
            ✓ Mark step done
          </button>
        ) : null}
        {plan.status === "completed" ? (
          <button className={cx.btn} style={btn} onClick={() => onComplete(false)} title="Reopen this task — mark it not done">
            ↺ Reopen
          </button>
        ) : (
          <button className={cx.btn} style={btnPrimary} onClick={() => onComplete(true)} title="Mark this whole task complete">
            ✓ Complete task
          </button>
        )}
        {onIgnoreTask ? (
          <button className={cx.btn}
            style={btn}
            onClick={onIgnoreTask}
            title="Ignore this task — archives it and stops it coming back (a recurring task won't repeat; scans/imports skip it). Undo from the Removed list."
          >
            🚫 Ignore
          </button>
        ) : null}
        {/* Confirmed HERE, on the screen the reader is actually looking at. This used to be confirmed
            on the desktop with `window.confirm` — which a phone can neither see nor answer, and which
            froze the phone outright while it was up (see ConfirmButton). */}
        <ConfirmButton
          style={btn}
          label="✕ Remove"
          confirmLabel="Remove — sure?"
          title="Remove this task (kept in the Removed list — you can undo)"
          confirmTitle="Press again to remove it (you can restore it from the Removed list)"
          onConfirm={onDelete}
        />
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
  onCompleteTask,
  onCreateTask,
  onPlanTask,
  onScanNow,
  scanning = false,
  onPlanPending,
  planningPending = false,
  scanMessage,
  planMessage,
  onIgnoreTask,
  onAddTaskDetails,
  onDelete,
  onRestore,
  onDeleteForever,
  onClose,
}: TasksPanelProps) {
  const active = useMemo(
    () => plans.filter((p) => p.status !== "archived").sort((a, b) => b.updatedAt - a.updatedAt),
    [plans],
  );
  // Completed tasks are hidden by default so the timeline shows what's still to do; a toggle
  // brings them back. `visible` is what the timeline/list render from; `active` stays the full
  // non-archived set for counts + resolving a directly-selected task.
  const [hideCompleted, setHideCompleted] = useState(true);
  const completedCount = useMemo(() => active.filter((p) => p.status === "completed").length, [active]);
  const visible = useMemo(
    () => (hideCompleted ? active.filter((p) => p.status !== "completed") : active),
    [active, hideCompleted],
  );
  // Unplanned stubs (the backlog the background sweep / "Plan all pending" works on).
  const pendingCount = useMemo(() => active.filter(needsAttention).length, [active]);
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
  const [repeat, setRepeat] = useState<"" | "daily" | "weekly" | "monthly">("");

  const selected = active.find((p) => p.id === selectedId);
  // All-tasks Gantt: a parent bar per task, expanded ones revealing their sub-task bars inline.
  const rows = useMemo(() => plansToGanttRows(visible, { expandedPlanIds: expanded }), [visible, expanded]);
  // Individual-task Gantt: just the selected task with all its sub-tasks shown.
  const selectedRows = useMemo(() => (selected ? plansToGanttRows([selected], { expandedPlanIds: "all" }) : []), [selected]);
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandAll = () => setExpanded(new Set(visible.map((p) => p.id)));
  const collapseAll = () => setExpanded(new Set());

  const submit = (planNow: boolean) => {
    const t = title.trim();
    if (!t) return;
    onCreateTask(t, due || undefined, repeat ? { freq: repeat, interval: 1 } : undefined, planNow);
    setTitle("");
    setDue("");
    setRepeat("");
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
      onComplete={(complete) => void onCompleteTask(p.id, complete)}
      {...(onIgnoreTask ? { onIgnoreTask: () => onIgnoreTask(p.id) } : {})}
      {...(onAddTaskDetails ? { onAddDetails: (text: string) => onAddTaskDetails(p.id, text) } : {})}
      onDelete={() => void onDelete(p.id)}
    />
  );

  return (
    <ModalShell
      title="Tasks"
      onClose={onClose}
      overlayStyle={overlay}
      cardStyle={panel}
    >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <strong>📋 Tasks — your to-do timeline</strong>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {(["timeline", "list"] as const).map((v) => (
              <button className={cx.btn}
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
            <button className={cx.btn} style={btn} onClick={onClose}>
              Close
            </button>
          </span>
        </div>

        {/* Add a task → the assistant plans it into a Gantt. */}
        {adding ? (
          <div style={addBox}>
            <input className={cx.input}
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit(false)}
              placeholder="What do you need to get done? e.g. renew my passport"
              style={addInput}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.85 }}>
              Due
              <input className={cx.input} type="date" value={due} onChange={(e) => setDue(e.target.value)} style={dateInput} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.85 }} title="A repeating task rolls forward to the next occurrence when you complete it">
              Repeat
              <select className={cx.input} value={repeat} onChange={(e) => setRepeat(e.target.value as typeof repeat)} style={dateInput}>
                <option value="">No</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <button className={cx.btn} style={btn} onClick={() => submit(false)} disabled={!title.trim()} title="Add a plain to-do now — no planning (you can hit ⚡ Plan it later)">
              + Add as-is
            </button>
            <button className={cx.btn} style={btnPrimary} onClick={() => submit(true)} disabled={!title.trim()} title="Research it and build a step-by-step plan">
              Plan it →
            </button>
            <button className={cx.btn} style={btn} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <button className={cx.btn} style={btnPrimary} onClick={() => setAdding(true)}>
              + Add task
            </button>
            {onScanNow ? (
              <button className={cx.btn} style={btn} onClick={onScanNow} disabled={scanning} title="Scan recent email + your calendar for tasks now">
                {scanning ? "🔄 Scanning…" : "🔄 Scan email & calendar"}
              </button>
            ) : null}
            {onPlanPending && pendingCount > 0 ? (
              <button className={cx.btn}
                style={btn}
                onClick={onPlanPending}
                disabled={planningPending}
                title="Plan every unplanned task now (the same agentic planning the background sweep runs) and push the sub-tasks to Google Tasks"
              >
                {planningPending ? "🔄 Planning…" : `⚡ Plan all pending (${pendingCount})`}
              </button>
            ) : null}
            {completedCount > 0 ? (
              <button className={cx.btn}
                style={hideCompleted ? btn : toggleOn}
                onClick={() => setHideCompleted((v) => !v)}
                title={hideCompleted ? "Show completed tasks on the timeline" : "Hide completed tasks"}
              >
                {hideCompleted ? `✓ Show completed (${completedCount})` : `Hide completed (${completedCount})`}
              </button>
            ) : null}
            <span style={{ fontSize: 12, opacity: 0.65 }}>
              The assistant researches it and lays the steps out on your timeline.
            </span>
          </div>
        )}

        {scanMessage && (
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8, color: scanMessage.startsWith("⚠") ? t.state.danger : t.state.good }}>
            {scanMessage}
          </div>
        )}
        {planMessage && (
          <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 8, color: planMessage.startsWith("⚠") ? t.state.danger : planMessage.startsWith("✓") ? t.state.good : t.text.base }}>
            {planMessage}
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

        {selected ? (
          // Individual task view — the one task's sub-tasks on their own Gantt + the detail card.
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button className={cx.btn} style={btn} onClick={() => setSelectedId(undefined)}>
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
        ) : visible.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 13, padding: "16px 0" }}>
            {active.length === 0 ? (
              <>
                No tasks yet. Click <strong>+ Add task</strong> (with a due date) and the assistant will plan it — or in
                chat say “plan my car registration renewal”.
              </>
            ) : (
              <>
                All caught up — {completedCount} completed task{completedCount === 1 ? "" : "s"} hidden. Use{" "}
                <strong>Show completed</strong> above to see {completedCount === 1 ? "it" : "them"}.
              </>
            )}
          </div>
        ) : view === "timeline" ? (
          <div>
            <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              <button className={cx.btn} style={btn} onClick={expandAll} title="Show every task's sub-tasks">
                ▾ Expand all
              </button>
              <button className={cx.btn} style={btn} onClick={collapseAll} title="Show only the main tasks">
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
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{visible.map((p) => cardFor(p))}</div>
        )}

        {/* Removed/ignored tasks — the undoable trash. Restore brings one back (and un-ignores it);
            Delete forever drops it for good. */}
        {removed.length > 0 ? (
          <div style={{ marginTop: 14, borderTop: `1px solid ${t.border.faint}`, paddingTop: 8 }}>
            <button className={cx.btn} style={{ ...btn, fontSize: 12 }} onClick={() => setShowRemoved((v) => !v)}>
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
                      <button className={cx.btn} style={btn} onClick={() => onRestore(p.id)} title="Bring this task back (and un-ignore it)">
                        ↩ Restore
                      </button>
                    ) : null}
                    {onDeleteForever ? (
                      <ConfirmButton
                        style={btn}
                        label="Delete forever"
                        confirmLabel="Delete forever — sure?"
                        title="Delete permanently (cannot undo)"
                        confirmTitle="Press again to delete it permanently — this can't be undone"
                        onConfirm={() => onDeleteForever(p.id)}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
    </ModalShell>
  );
});

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: t.surface.overlay,
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};
const panel: React.CSSProperties = {
  width: "min(680px, 100%)",
  maxHeight: "92vh",
  overflowY: "auto",
  background: t.surface.card,
  color: t.text.base,
  border: `1px solid ${t.border.subtle}`,
  borderRadius: 12,
  padding: 18,
  fontFamily: "system-ui, sans-serif",
};
const card: React.CSSProperties = {
  border: `1px solid ${t.border.faint}`,
  borderRadius: 8,
  padding: "10px 12px",
};

/** A small colour-coded chip for a task's source (Gmail / Calendar / VR / Google Tasks). */
function sourceTagStyle(tag: "Gmail" | "Calendar" | "VR" | "Google Tasks"): React.CSSProperties {
  // RAW-COLOUR-OK: source BRAND colours (Gmail red, Calendar blue), which are data about the
  // service rather than design tokens — the same reason the chart palettes are exempt.
  const palette: Record<string, [string, string]> = {
    Gmail: ["rgba(234,67,53,0.18)", t.state.danger],
    Calendar: ["rgba(66,133,244,0.2)", t.accent.text],
    VR: ["rgba(160,120,255,0.22)", "#cdbcff"], // RAW-COLOUR-OK: brand colour, see above
    "Google Tasks": ["rgba(52,168,83,0.18)", t.state.good],
  };
  const [background, color] = palette[tag] ?? palette.VR!;
  return {
    fontSize: 9,
    fontWeight: 700,
    padding: "1px 5px",
    borderRadius: 4,
    background,
    color,
    whiteSpace: "nowrap",
    letterSpacing: 0.2,
    flexShrink: 0,
  };
}
const btn: React.CSSProperties = {
  background: t.fill.base,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: t.accent.fill,
  border: `1px solid ${t.accent.edge}`,
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
  border: `1px solid ${t.border.faint}`,
  background: t.fill.subtle,
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
  border: `1px solid ${t.accent.edge}`,
  background: t.accent.wash,
  borderRadius: 8,
};
const addInput: React.CSSProperties = {
  flex: 1,
  minWidth: 220,
  background: t.fill.subtle,
  color: "inherit",
  border: `1px solid ${t.border.input}`,
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
};
const dateInput: React.CSSProperties = {
  background: t.fill.subtle,
  color: "inherit",
  border: `1px solid ${t.border.input}`,
  borderRadius: 6,
  padding: "5px 6px",
  fontSize: 12,
  colorScheme: "dark",
};
