import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import {
  MAX_ACTION_HISTORY,
  clearActionHistory,
  getActionsViewedAt,
  loadActionHistory,
  markActionsViewed,
  recordAction,
  unseenCount,
  type ActionEntry,
  formatActionHistory,
  filterActionHistory,
} from "./action-history.js";

describe("action history store", () => {
  it("records newest-first and bounds the log", async () => {
    const store = new InMemoryStore();
    expect(await loadActionHistory(store)).toEqual([]);
    await recordAction(store, { kind: "scan", label: "Scanned email & calendar", detail: "2 found" });
    await recordAction(store, { kind: "plan", label: "Planned: Trip" });
    const log = await loadActionHistory(store);
    expect(log.map((e) => e.label)).toEqual(["Planned: Trip", "Scanned email & calendar"]); // newest first
    expect(log[1]!.detail).toBe("2 found");

    for (let i = 0; i < MAX_ACTION_HISTORY + 5; i++) await recordAction(store, { kind: "other", label: `a${i}` });
    expect(await loadActionHistory(store)).toHaveLength(MAX_ACTION_HISTORY);
  });

  it("survives a corrupt memo", async () => {
    const store = new InMemoryStore();
    await store.putMemo("action-history", "{not json");
    expect(await loadActionHistory(store)).toEqual([]);
  });

  it("clears the log", async () => {
    const store = new InMemoryStore();
    await recordAction(store, { kind: "scan", label: "x" });
    await clearActionHistory(store);
    expect(await loadActionHistory(store)).toEqual([]);
  });

  it("tracks viewed-at and counts only newer entries", async () => {
    const store = new InMemoryStore();
    expect(await getActionsViewedAt(store)).toBe(0);
    const entries: ActionEntry[] = [
      { id: "a", at: 100, kind: "scan", label: "old" },
      { id: "b", at: 300, kind: "plan", label: "new1" },
      { id: "c", at: 400, kind: "plan", label: "new2" },
    ];
    expect(unseenCount(entries, 200)).toBe(2);
    expect(unseenCount(entries, 500)).toBe(0);
    await markActionsViewed(store);
    expect(await getActionsViewedAt(store)).toBeGreaterThan(0);
  });
});

describe("the assistant reading back its own unattended work", () => {
  // Asked for: it should know when it last did something, when it needs to or when the reader asks.
  // Every entry was ALREADY being written here with a timestamp — scans, plans, scheduled runs, task
  // steps it worked alone — and shown only to the reader. The record existed; the assistant was the
  // one party who couldn't see it, so it could neither answer "when did you last check my email?"
  // nor tell that it had already done a thing before doing it again.
  const NOW = new Date(2026, 7, 1, 9, 0).getTime();
  const entry = (at: number, kind: string, label: string, detail?: string) =>
    ({ id: `a${at}`, at, kind, label, ...(detail ? { detail } : {}) }) as ActionEntry;
  const log = [
    entry(NOW - 3600_000, "scheduled_run", "Scheduled “Morning email recap”", "replied in the ⏰ Scheduled chat"),
    entry(NOW - 26 * 3600_000, "scan", "Scanned email & calendar", "2 new"),
    entry(NOW - 9 * 86_400_000, "plan", "Planned: Flight to Iowa", "5 steps"),
  ];

  it("gives each entry a date and an age", () => {
    const out = formatActionHistory(log, NOW);
    expect(out).toContain("2026-08-01 08:00 (today) — Scheduled “Morning email recap” — replied in the ⏰ Scheduled chat");
    expect(out).toContain("(yesterday) — Scanned email & calendar — 2 new");
    expect(out).toContain("(9 days ago) — Planned: Flight to Iowa — 5 steps");
  });

  it("says plainly when there is nothing, rather than returning a blank", () => {
    // "I have no record" and an empty string read very differently to a model deciding what to say.
    expect(formatActionHistory([], NOW)).toBe("You have no record of doing anything automatically yet.");
  });

  it("narrows to one kind when asked", () => {
    expect(filterActionHistory(log, "scheduled_run", 20).map((e) => e.kind)).toEqual(["scheduled_run"]);
    expect(filterActionHistory(log, undefined, 20)).toHaveLength(3);
    expect(filterActionHistory(log, "SCAN", 20)).toHaveLength(1); // case-insensitive
  });

  it("bounds the limit so a stray argument can't dump the whole log into context", () => {
    const many = Array.from({ length: 80 }, (_, i) => entry(NOW - i * 1000, "scan", `s${i}`));
    expect(filterActionHistory(many, undefined, 999)).toHaveLength(50);
    expect(filterActionHistory(many, undefined, 0)).toHaveLength(20); // 0/NaN → the default, not nothing
    expect(filterActionHistory(many, undefined, -5)).toHaveLength(1);
  });
});
