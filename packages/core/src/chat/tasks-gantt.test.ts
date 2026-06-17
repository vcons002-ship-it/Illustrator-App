import { describe, expect, it } from "vitest";
import { dayToIso, ganttRowRef, isoToDay, plansToGanttRows } from "./tasks-gantt.js";
import type { TaskPlan } from "./tasks.js";

describe("isoToDay / dayToIso", () => {
  it("round-trips a date-only ISO string through an integer day number", () => {
    const d = isoToDay("2026-06-17")!;
    expect(Number.isInteger(d)).toBe(true);
    expect(dayToIso(d)).toBe("2026-06-17");
  });
  it("returns undefined for missing / unparseable dates", () => {
    expect(isoToDay(undefined)).toBeUndefined();
    expect(isoToDay("not a date")).toBeUndefined();
  });
});

describe("ganttRowRef", () => {
  it("splits a step row id into plan + step, and a plain plan id alone", () => {
    expect(ganttRowRef("task-abc")).toEqual({ planId: "task-abc" });
    expect(ganttRowRef("task-abc::step-1-x")).toEqual({ planId: "task-abc", stepId: "step-1-x" });
  });
});

function plan(partial: Partial<TaskPlan> & { steps: TaskPlan["steps"] }): TaskPlan {
  return {
    id: "task-1",
    title: "Renew registration",
    status: "active",
    source: { kind: "typed", text: "" },
    summary: "",
    createdAt: isoToDay("2026-06-10")! * 86_400_000,
    updatedAt: 0,
    ...partial,
  };
}

describe("plansToGanttRows", () => {
  const p = plan({
    deadlineIso: "2026-06-20",
    steps: [
      { id: "s1", title: "Gather docs", detail: "", actor: "ai_prep", status: "done", order: 0, dueIso: "2026-06-12", links: [], docs: [] },
      { id: "s2", title: "Pay fee", detail: "", actor: "user_action", status: "ready", order: 1, dueIso: "2026-06-18", leadTimeDays: 2, links: [], docs: [] },
    ],
  });

  it("emits a group row per plan followed by one row per step", () => {
    const rows = plansToGanttRows([p], { todayDay: isoToDay("2026-06-11")! });
    expect(rows.map((r) => r.id)).toEqual(["task-1", "task-1::s1", "task-1::s2"]);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[1]!.depth).toBe(1);
  });

  it("dates each step from its dueIso, carrying status into done/accent", () => {
    const rows = plansToGanttRows([p], { todayDay: isoToDay("2026-06-11")! });
    const s2 = rows[2]!;
    // due 2026-06-18 with a 2-day lead → ends on the 18th, starts on the 16th.
    expect(dayToIso(s2.end)).toBe("2026-06-18");
    expect(dayToIso(s2.start)).toBe("2026-06-16");
    expect(rows[1]!.done).toBe(true); // s1 is done
    expect(rows[1]!.accent).toBe("done");
    expect(s2.accent).toBe("active"); // ready
  });

  it("spans the group row across the plan's deadline", () => {
    const rows = plansToGanttRows([p], { todayDay: isoToDay("2026-06-11")! });
    expect(dayToIso(rows[0]!.end)).toBe("2026-06-20");
  });

  it("falls back to an ordered sequence when steps have no due dates", () => {
    const undated = plan({
      deadlineIso: "2026-06-20",
      steps: [
        { id: "a", title: "First", detail: "", actor: "ai_prep", status: "pending", order: 0, links: [], docs: [] },
        { id: "b", title: "Second", detail: "", actor: "ai_prep", status: "pending", order: 1, links: [], docs: [] },
      ],
    });
    const rows = plansToGanttRows([undated], { todayDay: isoToDay("2026-06-11")! });
    // The two undated steps spread left-to-right (the first ends no later than the second).
    expect(rows[1]!.end).toBeLessThanOrEqual(rows[2]!.end);
  });
});
