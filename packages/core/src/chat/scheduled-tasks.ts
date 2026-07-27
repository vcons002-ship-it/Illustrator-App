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
  /** ONE-TIME (`rule: "once"`): the local calendar day "YYYY-MM-DD" it runs on, paired with `time`.
   * Omitted ⇒ the next time `time` comes around (today if it's still ahead, else tomorrow), which is
   * what "remind me at 5pm" means. Ignored by the recurring rules. */
  date?: string;
  /** BOUND TASK: the task plan this action maintains. A bound run happens inside that task's own
   * chat — with its conversation, checklist and files already loaded — instead of the generic
   * Scheduled chat, so a recurring "keep this up to date" job picks up where it left off rather than
   * re-deriving the job from a prompt string every time. Unset ⇒ a standalone action. */
  planId?: string;
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
/** A date at `dom` (day-of-month) in year/month, at `time`, with `dom` CLAMPED to that month's real last
 * day. `new Date(y, m, 31)` silently OVERFLOWS a 30-day month (Sep 31 → Oct 1) / February (Feb 31 → Mar 3),
 * which would make a day-31 monthly schedule skip the short months entirely. Clamping instead fires it on
 * the month's LAST day (Sep 30, Feb 28/29) and — because the stored dayOfMonth is unchanged — the following
 * long month still fires on the 31st. `new Date(y, m+1, 0)` is day 0 of the next month = this month's last. */
function atDayOfMonth(year: number, month: number, dom: number, time: string): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return atTime(new Date(year, month, Math.min(dom, lastDay)), time);
}
/** A LOCAL datetime from "YYYY-MM-DD" + "HH:MM", or undefined when the date isn't a real calendar day.
 * Built field-wise (not `new Date(string)`, which reads a bare date as UTC and would shift the run into
 * the wrong local day); the round-trip check rejects overflow like "2026-02-31". */
function onDate(date: string, time: string): Date | undefined {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = atTime(new Date(y, mo - 1, d), time);
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return undefined;
  return at;
}
/** Is this a usable ISO datetime string? (Guards every place a bad/absent value would otherwise become
 * an `Invalid Date` — whose `.toISOString()` THROWS.) */
function validIso(iso: string | undefined): boolean {
  return !!iso && !Number.isNaN(new Date(iso).getTime());
}

/**
 * The next datetime (strictly after `from`) a task should run, per its rule + time.
 *
 * "once" resolves its ONE run time from `date` + `time` (or, with no date, the next time `time` comes
 * around). It deliberately does NOT read `nextDueIso`: that used to be the only source, so a fresh
 * one-shot — which has no nextDueIso yet — produced `new Date("")` = Invalid Date, and the caller's
 * `.toISOString()` threw. One-time scheduling was therefore impossible until this computed a real date.
 */
export function nextDue(task: Pick<ScheduledTask, "rule" | "time" | "weekday" | "dayOfMonth" | "nextDueIso" | "date">, from: Date): Date {
  const time = clampTime(task.time);
  if (task.rule === "once") {
    const exact = task.date ? onDate(task.date, time) : undefined;
    if (exact) return exact;
    // Already-scheduled one-shot with no (or an unparseable) date: keep the time it was given.
    if (!task.date && validIso(task.nextDueIso)) return new Date(task.nextDueIso);
    const today = atTime(from, time);
    return today > from ? today : atTime(addDays(from, 1), time);
  }
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
  // monthly — clamp the day to each target month's length (see atDayOfMonth) so a day-29/30/31 schedule
  // fires on a short month's LAST day instead of overflowing into the next month.
  const dom = task.dayOfMonth ?? from.getDate();
  const thisMonth = atDayOfMonth(from.getFullYear(), from.getMonth(), dom, time);
  return thisMonth > from ? thisMonth : atDayOfMonth(from.getFullYear(), from.getMonth() + 1, dom, time);
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
    // A calendar day only means anything for a one-shot; drop it on the recurring rules so it can't
    // linger and confuse a later edit.
    ...(rule === "once" && input.date ? { date: input.date.trim() } : {}),
    ...(input.planId?.trim() ? { planId: input.planId.trim() } : {}),
    ...(input.weekday !== undefined ? { weekday: Math.min(6, Math.max(0, Math.round(input.weekday))) } : {}),
    ...(input.dayOfMonth !== undefined ? { dayOfMonth: Math.min(31, Math.max(1, Math.round(input.dayOfMonth))) } : {}),
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? Date.now(),
    ...(input.lastRunIso ? { lastRunIso: input.lastRunIso } : {}),
    nextDueIso: input.nextDueIso ?? "",
  };
  // Compute the first run when not supplied (fresh task) — or when what we were handed isn't a real
  // datetime, so a corrupt/empty stored value can never survive as an Invalid Date.
  if (!validIso(base.nextDueIso)) base.nextDueIso = nextDue(base, now).toISOString();
  return base;
}

