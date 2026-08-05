import type { VisualReaderStore } from "../storage/store.js";
import type { BuddyPlan } from "./buddy-tools.js";

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

/**
 * ONE PART OF A SCHEDULED JOB — the unit that stops a recurring task doing half of itself.
 *
 * A scheduled task used to be a single instruction, fired as one chat message, and judged a success
 * if ANYTHING at all came back. So "research the venue options and put the shortlist on my calendar"
 * did the research — the salient, interesting half — said something about it, and passed. The
 * calendar was never touched, and nothing in the app was in a position to notice: there was no
 * record of the job having parts, so there was nothing to check the second one against.
 *
 * Written down, the parts become checkable. `needs` is the same token `set_plan` takes ("image",
 * "file", "command", "text", "reply", or a tool name) and means the same thing — what would PROVE
 * this part done — so a stored checklist compiles through exactly the machinery the chat's own
 * checklists already run on, rather than a second engine that would drift from it.
 */
export interface ScheduledStep {
  /** The action, phrased as one self-contained instruction ("Add the shortlist to my calendar"). */
  do: string;
  /** What proves it done — a `set_plan` needs token. Omitted ⇒ inferred from the wording. */
  needs?: string;
}

export interface ScheduledTask {
  id: string;
  title: string;
  /** The natural-language instruction sent to the assistant when it fires. With `steps`, this is the
   * job's GOAL — the context every step is done in service of — rather than the whole instruction. */
  prompt: string;
  /**
   * The parts of the job, in order. Authored when the task is scheduled, editable afterwards, and
   * re-used verbatim on every run — which is what makes a recurring task consistent instead of
   * re-derived (and re-derived differently) each time it fires.
   *
   * Absent or empty ⇒ the task runs the old way, as a single prompt. Every task created before this
   * existed is in that state, so the fallback is not a nicety; it is most of the stored ones.
   */
  steps?: ScheduledStep[];
  rule: ScheduleRule;
  /** Local time-of-day "HH:MM" (24h) it should run. Default "09:00". */
  time: string;
  /** ONE-TIME (`rule: "once"`): the local calendar day "YYYY-MM-DD" it runs on, paired with `time`.
   * Omitted ⇒ the next time `time` comes around (today if it's still ahead, else tomorrow), which is
   * what "remind me at 5pm" means. Ignored by the recurring rules. */
  date?: string;
  /**
   * ITS OWN WORKSPACE — the chat session this task lives and works in.
   *
   * Every scheduled action used to share one ⏰ Scheduled chat, which made each run a message in a
   * thread of unrelated jobs: no place for a task's own history to accumulate, nothing for the
   * reader to open and work in, and every run starting from a prompt string because there was
   * nowhere else for its state to be.
   *
   * The session is HIDDEN from the chat switcher and reached from ⏰ Scheduled instead — it is the
   * task's window, not another conversation to scroll past. Minted on first use, so tasks stored
   * before this adopt one the first time they run or are opened; the id is then theirs for good, and
   * their history survives being closed exactly like a task plan's chat does.
   */
  sessionId?: string;
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
  /**
   * What the last run actually PRODUCED, recorded once the turn settled.
   *
   * `lastRunIso` is stamped before the turn starts, deliberately — advancing first is what stops a
   * slow turn double-firing. But that made "last ran 7:00" a record of having been DISPATCHED, and a
   * run that then produced nothing was indistinguishable from one that worked. The reader is told it
   * ran and finds nothing, with nowhere to look for why.
   */
  lastRunNote?: string;
  /** ISO datetime when it's next due to run. */
  nextDueIso: string;
}

const KEY = "scheduled-tasks";
const MAX_TASKS = 40;
const MAX_TITLE = 120;
const MAX_PROMPT = 1000;
/** Bounded like everything else stored here. A recurring job with more than a dozen parts is a task
 * plan, not a scheduled action, and the checklist executor hands these over one turn at a time. */
const MAX_STEPS = 12;
const MAX_STEP = 200;

/** Normalise authored steps: trim, drop the empty ones, cap the count and each one's length. PURE. */
export function normalizeScheduledSteps(steps: readonly Partial<ScheduledStep>[] | undefined): ScheduledStep[] {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => ({
      do: (typeof s?.do === "string" ? s.do : "").trim().slice(0, MAX_STEP),
      ...(typeof s?.needs === "string" && s.needs.trim() ? { needs: s.needs.trim().toLowerCase() } : {}),
    }))
    .filter((s) => s.do.length > 0)
    .slice(0, MAX_STEPS);
}

