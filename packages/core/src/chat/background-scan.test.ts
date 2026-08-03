import { describe, expect, it } from "vitest";
import {
  FAILURE_RELOG_MS,
  QUIET_HEARTBEAT_MS,
  loadLastScan,
  nextScanRecord,
  saveLastScan,
  scanChangedSomething,
  scanHealthNote,
  shouldLogScan,
  summarizeScan,
  type ScanCounts,
  type ScanRecord,
} from "./background-scan.js";

const NOTHING: ScanCounts = { found: 0, imported: 0, edited: 0, mirrored: 0, events: 12 };

function memoStore() {
  const memos = new Map<string, string>();
  return {
    getMemo: async (k: string) => memos.get(k),
    putMemo: async (k: string, v: string) => {
      memos.set(k, v);
    },
  } as never;
}

describe("what a scan pass found", () => {
  it("doesn't count the calendar re-sync as a change", () => {
    // It happens on EVERY pass by construction, so counting it would make every pass "interesting"
    // and the heartbeat rule below would never do anything.
    expect(scanChangedSomething(NOTHING)).toBe(false);
    expect(scanChangedSomething({ ...NOTHING, found: 1 })).toBe(true);
    expect(scanChangedSomething({ ...NOTHING, mirrored: 2 })).toBe(true);
  });

  it("summarises a pass the same way for the button and the sweep", () => {
    expect(summarizeScan({ found: 2, imported: 1, edited: 0, mirrored: 0, events: 14 })).toBe(
      "2 new items from email/calendar · 1 Google task imported · 14 calendar events synced",
    );
    expect(summarizeScan(NOTHING)).toBe("12 calendar events synced");
  });
});

describe("the stored record", () => {
  it("dates a fault from when it STARTED, not from the last retry", () => {
    const first = nextScanRecord(undefined, { at: 1_000, ok: false, detail: "token expired", auto: true });
    expect(first.failingSince).toBe(1_000);
    const later = nextScanRecord(first, { at: 999_000, ok: false, detail: "token expired", auto: true });
    expect(later.failingSince).toBe(1_000);
    expect(later.at).toBe(999_000);
  });

  it("gives a DIFFERENT error its own start date", () => {
    const first = nextScanRecord(undefined, { at: 1_000, ok: false, detail: "token expired", auto: true });
    const other = nextScanRecord(first, { at: 5_000, ok: false, detail: "network unreachable", auto: true });
    expect(other.failingSince).toBe(5_000);
  });

  it("clears the fault once a pass succeeds", () => {
    const bad = nextScanRecord(undefined, { at: 1_000, ok: false, detail: "token expired", auto: true });
    const good = nextScanRecord(bad, { at: 2_000, ok: true, detail: "12 calendar events synced", auto: true });
    expect(good.failingSince).toBeUndefined();
    expect(good.ok).toBe(true);
  });

  it("round-trips through the store, and survives a corrupt memo", async () => {
    const store = memoStore();
    expect(await loadLastScan(store)).toBeUndefined();
    const rec = nextScanRecord(undefined, { at: 7_000, ok: true, detail: "3 calendar events synced", auto: true });
    await saveLastScan(store, rec);
    expect(await loadLastScan(store)).toEqual(rec);
    await (store as unknown as { putMemo: (k: string, v: string) => Promise<void> }).putMemo("last-background-scan", "{not json");
    expect(await loadLastScan(store)).toBeUndefined();
  });
});

describe("which passes reach the action history", () => {
  const pass = (at: number, ok: boolean, detail: string, auto = true, loggedAt?: number): ScanRecord => ({
    at,
    ok,
    detail,
    auto,
    ...(loggedAt !== undefined ? { loggedAt } : {}),
  });

  it("always logs a scan the reader asked for", () => {
    expect(shouldLogScan(undefined, pass(1_000, true, "12 calendar events synced", false), NOTHING)).toBe(true);
  });

  it("logs an automatic pass that found something", () => {
    expect(shouldLogScan(undefined, pass(1_000, true, "…", true), { ...NOTHING, found: 3 })).toBe(true);
  });

  it("keeps a quiet automatic pass OUT of the history", () => {
    // 200 entries, one sweep every 90 seconds: logging quiet passes would evict everything else the
    // assistant knows it did within the hour.
    const prev = pass(0, true, "quiet", true, 0);
    expect(shouldLogScan(prev, pass(90_000, true, "quiet", true, 0), NOTHING)).toBe(false);
  });

  it("still beats a heartbeat every few hours, so 'no entries' means something", () => {
    const prev = pass(0, true, "quiet", true, 0);
    const due = pass(QUIET_HEARTBEAT_MS, true, "quiet", true, 0);
    expect(shouldLogScan(prev, due, NOTHING)).toBe(true);
  });

  it("reports a NEW failure immediately", () => {
    const prev = pass(0, true, "quiet", true, 0);
    expect(shouldLogScan(prev, pass(90_000, false, "token expired", true, 0), undefined)).toBe(true);
  });

  it("doesn't repeat the same failure every 90 seconds", () => {
    const prev = pass(0, false, "token expired", true, 0);
    expect(shouldLogScan(prev, pass(90_000, false, "token expired", true, 0), undefined)).toBe(false);
  });

  it("but repeats a STILL-failing scan on a slow clock, so it can't be evicted into silence", () => {
    const prev = pass(0, false, "token expired", true, 0);
    expect(shouldLogScan(prev, pass(FAILURE_RELOG_MS, false, "token expired", true, 0), undefined)).toBe(true);
  });
});

describe("what the assistant is told about the scan", () => {
  it("separates 'never ran' from 'ran and found nothing'", () => {
    // This is the whole defect: both used to look like an empty action history, so "is the email
    // scan still working?" had no answer either way.
    const never = scanHealthNote(undefined, 10_000);
    expect(never).toMatch(/has not completed a pass yet/i);
    expect(never).not.toMatch(/failing/i);

    const quiet = scanHealthNote({ at: 10_000, ok: true, detail: "12 calendar events synced", auto: true }, 10_000 + 5 * 60_000);
    expect(quiet).toMatch(/last completed/i);
    expect(quiet).toMatch(/12 calendar events synced/);
    expect(quiet).toMatch(/5 minutes ago/);
  });

  it("says a failing scan is failing, since when, and what it means", () => {
    const note = scanHealthNote(
      { at: 86_400_000, ok: false, detail: "Google auth expired", auto: true, failingSince: 3_600_000 },
      86_400_000 + 60_000,
    );
    expect(note).toMatch(/FAILING/);
    expect(note).toMatch(/failing since/i);
    expect(note).toMatch(/Google auth expired/);
    expect(note).toMatch(/not picking up new tasks/i);
  });
});
