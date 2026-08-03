import type { VisualReaderStore } from "../storage/store.js";

/**
 * THE AUTOMATIC EMAIL & CALENDAR SCAN — its record, and the rules for what is worth reporting.
 *
 * The scan itself is a background sweep the host runs while the app is open and the reader is away
 * (see App.tsx). It worked; it just left no trace of having worked. Nothing went to the activity
 * log, nothing to the action history, nothing to the panel — and every failure was swallowed by a
 * bare `.catch(() => {})`. So a scan that had been dead for weeks (an expired Google token, say) and
 * a scan that ran perfectly every ninety seconds and found nothing produced EXACTLY the same
 * evidence: none. Asked whether it was still running, neither the reader nor the assistant could
 * tell, and the honest answer to "is it working?" was "there is no way to know".
 *
 * So this stores the last pass — when, whether it succeeded, and what came of it — and decides which
 * passes are worth an action-history entry. That decision has to thread a needle: logging every
 * ninety-second sweep would evict the entire 200-entry history within the hour, and logging only the
 * interesting ones brings back the silence for a reader whose inbox is simply quiet. Hence a
 * HEARTBEAT: a quiet pass still records itself every few hours, which is what turns "no entries" from
 * ambiguous into meaningful.
 *
 * Pure except the two store helpers; unit-tested.
 */

export const LAST_SCAN_KEY = "last-background-scan";

/** How long a still-failing scan waits before it says so again (so a dead token doesn't flood). */
export const FAILURE_RELOG_MS = 60 * 60_000;
/** How long a quiet, working scan waits before it logs "still running, still nothing" (the heartbeat). */
export const QUIET_HEARTBEAT_MS = 6 * 60 * 60_000;

/** What one pass found or moved. */
export interface ScanCounts {
  /** New actionable items spotted in email/calendar. */
  found: number;
  /** Google Tasks pulled in that weren't mirrored locally yet. */
  imported: number;
  /** Google Tasks whose notes the reader edited (→ re-planned). */
  edited: number;
  /** Ignore/complete/delete mirrored back from Google Tasks. */
  mirrored: number;
  /** Calendar events synced into the app's grid. */
  events: number;
}

export interface ScanRecord {
  /** ms epoch the pass finished. */
  at: number;
  ok: boolean;
  /** The summary line when it worked, the error when it didn't. */
  detail: string;
  /** Was this the automatic sweep, rather than the reader pressing Scan? */
  auto: boolean;
  /** On a failure: when this same error was FIRST seen, so "failing since" is a real date and not
   * just the most recent retry. Cleared by a successful pass. */
  failingSince?: number;
  /** When a pass was last written to the action history — the clock both the failure re-log and the
   * quiet heartbeat are measured against. Carried forward across passes that stay silent. */
  loggedAt?: number;
}

/** Did this pass actually move anything? (A calendar re-sync on its own doesn't count — it happens
 * every pass by construction, so treating it as a change would make every pass "interesting".) */
export function scanChangedSomething(c: ScanCounts): boolean {
  return c.found > 0 || c.imported > 0 || c.edited > 0 || c.mirrored > 0;
}

/** The one-line summary of a pass, shared by the button and the sweep so both report identically. */
export function summarizeScan(c: ScanCounts): string {
  const bits = [
    c.found ? `${c.found} new item${c.found === 1 ? "" : "s"} from email/calendar` : "",
    c.imported ? `${c.imported} Google task${c.imported === 1 ? "" : "s"} imported` : "",
    c.edited ? `${c.edited} edited in Google Tasks — re-planning` : "",
    c.mirrored ? `${c.mirrored} mirrored from Google Tasks (done/removed/ignored)` : "",
    `${c.events} calendar event${c.events === 1 ? "" : "s"} synced`,
  ].filter(Boolean);
  return bits.join(" · ");
}

/**
 * The record to store after a pass, given the one before it.
 *
 * `failingSince` is carried forward only while the error TEXT is unchanged. A different error is a
 * different fault and deserves its own start date; a success clears it outright. `loggedAt` always
 * carries forward — it belongs to the log, not to the pass. PURE.
 */
export function nextScanRecord(prev: ScanRecord | undefined, pass: { at: number; ok: boolean; detail: string; auto: boolean }): ScanRecord {
  const failingSince = pass.ok ? undefined : prev && !prev.ok && prev.detail === pass.detail ? (prev.failingSince ?? prev.at) : pass.at;
  return {
    at: pass.at,
    ok: pass.ok,
    detail: pass.detail,
    auto: pass.auto,
    ...(failingSince !== undefined ? { failingSince } : {}),
    ...(prev?.loggedAt !== undefined ? { loggedAt: prev.loggedAt } : {}),
  };
}

/**
 * Is this pass worth an entry in the action history?
 *
 * A reader-pressed scan always is — it's an action they took, and it's how the history reads today.
 * An automatic pass earns one when it FOUND something, when it starts failing (or is still failing an
 * hour later), or when the heartbeat is due. Everything else stays out, because the history is capped
 * at 200 entries and a ninety-second sweep would own all of them. PURE.
 */
export function shouldLogScan(prev: ScanRecord | undefined, next: ScanRecord, counts?: ScanCounts): boolean {
  if (!next.auto) return true;
  if (!next.ok) {
    // A NEW fault always reports. A continuing one repeats on a slow clock so it can't be evicted
    // out of the history and quietly become invisible again.
    const newFault = !prev || prev.ok || prev.detail !== next.detail;
    return newFault || next.at - (next.loggedAt ?? 0) >= FAILURE_RELOG_MS;
  }
  if (counts && scanChangedSomething(counts)) return true;
  // Nothing happened — but say so occasionally anyway, or "no scan entries" stays unreadable.
  return next.at - (next.loggedAt ?? 0) >= QUIET_HEARTBEAT_MS;
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "6 minutes ago" / "3 hours ago" / "2 days ago" — the relative half, so nobody has to subtract. PURE. */
export function agoLabel(ms: number): string {
  if (ms < 90_000) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 90) return `${mins} minutes ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(ms / 86_400_000)} days ago`;
}

/**
 * The state of the automatic scan, written for the assistant (and reusable in the panel).
 *
 * Three OUTCOMES, deliberately, because collapsing them is the whole bug: never run, ran and is
 * healthy, or is failing. "No record yet" is not "nothing was found" and neither is "the token
 * expired" — the assistant was answering all three as silence. PURE.
 */
export function scanHealthNote(rec: ScanRecord | undefined, now = Date.now()): string {
  if (!rec) return "The automatic email & calendar scan has not completed a pass yet — so nothing here says whether it found anything.";
  const when = `${stamp(rec.at)} (${agoLabel(Math.max(0, now - rec.at))})`;
  if (!rec.ok) {
    const since = rec.failingSince && rec.failingSince !== rec.at ? `, failing since ${stamp(rec.failingSince)}` : "";
    return `The automatic email & calendar scan is FAILING: last tried ${when}${since} — ${rec.detail}. Tell the reader: it is not picking up new tasks until that is fixed.`;
  }
  return `The automatic email & calendar scan last completed ${when} — ${rec.detail}.`;
}

// ---- Store -----------------------------------------------------------------

export async function loadLastScan(store: VisualReaderStore): Promise<ScanRecord | undefined> {
  try {
    const raw = await store.getMemo?.(LAST_SCAN_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as ScanRecord;
    return parsed && typeof parsed.at === "number" && typeof parsed.ok === "boolean" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function saveLastScan(store: VisualReaderStore, rec: ScanRecord): Promise<void> {
  await store.putMemo?.(LAST_SCAN_KEY, JSON.stringify(rec));
}
