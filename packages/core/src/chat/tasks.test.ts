import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import {
  MAX_TASK_PLANS,
  addIgnore,
  advanceStep,
  deleteTaskPlan,
  isIgnored,
  loadIgnored,
  loadTaskPlans,
  nextReadyStep,
  normalizeTaskPlan,
  tasksIndexBlock,
  updateTaskStep,
  upsertTaskPlan,
  type TaskPlan,
  type TaskPlanInput,
} from "./tasks.js";

const plan = (over: Partial<TaskPlanInput> = {}): TaskPlan =>
  normalizeTaskPlan({
    title: "Renew registration",
    source: { kind: "typed", text: "renew my car registration" },
    summary: "DMV renewal",
    steps: [
      { title: "Gather documents", actor: "ai_prep", status: "ready" },
      { title: "Pay the fee online", actor: "user_action" },
      { title: "Print the receipt", actor: "user_action" },
    ],
    ...over,
  });

describe("normalizeTaskPlan", () => {
  it("assigns step order, defaults status/actor, caps fields, and ids", () => {
    const p = plan();
    expect(p.steps.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(p.steps[0]!.actor).toBe("ai_prep");
    expect(p.steps[1]!.status).toBe("pending"); // default
    expect(p.id).toMatch(/^task-/);
    expect(p.status).toBe("active");
  });

  it("drops malformed links and caps step count", () => {
    const p = normalizeTaskPlan({
      title: "x",
      source: { kind: "typed", text: "x" },
      steps: [
        { title: "s", links: [{ label: "ok", url: "https://dmv.gov" }, { label: "bad", url: "javascript:alert(1)" }] },
        ...Array.from({ length: 40 }, () => ({ title: "extra" })),
      ],
    });
    expect(p.steps).toHaveLength(25); // MAX_STEPS_PER_PLAN
    expect(p.steps[0]!.links).toEqual([{ label: "ok", url: "https://dmv.gov" }]);
  });
});

describe("task plan store", () => {
  it("upserts by id, loads back, and deletes", async () => {
    const store = new InMemoryStore();
    expect(await loadTaskPlans(store)).toEqual([]);
    const p = plan();
    await upsertTaskPlan(store, p);
    await upsertTaskPlan(store, { ...p, title: "Renew (edited)" }); // same id replaces
    const loaded = await loadTaskPlans(store);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.title).toBe("Renew (edited)");
    await deleteTaskPlan(store, p.id);
    expect(await loadTaskPlans(store)).toEqual([]);
  });

  it("evicts the oldest plan past the cap", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < MAX_TASK_PLANS + 2; i++) await upsertTaskPlan(store, plan({ id: `t${i}`, title: `T${i}` }));
    const loaded = await loadTaskPlans(store);
    expect(loaded).toHaveLength(MAX_TASK_PLANS);
    expect(loaded[0]!.id).toBe("t2");
  });

  it("survives a corrupt memo", async () => {
    const store = new InMemoryStore();
    await store.putMemo("task-plans", "{not json");
    expect(await loadTaskPlans(store)).toEqual([]);
  });

  it("updateTaskStep patches status + google id", async () => {
    const store = new InMemoryStore();
    const p = plan();
    await upsertTaskPlan(store, p);
    const after = await updateTaskStep(store, p.id, p.steps[0]!.id, { status: "done", googleTaskId: "g1" });
    expect(after[0]!.steps[0]!.status).toBe("done");
    expect(after[0]!.steps[0]!.googleTaskId).toBe("g1");
  });
});

describe("advanceStep / nextReadyStep", () => {
  it("marks the current step done and sets the next ready", () => {
    const { plan: p1, ready } = advanceStep(plan());
    expect(p1.steps[0]!.status).toBe("done");
    expect(p1.steps[1]!.status).toBe("ready");
    expect(ready!.title).toBe("Pay the fee online");
  });

  it("completes the plan when the last step is advanced", () => {
    let p = plan();
    p = advanceStep(p).plan; // step 0 done, 1 ready
    p = advanceStep(p).plan; // step 1 done, 2 ready
    const last = advanceStep(p); // step 2 done → all done
    expect(last.plan.status).toBe("completed");
    expect(last.ready).toBeUndefined();
  });

  it("nextReadyStep returns the ready step, else the first non-done", () => {
    expect(nextReadyStep(plan())!.title).toBe("Gather documents");
    const allButLast = plan({
      steps: [
        { title: "a", status: "done" },
        { title: "b", status: "in_progress" },
      ],
    });
    expect(nextReadyStep(allButLast)!.title).toBe("b");
  });

  it("tasksIndexBlock names the active task + current step", () => {
    const block = tasksIndexBlock(plan({ deadlineIso: "2026-07-01" }));
    expect(block).toContain("ACTIVE TASK: Renew registration");
    expect(block).toContain("deadline 2026-07-01");
    expect(block).toContain("Gather documents");
    expect(block).toContain("mark_step_done");
  });
});

describe("ignore list", () => {
  it("adds rules (deduped) and matches candidates by item / sender / phrase", async () => {
    const store = new InMemoryStore();
    await addIgnore(store, { kind: "sender", value: "deals@shop.com" });
    await addIgnore(store, { kind: "sender", value: "deals@shop.com" }); // dedup
    await addIgnore(store, { kind: "phrase", value: "sale" });
    await addIgnore(store, { kind: "item", value: "msg-123" });
    const rules = await loadIgnored(store);
    expect(rules).toHaveLength(3);

    expect(isIgnored(rules, { source: { kind: "scan", emailId: "msg-123" }, title: "anything", reason: "" })).toBe(true);
    expect(isIgnored(rules, { source: { kind: "scan" }, from: "Deals@Shop.com", title: "x", reason: "" })).toBe(true);
    expect(isIgnored(rules, { source: { kind: "scan" }, title: "Big SALE today", reason: "" })).toBe(true);
    expect(isIgnored(rules, { source: { kind: "scan", emailId: "msg-999" }, from: "boss@work.com", title: "Report due", reason: "" })).toBe(false);
  });
});
