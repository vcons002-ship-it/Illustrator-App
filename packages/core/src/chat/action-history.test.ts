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
