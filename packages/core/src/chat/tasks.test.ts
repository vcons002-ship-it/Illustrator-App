import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import {
  MAX_TASK_PLANS,
  addIgnore,
  advanceStep,
  appendTaskContext,
  completeStepById,
  harvestTaskContext,
  mergeUserNotes,
  deleteTaskPlan,
  archiveTaskPlan,
  restoreTaskPlan,
  removeIgnore,
  normalizeRecurrence,
  nextAutoStep,
  MAX_WATCHES,
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
  hasGoogleSkipMarker,
  sourceTag,
  attachSourceEmailLink,
  gmailMessageLink,
  formatPlanForGoogleNotes,
  taskStubFromCandidate,
  tasksIndexBlock,
  taskDossier,
  applyTaskDocEdit,
  applyPlanEdit,
  googleParentPatch,
  mergeReplan,
  taskSourceNote,
  resolveActiveTaskPlanId,
  sessionLabelForPlan,
  updateTaskStep,
  setTaskPlanComplete,
  upsertTaskPlan,
  type TaskPlan,
  type TaskPlanInput,
  whenLabel,
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

  it("attachSourceEmailLink drops a Gmail link on the step that needs the reply/send", () => {
    const plan = normalizeTaskPlan({
      title: "Lease question",
      source: { kind: "email", emailId: "m9" },
      steps: [
        { title: "Read the lease terms", actor: "ai_prep" },
        { title: "Reply to the landlord with your answer", actor: "user_action" },
      ],
    });
    const linked = attachSourceEmailLink(plan, "m9");
    expect(linked.steps[0]!.links).toHaveLength(0);
    expect(linked.steps[1]!.links[0]).toEqual({ label: "📧 Open the email", url: gmailMessageLink("m9") });
    // Idempotent + no-op without an id.
    expect(attachSourceEmailLink(linked, "m9").steps[1]!.links).toHaveLength(1);
    expect(attachSourceEmailLink(plan, undefined)).toBe(plan);
  });

  it("formatPlanForGoogleNotes includes step links (so the email link is tappable in Google Tasks)", () => {
    const notes = formatPlanForGoogleNotes({
      steps: [
        { title: "Reply", actor: "user_action", status: "pending", links: [{ label: "📧 Open the email", url: gmailMessageLink("m9") }] },
      ],
    });
    expect(notes).toContain("📧 Open the email:");
    expect(notes).toContain(gmailMessageLink("m9"));
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
    // …and the new wording is PUSHED, rather than leaving Google showing the old one forever.
    expect(a[0]).toEqual({ title: "Renamed step", existingId: "g9", create: false, needsComplete: false, patch: { title: "Renamed step" } });
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

  it("sourceTag labels each origin (Gmail / Calendar / VR / Google Tasks)", () => {
    expect(sourceTag({ kind: "email", emailId: "m1" })).toBe("Gmail");
    expect(sourceTag({ kind: "calendar", eventId: "e1" })).toBe("Calendar");
    expect(sourceTag({ kind: "scan", emailId: "m1" })).toBe("Gmail");
    expect(sourceTag({ kind: "scan", eventId: "e1" })).toBe("Calendar");
    expect(sourceTag({ kind: "typed", text: "renew" })).toBe("VR");
    expect(sourceTag({ kind: "google", taskId: "gt-1" })).toBe("Google Tasks");
    // A Google-imported plan carries the "google" source → tagged "Google Tasks", not "VR".
    expect(sourceTag(planFromGoogleTask({ id: "gt-1", title: "Buy milk", subtasks: [] }).source)).toBe("Google Tasks");
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

  it("importableGoogleTasks skips tasks the reader marked [skip]/[ignore] in Google", () => {
    const trees = [
      { id: "gt-2", title: "Real task", subtasks: [] },
      { id: "gt-3", title: "Groceries [skip]", subtasks: [] },
      { id: "gt-4", title: "[ignore] personal note", subtasks: [] },
    ];
    expect(importableGoogleTasks(trees, []).map((t) => t.id)).toEqual(["gt-2"]);
    expect(hasGoogleSkipMarker("Groceries [skip]")).toBe(true);
    expect(hasGoogleSkipMarker("[IGNORE] x")).toBe(true);
    expect(hasGoogleSkipMarker("normal title")).toBe(false);
    expect(hasGoogleSkipMarker(undefined)).toBe(false);
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
    // Monthly from a day-31 date CLAMPS to the target month's last day instead of overflowing: Jan 31
    // rolls to Feb 28 (2026 is not a leap year), never skipping into March.
    expect(shiftIso("2026-01-31", { freq: "monthly", interval: 1 })).toBe("2026-02-28");
    expect(shiftIso("2024-01-31", { freq: "monthly", interval: 1 })).toBe("2024-02-29"); // leap-year Feb
    expect(shiftIso("2026-08-31", { freq: "monthly", interval: 1 })).toBe("2026-09-30"); // 30-day month
    expect(shiftIso("2026-11-15", { freq: "monthly", interval: 1 })).toBe("2026-12-15"); // no clamp needed
    expect(shiftIso("2026-12-31", { freq: "monthly", interval: 1 })).toBe("2027-01-31"); // year roll intact

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

  it("setTaskPlanComplete ticks every step + completes, and reopen resets a fully-done plan", async () => {
    const store = new InMemoryStore();
    const p = plan(); // multi-step, none done
    await upsertTaskPlan(store, p);
    const done = await setTaskPlanComplete(store, p.id, true);
    expect(done[0]!.status).toBe("completed");
    expect(done[0]!.steps.every((s) => s.status === "done")).toBe(true);
    // Reopen a fully-done plan → active again, first step ready, the rest pending.
    const reopened = await setTaskPlanComplete(store, p.id, false);
    expect(reopened[0]!.status).toBe("active");
    expect(reopened[0]!.steps[0]!.status).toBe("ready");
    expect(reopened[0]!.steps.slice(1).every((s) => s.status === "pending")).toBe(true);
  });

  it("setTaskPlanComplete completes a no-step to-do", async () => {
    const store = new InMemoryStore();
    const p = plan({ steps: [] });
    await upsertTaskPlan(store, p);
    const done = await setTaskPlanComplete(store, p.id, true);
    expect(done[0]!.status).toBe("completed");
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

  it("harvestTaskContext pulls pasted links + attached-file names from a turn's text", () => {
    const text =
      '[Attached file "resume.pdf"]\nJane Doe — 8y analytics…\n\n' +
      '[Attached image "headshot.jpg" — what it shows]\nA portrait.\n\n' +
      "Here's the job: https://jobs.acme.com/senior-analyst?id=42 and their site (https://acme.com).";
    expect(harvestTaskContext(text)).toEqual([
      "Link from chat: https://jobs.acme.com/senior-analyst?id=42",
      "Link from chat: https://acme.com",
      "Attached in chat: resume.pdf",
      "Attached in chat: headshot.jpg",
    ]);
    expect(harvestTaskContext("no links here")).toEqual([]);
  });

  it("mergeUserNotes appends bullets, dedupes verbatim repeats, and caps keeping the newest", () => {
    // Each note carries the day it was written: these are what a task remembers between sessions and
    // across scheduled runs that resume it cold, and undated they read as one flat present tense.
    const day = new Date(2026, 7, 1);
    const first = mergeUserNotes(undefined, ["Link from chat: https://a.com"], undefined, day);
    expect(first).toBe("• [2026-08-01] Link from chat: https://a.com");
    // Re-sending the same link changes nothing (same reference back) — even on a LATER day, since the
    // dedupe is on the note's own text, not on the line it became.
    expect(mergeUserNotes(first, ["Link from chat: https://a.com"], undefined, new Date(2026, 7, 9))).toBe(first);
    const grown = mergeUserNotes(first, ["Attached in chat: resume.pdf"], undefined, new Date(2026, 7, 9));
    expect(grown).toBe("• [2026-08-01] Link from chat: https://a.com\n• [2026-08-09] Attached in chat: resume.pdf");
    // Over the cap, the OLDEST content falls off the front.
    const capped = mergeUserNotes("x".repeat(90), ["newest note"], 40, day);
    expect(capped!.length).toBeLessThanOrEqual(40);
    expect(capped).toContain("newest note");
  });

  it("mergeUserNotes drops WHOLE oldest notes and says so, instead of cutting one in half", () => {
    const existing = ["• paid the deposit on the 3rd", "• venue confirmed for the 14th", "• catering still open"].join("\n");
    const r = mergeUserNotes(existing, ["band booked"], 95, new Date(2026, 7, 1))!;
    expect(r.length).toBeLessThanOrEqual(95);
    // The newest note survives, and so does the note before it — whole.
    expect(r).toContain("band booked");
    expect(r).toContain("• catering still open");
    // The loss is stated rather than silent, and nothing is left as a half-sentence fragment.
    expect(r).toMatch(/earlier notes? dropped/);
    expect(r).not.toContain("ed the deposit"); // no mid-note fragment
    for (const line of r.split("\n")) expect(line.startsWith("•")).toBe(true);
  });

  it("mergeUserNotes still respects the cap when a single note is longer than it", () => {
    const r = mergeUserNotes(undefined, ["y".repeat(200)], 50)!;
    expect(r.length).toBeLessThanOrEqual(50);
    expect(r.startsWith("…")).toBe(true); // marked as cut, not passed off as whole
  });

  it("appendTaskContext persists notes onto the plan and can flag a re-plan", async () => {
    const store = new InMemoryStore();
    const [saved] = await upsertTaskPlan(store, plan());
    const next = await appendTaskContext(store, saved!.id, ["Link from chat: https://jobs.acme.com/42"], { replan: true });
    expect(next!.userNotes).toContain("https://jobs.acme.com/42");
    expect(next!.needsReplan).toBe(true);
    const reloaded = (await loadTaskPlans(store)).find((p) => p.id === saved!.id);
    expect(reloaded!.userNotes).toContain("https://jobs.acme.com/42");
    // A repeat of the same note is a no-op; an unknown id returns undefined.
    expect((await appendTaskContext(store, saved!.id, ["Link from chat: https://jobs.acme.com/42"]))!.userNotes).toBe(next!.userNotes);
    expect(await appendTaskContext(store, "task-nope", ["x"])).toBeUndefined();
  });

  it("completeStepById checks off the NAMED step, out of order", () => {
    const p = plan();
    const middle = p.steps[1]!; // "Pay the fee online" — not the first pending step
    const r = completeStepById(p, middle.id)!;
    expect(r.step.status).toBe("done");
    expect(r.plan.steps[1]!.status).toBe("done");
    expect(r.plan.steps[0]!.status).toBe("ready"); // untouched — still the visible next action
    expect(r.completed).toBe(false);
    expect(r.ready).toBeUndefined(); // something was already ready, so nothing is promoted
  });

  it("completeStepById promotes the next step to ready when nothing is left in flight", () => {
    const p = plan(); // step 0 ready, 1-2 pending
    const r = completeStepById(p, p.steps[0]!.id)!;
    expect(r.plan.steps[0]!.status).toBe("done");
    expect(r.ready!.title).toBe("Pay the fee online");
    expect(r.plan.steps[1]!.status).toBe("ready");
  });

  it("completeStepById completes the plan on the last step, and un-checking reopens it", () => {
    let p = plan();
    for (const s of p.steps) p = completeStepById(p, s.id)!.plan;
    expect(p.status).toBe("completed");
    const reopened = completeStepById(p, p.steps[2]!.id, false)!;
    expect(reopened.plan.status).toBe("active");
    expect(reopened.plan.steps[2]!.status).toBe("ready");
    expect(reopened.completed).toBe(false);
  });

  it("completeStepById returns undefined for an unknown step id", () => {
    expect(completeStepById(plan(), "step-nope")).toBeUndefined();
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

  it("sessionLabelForPlan names the chat after the task, capped and trimmed", () => {
    expect(sessionLabelForPlan({ title: "Book the dentist" })).toBe("Book the dentist");
    expect(sessionLabelForPlan({ title: "  Plan   the   party  " })).toBe("Plan the party");
    expect(sessionLabelForPlan({ title: "" })).toBe("Task");
    expect(sessionLabelForPlan({})).toBe("Task");
    const long = "Organize the entire end-of-year fundraising gala including catering and venue booking";
    const label = sessionLabelForPlan({ title: long });
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.endsWith("…")).toBe(true);
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

describe("nextAutoStep — what the assistant may work on unattended", () => {
  const p = (over: Partial<TaskPlanInput> = {}): TaskPlan =>
    normalizeTaskPlan({
      title: "T",
      source: { kind: "typed", text: "t" },
      steps: [{ title: "Draft it", actor: "ai_prep", status: "ready" }],
      ...over,
    });

  it("picks a ready ai_prep step of an active, planned task", () => {
    const got = nextAutoStep([p()]);
    expect(got?.step.title).toBe("Draft it");
  });

  it("never picks a step the READER has to do", () => {
    expect(nextAutoStep([p({ steps: [{ title: "Pay the fee", actor: "user_action", status: "ready" }] })])).toBeUndefined();
  });

  it("waits while the plan is known to be stale (needsReplan) — acting would use superseded steps", () => {
    expect(nextAutoStep([p({ needsReplan: true })])).toBeUndefined();
  });

  it("waits while the planner has open questions rather than guessing", () => {
    expect(nextAutoStep([p({ clarifyingQuestions: ["Which airport?"] })])).toBeUndefined();
  });

  it("skips stubs, non-active plans, blocked and finished steps", () => {
    // A real stub is planned:false WITH NO STEPS (normalizeTaskPlan clears the flag once steps exist),
    // so there's nothing to work from until the sweep plans it.
    expect(nextAutoStep([p({ planned: false, steps: [] })])).toBeUndefined();
    expect(nextAutoStep([p({ status: "completed" })])).toBeUndefined();
    expect(nextAutoStep([p({ steps: [{ title: "Blocked", actor: "ai_prep", status: "blocked" }] })])).toBeUndefined();
    expect(nextAutoStep([p({ steps: [{ title: "Done", actor: "ai_prep", status: "done" }] })])).toBeUndefined();
  });

  it("honours skipStepIds so a step that can't be finished alone isn't retried forever", () => {
    const one = p();
    expect(nextAutoStep([one], { skipStepIds: new Set([one.steps[0]!.id]) })).toBeUndefined();
  });

  it("takes the most urgent first — step due date, else the plan's deadline", () => {
    const soon = p({ title: "Soon", steps: [{ title: "A", actor: "ai_prep", status: "ready", dueIso: "2026-07-01" }] });
    const later = p({ title: "Later", steps: [{ title: "B", actor: "ai_prep", status: "ready", dueIso: "2026-09-01" }] });
    const undated = p({ title: "Undated" });
    expect(nextAutoStep([later, undated, soon])?.plan.title).toBe("Soon");
    expect(nextAutoStep([undated, later])?.plan.title).toBe("Later"); // undated sorts last
  });
});

describe("planner-requested watches", () => {
  const withWatches = (watches: unknown[]): TaskPlan =>
    normalizeTaskPlan({
      title: "Party",
      source: { kind: "typed", text: "party" },
      steps: [{ title: "Invite", actor: "user_action" }],
      watches: watches as NonNullable<TaskPlanInput["watches"]>,
    });

  it("keeps well-formed watches and caps how many a plan may request", () => {
    const ok = withWatches([{ title: "RSVP check", prompt: "check replies", rule: "daily", time: "08:00" }]);
    expect(ok.watches).toEqual([{ title: "RSVP check", prompt: "check replies", rule: "daily", time: "08:00" }]);
    const many = withWatches(
      Array.from({ length: 9 }, (_, i) => ({ title: `w${i}`, prompt: "p", rule: "daily" })),
    );
    expect(many.watches).toHaveLength(MAX_WATCHES);
  });

  it("drops a watch with no cadence, title or prompt rather than guessing one", () => {
    expect(withWatches([{ title: "No rule", prompt: "p" }]).watches).toBeUndefined();
    expect(withWatches([{ prompt: "p", rule: "daily" }]).watches).toBeUndefined();
    expect(withWatches([{ title: "t", rule: "daily" }]).watches).toBeUndefined();
    expect(withWatches([{ title: "t", prompt: "p", rule: "hourly" }]).watches).toBeUndefined();
  });

  it("clamps weekday/dayOfMonth and only keeps a date on a one-shot", () => {
    const w = withWatches([{ title: "t", prompt: "p", rule: "weekly", weekday: 99, dayOfMonth: 0, date: "2026-07-04" }]).watches![0]!;
    expect(w.weekday).toBe(6);
    expect(w.dayOfMonth).toBe(1);
    expect(w.date).toBeUndefined(); // not a one-shot
    expect(withWatches([{ title: "t", prompt: "p", rule: "once", date: "2026-07-04" }]).watches![0]!.date).toBe("2026-07-04");
  });
});

describe("a task carries its dates where the model can read them", () => {
  // Asked for: "tasks need time stamps that the ai can see" — with today's date, so they can be
  // compared. A task is worked across days by a reader AND by scheduled runs that resume it cold; a
  // block with no clock in it made a month-old plan indistinguishable from this morning's.
  const NOW = new Date(2026, 7, 1, 9, 0).getTime();
  const day = (d: number) => new Date(2026, 6, d, 9, 0).getTime();

  const plan = {
    id: "p1", title: "Party", status: "active", source: { kind: "manual" }, summary: "throw a party",
    createdAt: day(12), updatedAt: day(30),
    steps: [
      { id: "s1", title: "Book venue", detail: "", actor: "user_action", status: "done", order: 0, links: [], docs: [], doneAt: day(14) },
      { id: "s2", title: "Send invites", detail: "", actor: "user_action", status: "done", order: 1, links: [], docs: [], doneAt: day(30) },
      { id: "s3", title: "Order cake", detail: "", actor: "user_action", status: "ready", order: 2, links: [], docs: [] },
    ],
  } as unknown as Parameters<typeof tasksIndexBlock>[0];

  it("says when it was created, last touched, and how far along", () => {
    const block = tasksIndexBlock(plan, NOW);
    expect(block).toContain("Created 2026-07-12 (20 days ago)");
    expect(block).toContain("last touched 2026-07-30 (2 days ago)");
    expect(block).toContain("2 of 3 steps done");
    expect(block).toContain("most recent 2026-07-30");
  });

  it("gives both the date and the age, because each answers a different question", () => {
    // The absolute date lines up with a deadline and with today's date at the top of the prompt; the
    // relative one answers "is this stale" without arithmetic the model is bad at.
    expect(whenLabel(NOW, NOW)).toBe("2026-08-01 (today)");
    expect(whenLabel(NOW - 86_400_000, NOW)).toBe("2026-07-31 (yesterday)");
    expect(whenLabel(NOW - 5 * 86_400_000, NOW)).toBe("2026-07-27 (5 days ago)");
  });

  it("says nothing about a most-recent completion when nothing is done yet", () => {
    const fresh = {
      ...plan,
      steps: plan.steps.map(({ doneAt: _drop, ...s }) => ({ ...s, status: "ready" })),
    } as unknown as typeof plan;
    const block = tasksIndexBlock(fresh, NOW);
    expect(block).toContain("0 of 3 steps done");
    expect(block).not.toContain("most recent");
  });

  it("stamps a step when it is checked off, and un-stamps it when reopened", () => {
    // A doneAt left on a reopened step would date work that has been undone.
    const done = completeStepById(plan, "s3", true, NOW)!;
    expect(done.step.doneAt).toBe(NOW);
    const reopened = completeStepById(done.plan, "s3", false)!;
    expect(reopened.step.doneAt).toBeUndefined();
  });
});

describe("taskSourceNote (where else a task's detail lives)", () => {
  it("names the calendar event a task came from, with the id needed to read it", () => {
    // Reported: asked to update an RSVP tracker that was on the task's calendar event, the model
    // searched what it could see, found nothing, and said there was nothing to find.
    const note = taskSourceNote({ kind: "calendar", eventId: "ev-9", summary: "Ada's party" });
    expect(note).toContain("ev-9");
    expect(note).toContain("Ada's party");
    expect(note).toMatch(/description/i);
    expect(note).toContain("list_events");
  });

  it("names the source email and how to read it", () => {
    const note = taskSourceNote({ kind: "email", emailId: "m-3", subject: "Invite", from: "ada@x.com" });
    expect(note).toContain("m-3");
    expect(note).toContain("read_email");
  });

  it("resolves a scanned item to whichever id it actually carries", () => {
    expect(taskSourceNote({ kind: "scan", eventId: "ev-1" })).toContain("list_events");
    expect(taskSourceNote({ kind: "scan", emailId: "m-1" })).toContain("read_email");
    expect(taskSourceNote({ kind: "scan" })).toBe("");
  });

  it("says nothing for a typed task, which has no elsewhere", () => {
    expect(taskSourceNote({ kind: "typed", text: "renew my registration" })).toBe("");
  });
});

describe("taskDossier (what the task already knows)", () => {
  it("surfaces saved context, research, documents and watches", () => {
    const p = plan({
      source: { kind: "calendar", eventId: "ev-9", summary: "Ada's party" },
      userNotes: "• [2026-07-01] Attached in chat: invite-list.csv",
      researchNotes: "Venue holds 40.",
      steps: [
        {
          title: "Track replies",
          actor: "ai_prep",
          docs: [{ title: "RSVP status tracker", kind: "reference", body: "- Ada: yes\n- Bo: ?" }],
        },
      ],
      watches: [{ title: "RSVP check", prompt: "check replies", rule: "daily", time: "08:00" }],
    });
    const d = taskDossier(p);
    expect(d).toContain("ev-9");
    expect(d).toContain("invite-list.csv"); // the file the reader handed it, by name
    expect(d).toContain("Venue holds 40.");
    expect(d).toContain("RSVP status tracker"); // the document it was told didn't exist
    expect(d).toContain("(reference)");
    expect(d).toContain("RSVP check");
  });

  it("keeps the NEWEST notes when they don't fit, and says they were cut", () => {
    const old = Array.from({ length: 40 }, (_, i) => `• [2026-01-01] old note ${i}`).join("\n");
    const p = plan({ userNotes: `${old}\n• [2026-07-01] the newest thing` });
    const d = taskDossier(p, 200);
    expect(d).toContain("the newest thing");
    expect(d).toContain("earlier notes trimmed");
    expect(d).not.toContain("old note 0");
  });

  it("is empty for a bare typed task with nothing accumulated", () => {
    expect(taskDossier(plan())).toBe("");
  });
});

describe("tasksIndexBlock carries the task's own material", () => {
  it("puts saved context in the prompt, not behind a tool call", () => {
    // The model doesn't fetch what it doesn't know exists — that was the whole failure.
    const p = plan({
      source: { kind: "calendar", eventId: "ev-9", summary: "Ada's party" },
      userNotes: "• [2026-07-01] Attached in chat: rsvp-tracker.md",
    });
    const block = tasksIndexBlock(p, Date.parse("2026-07-02T12:00:00Z"));
    expect(block).toContain("rsvp-tracker.md");
    expect(block).toContain("ev-9");
  });
});

describe("applyTaskDocEdit (writing a task's documents)", () => {
  const tracker = () =>
    plan({
      steps: [
        { title: "Send invites", actor: "user_action", status: "done" },
        {
          title: "Track replies",
          actor: "ai_prep",
          docs: [{ title: "RSVP status tracker", kind: "reference", body: "RSVP:\n- Ada: yes\n- Bo: ?\n- Cy: ?" }],
        },
      ],
    });

  it("updates one entry IN PLACE and leaves the rest alone", () => {
    // Rewriting the whole body from a partial view is how a tracker loses the lines the model
    // didn't happen to have in front of it.
    const r = applyTaskDocEdit(tracker(), { title: "RSVP status tracker", setLines: [{ match: "Bo", line: "Bo: yes" }] });
    expect(r.error).toBeUndefined();
    expect(r.created).toBe(false);
    expect(r.replaced).toEqual(["Bo"]);
    expect(r.doc!.body).toBe("RSVP:\n- Ada: yes\n- Bo: yes\n- Cy: ?");
  });

  it("adds a new entry into the list rather than at the bottom", () => {
    const r = applyTaskDocEdit(tracker(), { title: "RSVP status tracker", setLines: [{ match: "Dee", line: "Dee: yes" }] });
    expect(r.added).toEqual(["Dee"]);
    expect(r.doc!.body).toBe("RSVP:\n- Ada: yes\n- Bo: ?\n- Cy: ?\n- Dee: yes");
  });

  it("matches the document by title, case-insensitively, and doesn't start a second one", () => {
    const r = applyTaskDocEdit(tracker(), { title: "rsvp STATUS tracker", setLines: [{ match: "Ada", line: "Ada: no" }] });
    expect(r.created).toBe(false);
    expect(r.plan.steps.flatMap((s) => s.docs)).toHaveLength(1);
  });

  it("creates a document when there isn't one, on the step being worked", () => {
    const p = plan({ steps: [{ title: "Send invites", actor: "user_action" }] });
    const r = applyTaskDocEdit(p, { title: "Packing list", kind: "checklist", body: "- tent" });
    expect(r.created).toBe(true);
    expect(r.plan.steps[0]!.docs[0]).toMatchObject({ title: "Packing list", kind: "checklist", body: "- tent" });
  });

  it("reports an ambiguous label instead of guessing which line to overwrite", () => {
    const p = plan({
      steps: [{ title: "Track", actor: "ai_prep", docs: [{ title: "T", kind: "reference", body: "- Bo: chips\n- Bo: nut allergy" }] }],
    });
    const r = applyTaskDocEdit(p, { title: "T", setLines: [{ match: "Bo", line: "Bo: yes" }] });
    expect(r.ambiguous).toHaveLength(1);
    expect(r.doc!.body).toBe("- Bo: chips\n- Bo: nut allergy"); // untouched
  });

  it("refuses an edit with nothing in it, and one with nowhere to go", () => {
    expect(applyTaskDocEdit(tracker(), { title: "RSVP status tracker" }).error).toMatch(/nothing to change/i);
    const stub = plan({ steps: [] });
    expect(applyTaskDocEdit(stub, { title: "New doc", body: "x" }).error).toMatch(/no step/i);
  });
});

describe("mergeReplan (re-planning must not destroy the record)", () => {
  const before = () =>
    plan({
      userNotes: "• [2026-07-01] Attached in chat: invite-list.csv",
      steps: [
        { title: "Send invites", actor: "user_action", status: "done" },
        {
          title: "Track replies",
          actor: "ai_prep",
          status: "ready",
          researchNotes: "Ada replied by text",
          docs: [{ title: "RSVP status tracker", kind: "reference", body: "- Ada: yes" }],
        },
      ],
    });

  const after = () =>
    plan({
      title: "Party — refined",
      steps: [
        { title: "Send invites", actor: "user_action" },
        { title: "Track replies", actor: "ai_prep" },
        { title: "Order the cake", actor: "user_action" },
      ],
    });

  it("keeps completed work ticked and step ids stable", () => {
    // A re-plan used to un-tick every finished step and mint fresh ids, so any stepId the chat was
    // holding pointed at nothing.
    const old = before();
    const merged = mergeReplan(old, after());
    expect(merged.steps[0]!.status).toBe("done");
    expect(merged.steps[0]!.id).toBe(old.steps[0]!.id);
    expect(merged.steps[2]!.status).toBe("pending"); // genuinely new step
  });

  it("carries the documents and per-step findings across", () => {
    const merged = mergeReplan(before(), after());
    expect(merged.steps[1]!.docs[0]!.body).toBe("- Ada: yes");
    expect(merged.steps[1]!.researchNotes).toBe("Ada replied by text");
  });

  it("rehomes a document whose step the new plan dropped, instead of losing it", () => {
    const dropped = plan({ title: "Party", steps: [{ title: "Something else", actor: "ai_prep" }] });
    const merged = mergeReplan(before(), dropped);
    expect(merged.steps[0]!.docs.map((d) => d.title)).toContain("RSVP status tracker");
  });

  it("takes the new WORDING while keeping the old history", () => {
    const old = before();
    const merged = mergeReplan(old, after());
    expect(merged.title).toBe("Party — refined"); // the plan is the planner's to change
    expect(merged.userNotes).toContain("invite-list.csv"); // the record is not
    expect(merged.id).toBe(old.id);
  });

  it("does not quietly un-archive a task the reader removed", () => {
    const archived = { ...before(), status: "archived" as const, archivedReason: "removed" as const, archivedAt: 5 };
    const merged = mergeReplan(archived, after());
    expect(merged.status).toBe("archived");
    expect(merged.archivedReason).toBe("removed");
  });

  it("doesn't erase the previous research when the new pass gathered none", () => {
    const withResearch = { ...before(), researchNotes: "Venue holds 40." };
    const merged = mergeReplan(withResearch, after());
    expect(merged.researchNotes).toBe("Venue holds 40.");
  });
});

describe("editing a task and its steps without re-planning", () => {
  it("changes the task's own fields and clears answered questions", () => {
    const p = plan({ clarifyingQuestions: ["Which venue?"] });
    const next = applyPlanEdit(p, { title: "Ada's party", deadlineIso: "2026-08-01", clarifyingQuestions: [] });
    expect(next.title).toBe("Ada's party");
    expect(next.deadlineIso).toBe("2026-08-01");
    expect(next.clarifyingQuestions).toEqual([]);
  });

  it("edits an existing step in place instead of cloning its id", () => {
    // Concatenating an edit that carried an existing id produced TWO steps sharing it, and the
    // impostor — with no docs, no links and status "pending" — won every lookup by id.
    const p = plan({
      steps: [{ title: "Track replies", actor: "ai_prep", status: "in_progress", docs: [{ title: "T", kind: "reference", body: "x" }] }],
    });
    const id = p.steps[0]!.id;
    const next = applyStepEdits(p, [{ id, title: "Track replies + chase" }]);
    expect(next.steps).toHaveLength(1);
    expect(next.steps[0]!.id).toBe(id);
    expect(next.steps[0]!.title).toBe("Track replies + chase");
    expect(next.steps[0]!.status).toBe("in_progress");
    expect(next.steps[0]!.docs[0]!.body).toBe("x");
  });

  it("still appends a step that names no existing id", () => {
    const p = plan();
    expect(applyStepEdits(p, [{ title: "Order the cake" }]).steps).toHaveLength(4);
  });
});

describe("finished work stays finished and stays visible", () => {
  const worked = () =>
    plan({
      steps: [
        { title: "Book the venue", actor: "user_action", status: "done" },
        { title: "Send invites", actor: "user_action", status: "done" },
        { title: "Track replies", actor: "ai_prep", status: "ready" },
      ],
    });

  it("names the done steps in the prompt, not just a count", () => {
    // "3 of 7 steps done" is a number the model can't act on: it re-proposed finished work because
    // it was never told WHICH work was finished.
    const block = tasksIndexBlock(worked(), Date.now());
    expect(block).toContain("ALREADY DONE");
    expect(block).toContain("Book the venue");
    expect(block).toContain("Send invites");
    expect(block).toMatch(/do NOT redo/i);
  });

  it("keeps finished steps when the planner returns only the remainder", () => {
    // The planner is now TOLD what's done so it plans what's left — so a faithful re-plan comes
    // back without them, and mapping over its list alone would erase the record.
    const remainder = plan({ steps: [{ title: "Track replies", actor: "ai_prep" }, { title: "Order the cake", actor: "user_action" }] });
    const merged = mergeReplan(worked(), remainder);
    expect(merged.steps.map((s) => s.title)).toEqual(["Book the venue", "Send invites", "Track replies", "Order the cake"]);
    expect(merged.steps.slice(0, 2).every((s) => s.status === "done")).toBe(true);
    expect(merged.steps.map((s) => s.order)).toEqual([0, 1, 2, 3]);
  });

  it("still drops an UNFINISHED step the re-plan deliberately removed", () => {
    const p = plan({ steps: [{ title: "Obsolete step", actor: "user_action", status: "ready" }] });
    const merged = mergeReplan(p, plan({ steps: [{ title: "The real work", actor: "ai_prep" }] }));
    expect(merged.steps.map((s) => s.title)).toEqual(["The real work"]);
  });
});

describe("pushing the app's state back to Google Tasks", () => {
  it("reopens a sub-task Google still shows as completed", () => {
    // The sync only ever pushed completions, so un-ticking a step in the app was a change Google
    // never heard about — the reader saw it reopen here and stay struck through there.
    const a = reconcileGoogleSubtasks(
      [{ title: "Tailor resume", status: "ready", googleTaskId: "g1" }],
      [{ id: "g1", title: "Tailor resume", status: "completed" }],
    );
    expect(a[0]!.needsReopen).toBe(true);
    expect(a[0]!.needsComplete).toBe(false);
  });

  it("writes back only the fields that actually drifted", () => {
    const a = reconcileGoogleSubtasks(
      [{ title: "Submit", status: "pending", googleTaskId: "g1", detail: "before 5pm", dueIso: "2026-08-10" }],
      [{ id: "g1", title: "Submit", status: "needsAction", notes: "before 5pm", due: "2026-08-10T00:00:00.000Z" }],
    );
    // Same day, same notes, same title → nothing to write. (Google stores a full timestamp and only
    // honours the date, so comparing raw strings would report drift on every single sync.)
    expect(a[0]!.patch).toBeUndefined();
    const drifted = reconcileGoogleSubtasks(
      [{ title: "Submit", status: "pending", googleTaskId: "g1", detail: "before 5pm", dueIso: "2026-08-12" }],
      [{ id: "g1", title: "Submit", status: "needsAction", notes: "before 5pm", due: "2026-08-10T00:00:00.000Z" }],
    );
    expect(drifted[0]!.patch).toEqual({ due: "2026-08-12" });
  });

  it("carries the task's own title, date and done-state onto the parent", () => {
    // Only the notes were ever refreshed, so a renamed, re-dated or completed task still showed on
    // the reader's phone under the old title, on the old date, as something still to do.
    const p = plan({ title: "Ada's party", deadlineIso: "2026-08-01" });
    expect(googleParentPatch(p, "the notes")).toEqual({
      title: "Ada's party",
      status: "needsAction",
      notes: "the notes",
      due: "2026-08-01",
    });
    expect(googleParentPatch({ ...p, status: "completed" }, "n").status).toBe("completed");
    const { due } = googleParentPatch({ title: "x", status: "active" }, "n");
    expect(due).toBeUndefined();
  });
});
