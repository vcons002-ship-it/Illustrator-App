/**
 * CALENDAR ARITHMETIC, DONE BY THE APP.
 *
 * Reported as: a scheduled task whose first step was "calculate tomorrow's pregnancy day number
 * (relative to July 28, 2026 being Day 28)" — and which could not work out how many days had passed.
 * Worse than failing, it was ticked ✓ done: nothing downstream can check a number, so whatever the
 * model produced became the day the rest of the job used.
 *
 * The app knew the date all along, but only as prose — "Sunday, June 15, 2026, 4:58:03 PM
 * (UTC-04:00)". To answer "how many days since July 28" from that, a model has to parse English into
 * a date and then carry across month boundaries of differing lengths, in its head, with no way for
 * anyone to see it got it wrong. That is the same class of work `calculate` exists to take away from
 * it; there was simply no equivalent for dates.
 *
 * PURE — `now` is injected, never read from the clock, so every case here is testable and a run's
 * arithmetic doesn't depend on when the test happens to be run.
 */

/** What a caller can ask for. Deliberately three: the questions that actually come up, not a
 * date library. Anything wider is better served by the reader saying what they mean. */
export type DateMathOp = "diff" | "add" | "weekday";

export interface DateMathInput {
  op: DateMathOp;
  /** `diff`: the earlier date. */
  from?: string;
  /** `diff`: the later date (defaults to today, since "how long since X" usually means "until now"). */
  to?: string;
  /** `add` / `weekday`: the date to work from (defaults to today). */
  date?: string;
  /** `add`: how many days to move. Negative goes back. */
  days?: number;
}

export interface DateMathResult {
  ok: boolean;
  error?: string;
  /** `diff`: whole days from `from` to `to`. Negative when `to` is earlier. */
  days?: number;
  /** `add`: the resulting calendar day, ISO "YYYY-MM-DD". */
  date?: string;
  /** The weekday of `date` (`add`/`weekday`). */
  weekday?: string;
  /** A one-line answer for the model to read back, so it never has to re-derive what it just asked. */
  text?: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MS_PER_DAY = 86_400_000;

/** A calendar day as UTC midnight. Working in UTC is what makes the subtraction below exact: a
 * local-time day is 23 or 25 hours long twice a year, and "days between" computed across a DST
 * boundary comes out fractional and then rounds the wrong way. */
function utcDay(y: number, m: number, d: number): number {
  return Date.UTC(y, m, d);
}

/** The reader's TODAY as a UTC-midnight day number — taken from the local fields of `now`, so
 * "today" means the day it is where they are, not where UTC is. */
function todayFrom(now: Date): number {
  return utcDay(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Read a date the model wrote. ISO is the contract, but the three relative words are accepted
 * because they are what a model reaches for when the prompt has just told it what today is — and
 * refusing them would send it back to doing the arithmetic itself, which is the bug.
 *
 * A written month ("July 28, 2026") is accepted for the same reason: it is how the date appears in
 * the reader's own instruction, so it is what gets copied into the call. PURE.
 */
export function parseDateToken(token: string | undefined, now: Date): number | undefined {
  const t = (token ?? "").trim().toLowerCase();
  if (!t || t === "today" || t === "now") return todayFrom(now);
  if (t === "tomorrow") return todayFrom(now) + MS_PER_DAY;
  if (t === "yesterday") return todayFrom(now) - MS_PER_DAY;
  // ISO, and the leading date of an ISO datetime — a model handed "2026-07-28T00:00:00Z" means the day.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const at = utcDay(y, m - 1, d);
    // Reject overflow ("2026-02-31") rather than letting Date roll it into March — a silently
    // shifted date is exactly the failure this tool exists to prevent.
    const back = new Date(at);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return undefined;
    return at;
  }
  // "July 28, 2026" / "28 July 2026" — a written month, either order, with an optional comma.
  const named = /^(?:(\d{1,2})\s+)?([a-z]+)\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/.exec(t);
  if (named) {
    const month = MONTHS.findIndex((m) => m.startsWith(named[2]!.slice(0, 3)));
    const day = Number(named[1] ?? named[3]);
    const year = Number(named[4]);
    if (month === -1 || !day || day > 31) return undefined;
    const at = utcDay(year, month, day);
    if (new Date(at).getUTCMonth() !== month) return undefined;
    return at;
  }
  return undefined;
}

/** ISO "YYYY-MM-DD" for a UTC-midnight day number. */
function isoOf(day: number): string {
  return new Date(day).toISOString().slice(0, 10);
}

/**
 * Answer one calendar question. Every failure names the token it could not read and says what shape
 * to use, because a tool that says only "invalid" leaves the model guessing at a format — and a
 * model guessing at a format goes back to doing the sum itself.
 */
export function dateMath(input: DateMathInput, now: Date): DateMathResult {
  const bad = (which: string, value: string | undefined): DateMathResult => ({
    ok: false,
    error:
      `couldn't read the ${which} date "${value ?? ""}" — use YYYY-MM-DD (or "today", "tomorrow", "yesterday")`,
  });
  if (input.op === "diff") {
    const from = parseDateToken(input.from, now);
    if (from === undefined) return bad("from", input.from);
    const to = parseDateToken(input.to ?? "today", now);
    if (to === undefined) return bad("to", input.to);
    const days = Math.round((to - from) / MS_PER_DAY);
    return {
      ok: true,
      days,
      text:
        `${isoOf(from)} → ${isoOf(to)} is ${days} day${Math.abs(days) === 1 ? "" : "s"}` +
        `${days < 0 ? " (the second date is earlier)" : ""}.`,
    };
  }
  if (input.op === "add") {
    const base = parseDateToken(input.date ?? "today", now);
    if (base === undefined) return bad("", input.date);
    const days = Math.round(input.days ?? 0);
    if (!Number.isFinite(days)) return { ok: false, error: '"days" must be a whole number of days' };
    const at = base + days * MS_PER_DAY;
    const weekday = WEEKDAYS[new Date(at).getUTCDay()]!;
    return {
      ok: true,
      date: isoOf(at),
      weekday,
      text: `${isoOf(base)} ${days < 0 ? "−" : "+"} ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} is ${isoOf(at)} (${weekday}).`,
    };
  }
  const at = parseDateToken(input.date ?? "today", now);
  if (at === undefined) return bad("", input.date);
  const weekday = WEEKDAYS[new Date(at).getUTCDay()]!;
  return { ok: true, date: isoOf(at), weekday, text: `${isoOf(at)} is a ${weekday}.` };
}
