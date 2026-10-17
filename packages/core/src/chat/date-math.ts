/** Offline calendar arithmetic. Local dates use UTC midnights so DST cannot change elapsed days. */
export type DateMathOp = "diff" | "add" | "weekday" | "day_number";

export interface DateMathInput {
  op: DateMathOp;
  from?: string;
  /** Defaults to today for diff/day_number. */
  to?: string;
  /** Defaults to today for add/weekday. */
  date?: string;
  days?: number;
  /** Required for day_number: the number assigned to the anchor date (e.g. Day 1). */
  startDay?: number;
}

export interface DateMathResult {
  ok: boolean;
  error?: string;
  days?: number;
  dayNumber?: number;
  startDay?: number;
  from?: string;
  to?: string;
  date?: string;
  weekday?: string;
  text?: string;
}

export const DATE_MATH_GUIDANCE =
  'Dates/day counts → date_math, NEVER calculate. ' +
  '{"tool":"date_math","op":"day_number","from":"2026-06-30","to":"tomorrow","startDay":1} returns days+anchor (no extra +1). ' +
  'Other ops: diff(from,to=today), add(date=today,days), weekday(date=today). ' +
  'Use YYYY-MM-DD or today/tomorrow/yesterday; retry errors, never guess.';

/** Reject ISO-looking date subtraction in BOTH calculators, including the fallback.
 * Never reinterpret an ambiguous arithmetic expression as an instruction to schedule something. */
export function rejectCalendarExpression(expression: string): void {
  if (/\b\d{4}-\d{1,2}-\d{1,2}\b/.test(expression)) {
    throw new Error('ISO dates are not subtraction expressions. Use date_math with op:"diff" and from/to, or op:"day_number" with startDay for an anchored day count.');
  }
}

/** Never silently change an operation, default a missing offset to zero, or round it. */
export function parseDateMathInput(obj: Record<string, unknown>): DateMathInput | undefined {
  const op = obj.op;
  if (op !== "diff" && op !== "add" && op !== "weekday" && op !== "day_number") return undefined;
  const input: DateMathInput = { op };
  for (const key of ["from", "to", "date"] as const) {
    const value = obj[key] ?? (key === "from" ? obj.start : key === "to" ? obj.end : obj.on);
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 80) return undefined;
    input[key] = value.trim();
  }
  for (const key of ["days", "startDay"] as const) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
    input[key] = value;
  }
  if ((op === "diff" || op === "day_number") && !input.from) return undefined;
  if (op === "add" && input.days === undefined) return undefined;
  if (op === "day_number" && input.startDay === undefined) return undefined;
  return input;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MS_PER_DAY = 86_400_000;

function utcDay(y: number, m: number, d: number): number {
  const at = new Date(0);
  at.setUTCFullYear(y, m, d); // Date.UTC treats years 0..99 as 1900..1999.
  return at.getTime();
}

function supportedDay(at: number): boolean {
  const year = new Date(at).getUTCFullYear();
  return Number.isFinite(at) && year >= 1 && year <= 9999;
}

export function parseDateToken(token: string | undefined, now: Date): number | undefined {
  const t = token?.trim().toLowerCase();
  if (!t) return undefined;
  const today = utcDay(now.getFullYear(), now.getMonth(), now.getDate());
  if (["today", "now", "tomorrow", "yesterday"].includes(t)) {
    const at = today + (t === "tomorrow" ? 1 : t === "yesterday" ? -1 : 0) * MS_PER_DAY;
    return supportedDay(at) ? at : undefined;
  }
  // Complete ISO date or valid ISO datetime. Preserve its written day, not a timezone shift.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:\d{2}))?$/.exec(t);
  const named = /^(?:(\d{1,2})(?:st|nd|rd|th)?\s+)?([a-z]+)\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/.exec(t);
  let y: number, m: number, d: number;
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
    if (t.includes("t") && !Number.isFinite(Date.parse(t))) return undefined;
  } else if (named && Boolean(named[1]) !== Boolean(named[3])) {
    y = Number(named[4]);
    m = MONTHS.findIndex((month) => named[2] === month || named[2] === month.slice(0, 3));
    d = Number(named[1] ?? named[3]);
    if (m === -1) return undefined;
  } else return undefined;
  const at = utcDay(y, m, d);
  const back = new Date(at);
  return supportedDay(at) && back.getUTCFullYear() === y && back.getUTCMonth() === m && back.getUTCDate() === d ? at : undefined;
}

function isoOf(day: number): string {
  return new Date(day).toISOString().slice(0, 10);
}

export function dateMath(input: DateMathInput, now: Date): DateMathResult {
  const bad = (which: string, value: string | undefined): DateMathResult => ({
    ok: false,
    error: `couldn't read the ${which} date "${value ?? ""}" — use YYYY-MM-DD (or "today", "tomorrow", "yesterday")`,
  });
  if (input.op === "diff" || input.op === "day_number") {
    const from = parseDateToken(input.from, now);
    if (from === undefined) return bad("from", input.from);
    const to = parseDateToken(input.to ?? "today", now);
    if (to === undefined) return bad("to", input.to);
    const days = (to - from) / MS_PER_DAY;
    const range = { days, from: isoOf(from), to: isoOf(to) };
    if (input.op === "day_number") {
      if (!Number.isSafeInteger(input.startDay) || !Number.isSafeInteger(days + input.startDay!))
        return { ok: false, error: '"startDay" must be a safe whole number assigned to the anchor date' };
      const dayNumber = days + input.startDay!;
      return {
        ok: true,
        ...range,
        startDay: input.startDay!,
        dayNumber,
        text: `${range.from} is Day ${input.startDay}; ${range.to} is Day ${dayNumber} (${days} elapsed days + anchor ${input.startDay}; already includes the anchor, do not add 1 again).`,
      };
    }
    return {
      ok: true,
      ...range,
      text: `${range.from} → ${range.to} is ${days} day${Math.abs(days) === 1 ? "" : "s"}${days < 0 ? " (the second date is earlier)" : ""}.`,
    };
  }
  if (input.op !== "add" && input.op !== "weekday") return { ok: false, error: "op must be diff, day_number, add, or weekday" };
  const base = parseDateToken(input.date ?? "today", now);
  if (base === undefined) return bad("base", input.date);
  if (input.op === "add" && !Number.isSafeInteger(input.days)) return { ok: false, error: '"days" must be a whole number of days' };
  const days = input.op === "add" ? input.days! : 0;
  const at = base + days * MS_PER_DAY;
  if (!supportedDay(at)) return { ok: false, error: "result must be a calendar date in years 0001 through 9999" };
  const weekday = WEEKDAYS[new Date(at).getUTCDay()]!;
  return {
    ok: true,
    date: isoOf(at),
    weekday,
    text: input.op === "weekday"
      ? `${isoOf(at)} is a ${weekday}.`
      : `${isoOf(base)} ${days < 0 ? "−" : "+"} ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} is ${isoOf(at)} (${weekday}).`,
  };
}