/**
 * A scheduled task's checklist as a {@link BuddyPlan} — the shape the chat's own checklist machinery
 * already speaks, so a stored job compiles through `compileWorkflow` (app-managed) or drops straight
 * into the model-driven plan, with no second executor to keep in step with the first.
 *
 * The task's `prompt` becomes the GOAL. That is what makes each step readable on its own when the
 * executor hands it over without the others in front of it: "add the shortlist to my calendar" needs
 * to know which shortlist, and the goal is where that lives.
 *
 * `undefined` when there are no steps — the caller then fires the task the old way. PURE.
 */
export function scheduledPlan(task: Pick<ScheduledTask, "title" | "prompt" | "steps">): BuddyPlan | undefined {
  const steps = normalizeScheduledSteps(task.steps);
  if (steps.length === 0) return undefined;
  return {
    goal: task.prompt.trim() || task.title.trim(),
    steps: steps.map((s) => ({
      text: s.do,
      status: "pending" as const,
      ...(s.needs ? { needs: s.needs } : {}),
    })),
  };
}

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
/**
 * Which day of the week a weekly task actually runs on.
 *
 * The field is optional, and two places filled it in differently: the scheduler read
 * `weekday ?? from.getDay()` — the day the task happened to be created — while the panel read
 * `WEEKDAYS[weekday ?? 1]` and printed "Monday". So the app told the reader it was a Monday task and
 * then ran it on a Saturday, and both halves were behaving exactly as written.
 *
 * `nextDueIso` is the tie-breaker because it is the truth: it is the moment the task will actually
 * fire, so the day it falls on IS the task's day. Reading it here heals tasks already stored without
 * a weekday, with no migration. PURE.
 */
export function weekdayOf(task: Pick<ScheduledTask, "weekday" | "nextDueIso">): number | undefined {
  if (task.weekday !== undefined) return task.weekday;
  return validIso(task.nextDueIso) ? new Date(task.nextDueIso).getDay() : undefined;
}

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
    const target = weekdayOf(task) ?? from.getDay();
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
    ...((): { steps?: ScheduledStep[] } => {
      const steps = normalizeScheduledSteps(input.steps);
      return steps.length ? { steps } : {};
    })(),
    ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
    ...(input.planId?.trim() ? { planId: input.planId.trim() } : {}),
    ...(input.weekday !== undefined ? { weekday: Math.min(6, Math.max(0, Math.round(input.weekday))) } : {}),
    ...(input.dayOfMonth !== undefined ? { dayOfMonth: Math.min(31, Math.max(1, Math.round(input.dayOfMonth))) } : {}),
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? Date.now(),
    ...(input.lastRunIso ? { lastRunIso: input.lastRunIso } : {}),
    ...(input.lastRunNote ? { lastRunNote: input.lastRunNote } : {}),
    nextDueIso: input.nextDueIso ?? "",
  };
  // Compute the first run when not supplied (fresh task) — or when what we were handed isn't a real
  // datetime, so a corrupt/empty stored value can never survive as an Invalid Date.
  if (!validIso(base.nextDueIso)) base.nextDueIso = nextDue(base, now).toISOString();
  // A weekly task keeps its day EXPLICITLY from here on, resolved from the run it is actually
  // scheduled for. One stored fact, read by both the scheduler and the panel, instead of two
  // defaults that disagreed.
  if (base.rule === "weekly" && base.weekday === undefined) {
    return { ...base, weekday: new Date(base.nextDueIso).getDay() };
  }
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
  // WITH A CHECKLIST, the parts are not restated here. The plan rides the prompt by its own route —
  // compiled and handed over one step at a time when the app manages steps, injected as the current
  // checklist when the model drives — and writing them out a second time would be the same list in
  // two voices, one of which the executor isn't reading. What this line owes the run is the things
  // the checklist can't say: that it is a scheduled firing, and what window it covers.
  //
  // "Every step" is worth saying out loud. Half-finishing is the whole reported failure: a job that
  // researched something and never wrote the result anywhere, reported as done because a research
  // step is the interesting one and something did come back.
  if (scheduledPlan(task)) {
    return (
      `⏰ Scheduled task “${task.title}”. ${since}${record} Work its checklist now — EVERY step, in order, ` +
      `not just the first or the interesting one. The job as a whole: ${task.prompt}`
    );
  }
  return `⏰ Scheduled task “${task.title}”. ${since}${record} Do this now: ${task.prompt}`;
}

/**
 * What to record about a finished run, judged on whether anything actually LANDED in the chat rather
 * than on the run having been started.
 *
 * `where` names the session, because the other half of "it says it ran and I can't find it" is that
 * scheduled work deliberately runs in its own chat — so a reader looking at the main one sees nothing
 * however well it went. PURE.
 */
export type ScheduledRunOutcome = "replied" | "nothing" | "unconfirmed";

