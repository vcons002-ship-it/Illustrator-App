import { describe, expect, it } from "vitest";
import type { BuddyPlan, BuddyToolCall, BuddyToolResultPayload } from "./buddy-tools.js";
import {
  type StepEvidence,
  type WorkflowStep,
  advanceWorkflow,
  compileWorkflow,
  doneWhenToNeeds,
  evaluateStep,
  inferDoneWhen,
  isToolContract,
  needsToDoneWhen,
  resumeWorkflow,
  workflowToPlan,
} from "./workflow.js";

const ev = (
  results: { call: BuddyToolCall; result: BuddyToolResultPayload }[] = [],
  text = "",
): StepEvidence => ({ toolResults: results, text });

const step = (over: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id: "s1",
  instruction: "do a thing",
  doneWhen: { kind: "text", min: 1 },
  onFail: "ask_user",
  maxAttempts: 2,
  status: "active",
  attempts: 0,
  ...over,
});

describe("needsToDoneWhen", () => {
  it("maps aliases and bare tool names", () => {
    expect(needsToDoneWhen("image")).toEqual({ kind: "image" });
    expect(needsToDoneWhen("generate_image")).toEqual({ kind: "image" });
    expect(needsToDoneWhen("file")).toEqual({ kind: "file" });
    expect(needsToDoneWhen("command")).toEqual({ kind: "command_ok" });
    expect(needsToDoneWhen("reply")).toEqual({ kind: "user_reply" });
    expect(needsToDoneWhen("search_web")).toEqual({ kind: "tool_ok", tool: "search_web" });
    expect(needsToDoneWhen("")).toBeUndefined();
    expect(needsToDoneWhen(undefined)).toBeUndefined();
  });
});

describe("inferDoneWhen", () => {
  it("guesses a contract from the instruction text", () => {
    expect(inferDoneWhen("Generate an image of a red castle")).toEqual({ kind: "image" });
    expect(inferDoneWhen("Save a summary to notes.md")).toEqual({ kind: "file" });
    expect(inferDoneWhen("Run the test suite")).toEqual({ kind: "command_ok" });
    expect(inferDoneWhen("Search the web for tide tables")).toEqual({ kind: "tool_ok", tool: "search_web" });
    expect(inferDoneWhen("Ask me my favorite color")).toEqual({ kind: "user_reply" });
    expect(inferDoneWhen("List three follow-up ideas")).toEqual({ kind: "text", min: 1 });
  });
});

describe("compileWorkflow", () => {
  it("prefers a declared need, infers otherwise, and activates the first step", () => {
    const plan: BuddyPlan = {
      goal: "make art",
      steps: [
        { text: "Generate image A", status: "pending", needs: "image" },
        { text: "Say a closing line", status: "pending" }, // no need → inferred
      ],
    };
    const wf = compileWorkflow(plan);
    expect(wf.goal).toBe("make art");
    expect(wf.steps[0]).toMatchObject({ id: "s1", doneWhen: { kind: "image" }, status: "active", attempts: 0 });
    expect(wf.steps[1]!.status).toBe("pending");
    expect(wf.steps[1]!.doneWhen.kind).toBe("text"); // "say a closing line" → text
  });

  it("normalizes onFail (retry → ask_user) and defaults maxAttempts", () => {
    const wf = compileWorkflow({ steps: [{ text: "x", status: "pending", onFail: "retry" }] });
    expect(wf.steps[0]!.onFail).toBe("ask_user");
    expect(wf.steps[0]!.maxAttempts).toBe(2);
  });
});

