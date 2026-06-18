import { describe, expect, it } from "vitest";
import { activitySummary, orderActivities, pruneActivities, type Activity } from "./activity.js";

const a = (over: Partial<Activity> & { id: string }): Activity => ({
  label: over.label ?? over.id,
  status: "active",
  startedAt: 0,
  ...over,
});

describe("orderActivities", () => {
  it("puts active first, then queued (FIFO), then finished (newest first)", () => {
    const list: Activity[] = [
      a({ id: "d1", status: "done", startedAt: 1, endedAt: 10 }),
      a({ id: "q1", status: "queued", startedAt: 5 }),
      a({ id: "act", status: "active", startedAt: 7 }),
      a({ id: "q2", status: "queued", startedAt: 3 }),
      a({ id: "d2", status: "done", startedAt: 2, endedAt: 20 }),
    ];
    expect(orderActivities(list).map((x) => x.id)).toEqual(["act", "q2", "q1", "d2", "d1"]);
  });
});

describe("activitySummary", () => {
  it("is idle with nothing in flight", () => {
    expect(activitySummary([a({ id: "d", status: "done", endedAt: 1 })])).toEqual({
      busy: false,
      text: "Idle",
      activeCount: 0,
      queuedCount: 0,
    });
  });

  it("leads with the active label and counts the rest", () => {
    const list: Activity[] = [
      a({ id: "scan", label: "Searching email & calendar", status: "active", startedAt: 1 }),
      a({ id: "p1", label: "Planning: Flight to Iowa", status: "queued", startedAt: 2 }),
      a({ id: "p2", label: "Planning: DLA application", status: "queued", startedAt: 3 }),
    ];
    const s = activitySummary(list);
    expect(s.busy).toBe(true);
    expect(s.text).toBe("Searching email & calendar (+2 more)");
    expect(s).toMatchObject({ activeCount: 1, queuedCount: 2 });
  });
});

describe("pruneActivities", () => {
  it("keeps in-flight forever, expires old finished items", () => {
    const list: Activity[] = [
      a({ id: "act", status: "active", startedAt: 0 }),
      a({ id: "fresh", status: "done", endedAt: 9000 }),
      a({ id: "stale", status: "done", endedAt: 100 }),
    ];
    expect(pruneActivities(list, 10000, 8000).map((x) => x.id)).toEqual(["act", "fresh"]);
  });
});
