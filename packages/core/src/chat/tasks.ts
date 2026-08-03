import type { VisualReaderStore } from "../storage/store.js";

/**
 * TASK PLANS — the persistent state behind the Task Orchestrator. A real-world task
 * (renew car registration, file a form, RSVP) becomes a `TaskPlan`: a researched
 * deadline + lead-time, ordered steps (each flagged "the AI can prep this" vs "you
 * must do this"), attached/created prep documents, official links, and a mirror to
 * Google Tasks/Calendar. Plans survive across sessions and time, so progress is tracked
 * step by step. Plus an IGNORE list so dismissed ads/bloat never re-surface in scans.
 *
 * Stored like skills/memory — one bounded JSON array per key in the shared KV store.
 * The store helpers and the pure selectors (advanceStep/nextReadyStep/isIgnored) are
 * all unit-tested.
 */

export const TASK_PLANS_KEY = "task-plans";
export const TASK_IGNORE_KEY = "task-ignore";

export const MAX_TASK_PLANS = 50;
export const MAX_STEPS_PER_PLAN = 25;
export const MAX_LINKS_PER_STEP = 6;
export const MAX_CLARIFYING_QS = 6;
export const MAX_IGNORE_RULES = 300;
const MAX_TITLE_CHARS = 200;
const MAX_DETAIL_CHARS = 1000;
const MAX_NOTES_CHARS = 4000;
const MAX_DOC_BODY_CHARS = 20_000;
const MAX_URL_CHARS = 600;

export type StepActor = "ai_prep" | "user_action";
export type StepStatus = "pending" | "ready" | "in_progress" | "blocked" | "done";
export type PlanStatus = "active" | "completed" | "archived";

/** An app-managed repeat rule: when a recurring task is completed, the app rolls it forward to the
 * next occurrence (see `nextOccurrence`) instead of leaving a pile of duplicates. */
export interface TaskRecurrence {
  freq: "daily" | "weekly" | "monthly";
  /** Every N periods (>=1). */
  interval: number;
}

export type TaskSource =
  | { kind: "typed"; text: string }
  | { kind: "email"; emailId: string; subject?: string; from?: string }
  | { kind: "calendar"; eventId: string; summary?: string }
  | { kind: "scan"; emailId?: string; eventId?: string; from?: string }
  /** A task that originated as a MANUAL entry in Google Tasks (imported), as opposed to a `typed`
   * task entered in the app (VR). Kept distinct only so the source tag can tell them apart. */
  | { kind: "google"; taskId: string };

/** Short human tag for where a task came from — Gmail, Calendar, VR (typed in the app), or Google
 * Tasks (typed in Google). Shown on the task so its origin is clear at a glance. PURE. */
export function sourceTag(source: TaskSource): "Gmail" | "Calendar" | "VR" | "Google Tasks" {
  switch (source.kind) {
    case "email":
      return "Gmail";
    case "calendar":
      return "Calendar";
    case "scan":
      return source.emailId ? "Gmail" : source.eventId ? "Calendar" : "Gmail";
    case "google":
      return "Google Tasks";
    default:
      return "VR";
  }
}

export interface TaskLink {
  label: string;
  url: string;
  /** The authoritative site for the task (e.g. the DMV), so the UI can highlight it. */
  official?: boolean;
}

export interface TaskDoc {
  title: string;
  kind: "draft" | "reference" | "checklist";
  /** Fenced-block-ready content (saved via the chat's CodeCard path). */
  body: string;
  /** Code-fence language for save (md/html/csv…); defaults to md. */
  fence?: string;
}

export interface TaskStep {
  id: string;
  title: string;
  /** What to do. */
  detail: string;
  actor: StepActor;
  status: StepStatus;
  order: number;
  dueIso?: string;
  leadTimeDays?: number;
  estCost?: string;
  links: TaskLink[];
  docs: TaskDoc[];
  researchNotes?: string;
  googleTaskId?: string;
  googleEventId?: string;
  /**
   * When this step was checked off (ms epoch).
   *
   * A task is worked across days by a reader and by scheduled runs that resume it cold, and neither
   * could tell whether "3 of 7 done" happened this morning or a month ago. Without it the model
   * re-reports settled work as news and treats a stalled task as a fresh one.
   */
  doneAt?: number;
}

export interface TaskPlan {
  id: string;
  title: string;
  status: PlanStatus;
  source: TaskSource;
  summary: string;
  deadlineIso?: string;
  leadTimeDays?: number;
  estCost?: string;
  steps: TaskStep[];
  researchNotes?: string;
  /** Questions the planner still needs answered to finalize the plan (e.g. "which city are
   * you flying from?", "what's your budget?"). Surfaced in the panel and asked when the task
   * is opened in chat — this is how the agent "asks what it needs" to plan, e.g. a trip. */
  clarifyingQuestions?: string[];
  /** Extra details the reader added (answers to clarifyingQuestions, new context). Fed into the
   * next (re-)plan's source so the agent refines the plan with them. */
  userNotes?: string;
  /** Set when the reader added details to a PLANNED task — the background sweep re-plans it in
   * place to incorporate them, then clears the flag (the "re-attack with new info" loop). */
  needsReplan?: boolean;
  /** The exact notes string the app last WROTE to this task's parent Google Task. The baseline for
   * detecting edits the reader makes directly in Google Tasks (see `googleNotesUserEdit`): anything
   * present now but not here is treated as their added detail → userNotes + needsReplan. */
  googleNotesSynced?: string;
  /** `false` for a scan-surfaced STUB that's in the list but hasn't been planned yet (no steps);
   * omitted/true once it has a real step-by-step plan. The periodic sweep (or the "Plan" button)
   * turns stubs into full plans. */
  planned?: boolean;
  createdAt: number;
  updatedAt: number;
  /** The buddy chat session that executes this plan (reuses multi-session chat). */
  sessionId?: string;
  /** The PARENT Google Task this plan mirrors (set when created via create_task/add_task_group),
   * so planning can push its steps back as sub-tasks under it. */
  googleTaskId?: string;
  /** Why this plan was archived (soft-removed) — shown in the "Removed" list; cleared on restore. */
  archivedReason?: "removed" | "ignored";
  /** When it was archived (ms epoch), for sorting the Removed list. */
  archivedAt?: number;
  /** An app-managed repeat rule; on completion the task rolls forward to the next occurrence. */
  recurrence?: TaskRecurrence;
  /** BACKGROUND WATCHES the planner asked for: the recurring/dated checks this task needs in order to
   * make progress on its own ("check for RSVP replies each morning", "chase non-responders on the
   * 9th"). The host turns each into a scheduled action BOUND to this task, so it runs in the task's
   * own chat and writes back to it. Reconciled on re-plan rather than re-created, so a repeating
   * watch keeps its run history (and therefore its "what's new since last time" window). */
  watches?: PlannedWatch[];
}

/** One background check a plan needs. Mirrors the schedulable fields of a ScheduledTask; the host
 * fills in the binding (`planId`) and the run bookkeeping. */