export function scheduledRunNote(outcome: ScheduledRunOutcome, where: string): string {
  if (outcome === "replied") return `replied in ${where}`;
  // "Nothing came back" and "we couldn't see whether anything came back" need different fixes and
  // would look identical if both were reported as failure. A task-bound action runs in its OWN chat,
  // which is precisely the one a reader or a background sweep is most likely to switch away from
  // mid-run — and the evidence for the run lives in whichever conversation is on screen when it
  // settles. So when the chat changed underneath it, say THAT rather than guess at an outcome.
  if (outcome === "unconfirmed") return `ran, but the chat changed before it finished — check ${where}`;
  return `no reply — nothing landed in ${where}`;
}

/**
 * Change WHEN a task runs, recomputing its next occurrence from now.
 *
 * Editing rather than delete-and-recreate, deliberately: a recurring action's `lastRunIso` is the
 * window each run is given ("cover only what is NEW since then"), so recreating one silently throws
 * away everything it already handled and the next run re-reports it all. The history is the part
 * worth keeping; only the cadence was wrong. PURE.
 */
export function rescheduleTask(
  task: ScheduledTask,
  when: { rule?: ScheduleRule; time?: string; weekday?: number; dayOfMonth?: number; date?: string },
  now = new Date(),
): ScheduledTask {
  const rule = when.rule ?? task.rule;
  // Strip every cadence field first, then put back only the one this rule uses. Spreading the task
  // and conditionally ADDING would leave a stale day-of-week on a monthly rule — invisible until the
  // rule changed back and it steered the schedule again.
  const { weekday: _wd, dayOfMonth: _dom, date: _date, ...bare } = task;
  const next: ScheduledTask = {
    ...bare,
    rule,
    time: clampTime(when.time ?? task.time),
    // Each rule keeps only the field that means anything to it, so a day-of-week left over from a
    // weekly rule can't quietly steer a monthly one.
    ...(rule === "weekly"
      ? { weekday: Math.min(6, Math.max(0, Math.round(when.weekday ?? weekdayOf(task) ?? now.getDay()))) }
      : {}),
    ...(rule === "monthly" ? { dayOfMonth: Math.min(31, Math.max(1, Math.round(when.dayOfMonth ?? task.dayOfMonth ?? now.getDate()))) } : {}),
    ...(rule === "once" && (when.date ?? task.date) ? { date: (when.date ?? task.date)!.trim() } : {}),
    nextDueIso: "",
  };
  return { ...next, nextDueIso: nextDue(next, now).toISOString() };
}

/** A human description of a task's cadence (for the UI). */
export function describeSchedule(task: ScheduledTask): string {
  const at = `at ${task.time}`;
  if (task.rule === "daily") return `Daily ${at}`;
  // Never invent a day. Saying "Monday" for a task with no weekday stored is how the app came to
  // report that a Monday-only task had run on a Saturday.
  if (task.rule === "weekly") {
    const wd = weekdayOf(task);
    return wd === undefined ? `Weekly ${at}` : `Weekly on ${WEEKDAYS[wd]} ${at}`;
  }
  if (task.rule === "monthly") return `Monthly on day ${task.dayOfMonth ?? 1} ${at}`;
  // One-shot: show the actual moment it runs (never "Invalid Date" — see validIso).
  return validIso(task.nextDueIso) ? `Once — ${new Date(task.nextDueIso).toLocaleString()}` : `Once ${at}`;
}

/**
 * What a scheduled task's own workspace is called, in the reader's terms.
 *
 * Mirrors `sessionLabelForPlan` — the ⏰ marks it as a scheduled action's window rather than a chat
 * someone started, which matters because these are deliberately kept out of the chat switcher and a
 * reader meeting one has to be able to tell what they are looking at. PURE.
 */
export function scheduledSessionLabel(task: Pick<ScheduledTask, "title">): string {
  const t = (task.title ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "⏰ Scheduled task";
  return `⏰ ${t.length > 58 ? `${t.slice(0, 55).trimEnd()}…` : t}`;
}

/**
 * Give a task its own workspace id if it hasn't got one — the migration, for every task stored
 * before workspaces existed.
 *
 * Deliberately lazy rather than a sweep over the store: a task adopts its window the first time it
 * is opened or actually runs, so nothing has to walk (and rewrite) every stored task on boot, and a
 * task that never fires again never grows an empty chat. `mint` is injected because the id has to be
 * unique per session and this file is pure — the host passes the same generator its chats use.
 *
 * Returns the task UNCHANGED when it already has one, so callers can run it unconditionally and
 * persist only on a real change. PURE.
 */
export function withScheduledWorkspace(task: ScheduledTask, mint: () => string): ScheduledTask {
  return task.sessionId?.trim() ? task : { ...task, sessionId: mint() };
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
