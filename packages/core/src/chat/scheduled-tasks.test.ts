import { describe, expect, it } from "vitest";
import {
  advanceSchedule,
  describeSchedule,
  dueScheduledTasks,
  nextDue,
  normalizeScheduledTask,
  type ScheduledTask,
} from "./scheduled-tasks.js";

const make = (over: Partial<ScheduledTask> = {}): ScheduledTask =>
  normalizeScheduledTask({ title: "T", prompt: "do it", rule: "daily", time: "09:00", ...over }, new Date("2026-06-16T07:00:00"));

describe("nextDue", () => {
  it("daily: today's time if ahead, else tomorrow", () => {
    const t = make({ time: "09:00" });
    // from 07:00 → 09:00 today
    expect(nextDue(t, new Date("2026-06-16T07:00:00")).toISOString()).toBe(new Date("2026-06-16T09:00:00").toISOString());
    // from 10:00 → 09:00 tomorrow
    expect(nextDue(t, new Date("2026-06-16T10:00:00")).toISOString()).toBe(new Date("2026-06-17T09:00:00").toISOString());
  });

  it("weekly: next occurrence of the weekday", () => {
    const t = make({ rule: "weekly", weekday: 1, time: "08:00" }); // Monday
    // 2026-06-16 is a Tuesday → next Monday is 2026-06-22
    expect(nextDue(t, new Date("2026-06-16T07:00:00")).toISOString()).toBe(new Date("2026-06-22T08:00:00").toISOString());
  });

  it("monthly: the day-of-month, rolling to next month when past", () => {
    const t = make({ rule: "monthly", dayOfMonth: 1, time: "06:00" });
    // 2026-06-16 → day 1 already passed this month → 2026-07-01
    expect(nextDue(t, new Date("2026-06-16T07:00:00")).toISOString()).toBe(new Date("2026-07-01T06:00:00").toISOString());
  });

  it("monthly: a day-31 schedule CLAMPS to short months instead of overflowing (Aug 31 → Sep 30 → Oct 31)", () => {
    // `new Date(y, m, 31)` for a 30-day month rolls forward to the 1st of the NEXT month, which would make
    // a day-31 schedule skip every short month. Clamping fires it on the month's last day and — because
    // dayOfMonth stays 31 — the following long month still fires on the 31st.
    const t = make({ rule: "monthly", dayOfMonth: 31, time: "09:00" });
    expect(nextDue(t, new Date("2026-08-31T10:00:00")).toISOString()).toBe(new Date("2026-09-30T09:00:00").toISOString());
    expect(nextDue(t, new Date("2026-09-30T09:00:05")).toISOString()).toBe(new Date("2026-10-31T09:00:00").toISOString());
    // February clamps to 28 (non-leap) / 29 (leap).
    expect(nextDue(t, new Date("2026-01-31T10:00:00")).toISOString()).toBe(new Date("2026-02-28T09:00:00").toISOString());
    expect(nextDue(t, new Date("2024-01-31T10:00:00")).toISOString()).toBe(new Date("2024-02-29T09:00:00").toISOString());
    // advanceSchedule (which uses nextDue) rolls Aug 31 → Sep 30 the same way.
    const advanced = advanceSchedule({ ...t, dayOfMonth: 31 }, new Date("2026-08-31T09:00:05"));
    expect(new Date(advanced.nextDueIso).toISOString()).toBe(new Date("2026-09-30T09:00:00").toISOString());
  });
});

