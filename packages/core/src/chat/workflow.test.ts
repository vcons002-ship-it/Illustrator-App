import { describe, expect, it } from "vitest";
import type { BuddyPlan, BuddyToolCall, BuddyToolResultPayload } from "./buddy-tools.js";
import {
  type StepEvidence,
  type WorkflowStep,
  advanceWorkflow,
  attemptedStepWork,
  checklistMetaOnly,
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

  it("W2: an unrecognized token (not a real tool name) falls through to undefined so the caller infers", () => {
    // "research" is a topic word, not a tool — returning tool_ok("research") would be unsatisfiable
    // (no tool by that name ever runs), so the contract must fall through to inferDoneWhen instead.
    expect(needsToDoneWhen("research")).toBeUndefined();
    expect(needsToDoneWhen("summarize")).toBeUndefined();
    // A REAL (but non-aliased) tool name still compiles to tool_ok.
    expect(needsToDoneWhen("generate_video")).toEqual({ kind: "tool_ok", tool: "generate_video" });
    expect(needsToDoneWhen("edit_file")).toEqual({ kind: "tool_ok", tool: "edit_file" });
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

  it("W1: a tool_ok step is NOT done when the host tool reported a NESTED failure (video/writeFile/image ok:false)", () => {
    // Host tools carry failure nested, with no top-level `error` — a failed render is `{video:{ok:false}}`.
    // The collar must see through that and NOT mark the step done, or a failed generate_video advances the run.
    const vid = (ok: boolean): { call: BuddyToolCall; result: BuddyToolResultPayload } => ({
      call: { tool: "generate_video", prompt: "morph", source: { kind: "last" } },
      result: { video: { ok } },
    });
    expect(evaluateStep(step({ doneWhen: { kind: "tool_ok", tool: "generate_video" } }), ev([vid(false)])).done).toBe(false);
    expect(evaluateStep(step({ doneWhen: { kind: "tool_ok", tool: "generate_video" } }), ev([vid(true)])).done).toBe(true);
    // Same for a nested write failure surfaced through a tool_ok contract.
    expect(
      evaluateStep(step({ doneWhen: { kind: "tool_ok", tool: "write_file" } }), ev([{ call: { tool: "write_file", path: "a", content: "" }, result: { writeFile: { path: "a", ok: false, error: "denied" } } }])).done,
    ).toBe(false);
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

describe("attemptedStepWork — did the model actually TRY the step (vs fiddle the checklist)", () => {
  const gi: BuddyToolCall = { tool: "generate_image", prompt: "a castle" };
  const cs: BuddyToolCall = { tool: "complete_step" };
  const sp: BuddyToolCall = { tool: "set_plan", steps: ["x"] };

  it("counts a render attempt on an image step whether it succeeded OR failed", () => {
    const img = step({ doneWhen: { kind: "image" } });
    expect(attemptedStepWork(img, ev([{ call: gi, result: { image: { ok: true } } }]))).toBe(true);
    expect(attemptedStepWork(img, ev([{ call: gi, result: { image: { ok: false, error: "vram" } } }]))).toBe(true);
  });

  it("is FALSE on an image step when the model only checked the box or narrated", () => {
    const img = step({ doneWhen: { kind: "image" } });
    // The exact bug: tried to complete_step (refused) instead of rendering.
    expect(attemptedStepWork(img, ev([{ call: cs, result: { error: "the app runs this checklist" } }]))).toBe(false);
    // Or just narrated "I made all four!" with no tool at all.
    expect(attemptedStepWork(img, ev([], "Here are all four images."))).toBe(false);
  });

  it("keys tool_ok on the SPECIFIC tool, and text/narration on non-empty text", () => {
    const sw = step({ doneWhen: { kind: "tool_ok", tool: "search_web" } });
    expect(attemptedStepWork(sw, ev([{ call: { tool: "search_web", query: "q" }, result: {} }]))).toBe(true);
    expect(attemptedStepWork(sw, ev([{ call: { tool: "search_books", query: "q" }, result: {} }]))).toBe(false);
    const txt = step({ doneWhen: { kind: "text", min: 1 } });
    expect(attemptedStepWork(txt, ev([], "an answer"))).toBe(true);
    expect(attemptedStepWork(txt, ev([], "   "))).toBe(false);
    // user_reply parks by design — always "attempted" so it never triggers a nudge.
    expect(attemptedStepWork(step({ doneWhen: { kind: "user_reply" } }), ev())).toBe(true);
  });

  it("checklistMetaOnly flags a turn that only touched set_plan/complete_step", () => {
    expect(checklistMetaOnly(ev([{ call: cs, result: {} }]))).toBe(true);
    expect(checklistMetaOnly(ev([{ call: sp, result: {} }, { call: cs, result: {} }]))).toBe(true);
    expect(checklistMetaOnly(ev([{ call: cs, result: {} }, { call: gi, result: { image: { ok: true } } }]))).toBe(false);
    expect(checklistMetaOnly(ev())).toBe(false); // no tools at all is a narration miss, not meta-fiddling
  });
});

describe("a multi-image checklist doesn't wedge on its second step", () => {
  // Reported: "the app-managed workflow gets stuck on step 2 for multiple image generations — it
  // never gets checked off, and when handed back to the LLM it only sees the step isn't done and
  // tries again." Two faults stacked, both here.
  const img = (ok: boolean): { call: BuddyToolCall; result: BuddyToolResultPayload } => ({
    call: { tool: "generate_image", prompt: "x" },
    result: { image: { ok } },
  });

  it("reads an elliptical second step in the context of the first", () => {
    // Only the FIRST item of a run spells out the work. On its own, "now do the same for the barn"
    // says nothing about images, so it compiled to the generic text fallback — and then judged a
    // turn that rendered a picture by whether it had also written a paragraph.
    const plan: BuddyPlan = {
      goal: "farm pictures",
      steps: [
        { text: "Generate an image of a goat in a field", status: "pending" },
        { text: "Now do the same for the barn", status: "pending" },
        { text: "Repeat for the tractor", status: "pending" },
      ],
    };
    const wf = compileWorkflow(plan);
    expect(wf.steps.map((s) => s.doneWhen.kind)).toEqual(["image", "image", "image"]);
  });

  it("does not inherit across an unrelated step", () => {
    const wf = compileWorkflow({
      steps: [
        { text: "Generate an image of a goat", status: "pending" },
        { text: "Write a short caption for it", status: "pending" },
      ],
    });
    expect(wf.steps[1]!.doneWhen.kind).toBe("text");
  });

  it("lets observed work beat a GUESSED answer-contract", () => {
    // The second fault, and the one that actually wedged it: a render SUSPENDS the turn, so there is
    // no prose by construction. A text contract then reported the step undone for ever — doing it
    // again produced the same nothing.
    const guessed = step({ doneWhen: { kind: "text", min: 1 }, inferred: true });
    expect(evaluateStep(guessed, ev([img(true)])).done).toBe(true);
    expect(evaluateStep(step({ doneWhen: { kind: "narration" }, inferred: true }), ev([img(true)])).done).toBe(true);
  });

  it("does NOT let observed work beat a contract the model DECLARED", () => {
    // needs:"text" is the model's own word about what would prove this step done. A guess may be
    // overruled by reality; a promise may not — otherwise "render it, then describe it" ticks off
    // the describing step the moment the render lands.
    const declared = step({ doneWhen: { kind: "text", min: 1 } }); // no `inferred` flag
    expect(evaluateStep(declared, ev([img(true)])).done).toBe(false);
  });

  it("counts only real deliverables, not any tool that ran", () => {
    // A web search is work in progress, not something produced — it must not tick off a step that
    // asked for an answer, however loosely that step was classified.
    const guessed = step({ doneWhen: { kind: "text", min: 1 }, inferred: true });
    const searched = ev([{ call: { tool: "search_web", query: "goats" }, result: { hits: [] } }]);
    expect(evaluateStep(guessed, searched).done).toBe(false);
    expect(evaluateStep(guessed, ev([img(false)])).done).toBe(false); // a FAILED render isn't done either
  });

  it("treats a failed render on a guessed step as a real attempt", () => {
    // Otherwise the model that tried and was refused by the image engine is told it hasn't started —
    // and re-nudged, for ever, without ever spending an attempt or reaching the reader.
    const guessed = step({ doneWhen: { kind: "text", min: 1 }, inferred: true });
    expect(attemptedStepWork(guessed, ev([img(false)]))).toBe(true);
    expect(attemptedStepWork(guessed, ev([]))).toBe(false); // nothing at all is still no attempt
  });

  it("runs the whole three-image checklist to completion", () => {
    // End to end, the way the host drives it: each render is judged, ticked, and the next step armed.
    let wf = compileWorkflow({
      steps: [
        { text: "Generate an image of a goat", status: "pending" },
        { text: "Now the barn", status: "pending" },
        { text: "And the tractor", status: "pending" },
      ],
    });
    const actions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const active = wf.steps.find((s) => s.status === "active")!;
      const adv = advanceWorkflow(wf, evaluateStep(active, ev([img(true)])));
      actions.push(adv.action);
      wf = adv.workflow;
    }
    expect(actions).toEqual(["advance", "advance", "finish"]);
    expect(wf.steps.every((s) => s.status === "done")).toBe(true);
  });
});

describe("inferDoneWhen reads the ways people actually ask for a picture", () => {
  for (const phrase of [
    "Create an illustration of the farmhouse",
    "Draw the final scene",
    "Illustrate the opening scene",
    "Generate the remaining two images",
  ]) {
    it(`"${phrase}"`, () => expect(inferDoneWhen(phrase).kind).toBe("image"));
  }

  it("still falls back to text for something genuinely unclassifiable", () => {
    expect(inferDoneWhen("Think about what the reader might want next").kind).toBe("text");
  });
});