export interface PlannedWatch {
  /** Short name — also the reconcile key across re-plans, so keep it stable. */
  title: string;
  /** What to actually do each time it fires (self-contained, like a scheduled action's prompt). */
  prompt: string;
  rule: "daily" | "weekly" | "monthly" | "once";
  /** 24h "HH:MM"; defaults to the scheduler's own default when absent. */
  time?: string;
  /** One-time only: the day to run ("YYYY-MM-DD"). */
  date?: string;
  /** Weekly: 0–6 (Sun–Sat). */
  weekday?: number;
  /** Monthly: 1–31. */
  dayOfMonth?: number;
}

/** A possible task the scan surfaced, before the user turns it into a plan. */
export interface TaskCandidate {
  source: TaskSource;
  title: string;
  reason: string;
  from?: string;
  suggestedDeadlineIso?: string;
}

/** A persistent "don't surface this" rule. */
export interface IgnoreRule {
  kind: "item" | "sender" | "phrase";
  value: string;
  at: number;
}

// ---------------------------------------------------------------- store: plans

function isTaskPlan(v: unknown): v is TaskPlan {
  const p = v as TaskPlan;
  return p != null && typeof p.id === "string" && typeof p.title === "string" && Array.isArray(p.steps);
}

export async function loadTaskPlans(store: VisualReaderStore): Promise<TaskPlan[]> {
  try {
    const raw = await store.getMemo?.(TASK_PLANS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTaskPlan).slice(0, MAX_TASK_PLANS);
  } catch {
    return [];
  }
}

async function persistPlans(store: VisualReaderStore, plans: TaskPlan[]): Promise<void> {
  await store.putMemo?.(TASK_PLANS_KEY, JSON.stringify(plans.slice(-MAX_TASK_PLANS)));
}

const cap = (s: string | undefined, n: number): string => (s ?? "").trim().slice(0, n);

