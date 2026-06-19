import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import {
  MAX_TASK_PLANS,
  addIgnore,
  advanceStep,
  deleteTaskPlan,
  archiveTaskPlan,
  restoreTaskPlan,
  removeIgnore,
  normalizeRecurrence,
  describeRecurrence,
  shiftIso,
  nextOccurrence,
  isIgnored,
  loadIgnored,
  loadTaskPlans,
  nextReadyStep,
  normalizeTaskPlan,
  needsPlanning,
  needsAttention,
  googleNotesUserEdit,
  applyStepEdits,
  reconcileGoogleSubtasks,
  planFromGoogleTask,
  importableGoogleTasks,
  formatPlanForGoogleNotes,
  taskStubFromCandidate,
  tasksIndexBlock,
  resolveActiveTaskPlanId,
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

  it("marks a scan stub as unplanned, and a real plan as planned", () => {
    const stub = normalizeTaskPlan(taskStubFromCandidate({
      source: { kind: "scan", eventId: "e1" },
      title: "Plan the Iowa trip",
      reason: "trip on the calendar with no flight booked",
      suggestedDeadlineIso: "2026-07-10",
    }));
    expect(needsPlanning(stub)).toBe(true);
    expect(stub.planned).toBe(false);
    expect(stub.steps).toHaveLength(0);
    expect(stub.deadlineIso).toBe("2026-07-10");
    expect(stub.summary).toBe("trip on the calendar with no flight booked");
    // A plan WITH steps is never marked unplanned (even if planned:false is passed by mistake).
    const real = normalizeTaskPlan({ title: "x", source: { kind: "typed", text: "x" }, planned: false, steps: [{ title: "s" }] });
    expect(needsPlanning(real)).toBe(false);
    expect(real.planned).toBeUndefined();
  });

  it("keeps userNotes + needsReplan for the re-attack loop; needsAttention covers both cases", () => {
    const stub = normalizeTaskPlan({ title: "s", source: { kind: "typed", text: "s" }, planned: false, steps: [] });
    const planned = normalizeTaskPlan({ title: "p", source: { kind: "typed", text: "p" }, steps: [{ title: "a" }] });
    const withNotes = normalizeTaskPlan({
      title: "trip",
      source: { kind: "typed", text: "trip" },
      steps: [{ title: "book flights" }],
      userNotes: "Flying from Boston, budget $800",
      needsReplan: true,
    });
    expect(needsAttention(stub)).toBe(true); // an unplanned stub
    expect(needsAttention(planned)).toBe(false); // a finished plan, no new info
    expect(needsAttention(withNotes)).toBe(true); // planned, but the reader added details
    expect(withNotes.userNotes).toContain("Boston");
    expect(withNotes.needsReplan).toBe(true);
  });

  it("googleNotesUserEdit captures lines the reader added in Google Tasks (for the re-plan loop)", () => {
    const synced = "Plan the Iowa trip\n\nNEEDS FROM YOU:\n• Which city are you flying from?\n\nPLAN — 2 steps:\n— planned by Visual Reader";
    // The reader appended an answer line in Google Tasks.
    const edited = synced + "\nFlying from Boston, budget about $800, just me";
    expect(googleNotesUserEdit(edited, synced)).toBe("Flying from Boston, budget about $800, just me");
    // No change → nothing captured.
    expect(googleNotesUserEdit(synced, synced)).toBe("");
    // No baseline yet → don't mistake the existing notes for an edit.
    expect(googleNotesUserEdit(synced, undefined)).toBe("");
    // Missing notes → empty.
    expect(googleNotesUserEdit(undefined, synced)).toBe("");
  });

  it("formatPlanForGoogleNotes surfaces clarifying questions as 'needs from you'", () => {
    const notes = formatPlanForGoogleNotes({
      summary: "Plan the Iowa trip",
      steps: [{ title: "Book flights", actor: "user_action", status: "pending" }],
      clarifyingQuestions: ["Which city are you flying from?", "What's your budget?"],
    });
    expect(notes).toMatch(/NEEDS FROM YOU/);
    expect(notes).toContain("Which city are you flying from?");
  });

  it("reconcileGoogleSubtasks: reuses by title/id, marks done complete, never duplicates or deletes", () => {
    const existing = [
      { id: "g1", title: "Tailor resume", status: "needsAction" },
      { id: "g2", title: "Submit application", status: "completed" },
      { id: "g3", title: "An old superseded step", status: "needsAction" }, // orphan — left alone
    ];
    const steps = [
      { title: "Tailor resume", status: "done" as const }, // matches g1 by title; now done → complete it
      { title: "Submit application", status: "done" as const }, // matches g2, already completed → no-op
      { title: "Write cover letter", status: "pending" as const }, // no googleTaskId → new → create
      { title: "tailor RESUME", status: "pending" as const }, // same title as step 1 (and g1) → must NOT reuse g1 again
    ];
    const a = reconcileGoogleSubtasks(steps, existing);
    expect(a[0]).toEqual({ title: "Tailor resume", existingId: "g1", create: false, needsComplete: true });
    expect(a[1]).toEqual({ title: "Submit application", existingId: "g2", create: false, needsComplete: false });
    expect(a[2]).toEqual({ title: "Write cover letter", create: true, needsComplete: false });
    expect(a[3]).toEqual({ title: "tailor RESUME", create: true, needsComplete: false }); // g1 already used → create
    // It proposes NOTHING for the orphan g3 (we never delete superseded sub-tasks).
    expect(a.some((x) => x.existingId === "g3")).toBe(false);
  });

  it("reconcileGoogleSubtasks: a stored googleTaskId wins even if the title changed", () => {
    const a = reconcileGoogleSubtasks(
      [{ title: "Renamed step", status: "pending", googleTaskId: "g9" }],
      [{ id: "g9", title: "Original wording", status: "needsAction" }],
    );
    expect(a[0]).toEqual({ title: "Renamed step", existingId: "g9", create: false, needsComplete: false });
  });

  it("carries the Google Task link (parent) + per-step Google sub-task ids", () => {
    const p = normalizeTaskPlan({
      title: "Apply to the job",
      source: { kind: "typed", text: "apply" },
      googleTaskId: "gt-parent",
      steps: [
        { title: "Tailor resume", googleTaskId: "gt-sub-1" },
        { title: "Submit", actor: "user_action" },
      ],
    });
    expect(p.googleTaskId).toBe("gt-parent");
    expect(p.steps[0]!.googleTaskId).toBe("gt-sub-1");
    expect(p.steps[1]!.googleTaskId).toBeUndefined(); // an unsynced step
  });

  it("planFromGoogleTask: mirrors a Google task (+ sub-tasks) into a planned plan with ids", () => {
    const p = normalizeTaskPlan(
      planFromGoogleTask({
        id: "gt-1",
        title: "Apply to the data scientist job",
        notes: "Posting on USAJobs",
        due: "2026-07-01T00:00:00Z",
        status: "needsAction",
        subtasks: [
          { id: "gt-1a", title: "Tailor resume", status: "needsAction" },
          { id: "gt-1b", title: "Submit application", status: "completed" },
        ],
      }),
    );
    expect(p.title).toBe("Apply to the data scientist job");
    expect(p.googleTaskId).toBe("gt-1"); // linked, so a re-import won't duplicate it
    expect(p.summary).toBe("Posting on USAJobs");
    expect(p.deadlineIso).toBe("2026-07-01"); // date part only
    expect(needsPlanning(p)).toBe(false); // a real (planned) task, not a stub the sweep would plan
    expect(p.steps.map((s) => s.googleTaskId)).toEqual(["gt-1a", "gt-1b"]);
    expect(p.steps[0]!.status).toBe("pending");
    expect(p.steps[1]!.status).toBe("done"); // completed in Google → done in-app
  });

  it("planFromGoogleTask: a completed Google task maps to a completed plan; missing title is safe", () => {
    const p = normalizeTaskPlan(planFromGoogleTask({ id: "gt-9", title: "", status: "completed", subtasks: [] }));
    expect(p.status).toBe("completed");
    expect(p.title).toBe("Google task");
    expect(p.steps).toHaveLength(0);
  });

  it("importableGoogleTasks: only returns trees not already linked to a local plan", () => {
    const existing = [
      normalizeTaskPlan({ title: "Already here", source: { kind: "typed", text: "x" }, googleTaskId: "gt-1", steps: [{ title: "s" }] }),
      normalizeTaskPlan({ title: "No google link", source: { kind: "typed", text: "y" }, steps: [{ title: "s" }] }),
    ];
    const trees = [
      { id: "gt-1", title: "Already here", subtasks: [] }, // linked → skip
      { id: "gt-2", title: "New from Google", subtasks: [] }, // not linked → import
      { id: "", title: "No id", subtasks: [] }, // malformed → skip
    ];
    expect(importableGoogleTasks(trees, existing).map((t) => t.id)).toEqual(["gt-2"]);
  });

  it("formatPlanForGoogleNotes renders the whole plan for the parent task's notes", () => {
    const notes = formatPlanForGoogleNotes({
      summary: "Apply to the data scientist role",
      deadlineIso: "2026-07-10",
      steps: [
        { title: "Tailor resume", detail: "Match the JD keywords", actor: "ai_prep", status: "done", dueIso: "2026-07-01" },
        { title: "Submit application", actor: "user_action", status: "pending" },
      ],
    });
    expect(notes).toContain("Apply to the data scientist role");
    expect(notes).toContain("PLAN — 2 steps:");
    expect(notes).toContain("1. [x] Tailor resume (AI preps, due 2026-07-01)");
    expect(notes).toContain("Match the JD keywords");
    expect(notes).toContain("2. [ ] Submit application (you do)");
    expect(notes).toContain("Deadline: 2026-07-10");
    expect(notes.length).toBeLessThanOrEqual(8000);
  });

  it("applyStepEdits: appends by default, replaces on demand, re-orders, clears a stub's planned flag", () => {
    const p = plan(); // 3 steps
    const appended = applyStepEdits(p, [{ title: "Call the vendor", actor: "user_action" }]);
    expect(appended.steps).toHaveLength(4);
    expect(appended.steps[3]!.title).toBe("Call the vendor");
    expect(appended.steps.map((s) => s.order)).toEqual([0, 1, 2, 3]);

    const replaced = applyStepEdits(p, [{ title: "Only step" }], { replace: true });
    expect(replaced.steps).toHaveLength(1);
    expect(replaced.steps[0]!.title).toBe("Only step");

    // A stub (planned:false, 0 steps) loses `planned` once it gains steps (so the sweep won't wipe it).
    const stub = normalizeTaskPlan({ title: "x", source: { kind: "typed", text: "x" }, planned: false, steps: [] });
    expect(needsPlanning(stub)).toBe(true);
    const filled = applyStepEdits(stub, [{ title: "a step" }]);
    expect(needsPlanning(filled)).toBe(false);
    expect(filled.planned).toBeUndefined();
  });

  it("keeps + bounds clarifying questions (drops empties, caps to 6)", () => {
    const p = normalizeTaskPlan({
      title: "Trip",
      source: { kind: "typed", text: "x" },
      steps: [{ title: "s" }],
      clarifyingQuestions: ["Which city?", "", "Budget?", "a", "b", "c", "d", "e"],
    });
    expect(p.clarifyingQuestions).toEqual(["Which city?", "Budget?", "a", "b", "c", "d"]); // empties dropped, capped at 6
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

  it("archive soft-removes (keeps the plan, hidden from active), restore brings it back", async () => {
    const store = new InMemoryStore();
    const p = plan();
    await upsertTaskPlan(store, p);
    await archiveTaskPlan(store, p.id, "ignored");
    const removed = (await loadTaskPlans(store))[0]!;
    expect(removed.status).toBe("archived"); // still in the store (so it won't re-surface/re-import)
    expect(removed.archivedReason).toBe("ignored");
    expect(removed.archivedAt).toBeGreaterThan(0);
    await restoreTaskPlan(store, p.id);
    const back = (await loadTaskPlans(store))[0]!;
    expect(back.status).toBe("active");
    expect(back.archivedReason).toBeUndefined();
    expect(back.archivedAt).toBeUndefined();
  });

  it("recurrence: normalize/describe/shift and nextOccurrence roll a completed task forward", () => {
    expect(normalizeRecurrence({ freq: "weekly", interval: 2 })).toEqual({ freq: "weekly", interval: 2 });
    expect(normalizeRecurrence({ freq: "weekly", interval: 0 })).toEqual({ freq: "weekly", interval: 1 }); // clamped
    expect(normalizeRecurrence({ freq: "yearly" })).toBeUndefined(); // unknown freq dropped
    expect(describeRecurrence({ freq: "daily", interval: 1 })).toBe("every day"); // label
    expect(describeRecurrence({ freq: "weekly", interval: 2 })).toBe("every 2 weeks");
    expect(shiftIso("2026-07-01", { freq: "weekly", interval: 1 })).toBe("2026-07-08");
    expect(shiftIso("2026-01-31", { freq: "monthly", interval: 1 })).toBe("2026-03-03"); // JS month roll

    const weekly = plan({
      deadlineIso: "2026-07-01",
      recurrence: { freq: "weekly", interval: 1 },
      steps: [
        { title: "Pay the fee", status: "done", dueIso: "2026-06-30" },
        { title: "File it", status: "done", dueIso: "2026-07-01" },
      ],
    });
    // Completed on 2026-07-05 → next occurrence is the following week, steps reset to pending.
    const next = normalizeTaskPlan({ ...nextOccurrence(weekly, "2026-07-05")!, id: weekly.id });
    expect(next.id).toBe(weekly.id); // rolls in place
    expect(next.deadlineIso).toBe("2026-07-08");
    expect(next.status).toBe("active");
    expect(next.recurrence).toEqual({ freq: "weekly", interval: 1 });
    expect(next.steps.every((s) => s.status !== "done")).toBe(true);
    expect(next.steps[0]!.dueIso).toBe("2026-07-07"); // step due shifted by the same week
    expect(next.googleTaskId).toBeUndefined(); // new cycle gets its own Google task
  });

  it("nextOccurrence returns undefined for a non-recurring plan", () => {
    expect(nextOccurrence(plan(), "2026-07-05")).toBeUndefined();
  });

  it("removeIgnore deletes a rule (the undo for a restored ignore)", async () => {
    const store = new InMemoryStore();
    await addIgnore(store, { kind: "sender", value: "spam@x.com" });
    await addIgnore(store, { kind: "phrase", value: "sale" });
    await removeIgnore(store, { kind: "sender", value: "SPAM@x.com" }); // case-insensitive
    const rules = await loadIgnored(store);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.kind).toBe("phrase");
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

  it("tasksIndexBlock names the active task + current step with ids", () => {
    const block = tasksIndexBlock(plan({ deadlineIso: "2026-07-01" }));
    expect(block).toContain("ACTIVE TASK: Renew registration");
    expect(block).toContain("deadline 2026-07-01");
    expect(block).toContain("Gather documents");
    expect(block).toMatch(/plan id:/);
    expect(block).toMatch(/step id:/);
  });

  it("tasksIndexBlock surfaces open clarifying questions so the chat asks them first", () => {
    const block = tasksIndexBlock(plan({ clarifyingQuestions: ["Which city are you flying from?"] }));
    expect(block).toMatch(/OPEN QUESTIONS/);
    expect(block).toContain("Which city are you flying from?");
  });

  it("tasksIndexBlock reports an all-done plan but still carries the plan id (so it can be re-planned)", () => {
    const done = plan({
      steps: [
        { title: "Gather documents", actor: "ai_prep", status: "done" },
        { title: "Pay the fee online", actor: "user_action", status: "done" },
      ],
    });
    const block = tasksIndexBlock(done);
    expect(block).toContain("All steps are done.");
    expect(block).toMatch(/plan id:/);
  });

  it("resolveActiveTaskPlanId returns the plan whose session is active, else undefined", () => {
    const a = plan({ id: "task-a", sessionId: "buddy-1" });
    const b = plan({ id: "task-b", sessionId: "buddy-2" });
    expect(resolveActiveTaskPlanId([a, b], "buddy-2")).toBe("task-b");
    expect(resolveActiveTaskPlanId([a, b], "buddy-9")).toBeUndefined();
    expect(resolveActiveTaskPlanId([a, b], undefined)).toBeUndefined();
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
