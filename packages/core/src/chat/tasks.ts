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
export const MAX_IGNORE_RULES = 300;
const MAX_TITLE_CHARS = 200;
const MAX_DETAIL_CHARS = 1000;
const MAX_NOTES_CHARS = 4000;
const MAX_DOC_BODY_CHARS = 20_000;
const MAX_URL_CHARS = 600;

export type StepActor = "ai_prep" | "user_action";
export type StepStatus = "pending" | "ready" | "in_progress" | "blocked" | "done";
export type PlanStatus = "active" | "completed" | "archived";

export type TaskSource =
  | { kind: "typed"; text: string }
  | { kind: "email"; emailId: string; subject?: string }
  | { kind: "calendar"; eventId: string; summary?: string }
  | { kind: "scan"; emailId?: string; eventId?: string };

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
  createdAt: number;
  updatedAt: number;
  /** The buddy chat session that executes this plan (reuses multi-session chat). */
  sessionId?: string;
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
  createdAt?: number;
  sessionId?: string;
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
    ...(input.deadlineIso ? { deadlineIso: cap(input.deadlineIso, 40) } : {}),
    ...(typeof input.leadTimeDays === "number" && Number.isFinite(input.leadTimeDays)
      ? { leadTimeDays: Math.max(0, Math.round(input.leadTimeDays)) }
      : {}),
    ...(input.estCost ? { estCost: cap(input.estCost, 60) } : {}),
    steps,
    ...(input.researchNotes ? { researchNotes: cap(input.researchNotes, MAX_NOTES_CHARS) } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
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

// ------------------------------------------------------------- pure selectors

/** Mark the current (first non-done) step done and set the next one ready. Pure —
 * returns the updated plan and the newly-ready step (undefined when all done → the
 * plan is marked completed). */
export function advanceStep(plan: TaskPlan): { plan: TaskPlan; ready?: TaskStep } {
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  const currentIdx = ordered.findIndex((s) => s.status !== "done");
  if (currentIdx === -1) return { plan: { ...plan, status: "completed" } };
  const steps = ordered.map((s, i) =>
    i === currentIdx ? { ...s, status: "done" as StepStatus } : s,
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

/** The step the user should tackle next: the first "ready", else the first non-done. */
export function nextReadyStep(plan: TaskPlan): TaskStep | undefined {
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  return ordered.find((s) => s.status === "ready") ?? ordered.find((s) => s.status !== "done");
}

/** Compact plan context to prepend to the execution chat's system prompt (carries the
 * ids the step tools need). */
export function tasksIndexBlock(plan: TaskPlan): string {
  const ready = nextReadyStep(plan);
  const lines = [
    `ACTIVE TASK: ${plan.title}${plan.deadlineIso ? ` — deadline ${plan.deadlineIso}` : ""} (plan id: ${plan.id})`,
    plan.summary ? plan.summary : "",
    ready
      ? `Current step (${ready.actor === "ai_prep" ? "you can prep this" : "the reader does this"}, step id: ${ready.id}): ` +
        `${ready.title}${ready.detail ? ` — ${ready.detail}` : ""}` +
        (ready.links.length ? `\nLinks: ${ready.links.map((l) => l.url).join(", ")}` : "")
      : "All steps are done.",
  ].filter(Boolean);
  return lines.join("\n");
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

/** The source's email/event id, for ignore-by-item and plan dedup. */
export function sourceId(source: TaskSource): string | undefined {
  if (source.kind === "email") return source.emailId;
  if (source.kind === "calendar") return source.eventId;
  if (source.kind === "scan") return source.emailId ?? source.eventId;
  return undefined;
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