function normalizeLink(l: TaskLink): TaskLink | undefined {
  const url = cap(l.url, MAX_URL_CHARS);
  if (!/^https?:\/\//i.test(url)) return undefined;
  return { label: cap(l.label, MAX_TITLE_CHARS) || url, url, ...(l.official ? { official: true } : {}) };
}

const STEP_STATUSES: StepStatus[] = ["pending", "ready", "in_progress", "blocked", "done"];

/** Clean + bound a step; `order` is assigned by the caller's index. */
export function normalizeStep(input: Partial<TaskStep> & { title: string }, order: number): TaskStep {
  return {
    id: input.id || `step-${order}-${Math.random().toString(36).slice(2, 8)}`,
    title: cap(input.title, MAX_TITLE_CHARS) || `Step ${order + 1}`,
    detail: cap(input.detail, MAX_DETAIL_CHARS),
    actor: input.actor === "ai_prep" ? "ai_prep" : "user_action",
    status: input.status && STEP_STATUSES.includes(input.status) ? input.status : "pending",
    order,
    ...(input.dueIso ? { dueIso: cap(input.dueIso, 40) } : {}),
    ...(typeof input.leadTimeDays === "number" && Number.isFinite(input.leadTimeDays)
      ? { leadTimeDays: Math.max(0, Math.round(input.leadTimeDays)) }
      : {}),
    ...(input.estCost ? { estCost: cap(input.estCost, 60) } : {}),
    links: (input.links ?? []).map(normalizeLink).filter((l): l is TaskLink => !!l).slice(0, MAX_LINKS_PER_STEP),
    docs: (input.docs ?? []).map((d) => ({
      title: cap(d.title, MAX_TITLE_CHARS) || "document",
      kind: d.kind === "reference" || d.kind === "checklist" ? d.kind : "draft",
      body: cap(d.body, MAX_DOC_BODY_CHARS),
      ...(d.fence ? { fence: cap(d.fence, 12) } : {}),
    })),
    ...(input.researchNotes ? { researchNotes: cap(input.researchNotes, MAX_NOTES_CHARS) } : {}),
    ...(input.googleTaskId ? { googleTaskId: input.googleTaskId } : {}),
    ...(input.googleEventId ? { googleEventId: input.googleEventId } : {}),
  };
}

/** Input to `normalizeTaskPlan` — like a TaskPlan but with partial, unbounded steps
 * (the planner / a host caller supplies rough data we clean up). */
export interface TaskPlanInput {
  id?: string;
  title: string;
  status?: PlanStatus;
  source: TaskSource;
  summary?: string;
  deadlineIso?: string;
  leadTimeDays?: number;
  estCost?: string;
  steps?: (Partial<TaskStep> & { title: string })[];
  researchNotes?: string;
  clarifyingQuestions?: string[];
  userNotes?: string;
  needsReplan?: boolean;
  googleNotesSynced?: string;
  /** Pass `false` to mark a scan stub awaiting planning; defaults to "has steps". */
  planned?: boolean;
  createdAt?: number;
  sessionId?: string;
  googleTaskId?: string;
  recurrence?: TaskRecurrence;
  /** Background checks the planner asked for (see PlannedWatch); normalised + capped. */
  watches?: Partial<PlannedWatch>[];
}

/** Clean + bound a whole plan (assigns step order, caps step count). */
export function normalizeTaskPlan(input: TaskPlanInput): TaskPlan {
  const now = Date.now();
  const steps = (input.steps ?? []).slice(0, MAX_STEPS_PER_PLAN).map((s, i) => normalizeStep(s, i));
  return {
    id: input.id || `task-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: cap(input.title, MAX_TITLE_CHARS) || "Task",
    status: input.status === "completed" || input.status === "archived" ? input.status : "active",
    source: input.source,
    summary: cap(input.summary, MAX_DETAIL_CHARS),
    // Stored only when this is a stub awaiting planning; a real plan (input.planned !== false, or
    // it already has steps) leaves it omitted so `needsPlanning` is false.
    ...(input.planned === false && steps.length === 0 ? { planned: false } : {}),
    ...(input.deadlineIso ? { deadlineIso: cap(input.deadlineIso, 40) } : {}),
    ...(typeof input.leadTimeDays === "number" && Number.isFinite(input.leadTimeDays)
      ? { leadTimeDays: Math.max(0, Math.round(input.leadTimeDays)) }
      : {}),
    ...(input.estCost ? { estCost: cap(input.estCost, 60) } : {}),
    steps,
    ...(input.researchNotes ? { researchNotes: cap(input.researchNotes, MAX_NOTES_CHARS) } : {}),
    ...(() => {
      const qs = (input.clarifyingQuestions ?? []).map((q) => cap(q, MAX_DETAIL_CHARS)).filter(Boolean).slice(0, MAX_CLARIFYING_QS);
      return qs.length ? { clarifyingQuestions: qs } : {};
    })(),
    ...(input.userNotes && input.userNotes.trim() ? { userNotes: cap(input.userNotes, MAX_NOTES_CHARS) } : {}),
    ...(input.needsReplan ? { needsReplan: true } : {}),
    ...(input.googleNotesSynced !== undefined ? { googleNotesSynced: input.googleNotesSynced.slice(0, 8000) } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.googleTaskId ? { googleTaskId: input.googleTaskId } : {}),
    ...(() => {
      const rec = input.recurrence ? normalizeRecurrence(input.recurrence) : undefined;
      return rec ? { recurrence: rec } : {};
    })(),
    ...(() => {
      const w = (input.watches ?? []).map(normalizeWatch).filter((x): x is PlannedWatch => !!x).slice(0, MAX_WATCHES);
      return w.length ? { watches: w } : {};
    })(),
  };
}

/** At most this many background watches per plan — a planner that asks for a dozen recurring checks
 * would quietly fill the schedule, and nothing legitimate needs more than a few. */
export const MAX_WATCHES = 4;

/** Validate + clamp one planner-requested watch (no title/prompt, or an unknown rule → dropped). PURE. */
export function normalizeWatch(w: Partial<PlannedWatch> | undefined): PlannedWatch | undefined {
  const title = w?.title ? cap(w.title, MAX_TITLE_CHARS) : "";
  const prompt = w?.prompt ? cap(w.prompt, MAX_DETAIL_CHARS) : "";
  if (!title || !prompt) return undefined;
  const rule = w?.rule === "weekly" || w?.rule === "monthly" || w?.rule === "once" ? w.rule : w?.rule === "daily" ? "daily" : undefined;
  if (!rule) return undefined; // an unstated cadence is not a schedule — don't guess one
  return {
    title,
    prompt,
    rule,
    ...(w?.time && /^\d{1,2}:\d{2}$/.test(w.time.trim()) ? { time: w.time.trim() } : {}),
    ...(rule === "once" && w?.date && /^\d{4}-\d{1,2}-\d{1,2}$/.test(w.date.trim()) ? { date: w.date.trim() } : {}),
    ...(typeof w?.weekday === "number" && Number.isFinite(w.weekday) ? { weekday: Math.min(6, Math.max(0, Math.round(w.weekday))) } : {}),
    ...(typeof w?.dayOfMonth === "number" && Number.isFinite(w.dayOfMonth) ? { dayOfMonth: Math.min(31, Math.max(1, Math.round(w.dayOfMonth))) } : {}),
  };
}

/** Validate + clamp a repeat rule (unknown freq → dropped; interval forced to 1–52). PURE. */
export function normalizeRecurrence(r: { freq?: string; interval?: number }): TaskRecurrence | undefined {
  const freq = r.freq === "daily" || r.freq === "weekly" || r.freq === "monthly" ? r.freq : undefined;
  if (!freq) return undefined;
  const interval =
    typeof r.interval === "number" && Number.isFinite(r.interval) ? Math.min(52, Math.max(1, Math.round(r.interval))) : 1;
  return { freq, interval };
}

/** A human label for a repeat rule, e.g. "every week" or "every 2 days". PURE. */
export function describeRecurrence(rec: TaskRecurrence): string {
  const unit = rec.freq === "daily" ? "day" : rec.freq === "weekly" ? "week" : "month";
  return rec.interval === 1 ? `every ${unit}` : `every ${rec.interval} ${unit}s`;
}

/** Shift a YYYY-MM-DD date forward by ONE recurrence period (UTC). PURE. */
export function shiftIso(iso: string, rec: TaskRecurrence): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const n = Math.max(1, rec.interval);
  if (rec.freq === "daily") d.setUTCDate(d.getUTCDate() + n);
  else if (rec.freq === "weekly") d.setUTCDate(d.getUTCDate() + 7 * n);
  else {
    // Monthly: `setUTCMonth(m + n)` on a day-29/30/31 date OVERFLOWS a shorter target month — Jan 31 + 1
    // month asks for "Feb 31", which JS rolls forward to Mar 3, silently SKIPPING February. Change the
    // month off day 1 (never overflows), then clamp the day to the target month's last day, so Jan 31
    // rolls to Feb 28/29 (the month's end), not into March.
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
  }
  return d.toISOString().slice(0, 10);
}

/**
 * The NEXT occurrence of a recurring plan once it's completed: roll the deadline (and every dated
 * step) forward by the recurrence until it lands after `todayIso`, reset all steps to pending, and
 * drop the Google links so the new cycle gets its own Google task. Returns a `TaskPlanInput` — the
 * caller sets the id (pass the old id to roll the task in place). PURE. Returns undefined when the
 * plan doesn't repeat.
 */
export function nextOccurrence(plan: TaskPlan, todayIso: string): TaskPlanInput | undefined {
  if (!plan.recurrence) return undefined;
  const rec = plan.recurrence;
  const base = plan.deadlineIso ? plan.deadlineIso.slice(0, 10) : todayIso;
  let deadline = shiftIso(base, rec);
  let shifts = 1;
  while (deadline <= todayIso && shifts < 1000) {
    deadline = shiftIso(deadline, rec);
    shifts++;
  }
  const shiftN = (iso: string): string => {
    let r = iso.slice(0, 10);
    for (let i = 0; i < shifts; i++) r = shiftIso(r, rec);
    return r;
  };
  return {
    title: plan.title,
    source: plan.source,
    deadlineIso: deadline,
    recurrence: rec,
    ...(plan.summary ? { summary: plan.summary } : {}),
    steps: plan.steps.map((s) => ({
      title: s.title,
      detail: s.detail,
      actor: s.actor,
      status: "pending" as StepStatus,
      links: s.links,
      docs: s.docs,
      ...(s.dueIso ? { dueIso: shiftN(s.dueIso) } : {}),
      ...(typeof s.leadTimeDays === "number" ? { leadTimeDays: s.leadTimeDays } : {}),
      ...(s.estCost ? { estCost: s.estCost } : {}),
    })),
  };
}

/** Upsert a plan by id (replace in place; oldest evicted past the cap). */
export async function upsertTaskPlan(store: VisualReaderStore, plan: TaskPlan): Promise<TaskPlan[]> {
  const plans = await loadTaskPlans(store);
  const kept = plans.filter((p) => p.id !== plan.id);
  kept.push({ ...plan, updatedAt: Date.now() });
  const bounded = kept.slice(-MAX_TASK_PLANS);
  await persistPlans(store, bounded);
  return bounded;
}

export async function deleteTaskPlan(store: VisualReaderStore, id: string): Promise<TaskPlan[]> {
  const kept = (await loadTaskPlans(store)).filter((p) => p.id !== id);
  await persistPlans(store, kept);
  return kept;
}

/** Soft-remove a plan: mark it `archived` (kept in the store, hidden from the active list). Because
 * the plan stays "known", a removed item won't re-surface from a scan or re-import from Google Tasks
 * (both dedupe against ALL plans) — and it can be Restored. `reason` records why it was removed. */
export async function archiveTaskPlan(
  store: VisualReaderStore,
  id: string,
  reason: "removed" | "ignored" = "removed",
): Promise<TaskPlan[]> {
  const next = (await loadTaskPlans(store)).map((p) =>
    p.id === id ? { ...p, status: "archived" as const, archivedReason: reason, archivedAt: Date.now(), updatedAt: Date.now() } : p,
  );
  await persistPlans(store, next);
  return next;
}

/** Undo a removal: flip an archived plan back to active (clearing the archive metadata). */
export async function restoreTaskPlan(store: VisualReaderStore, id: string): Promise<TaskPlan[]> {
  const next = (await loadTaskPlans(store)).map((p) => {
    if (p.id !== id) return p;
    const { archivedReason: _r, archivedAt: _a, ...rest } = p;
    return { ...rest, status: "active" as const, updatedAt: Date.now() };
  });
  await persistPlans(store, next);
  return next;
}

/** Mark a WHOLE plan complete (or reopen it) — the "✓ Complete task" / "↺ Reopen" button. Completing
 * ticks every step done and flips the plan to "completed" (works for a no-step to-do too); reopening
 * sets it back to "active" and, when the plan was fully done, resets its steps (first → ready, rest →
 * pending) so it's workable again. Returns the saved plans. */
export async function setTaskPlanComplete(store: VisualReaderStore, id: string, complete: boolean): Promise<TaskPlan[]> {
  const plans = await loadTaskPlans(store);
  const next = plans.map((p) => {
    if (p.id !== id) return p;
    if (complete) {
      return {
        ...p,
        status: "completed" as const,
        steps: p.steps.map((s) => ({ ...s, status: "done" as StepStatus, doneAt: s.doneAt ?? Date.now() })),
        updatedAt: Date.now(),
      };
    }
    const wasAllDone = p.steps.length > 0 && p.steps.every((s) => s.status === "done");
    const steps = wasAllDone ? p.steps.map((s, i) => ({ ...s, status: (i === 0 ? "ready" : "pending") as StepStatus })) : p.steps;
    return { ...p, status: "active" as const, steps, updatedAt: Date.now() };
  });
  await persistPlans(store, next);
  return next;
}

/** Patch one step (status/notes/google ids); bumps updatedAt. Returns the saved plans. */
export async function updateTaskStep(
  store: VisualReaderStore,
  planId: string,
  stepId: string,
  patch: Partial<Pick<TaskStep, "status" | "researchNotes" | "googleTaskId" | "googleEventId">>,
): Promise<TaskPlan[]> {
  const plans = await loadTaskPlans(store);
  const next = plans.map((p) =>
    p.id !== planId
      ? p
      : {
          ...p,
          updatedAt: Date.now(),
          steps: p.steps.map((s) =>
            s.id !== stepId
              ? s
              : {
                  ...s,
                  ...(patch.status && STEP_STATUSES.includes(patch.status) ? { status: patch.status } : {}),
                  ...(patch.researchNotes !== undefined ? { researchNotes: cap(patch.researchNotes, MAX_NOTES_CHARS) } : {}),
                  ...(patch.googleTaskId ? { googleTaskId: patch.googleTaskId } : {}),
                  ...(patch.googleEventId ? { googleEventId: patch.googleEventId } : {}),
                },
          ),
        },
  );
  await persistPlans(store, next);
  return next;
}

/** Add or replace a plan's steps (the chat "add a step / refine these steps" path). `replace`
 * swaps the whole list; otherwise the edits are appended. Each edit is normalized (fresh id +
 * order unless an id is supplied, which is preserved), capped at MAX_STEPS_PER_PLAN. A stub's
 * `planned:false` is cleared once it has steps, so the background sweep won't wipe chat-added work.
 * PURE. */
export function applyStepEdits(
  plan: TaskPlan,
  edits: readonly (Partial<TaskStep> & { title: string })[],
  opts: { replace?: boolean } = {},
): TaskPlan {
  const base = opts.replace ? [] : plan.steps;
  const steps = [...base, ...edits].slice(0, MAX_STEPS_PER_PLAN).map((s, i) => normalizeStep(s, i));
  const next: TaskPlan = { ...plan, steps, updatedAt: Date.now() };
  if (next.planned === false && steps.length > 0) delete next.planned;
  return next;
}

// ------------------------------------------------------------- pure selectors

/** Mark the current (first non-done) step done and set the next one ready. Pure —
 * returns the updated plan and the newly-ready step (undefined when all done → the
 * plan is marked completed). */
export function advanceStep(plan: TaskPlan): { plan: TaskPlan; ready?: TaskStep } {
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  const currentIdx = ordered.findIndex((s) => s.status !== "done");
  if (currentIdx === -1) return { plan: { ...plan, status: "completed" } };
  const steps = ordered.map((s, i) =>
    i === currentIdx ? { ...s, status: "done" as StepStatus, doneAt: Date.now() } : s,
  );
  const nextIdx = steps.findIndex((s, i) => i > currentIdx && s.status !== "done");
  let ready: TaskStep | undefined;
  if (nextIdx >= 0) {
    ready = { ...steps[nextIdx]!, status: "ready" };
    steps[nextIdx] = ready;
  }
  const allDone = steps.every((s) => s.status === "done");
  return {
    plan: { ...plan, steps, status: allDone ? "completed" : plan.status, updatedAt: Date.now() },
    ...(ready ? { ready } : {}),
  };
}

/**
 * Deterministic context harvest from ONE task-chat user turn: pasted links and attached-file names.
 * The host folds attachments into the turn text as `[Attached file "name"]` / `[Attached image
 * "name" …]` blocks, so both are recoverable from the text alone. This is the guarantee that
 * closing a task chat never loses what the reader HANDED it, even when the model saves nothing —
 * the model's own save_task_context notes add the meaning on top. PURE.
 */
export function harvestTaskContext(userText: string): string[] {
  const notes: string[] = [];
  const urls = userText.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
  for (const u of [...new Set(urls)].slice(0, 5)) notes.push(`Link from chat: ${u}`);
  const attRe = /\[Attached (?:file|image) "([^"]+)"/g;
  const seen = new Set<string>();
  for (let m = attRe.exec(userText); m; m = attRe.exec(userText)) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      notes.push(`Attached in chat: ${name}`);
    }
  }
  return notes;
}

/**
 * Merge fresh context notes into a plan's `userNotes`: one bullet per note, deduped against what's
 * already there (verbatim containment), capped keeping the NEWEST content. Returns the existing value
 * unchanged (same reference) when every note is already present.
 *
 * The cap drops WHOLE oldest notes and says how many went. A blind `slice` cut mid-note, leaving a
 * fragment that read as a real note ("…ed the deposit on the 3rd"), and left no sign that anything had
 * been lost at all — on a long-running task that's the earliest context disappearing silently. PURE.
 */
export function mergeUserNotes(
  existing: string | undefined,
  notes: string[],
  capChars = MAX_NOTES_CHARS,
  at: Date = new Date(),
): string | undefined {
  const cur = existing?.trim() ?? "";
  const fresh = notes.map((n) => n.trim()).filter((n) => n.length > 0 && !cur.includes(n));
  if (fresh.length === 0) return existing;
  // DATE each note as it is written. These notes are the memory a task carries between sessions and
  // across scheduled runs that resume it cold, and undated they read as one flat present tense — the
  // model can't tell this morning's finding from one three weeks stale, so it re-reports settled
  // things as news. The stamp is written once, here, and travels with the note.
  const stamp = isoDay(at);
  const lines = [cur, ...fresh.map((n) => (n.startsWith("•") ? n : `• [${stamp}] ${n}`))].filter(Boolean).join("\n").split("\n");
  let next = lines.join("\n");
  if (next.length <= capChars) return next;
  // Drop from the front, a whole line at a time, until what's left PLUS the marker fits. The marker is
  // terse on purpose: a wordy one eats the budget it's accounting for, evicting notes to explain that
  // notes were evicted.
  const marker = (n: number) => `• (${n} earlier note${n === 1 ? "" : "s"} dropped)`;
  const kept = [...lines];
  let dropped = 0;
  const size = (): number => (dropped === 0 ? 0 : marker(dropped).length + 1) + kept.join("\n").length;
  while (kept.length > 1 && size() > capChars) {
    kept.shift();
    dropped++;
  }
  next = dropped > 0 ? [marker(dropped), ...kept].join("\n") : kept.join("\n");
  // A single note longer than the whole cap still has to be cut somewhere; keep its END (the newest
  // writing) and mark it, rather than returning something over budget.
  return next.length > capChars ? `…${next.slice(next.length - capChars + 1)}` : next;
}

/** Append context notes to a plan's `userNotes` (see {@link mergeUserNotes}) and optionally flag it
 * for an in-place re-plan (the background sweep folds userNotes into the rebuilt plan). No-op write
 * is skipped. Returns the saved (or unchanged) plan; undefined when the id doesn't exist. */
export async function appendTaskContext(
  store: VisualReaderStore,
  planId: string,
  notes: string[],
  opts: { replan?: boolean } = {},
): Promise<TaskPlan | undefined> {
  const plans = await loadTaskPlans(store);
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return undefined;
  const merged = mergeUserNotes(plan.userNotes, notes);
  const notesChanged = merged !== plan.userNotes;
  const replanChanged = !!opts.replan && !plan.needsReplan;
  if (!notesChanged && !replanChanged) return plan;
  const next: TaskPlan = {
    ...plan,
    ...(merged !== undefined ? { userNotes: merged } : {}),
    ...(opts.replan ? { needsReplan: true } : {}),
    updatedAt: Date.now(),
  };
  await upsertTaskPlan(store, next);
  return next;
}

/** Mark ONE NAMED step done (or reopen it with `done:false`) — the chat's "check off this
 * sub-task" path. Unlike {@link advanceStep} (which always completes the FIRST pending step,
 * for strictly-ordered execution), this targets the step the user actually named, in any order.
 * Recomputes the plan around it: every step done → the plan completes; un-checking a step of a
 * completed plan reactivates it; and when nothing is left ready/in-progress afterwards, the first
 * non-done step (by order) is promoted to ready so the plan always shows a next action. Returns
 * undefined when the step id doesn't exist. PURE. */
export function completeStepById(
  plan: TaskPlan,
  stepId: string,
  done = true,
  at = Date.now(),
): { plan: TaskPlan; step: TaskStep; ready?: TaskStep; completed: boolean } | undefined {
  const target = plan.steps.find((s) => s.id === stepId);
  if (!target) return undefined;
  // Stamp when it was checked off, and clear the stamp when it is reopened — a doneAt on a step
  // that is no longer done would date work that has been undone.
  const { doneAt: _wasDoneAt, ...withoutStamp } = target;
  const flipped: TaskStep = done ? { ...target, status: "done", doneAt: at } : { ...withoutStamp, status: "ready" };
  let steps = plan.steps.map((s) => (s.id === stepId ? flipped : s));
  const allDone = steps.length > 0 && steps.every((s) => s.status === "done");
  let ready: TaskStep | undefined;
  if (!allDone && !steps.some((s) => s.status === "ready" || s.status === "in_progress")) {
    const next = [...steps].sort((a, b) => a.order - b.order).find((s) => s.status !== "done");
    if (next) {
      ready = { ...next, status: "ready" };
      const promoted = ready;
      steps = steps.map((s) => (s.id === promoted.id ? promoted : s));
    }
  }
  const status: PlanStatus = allDone ? "completed" : plan.status === "completed" ? "active" : plan.status;
  return {
    plan: { ...plan, steps, status, updatedAt: Date.now() },
    step: flipped,
    ...(ready ? { ready } : {}),
    completed: allDone,
  };
}

/** What to do with each plan step when syncing to Google Tasks: reuse an existing sub-task or
 * create one, and whether to mark it completed. Pure so the matching is unit-tested; the host runs
 * the create/patch calls. Never proposes a DELETE — superseded sub-tasks are kept for history. */
export interface GoogleSubtaskAction {
  /** The plan step's title (for creating a new sub-task). */
  title: string;
  /** Reuse this existing Google sub-task id (matched by stored id, then by title). */
  existingId?: string;
  /** Create a new sub-task (no existing match). */
  create: boolean;
  /** Patch the (existing or new) sub-task to "completed" — the step is done but Google isn't. */
  needsComplete: boolean;
}

const normTaskTitle = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Reconcile a plan's steps against the parent's existing Google sub-tasks: match by the step's
 * stored googleTaskId first, else by normalized title (so a re-plan reuses what's there instead of
 * duplicating); completed steps are marked complete; anything unmatched is a fresh create. */
export function reconcileGoogleSubtasks(
  steps: readonly { title: string; status: TaskStep["status"]; googleTaskId?: string }[],
  existing: readonly { id: string; title: string; status?: string }[],
): GoogleSubtaskAction[] {
  const byId = new Map(existing.map((t) => [t.id, t]));
  const byTitle = new Map<string, { id: string; title: string; status?: string }>();
  for (const t of existing) {
    const k = normTaskTitle(t.title);
    if (!byTitle.has(k)) byTitle.set(k, t);
  }
  const used = new Set<string>();
  return steps.map((step) => {
    const done = step.status === "done";
    let match = step.googleTaskId ? byId.get(step.googleTaskId) : undefined;
    if (!match) {
      const m = byTitle.get(normTaskTitle(step.title));
      if (m && !used.has(m.id)) match = m;
    }
    if (match) {
      used.add(match.id);
      return { title: step.title, existingId: match.id, create: false, needsComplete: done && match.status !== "completed" };
    }
    return { title: step.title, create: true, needsComplete: done };
  });
}

/** A scan-surfaced task still awaiting its step-by-step plan (a stub: planned===false, no steps). */
export function needsPlanning(plan: TaskPlan): boolean {
  return plan.planned === false;
}

/** A task the background sweep should (re-)plan: an unplanned stub OR a planned task the reader
 * added details to (needsReplan) — so the "re-attack with new info" loop runs at the next sweep. */
export function needsAttention(plan: TaskPlan): boolean {
  return plan.planned === false || plan.needsReplan === true;
}

/**
 * The text the reader ADDED to a Google Task's notes since the app last wrote them — the bridge for
 * "edit it in Google Tasks → re-plan". Returns the lines present in `current` but NOT in the
 * `synced` baseline (trimmed, non-empty, order preserved, de-duped). Empty when nothing was added.
 * Returns "" when there is NO baseline yet (`synced === undefined`) so a plan synced before this
 * feature doesn't have its whole existing notes mistaken for a fresh edit. PURE.
 */
export function googleNotesUserEdit(current: string | undefined, synced: string | undefined): string {
  if (!current || synced === undefined) return "";
  const known = new Set(synced.split("\n").map((l) => l.trim()));
  const seen = new Set<string>();
  const added: string[] = [];
  for (const raw of current.split("\n")) {
    const line = raw.trim();
    if (!line || known.has(line) || seen.has(line)) continue;
    seen.add(line);
    added.push(line);
  }
  return added.join("\n").trim();
}

/** Render a plan as readable notes for the PARENT Google Task, so the whole plan — summary, the
 * numbered steps (with who does each + due dates), and the deadline — is visible right in Google
 * Tasks, not just as a bare title with child rows. Bounded to Google's notes limit (~8 KB). PURE. */
/** A Gmail deep link to one message (its API id), so a plan can point straight at the email a step
 * is about. Opens it in All Mail (works whether it's in the inbox or archived). PURE. */
export function gmailMessageLink(messageId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}`;
}

const EMAIL_ACTION_RE = /\b(repl(?:y|ies|ied)|respond|response|e-?mail|sending|send|reach out|follow[ -]?up|get back|write back|rsvp|confirm with)\b/i;

/** Attach a Gmail link to the SOURCE email on the step that involves emailing/replying — so the
 * reader can jump straight to the message from the plan (and, once it's in the notes, from Google
 * Tasks). Picks the first step whose title/detail mentions an email action, else the first
 * user_action step, else step 0. Idempotent (won't add a duplicate). PURE. */
export function attachSourceEmailLink(plan: TaskPlan, emailId: string | undefined): TaskPlan {
  if (!emailId || plan.steps.length === 0) return plan;
  const url = gmailMessageLink(emailId);
  let idx = plan.steps.findIndex((s) => EMAIL_ACTION_RE.test(`${s.title} ${s.detail ?? ""}`));
  if (idx < 0) idx = plan.steps.findIndex((s) => s.actor === "user_action");
  if (idx < 0) idx = 0;
  if (plan.steps[idx]!.links.some((l) => l.url === url)) return plan;
  const steps = plan.steps.map((s, i) =>
    i === idx ? { ...s, links: [...s.links, { label: "📧 Open the email", url }] } : s,
  );
  return { ...plan, steps };
}

export function formatPlanForGoogleNotes(plan: {
  summary?: string;
  deadlineIso?: string;
  steps: readonly { title: string; detail?: string; actor: StepActor; status: StepStatus; dueIso?: string; links?: readonly TaskLink[] }[];
  clarifyingQuestions?: readonly string[];
}): string {
  const lines: string[] = [];
  if (plan.summary) lines.push(plan.summary.trim(), "");
  // Surface what the planner still needs from the reader RIGHT in the task notes — so they can fill
  // it in here (or in the app) and the planner re-attacks with it. Worded as a prompt to answer.
  const qs = (plan.clarifyingQuestions ?? []).map((q) => q.trim()).filter(Boolean);
  if (qs.length) {
    lines.push("NEEDS FROM YOU (add answers below and the app will refine the plan):");
    qs.forEach((q) => lines.push(`• ${q}`));
    lines.push("");
  }
  if (plan.steps.length) {
    lines.push(`PLAN — ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}:`);
    plan.steps.forEach((s, i) => {
      const mark = s.status === "done" ? "[x]" : "[ ]";
      const who = s.actor === "ai_prep" ? "AI preps" : "you do";
      const due = s.dueIso ? `, due ${s.dueIso}` : "";
      lines.push(`${i + 1}. ${mark} ${s.title} (${who}${due})`);
      if (s.detail) lines.push(`     ${s.detail.trim()}`);
      // Links (official sites, and the 📧 email-to-reply link) so they're tappable right in Google Tasks.
      for (const l of s.links ?? []) lines.push(`     ${l.label}: ${l.url}`);
    });
  }
  if (plan.deadlineIso) lines.push("", `Deadline: ${plan.deadlineIso}`);
  lines.push("", "— planned by Visual Reader");
  return lines.join("\n").slice(0, 8000);
}

/** A top-level Google Task plus its sub-tasks — the shape `listTaskTree` returns. */
export interface GoogleTaskTree {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status?: string;
  subtasks: { id: string; title: string; status?: string }[];
}

/** Pure: build a PLANNED TaskPlan from a Google Task (one the app created, or the user added in
 * Google), carrying the parent + per-step Google ids so a later sync reconciles in place rather
 * than duplicating. This mirrors Google Tasks back INTO the app list — the reverse of pushing a
 * plan out — so a task that lives in Google shows up in the app even if its local plan is gone. */
export function planFromGoogleTask(node: GoogleTaskTree): TaskPlanInput {
  return {
    title: node.title || "Google task",
    // A manual entry made in Google Tasks — tagged "Google Tasks" (vs "VR" for app-typed). sourceId/
    // sourceFrom return undefined for this kind (the googleTaskId is the link), so dedupe/ignore are
    // unchanged — it behaves like `typed` everywhere except the source tag.
    source: { kind: "google", taskId: node.id },
    googleTaskId: node.id,
    status: node.status === "completed" ? "completed" : "active",
    ...(node.notes ? { summary: node.notes } : {}),
    ...(node.due ? { deadlineIso: node.due.slice(0, 10) } : {}),
    steps: node.subtasks.map((s) => ({
      title: s.title || "(untitled)",
      actor: "user_action" as const,
      status: (s.status === "completed" ? "done" : "pending") as StepStatus,
      googleTaskId: s.id,
    })),
  };
}

/** Pure: which Google Tasks aren't yet mirrored in the app's plans — matched by the stored
 * parent googleTaskId, so re-running an import never duplicates a task already in the list. */
/** Google-side "don't manage this" marker: put [skip] (or [ignore]) anywhere in a Google Task's
 * TITLE and the app won't import it — and mirrors it as ignored if it was already imported. */
const GOOGLE_SKIP_RE = /\[(skip|ignore)\]/i;

/** Whether a Google task title carries the skip/ignore marker. PURE. */
export function hasGoogleSkipMarker(title: string | undefined): boolean {
  return !!title && GOOGLE_SKIP_RE.test(title);
}

export function importableGoogleTasks(
  trees: readonly GoogleTaskTree[],
  existing: readonly TaskPlan[],
): GoogleTaskTree[] {
  const known = new Set(existing.map((p) => p.googleTaskId).filter((id): id is string => !!id));
  // Skip tasks the reader marked [skip]/[ignore] in Google, and ones already linked to a plan.
  return trees.filter((t) => !!t.id && !known.has(t.id) && !hasGoogleSkipMarker(t.title));
}

/** Build an UNPLANNED task stub from a scan candidate — it goes straight into the list/calendar
 * sweep without any LLM work; planning happens later (periodic sweep or the Plan button). */
export function taskStubFromCandidate(c: TaskCandidate): TaskPlanInput {
  return {
    title: c.title,
    source: c.source,
    planned: false,
    steps: [],
    ...(c.reason ? { summary: c.reason } : {}),
    ...(c.suggestedDeadlineIso ? { deadlineIso: c.suggestedDeadlineIso } : {}),
  };
}

/** The step the user should tackle next: the first "ready", else the first non-done. */
export function nextReadyStep(plan: TaskPlan): TaskStep | undefined {
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  return ordered.find((s) => s.status === "ready") ?? ordered.find((s) => s.status !== "done");
}

/** A task step the assistant may attempt unattended, with the plan it belongs to. */
export interface AutoStepPick {
  plan: TaskPlan;
  step: TaskStep;
}

/**
 * The next step the assistant may work on ITS OWN, or undefined when there's nothing safe to do.
 *
 * This is the gate for unattended execution, so it is deliberately conservative — every exclusion
 * below is a case where acting alone would be wrong rather than merely unhelpful:
 *  - only `ai_prep` steps. `user_action` is the reader's to do, by definition.
 *  - only ACTIVE, already-planned tasks. A stub has no real steps to work from.
 *  - never while `needsReplan` is set: the plan is known to be out of date and is about to be
 *    rewritten, so acting now would work from steps that are already superseded.
 *  - never while `clarifyingQuestions` are outstanding: the planner said out loud that it's missing
 *    what it needs, and guessing is exactly what it was told not to do.
 *  - never a `blocked` step, and never one already `done`.
 *  - `skipStepIds` drops steps the caller has already tried and got nowhere with, so a step that
 *    can't be finished unattended doesn't get retried forever.
 *
 * Most urgent first: the step's own due date, else its plan's deadline; undated work sorts last, ties
 * broken by plan age so the queue is stable. PURE.
 */
export function nextAutoStep(plans: TaskPlan[], opts: { skipStepIds?: ReadonlySet<string> } = {}): AutoStepPick | undefined {
  const skip = opts.skipStepIds ?? new Set<string>();
  const candidates: AutoStepPick[] = [];
  for (const plan of plans) {
    if (plan.status !== "active" || plan.planned === false) continue;
    if (plan.needsReplan) continue;
    if (plan.clarifyingQuestions?.length) continue;
    const step = nextReadyStep(plan);
    if (!step || step.actor !== "ai_prep" || step.status === "done" || step.status === "blocked") continue;
    if (skip.has(step.id)) continue;
    candidates.push({ plan, step });
  }
  const due = (c: AutoStepPick): string => c.step.dueIso ?? c.plan.deadlineIso ?? "9999-12-31";
  return candidates.sort((a, b) => due(a).localeCompare(due(b)) || a.plan.createdAt - b.plan.createdAt)[0];
}

/** Compact plan context to prepend to the execution chat's system prompt (carries the
 * ids the step tools need). */
/** `YYYY-MM-DD` in LOCAL time — the reader's day, not UTC's. PURE. */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A date the model can act on: the day itself, plus how long ago that was.
 *
 * Both halves earn their place. The absolute date is what lines up with a deadline and with today's
 * date at the top of the prompt; the relative one is what actually answers "is this stale" without
 * making the model do arithmetic it is bad at. PURE.
 */
export function whenLabel(ms: number, now = Date.now()): string {
  const day = isoDay(new Date(ms));
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return `${day} (today)`;
  if (days === 1) return `${day} (yesterday)`;
  return `${day} (${days} days ago)`;
}

/**
 * WHERE ELSE this task's detail lives — named, with the id needed to go and get it.
 *
 * A task carries its origin in `source`, and nothing ever told the model. So a task raised from a
 * calendar event — whose DESCRIPTION is where its running detail lives, an RSVP list, a packing
 * list, a status per person — arrived looking like a bare title and three steps, and a model asked
 * to "update the RSVP list" searched the places it knew about, found nothing, and reported that
 * there was nothing to find. The list was two fields away the whole time.
 *
 * A `typed` task has no elsewhere, so it gets no line rather than a line saying so. PURE.
 */
export function taskSourceNote(source: TaskSource): string {
  const eventLine = (eventId: string, summary?: string): string =>
    `SOURCE: a CALENDAR EVENT${summary ? ` — “${summary}”` : ""} (eventId: ${eventId}). An event's DESCRIPTION is ` +
    `where its running detail lives (an RSVP or attendance list, a packing list, a status per person). READ IT with ` +
    `list_events${summary ? ` (query: "${summary}")` : ""} before concluding this task has no list/detail attached — ` +
    'and update it in place with update_event "setLines" rather than rewriting it.';
  const emailLine = (emailId: string, subject?: string, from?: string): string =>
    `SOURCE: an EMAIL${subject ? ` — “${subject}”` : ""}${from ? ` from ${from}` : ""} (emailId: ${emailId}). ` +
    "Read it with read_email (and read_attachment for anything on it) before saying you can't find what it referred to.";
  switch (source.kind) {
    case "calendar":
      return eventLine(source.eventId, source.summary);
    case "email":
      return emailLine(source.emailId, source.subject, source.from);
    case "scan":
      // A scanned item is one or the other; it was surfaced FROM whichever id it carries.
      if (source.eventId) return eventLine(source.eventId);
      if (source.emailId) return emailLine(source.emailId, undefined, source.from);
      return "";
    case "google":
      return `SOURCE: Google Tasks (taskId: ${source.taskId}) — its notes may carry detail the reader added there.`;
    default:
      return "";
  }
}

/** How much accumulated context rides along in the prompt before the rest is left to get_task_plan. */
const DOSSIER_NOTES_CHARS = 1500;

/** Keep the END of a body of notes (the newest writing) and say how much went. PURE. */
function tailNotes(text: string, limit: number): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  const cut = t.slice(t.length - limit);
  const at = cut.indexOf("\n");
  const kept = at >= 0 ? cut.slice(at + 1) : cut;
  return `[earlier notes trimmed — get_task_plan returns them in full]\n${kept}`;
}

/**
 * EVERYTHING A TASK ALREADY KNOWS, rendered for the model.
 *
 * The app works hard to accumulate this — `harvestTaskContext` records every link and attachment
 * name the reader hands a task chat, `save_task_context` records what each session and each bound
 * background run found, the planner leaves its research behind, and steps carry generated documents.
 * None of it was ever read back. It went into `userNotes` and came out only when the task was
 * RE-PLANNED, which is to say: the model that needed it never saw it, and the reader watched it
 * search too narrowly and give up on material it had been handed directly.
 *
 * Bounded, and honest about the bound — the notes are tailed to the NEWEST and say when they were
 * cut, because a task worked over weeks accumulates more than belongs in every turn. PURE.
 */
export function taskDossier(plan: TaskPlan, notesChars = DOSSIER_NOTES_CHARS): string {
  const docs = plan.steps.flatMap((s) => (s.docs ?? []).map((d) => ({ doc: d, step: s })));
  const sections = [
    taskSourceNote(plan.source),
    plan.userNotes?.trim()
      ? "SAVED CONTEXT ON THIS TASK (links and files the reader handed it, and what earlier sessions and background " +
        `runs found — this is the task's memory, treat it as given):\n${tailNotes(plan.userNotes, notesChars)}`
      : "",
    plan.researchNotes?.trim() ? `RESEARCH FROM PLANNING THIS TASK:\n${tailNotes(plan.researchNotes, notesChars)}` : "",
    docs.length
      ? "DOCUMENTS THIS TASK ALREADY HAS (get_task_plan returns their contents — read the relevant one BEFORE " +
        `building anything that duplicates it):\n${docs.map(({ doc, step }) => `- “${doc.title}” (${doc.kind}) — on step “${step.title}”`).join("\n")}`
      : "",
    plan.watches?.length ? `BACKGROUND WATCHES on this task:\n${plan.watches.map((w) => `- ${w.title}: ${w.prompt}`).join("\n")}` : "",
  ].filter(Boolean);
  return sections.join("\n");
}

export function tasksIndexBlock(plan: TaskPlan, now = Date.now()): string {
  const ready = nextReadyStep(plan);
  const done = plan.steps.filter((s) => s.status === "done");
  const lastDone = done.reduce((m, s) => Math.max(m, s.doneAt ?? 0), 0);
  // WHEN, so the model can tell a task it touched this morning from one that has sat for a month.
  // Today's date is already at the top of the prompt, so these are directly comparable.
  const dates =
    `Created ${whenLabel(plan.createdAt, now)} · last touched ${whenLabel(plan.updatedAt, now)}` +
    ` · ${done.length} of ${plan.steps.length} steps done` +
    (lastDone > 0 ? ` (most recent ${whenLabel(lastDone, now)})` : "");
  const lines = [
    `ACTIVE TASK: ${plan.title}${plan.deadlineIso ? ` — deadline ${plan.deadlineIso}` : ""} (plan id: ${plan.id})`,
    plan.summary ? plan.summary : "",
    dates,
    plan.clarifyingQuestions?.length
      ? "OPEN QUESTIONS you still need answered to finalize this plan — ASK the reader these FIRST, " +
        "then refine the plan with their answers:\n" +
        plan.clarifyingQuestions.map((q) => `- ${q}`).join("\n")
      : "",
    ready
      ? `Current step (${ready.actor === "ai_prep" ? "you can prep this" : "the reader does this"}, step id: ${ready.id}): ` +
        `${ready.title}${ready.detail ? ` — ${ready.detail}` : ""}` +
        (ready.links.length ? `\nLinks: ${ready.links.map((l) => l.url).join(", ")}` : "")
      : "All steps are done.",
    // What the task already knows. Inline, not behind a tool call, because the failure this fixes is
    // the model not KNOWING there was anything to fetch — it searched the places it could see, found
    // nothing, and said so. Material it can't see is material it will not go looking for.
    taskDossier(plan),
  ].filter(Boolean);
  return lines.join("\n");
}

/** The id of the plan whose execution chat is `activeSessionId` (the task currently being
 * "worked" in chat), or undefined when that session isn't tied to a plan. */
export function resolveActiveTaskPlanId(plans: TaskPlan[], activeSessionId: string | undefined): string | undefined {
  if (!activeSessionId) return undefined;
  return plans.find((p) => p.sessionId === activeSessionId)?.id;
}

/** A chat-session label for a task's dedicated chat: the plan title, trimmed and length-capped
 * (titles can be a full sentence), falling back to "Task" when blank. Pure for unit testing. */
export function sessionLabelForPlan(plan: { title?: string }): string {
  const t = (plan.title ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "Task";
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

// ------------------------------------------------------------------- ignore list

function isIgnoreRule(v: unknown): v is IgnoreRule {
  const r = v as IgnoreRule;
  return r != null && (r.kind === "item" || r.kind === "sender" || r.kind === "phrase") && typeof r.value === "string";
}

export async function loadIgnored(store: VisualReaderStore): Promise<IgnoreRule[]> {
  try {
    const raw = await store.getMemo?.(TASK_IGNORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isIgnoreRule).slice(0, MAX_IGNORE_RULES);
  } catch {
    return [];
  }
}

/** Add an ignore rule (deduped by kind+value); oldest evicted past the cap. */
export async function addIgnore(store: VisualReaderStore, rule: { kind: IgnoreRule["kind"]; value: string }): Promise<IgnoreRule[]> {
  const value = rule.value.trim().slice(0, MAX_URL_CHARS);
  if (!value) return loadIgnored(store);
  const rules = await loadIgnored(store);
  const key = `${rule.kind}:${value.toLowerCase()}`;
  const kept = rules.filter((r) => `${r.kind}:${r.value.toLowerCase()}` !== key);
  kept.push({ kind: rule.kind, value, at: Date.now() });
  const bounded = kept.slice(-MAX_IGNORE_RULES);
  await store.putMemo?.(TASK_IGNORE_KEY, JSON.stringify(bounded));
  return bounded;
}

/** Remove an ignore rule (by kind+value, case-insensitive) — the undo when a removed task is
 * restored, so a sender/phrase you'd suppressed can surface again. */
export async function removeIgnore(store: VisualReaderStore, rule: { kind: IgnoreRule["kind"]; value: string }): Promise<IgnoreRule[]> {
  const key = `${rule.kind}:${rule.value.trim().toLowerCase()}`;
  const kept = (await loadIgnored(store)).filter((r) => `${r.kind}:${r.value.toLowerCase()}` !== key);
  await store.putMemo?.(TASK_IGNORE_KEY, JSON.stringify(kept));
  return kept;
}

/** The source's email/event id, for ignore-by-item and plan dedup. */
export function sourceId(source: TaskSource): string | undefined {
  if (source.kind === "email") return source.emailId;
  if (source.kind === "calendar") return source.eventId;
  if (source.kind === "scan") return source.emailId ?? source.eventId;
  return undefined;
}

/** The source's from-address (email/scan), for "ignore this sender" on a plan. */
export function sourceFrom(source: TaskSource): string | undefined {
  return source.kind === "email" || source.kind === "scan" ? source.from : undefined;
}

/** True when a scan candidate matches a persistent ignore rule (its item id, its
 * from-address, or a subject phrase). */
export function isIgnored(ignored: readonly IgnoreRule[], candidate: TaskCandidate): boolean {
  const id = sourceId(candidate.source);
  const from = (candidate.from ?? "").toLowerCase();
  const title = candidate.title.toLowerCase();
  return ignored.some((r) => {
    const v = r.value.toLowerCase();
    if (r.kind === "item") return !!id && id === r.value;
    if (r.kind === "sender") return !!from && from.includes(v);
    return !!v && title.includes(v);
  });
}