describe("one-time ('once') scheduling", () => {
  const NOW = new Date("2026-06-16T07:00:00");

  it("schedules a one-shot on an explicit local date + time (no throw on a fresh task)", () => {
    // Regression: a fresh `once` task had no nextDueIso, so nextDue returned `new Date("")` and
    // normalize's `.toISOString()` threw RangeError — one-time scheduling was impossible.
    const t = normalizeScheduledTask({ title: "Call", prompt: "call the dentist", rule: "once", date: "2026-07-04", time: "17:30" }, NOW);
    expect(t.rule).toBe("once");
    expect(t.nextDueIso).toBe(new Date("2026-07-04T17:30:00").toISOString());
    expect(describeSchedule(t)).toMatch(/^Once — /);
  });

  it("with no date: the next time that clock time comes around (today if ahead, else tomorrow)", () => {
    expect(normalizeScheduledTask({ title: "T", prompt: "p", rule: "once", time: "09:00" }, NOW).nextDueIso).toBe(
      new Date("2026-06-16T09:00:00").toISOString(),
    );
    expect(
      normalizeScheduledTask({ title: "T", prompt: "p", rule: "once", time: "06:00" }, NOW).nextDueIso,
    ).toBe(new Date("2026-06-17T06:00:00").toISOString());
  });

  it("rejects an impossible calendar day and falls back instead of producing an Invalid Date", () => {
    const t = normalizeScheduledTask({ title: "T", prompt: "p", rule: "once", date: "2026-02-31", time: "08:00" }, NOW);
    expect(Number.isNaN(new Date(t.nextDueIso).getTime())).toBe(false);
    expect(t.nextDueIso).toBe(new Date("2026-06-16T08:00:00").toISOString()); // falls back to the next 08:00 (today, 07:00 now)
  });

  it("reads the date as LOCAL, not UTC (a bare ISO date would shift the run a day)", () => {
    const t = normalizeScheduledTask({ title: "T", prompt: "p", rule: "once", date: "2026-07-04", time: "00:30" }, NOW);
    const d = new Date(t.nextDueIso);
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(30);
  });

  it("fires when due, then disables (never reschedules)", () => {
    const t = normalizeScheduledTask({ title: "T", prompt: "p", rule: "once", date: "2026-06-16", time: "08:00" }, NOW);
    expect(dueScheduledTasks([t], new Date("2026-06-16T07:59:00"))).toHaveLength(0);
    expect(dueScheduledTasks([t], new Date("2026-06-16T08:00:01"))).toHaveLength(1);
    const after = advanceSchedule(t, new Date("2026-06-16T08:00:01"));
    expect(after.enabled).toBe(false);
    expect(dueScheduledTasks([after], new Date("2026-06-17T09:00:00"))).toHaveLength(0);
  });

  it("a stored one-shot keeps its scheduled moment when re-normalised", () => {
    const t = normalizeScheduledTask({ title: "T", prompt: "p", rule: "once", date: "2026-07-04", time: "17:30" }, NOW);
    expect(normalizeScheduledTask(t, new Date("2026-07-01T12:00:00")).nextDueIso).toBe(t.nextDueIso);
  });

  it("drops a stray date on a recurring rule", () => {
    expect(normalizeScheduledTask({ title: "T", prompt: "p", rule: "daily", date: "2026-07-04", time: "09:00" }, NOW).date).toBeUndefined();
  });
});

describe("normalize + due + advance", () => {
  it("normalises, clamps the time, and computes a first due", () => {
    const t = normalizeScheduledTask({ title: "  Recap  ", prompt: "x", rule: "daily", time: "25:99" }, new Date("2026-06-16T07:00:00"));
    expect(t.title).toBe("Recap");
    expect(t.time).toBe("23:59"); // clamped
    expect(t.enabled).toBe(true);
    expect(t.nextDueIso).toBeTruthy();
  });

  it("selects only due + enabled tasks", () => {
    const due = make({ nextDueIso: new Date("2026-06-16T06:00:00").toISOString() });
    const future = make({ nextDueIso: new Date("2026-06-17T09:00:00").toISOString() });
    const disabled = make({ enabled: false, nextDueIso: new Date("2026-06-16T06:00:00").toISOString() });
    const got = dueScheduledTasks([due, future, disabled], new Date("2026-06-16T07:00:00"));
    expect(got).toEqual([due]);
  });

  it("advances a recurring task and disables a 'once' task", () => {
    const daily = make({ rule: "daily", time: "09:00" });
    const advanced = advanceSchedule(daily, new Date("2026-06-16T09:00:05"));
    expect(advanced.lastRunIso).toBeTruthy();
    expect(new Date(advanced.nextDueIso).toISOString()).toBe(new Date("2026-06-17T09:00:00").toISOString());
    const once = make({ rule: "once", nextDueIso: new Date("2026-06-16T09:00:00").toISOString() });
    expect(advanceSchedule(once).enabled).toBe(false);
  });

  it("describes the cadence", () => {
    expect(describeSchedule(make({ rule: "daily", time: "09:00" }))).toBe("Daily at 09:00");
    expect(describeSchedule(make({ rule: "weekly", weekday: 5, time: "17:00" }))).toContain("Friday");
  });
});