describe("evaluateStep — the collar (evidence only)", () => {
  const img = (ok: boolean): { call: BuddyToolCall; result: BuddyToolResultPayload } => ({
    call: { tool: "generate_image", prompt: "x" },
    result: { image: { ok } },
  });

  it("image: done only when a render actually landed", () => {
    expect(evaluateStep(step({ doneWhen: { kind: "image" } }), ev([img(true)])).done).toBe(true);
    expect(evaluateStep(step({ doneWhen: { kind: "image" } }), ev([img(false)])).done).toBe(false);
    // The model narrating "I made the image!" with NO render does NOT satisfy it.
    expect(evaluateStep(step({ doneWhen: { kind: "image" } }), ev([], "Here is your image!")).done).toBe(false);
  });

  it("file / command_ok / tool_ok read their payload signals", () => {
    expect(evaluateStep(step({ doneWhen: { kind: "file" } }), ev([{ call: { tool: "write_file", path: "a", content: "" }, result: { writeFile: { path: "a", ok: true } } }])).done).toBe(true);
    expect(evaluateStep(step({ doneWhen: { kind: "command_ok" } }), ev([{ call: { tool: "run_command", command: "ls" }, result: { command: { stdout: "", stderr: "", code: 0 } } }])).done).toBe(true);
    expect(evaluateStep(step({ doneWhen: { kind: "command_ok" } }), ev([{ call: { tool: "run_command", command: "ls" }, result: { command: { stdout: "", stderr: "boom", code: 1 } } }])).done).toBe(false);
    expect(evaluateStep(step({ doneWhen: { kind: "tool_ok", tool: "search_web" } }), ev([{ call: { tool: "search_web", query: "x" }, result: { hits: [] } }])).done).toBe(true);
    expect(evaluateStep(step({ doneWhen: { kind: "tool_ok", tool: "search_web" } }), ev([{ call: { tool: "search_web", query: "x" }, result: { error: "network" } }])).done).toBe(false);
  });

  it("text: honors min length and optional regex", () => {
    expect(evaluateStep(step({ doneWhen: { kind: "text", min: 1 } }), ev([], "  ")).done).toBe(false);
    expect(evaluateStep(step({ doneWhen: { kind: "text", min: 1 } }), ev([], "hi")).done).toBe(true);
    expect(evaluateStep(step({ doneWhen: { kind: "text", regex: "\\bdone\\b" } }), ev([], "all done here")).done).toBe(true);
    expect(evaluateStep(step({ doneWhen: { kind: "text", regex: "\\bdone\\b" } }), ev([], "still going")).done).toBe(false);
  });

  it("narration: done once anything is said; user_reply: parks", () => {
    expect(evaluateStep(step({ doneWhen: { kind: "narration" } }), ev([], "1")).done).toBe(true);
    expect(evaluateStep(step({ doneWhen: { kind: "narration" } }), ev([], "")).done).toBe(false);
    expect(evaluateStep(step({ doneWhen: { kind: "user_reply" } }), ev([], "what's your color?"))).toEqual({
      done: false,
      parks: true,
    });
  });
});

