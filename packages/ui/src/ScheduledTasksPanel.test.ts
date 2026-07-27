import { describe, expect, it } from "vitest";
import type { ScheduledTask } from "@visual-reader/core";
import { groupByTask } from "./ScheduledTasksPanel.js";

const task = (over: Partial<ScheduledTask>): ScheduledTask => ({
  id: over.id ?? "s1",
  title: over.title ?? "Check",
  prompt: "do it",
  rule: "daily",
  time: "09:00",
  enabled: true,
  createdAt: 0,
  nextDueIso: "2026-07-01T09:00:00.000Z",
  ...over,
});

describe("groupByTask", () => {
  it("groups actions under the task they maintain, standalone ones last", () => {
    const got = groupByTask(
      [
        task({ id: "a", title: "Standalone" }),
        task({ id: "b", title: "RSVP check", planId: "p2" }),
        task({ id: "c", title: "Price watch", planId: "p1" }),
      ],
      { p1: "Book the flight", p2: "Plan the party" },
    );
    expect(got.map((g) => g.label)).toEqual(["Book the flight", "Plan the party", undefined]);
    expect(got[2]!.items.map((t) => t.id)).toEqual(["a"]); // the untied one, last
  });

  it("keeps several actions for the same task together", () => {
    const got = groupByTask(
      [task({ id: "a", planId: "p1" }), task({ id: "b", planId: "p1" })],
      { p1: "Plan the party" },
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.items.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("flags an action whose task was deleted — it has nothing left to maintain", () => {
    const got = groupByTask([task({ id: "a", planId: "gone" })], {});
    expect(got[0]!.missing).toBe(true);
    expect(got[0]!.label).toMatch(/no longer exists/i);
  });

  it("with nothing bound, it's a single untitled group (the flat list it always was)", () => {
    const got = groupByTask([task({ id: "a" }), task({ id: "b" })], {});
    expect(got).toEqual([{ key: "", items: expect.any(Array) }]);
    expect(got[0]!.items).toHaveLength(2);
  });
});