/** Enabled tasks whose next-due time has passed (`now` or earlier). */
export function dueScheduledTasks(tasks: ScheduledTask[], now = new Date()): ScheduledTask[] {
  return tasks.filter((t) => t.enabled && t.nextDueIso && new Date(t.nextDueIso) <= now);
}

/**
 * Of the DUE actions, the ones that should actually fire now.
 *
 * An action bound to a task the reader has finished — completed, or archived by ignoring/removing it —
 * has nothing left to maintain, and firing it reopens that task's chat to do work that no longer
 * matters (chasing RSVPs for a party that already happened). Those are SKIPPED, not cancelled: the
 * judgement is made against the plan's status at fire time, so reopening the task, or a recurring task
 * rolling forward onto the same plan id, makes its actions live again with nothing to re-create.
 *
 * An action whose plan is GONE still runs — it falls back to the shared chat. A deleted plan can't
 * distinguish "the reader tidied up and wants this to stop" from "the plan was lost", and ⏰ Scheduled
 * already flags these for the reader to remove. PURE.
 */
export function runnableScheduledTasks(
  due: readonly ScheduledTask[],
  plans: readonly { id: string; status?: string }[],
): ScheduledTask[] {
  return due.filter((t) => {
    if (!t.planId) return true;
    const plan = plans.find((p) => p.id === t.planId);
    return !plan || (plan.status !== "completed" && plan.status !== "archived");
  });
}

/** After a task runs: stamp lastRun, advance nextDue (or disable a "once" task). */
export function advanceSchedule(task: ScheduledTask, ranAt = new Date()): ScheduledTask {
  if (task.rule === "once") return { ...task, enabled: false, lastRunIso: ranAt.toISOString() };
  return { ...task, lastRunIso: ranAt.toISOString(), nextDueIso: nextDue(task, ranAt).toISOString() };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The message a due scheduled action fires into the chat.
 *
 * Carries the LAST-RUN timestamp, which is what makes a repeating watch ("check for RSVP replies")
 * additive instead of amnesiac: without it every run re-reads the same mail from scratch and
 * re-reports (or double-counts) things it already handled. `lastRunIso` is already stamped by
 * `advanceSchedule`, so this needs no extra bookkeeping — it just tells the model the window it
 * actually has to look at. Call it with the task as it was BEFORE advancing, so the timestamp is the
 * PREVIOUS run rather than this one.
 *
 * A task-bound action also gets told to record what it finds on the task, so the next run (and the
 * reader) inherits the state rather than it living only in one reply. PURE.
 */
export function scheduledRunPrompt(task: ScheduledTask): string {
  const since = validIso(task.lastRunIso)
    ? `You last ran this at ${task.lastRunIso} — cover only what is NEW since then, and don't re-report or ` +
      "re-count anything you already handled on an earlier run."
    : "This is its first run, so start from what's already there.";
  const record = task.planId
    ? " Record what you find on this task (save_task_context) so the next run and the reader both pick it up, " +
      "and update the task's steps if what you found changes them."
    : "";
  return `⏰ Scheduled task “${task.title}”. ${since}${record} Do this now: ${task.prompt}`;
}

/** A human description of a task's cadence (for the UI). */
export function describeSchedule(task: ScheduledTask): string {
  const at = `at ${task.time}`;
  if (task.rule === "daily") return `Daily ${at}`;
  if (task.rule === "weekly") return `Weekly on ${WEEKDAYS[task.weekday ?? 1]} ${at}`;
  if (task.rule === "monthly") return `Monthly on day ${task.dayOfMonth ?? 1} ${at}`;
  // One-shot: show the actual moment it runs (never "Invalid Date" — see validIso).
  return validIso(task.nextDueIso) ? `Once — ${new Date(task.nextDueIso).toLocaleString()}` : `Once ${at}`;
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