describe("advanceWorkflow", () => {
  const wf = () => compileWorkflow({ steps: [{ text: "A", status: "pending" }, { text: "B", status: "pending" }, { text: "C", status: "pending" }] });

  it("done → advances to the next step", () => {
    const r = advanceWorkflow(wf(), { done: true });
    expect(r.action).toBe("advance");
    expect(r.workflow.steps[0]!.status).toBe("done");
    expect(r.workflow.steps[1]!.status).toBe("active");
    expect(r.next?.id).toBe("s2");
  });

  it("done on the last step → finish", () => {
    let w = wf();
    w = advanceWorkflow(w, { done: true }).workflow; // A done, B active
    w = advanceWorkflow(w, { done: true }).workflow; // B done, C active
    const r = advanceWorkflow(w, { done: true }); // C done
    expect(r.action).toBe("finish");
    expect(r.workflow.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("not done with attempts left → retry (stays active)", () => {
    const r = advanceWorkflow(wf(), { done: false, reason: "no image" });
    expect(r.action).toBe("retry");
    expect(r.workflow.steps[0]!).toMatchObject({ status: "active", attempts: 1 });
  });

  it("exhausted attempts, onFail skip → fail this step and move on", () => {
    let w = compileWorkflow({ steps: [{ text: "A", status: "pending", onFail: "skip" }, { text: "B", status: "pending" }] });
    w = advanceWorkflow(w, { done: false }).workflow; // attempt 1 → retry
    const r = advanceWorkflow(w, { done: false }); // attempt 2 → exhausted → skip
    expect(r.action).toBe("skip");
    expect(r.workflow.steps[0]!.status).toBe("failed");
    expect(r.workflow.steps[1]!.status).toBe("active");
  });

  it("exhausted attempts, onFail ask_user → park (blocked)", () => {
    let w = wf(); // default onFail ask_user
    w = advanceWorkflow(w, { done: false }).workflow;
    const r = advanceWorkflow(w, { done: false });
    expect(r.action).toBe("park");
    expect(r.workflow.steps[0]!.status).toBe("blocked");
  });

  it("exhausted attempts, onFail abort → abort", () => {
    let w = compileWorkflow({ steps: [{ text: "A", status: "pending", onFail: "abort" }] });
    w = advanceWorkflow(w, { done: false }).workflow;
    const r = advanceWorkflow(w, { done: false });
    expect(r.action).toBe("abort");
    expect(r.workflow.steps[0]!.status).toBe("failed");
  });

  it("parks immediately on a user_reply outcome", () => {
    const r = advanceWorkflow(wf(), { done: false, parks: true });
    expect(r.action).toBe("park");
    expect(r.workflow.steps[0]!.status).toBe("blocked");
  });
});

describe("resumeWorkflow / workflowToPlan", () => {
  it("resume re-activates the blocked step", () => {
    let w = compileWorkflow({ steps: [{ text: "ask", status: "pending" }, { text: "next", status: "pending" }] });
    w = advanceWorkflow(w, { done: false, parks: true }).workflow; // blocked
    expect(w.steps[0]!.status).toBe("blocked");
    const resumed = resumeWorkflow(w);
    expect(resumed.steps[0]!).toMatchObject({ status: "active", attempts: 0 });
  });

  it("workflowToPlan maps done→done, everything else→pending, and carries the step's tool need", () => {
    let w = compileWorkflow({
      goal: "g",
      steps: [
        { text: "Draw it", status: "pending", needs: "image" },
        { text: "Save it", status: "pending", needs: "file" },
      ],
    });
    w = advanceWorkflow(w, { done: true }).workflow; // A done, B active
    const plan = workflowToPlan(w);
    expect(plan.goal).toBe("g");
    expect(plan.steps[0]).toMatchObject({ text: "Draw it", status: "done", needs: "generate_image" });
    expect(plan.steps[1]).toMatchObject({ text: "Save it", status: "pending", needs: "write_file" });
  });

  it("G5: a `produces` step compiles to a files contract verified against filesPresent evidence", () => {
    const w = compileWorkflow({ goal: "g", steps: [{ text: "Build the module", status: "pending", produces: ["a.py", "b.py"] }] });
    expect(w.steps[0]!.doneWhen).toEqual({ kind: "files", paths: ["a.py", "b.py"] });
    const ev = (present: { path: string; ok: boolean }[]): StepEvidence => ({ toolResults: [], text: "", filesPresent: present });
    expect(evaluateStep(w.steps[0]!, ev([{ path: "a.py", ok: true }, { path: "b.py", ok: true }])).done).toBe(true);
    const miss = evaluateStep(w.steps[0]!, ev([{ path: "a.py", ok: true }, { path: "b.py", ok: false }]));
    expect(miss.done).toBe(false);
    expect(miss.reason).toContain("b.py");
    expect(evaluateStep(w.steps[0]!, { toolResults: [], text: "" }).done).toBe(false); // no evidence → not done
  });

  it("G6: a `verify` step appends an enforced command_ok follow-up step", () => {
    const w = compileWorkflow({ goal: "g", steps: [{ text: "Write code", status: "pending", needs: "file", verify: "pytest -q" }] });
    expect(w.steps).toHaveLength(2);
    expect(w.steps[0]!.doneWhen).toEqual({ kind: "file" });
    expect(w.steps[1]!.doneWhen).toEqual({ kind: "command_ok" });
    expect(w.steps[1]!.instruction).toContain("pytest -q");
    expect(w.steps[0]!.status).toBe("active");
    // No verify → no extra step.
    expect(compileWorkflow({ steps: [{ text: "x", status: "pending", needs: "file" }] }).steps).toHaveLength(1);
  });

  it("doneWhenToNeeds maps a contract to the tool it requires (or undefined for prose)", () => {
    expect(doneWhenToNeeds({ kind: "image" })).toBe("generate_image");
    expect(doneWhenToNeeds({ kind: "file" })).toBe("write_file");
    expect(doneWhenToNeeds({ kind: "command_ok" })).toBe("run_command");
    expect(doneWhenToNeeds({ kind: "tool_ok", tool: "search_web" })).toBe("search_web");
    expect(doneWhenToNeeds({ kind: "narration" })).toBeUndefined();
    expect(doneWhenToNeeds({ kind: "text", min: 1 })).toBeUndefined();
    expect(doneWhenToNeeds({ kind: "user_reply" })).toBeUndefined();
  });
});

describe("isToolContract", () => {
  it("is true for tool-effect contracts (the model's only output is the tool call)", () => {
    for (const kind of ["image", "file", "files", "command_ok", "tool_ok"] as const) {
      expect(isToolContract(kind)).toBe(true);
    }
  });
  it("is false for answer contracts (the text IS the deliverable)", () => {
    for (const kind of ["text", "narration", "user_reply"] as const) {
      expect(isToolContract(kind)).toBe(false);
    }
  });
});
