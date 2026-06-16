import type { VisualReaderStore } from "../storage/store.js";

/**
 * Scheduled / periodic tasks — recurring agentic actions the assistant runs on a
 * cadence ("every morning summarise my unread email", "every Friday give me a market
 * recap", "monthly, review my budget"). Stored in the `memos` KV store; the host's
 * while-open loop fires the ones that are due into the buddy chat (there's no always-on
 * daemon, so they run when the app is open — Google reminders cover the rest).
 *
 * Pure: the entity, the bounded store helpers, and the scheduling math (next-due
 * computation, due selection, advance-after-run) are all unit-tested.
 */

export type ScheduleRule = "once" | "daily" | "weekly" | "monthly";

export interface ScheduledTask {
  id: string;
  title: string;
  /** The natural-language instruction sent to the assistant when it fires. */
  prompt: string;
  rule: ScheduleRule;
  /** Local time-of-day "HH:MM" (24h) it should run. Default "09:00". */
  time: string;
  /** Weekly: 0–6 (Sun–Sat). */
  weekday?: number;
  /** Monthly: day-of-month 1–31. */
  dayOfMonth?: number;
  enabled: boolean;
  createdAt: number;
  lastRunIso?: string;
  /** ISO datetime when it's next due to run. */
  nextDueIso: string;
}

const KEY = "scheduled-tasks";
const MAX_TASKS = 40;
const MAX_TITLE = 120;
const MAX_PROMPT = 1000;

/** A stable id for a new scheduled task. */
export function scheduledId(): string {
  return `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clampTime(time: string | undefined): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!m) return "09:00";
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function atTime(base: Date, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(base);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/**
 * The next datetime (strictly after `from`) a recurring task should run, per its rule +
 * time. "once" returns its current nextDue unchanged (it's a one-shot).
 */
export function nextDue(task: Pick<ScheduledTask, "rule" | "time" | "weekday" | "dayOfMonth" | "nextDueIso">, from: Date): Date {
  const time = clampTime(task.time);
  if (task.rule === "once") return new Date(task.nextDueIso);
  if (task.rule === "daily") {
    const d = atTime(from, time);
    return d > from ? d : atTime(addDays(from, 1), time);
  }
  if (task.rule === "weekly") {
    const target = task.weekday ?? from.getDay();
    let delta = (target - from.getDay() + 7) % 7;
    if (delta === 0 && atTime(from, time) <= from) delta = 7;
    return atTime(addDays(from, delta), time);
  }
  // monthly
  const dom = task.dayOfMonth ?? from.getDate();
  const thisMonth = atTime(new Date(from.getFullYear(), from.getMonth(), dom), time);
  return thisMonth > from ? thisMonth : atTime(new Date(from.getFullYear(), from.getMonth() + 1, dom), time);
}

/** Normalise/cap a partial task into a stored ScheduledTask, computing its first due time. */
export function normalizeScheduledTask(input: Partial<ScheduledTask> & { title: string; prompt: string }, now = new Date()): ScheduledTask {
  const rule: ScheduleRule = input.rule === "daily" || input.rule === "weekly" || input.rule === "monthly" || input.rule === "once" ? input.rule : "daily";
  const time = clampTime(input.time);
  const base = {
    id: input.id ?? scheduledId(),
    title: input.title.trim().slice(0, MAX_TITLE) || "Scheduled task",
    prompt: input.prompt.trim().slice(0, MAX_PROMPT),
    rule,
    time,
    ...(input.weekday !== undefined ? { weekday: Math.min(6, Math.max(0, Math.round(input.weekday))) } : {}),
    ...(input.dayOfMonth !== undefined ? { dayOfMonth: Math.min(31, Math.max(1, Math.round(input.dayOfMonth))) } : {}),
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? Date.now(),
    ...(input.lastRunIso ? { lastRunIso: input.lastRunIso } : {}),
    nextDueIso: input.nextDueIso ?? "",
  };
  // Compute the first run when not supplied (or for a fresh recurring task).
  if (!base.nextDueIso) base.nextDueIso = nextDue(base, now).toISOString();
  return base;
}

/** Enabled tasks whose next-due time has passed (`now` or earlier). */
export function dueScheduledTasks(tasks: ScheduledTask[], now = new Date()): ScheduledTask[] {
  return tasks.filter((t) => t.enabled && t.nextDueIso && new Date(t.nextDueIso) <= now);
}

/** After a task runs: stamp lastRun, advance nextDue (or disable a "once" task). */
export function advanceSchedule(task: ScheduledTask, ranAt = new Date()): ScheduledTask {
  if (task.rule === "once") return { ...task, enabled: false, lastRunIso: ranAt.toISOString() };
  return { ...task, lastRunIso: ranAt.toISOString(), nextDueIso: nextDue(task, ranAt).toISOString() };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A human description of a task's cadence (for the UI). */
export function describeSchedule(task: ScheduledTask): string {
  const at = `at ${task.time}`;
  if (task.rule === "daily") return `Daily ${at}`;
  if (task.rule === "weekly") return `Weekly on ${WEEKDAYS[task.weekday ?? 1]} ${at}`;
  if (task.rule === "monthly") return `Monthly on day ${task.dayOfMonth ?? 1} ${at}`;
  return `Once — ${new Date(task.nextDueIso).toLocaleString()}`;
}

// ---- Store (bounded JSON array under one key, mirroring tasks.ts) -----------

export async function loadScheduledTasks(store: VisualReaderStore): Promise<ScheduledTask[]> {
  try {
    const raw = await store.getMemo?.(KEY);
    const arr = raw ? (JSON.parse(raw) as ScheduledTask[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function persist(store: VisualReaderStore, tasks: ScheduledTask[]): Promise<void> {
  await store.putMemo?.(KEY, JSON.stringify(tasks.slice(-MAX_TASKS)));
}
export async function upsertScheduledTask(store: VisualReaderStore, task: ScheduledTask): Promise<ScheduledTask[]> {
  const tasks = await loadScheduledTasks(store);
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) tasks[i] = task;
  else tasks.push(task);
  await persist(store, tasks);
  return tasks;
}
export async function deleteScheduledTask(store: VisualReaderStore, id: string): Promise<ScheduledTask[]> {
  const tasks = (await loadScheduledTasks(store)).filter((t) => t.id !== id);
  await persist(store, tasks);
  return tasks;
}
