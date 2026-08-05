import { describe, expect, it } from "vitest";
import { dateMath, parseDateToken } from "./date-math.js";

/** A fixed "now": Monday 15 June 2026, local afternoon. Injected everywhere so none of this
 * depends on when the suite happens to run. */
const NOW = new Date(2026, 5, 15, 16, 58, 3);

describe("dateMath — the arithmetic the model was doing in its head", () => {
  it("counts the days between two dates, across months of different lengths", () => {
    // The reported case: "relative to July 28, 2026 being Day 28". July has 31 days, so carrying
    // across the boundary is exactly where a model doing this unaided goes wrong.
    expect(dateMath({ op: "diff", from: "2026-07-28", to: "2026-08-05" }, NOW).days).toBe(8);
    expect(dateMath({ op: "diff", from: "2026-01-31", to: "2026-03-01" }, NOW).days).toBe(29); // 2026 is not a leap year
    expect(dateMath({ op: "diff", from: "2024-02-28", to: "2024-03-01" }, NOW).days).toBe(2); // 2024 is
  });

  it("defaults the second date to today, because \"how long since X\" means until now", () => {
    expect(dateMath({ op: "diff", from: "2026-06-01" }, NOW).days).toBe(14);
    // And answers backwards without pretending it can't.
    const back = dateMath({ op: "diff", from: "2026-06-20", to: "2026-06-15" }, NOW);
    expect(back.days).toBe(-5);
    expect(back.text).toMatch(/the second date is earlier/);
  });

  it("moves a date forward and back, and says which weekday it lands on", () => {
    expect(dateMath({ op: "add", date: "2026-07-28", days: 9 }, NOW)).toMatchObject({ date: "2026-08-06", weekday: "Thursday" });
    expect(dateMath({ op: "add", date: "2026-03-01", days: -1 }, NOW).date).toBe("2026-02-28");
    expect(dateMath({ op: "add", days: 1 }, NOW).date).toBe("2026-06-16"); // date defaults to today
  });

  it("names a weekday", () => {
    expect(dateMath({ op: "weekday", date: "2026-06-15" }, NOW)).toMatchObject({ weekday: "Monday" });
    expect(dateMath({ op: "weekday" }, NOW).date).toBe("2026-06-15");
  });

  it("is exact across a DST boundary", () => {
    // Local days are 23 or 25 hours long twice a year. Computed in local time, "days between" comes
    // out fractional there and rounds the wrong way — which is why this works in UTC throughout.
    expect(dateMath({ op: "diff", from: "2026-03-07", to: "2026-03-09" }, NOW).days).toBe(2);
    expect(dateMath({ op: "diff", from: "2026-10-31", to: "2026-11-02" }, NOW).days).toBe(2);
  });
});

describe("reading the dates a model actually writes", () => {
  it("takes the relative words the prompt has just taught it", () => {
    // Refusing these would send it back to doing the arithmetic itself, which is the bug.
    expect(parseDateToken("today", NOW)).toBe(Date.UTC(2026, 5, 15));
    expect(parseDateToken("tomorrow", NOW)).toBe(Date.UTC(2026, 5, 16));
    expect(parseDateToken("yesterday", NOW)).toBe(Date.UTC(2026, 5, 14));
  });

  it("takes ISO, and the date half of an ISO datetime", () => {
    expect(parseDateToken("2026-07-28", NOW)).toBe(Date.UTC(2026, 6, 28));
    expect(parseDateToken("2026-07-28T09:00:00.000Z", NOW)).toBe(Date.UTC(2026, 6, 28));
    expect(parseDateToken("2026-7-8", NOW)).toBe(Date.UTC(2026, 6, 8));
  });

  it("takes a written month, which is how the date appears in the reader's own instruction", () => {
    expect(parseDateToken("July 28, 2026", NOW)).toBe(Date.UTC(2026, 6, 28));
    expect(parseDateToken("28 July 2026", NOW)).toBe(Date.UTC(2026, 6, 28));
    expect(parseDateToken("Jul 28 2026", NOW)).toBe(Date.UTC(2026, 6, 28));
  });

  it("refuses a day that doesn't exist rather than rolling it into the next month", () => {
    // A silently shifted date is exactly the failure this tool exists to prevent.
    expect(parseDateToken("2026-02-31", NOW)).toBeUndefined();
    expect(parseDateToken("February 30, 2026", NOW)).toBeUndefined();
    expect(parseDateToken("not a date", NOW)).toBeUndefined();
    expect(parseDateToken("", NOW)).toBe(Date.UTC(2026, 5, 15)); // empty = today
  });

  it("says what shape to use when it can't read one", () => {
    // "Invalid" alone leaves the model guessing at a format — and a model guessing at a format goes
    // back to doing the sum itself.
    const r = dateMath({ op: "diff", from: "last Tuesday" }, NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/YYYY-MM-DD/);
    expect(r.error).toMatch(/last Tuesday/);
  });
});
