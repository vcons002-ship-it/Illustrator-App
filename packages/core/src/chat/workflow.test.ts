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
  isPlanningStep,
  isToolContract,
  needsToDoneWhen,
  recompileWorkflow,
  resumeWorkflow,
  stepDirective,
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

describe("an elliptical step survives leaving the model's context", () => {
  // Reported after the wedge was fixed: the run now advances, but it "generates the second or third
  // image twice and never the first". The directives that name each step are EPHEMERAL by design and
  // a tool step's own narration is dropped, so by step 3 nothing in context says what "the same" was
  // — and the model renders whichever subject it can still see, which is the previous picture.
  it("records what each continuation step continues", () => {
    const wf = compileWorkflow({
      steps: [
        { text: "Generate an image of a goat in a field", status: "pending" },
        { text: "Now do the same for the barn", status: "pending" },
        { text: "Repeat for the tractor", status: "pending" },
      ],
    });
    expect(wf.steps[0]!.context).toBeUndefined(); // it spells itself out
    expect(wf.steps[1]!.context).toBe("Generate an image of a goat in a field");
    // Step 3 points at the step that SPELT THE WORK OUT, not at another ellipsis.
    expect(wf.steps[2]!.context).toBe("Generate an image of a goat in a field");
  });

  it("adds nothing to a step that stands on its own", () => {
    const wf = compileWorkflow({
      steps: [
        { text: "Generate an image of a goat", status: "pending" },
        { text: "Generate an image of a chicken", status: "pending" },
      ],
    });
    expect(wf.steps[1]!.context).toBeUndefined();
  });
});

describe("re-planning mid-run keeps the work already done", () => {
  // The turn the reader saw as "it apologises for getting confused about the plan": set_plan is how a
  // model both starts AND revises a checklist, and revising is exactly what a confused model does.
  // Compiling that from scratch re-armed step 1 and redid finished work.
  const plan: BuddyPlan = {
    steps: [
      { text: "Generate an image of a goat", status: "pending" },
      { text: "Now the barn", status: "pending" },
      { text: "And the tractor", status: "pending" },
    ],
  };

  it("keeps finished steps finished and arms the first unfinished one", () => {
    let wf = compileWorkflow(plan);
    wf = advanceWorkflow(wf, { done: true }).workflow; // step 1 rendered
    expect(wf.steps[0]!.status).toBe("done");

    const again = recompileWorkflow(wf, plan); // the model re-issues the same checklist
    expect(again.steps[0]!.status).toBe("done");
    expect(again.steps[1]!.status).toBe("active");
    expect(again.steps[2]!.status).toBe("pending");
  });

  it("lets a genuinely revised plan take effect", () => {
    let wf = compileWorkflow(plan);
    wf = advanceWorkflow(wf, { done: true }).workflow;
    const revised = recompileWorkflow(wf, {
      steps: [
        { text: "Generate an image of a goat", status: "pending" }, // already done
        { text: "Generate an image of a duck", status: "pending" }, // new work
      ],
    });
    expect(revised.steps.map((s) => s.status)).toEqual(["done", "active"]);
  });

  it("compiles normally when there was no run to preserve", () => {
    expect(recompileWorkflow(undefined, plan).steps.map((s) => s.status)).toEqual(["active", "pending", "pending"]);
  });

  it("finishes rather than re-arming when every step is already done", () => {
    let wf = compileWorkflow(plan);
    for (let i = 0; i < 3; i++) wf = advanceWorkflow(wf, { done: true }).workflow;
    const again = recompileWorkflow(wf, plan);
    expect(again.steps.every((s) => s.status === "done")).toBe(true);
  });
});

describe("no step is ever reached anonymously", () => {
  // The reported fault, stated exactly: "it was step one that had an issue and never ran." Steps two
  // onward were each reached by a directive naming them; the first was reached by nothing — it ran on
  // whatever the model chose to do in the turn it wrote the plan. And because the collar can see THAT
  // an image rendered but not WHAT it depicts, whatever came back was credited to step 1.
  const wf = compileWorkflow({
    steps: [
      { text: "Generate an image of a goat in a field", status: "pending" },
      { text: "Now do the same for the barn", status: "pending" },
      { text: "Repeat for the tractor", status: "pending" },
    ],
  });

  it("names the step and its position, whatever brought us here", () => {
    for (const kind of ["start", "advance", "retry", "nudge"] as const) {
      const d = stepDirective(wf, wf.steps[0]!, kind);
      expect(d, kind).toContain("step 1 of 3");
      expect(d, kind).toContain("Generate an image of a goat in a field");
    }
  });

  it("gives the FIRST step a directive of its own", () => {
    // The whole fix: a planning turn no longer leaves step 1 to the model's own reading of its plan.
    const d = stepDirective(wf, wf.steps[0]!, "start");
    expect(d).toContain("Checklist ready — 3 steps");
    expect(d).toContain("ONLY step 1 of 3");
  });

  it("carries the antecedent of an elliptical step, and only then", () => {
    expect(stepDirective(wf, wf.steps[2]!, "advance")).toContain("Generate an image of a goat in a field");
    expect(stepDirective(wf, wf.steps[2]!, "advance")).toContain("not the previous one's");
    expect(stepDirective(wf, wf.steps[0]!, "advance")).not.toContain("This continues");
  });

  it("passes on why a retry is being asked for", () => {
    expect(stepDirective(wf, wf.steps[1]!, "retry", { reason: "no image was rendered" })).toContain("no image was rendered");
  });

  it("says which tool a nudged step needs, and who owns the checklist", () => {
    const d = stepDirective(wf, wf.steps[1]!, "nudge", { needsTool: "generate_image", checklistMeta: true });
    expect(d).toContain("ACTUAL generate_image call");
    expect(d).toContain("do NOT call complete_step");
  });

  it("counts a single-step checklist in the singular", () => {
    const one = compileWorkflow({ steps: [{ text: "Generate an image of a goat", status: "pending" }] });
    expect(stepDirective(one, one.steps[0]!, "start")).toContain("1 step.");
  });
});

describe("planning is not a step", () => {
  // Reported: "it still tries to check off a step before doing anything, as if it thinks the first
  // step will be 'plan the actions'." It does think that — because it wrote that step itself. And it
  // is the worst possible one: nothing about planning can be observed, so the contract falls to the
  // generic text check, which any sentence satisfies. The run ticks a step off before doing anything,
  // which is precisely what the collar exists to prevent.
  it("recognises the model talking about its own checklist", () => {
    for (const meta of [
      "Plan the actions",
      "Plan the three images",
      "First, plan the steps",
      "Decide the prompts for each image",
      "Outline the approach",
      "I'll determine what to generate",
      "Prepare the image prompts",
    ])
      expect(isPlanningStep(meta), meta).toBe(true);
  });

  it("leaves real deliverables alone", () => {
    // The line that matters: a possessive says this is the READER'S deliverable, not the checklist
    // describing itself. Dropping "Plan my trip to Rome" would throw away what they asked for.
    for (const real of [
      "Plan my trip to Rome",
      "Draft the itinerary",
      "List 3 follow-ups",
      "Generate an image of a goat",
      "Write the recap to recap.md",
      "Choose a name for the character",
      "Design a logo for the shop",
    ])
      expect(isPlanningStep(real), real).toBe(false);
  });

  it("drops a leading planning step so the run starts on real work", () => {
    const wf = compileWorkflow({
      steps: [
        { text: "Plan the three images", status: "pending" },
        { text: "Generate an image of a goat", status: "pending" },
        { text: "Now the barn", status: "pending" },
      ],
    });
    expect(wf.steps.map((s) => s.instruction)).toEqual(["Generate an image of a goat", "Now the barn"]);
    expect(wf.steps[0]!.status).toBe("active"); // and the first REAL step is the one armed
  });

  it("keeps it when the model DECLARED what proves it done", () => {
    // needs:"text" is the model's own word that this step produces something written. A guess may be
    // overruled; a promise is kept — the same line drawn everywhere else in this file.
    const wf = compileWorkflow({
      steps: [
        { text: "Plan the approach", needs: "text", status: "pending" },
        { text: "Generate an image of a goat", status: "pending" },
      ],
    });
    expect(wf.steps).toHaveLength(2);
  });

  it("never drops the only step there is", () => {
    const wf = compileWorkflow({ steps: [{ text: "Plan the actions", status: "pending" }] });
    expect(wf.steps).toHaveLength(1);
  });

  it("only drops it at the FRONT", () => {
    // Mid-run "now decide the order" is odd but it is not the app ticking a box before any work.
    const wf = compileWorkflow({
      steps: [
        { text: "Generate an image of a goat", status: "pending" },
        { text: "Plan the remaining images", status: "pending" },
      ],
    });
    expect(wf.steps).toHaveLength(2);
  });
});

describe("AUDIT: every contract can be satisfied by the tool that satisfies it", () => {
  // The consistency problem in one table. For each realistic step, the contract it compiles to, the
  // tool a model would call for it, and the evidence the HOST actually records for that tool — then
  // ask whether the step completes. Anything that doesn't is a workflow that wedges on a step whose
  // work was done, which is the shape every app-managed report in this stream has taken.
  //
  // Seven of these thirteen failed when the audit was first run. The cause was one line: auto-run
  // results crossed the worker boundary as `{}` — only the error flag survived — so the collar judged
  // an empty payload and concluded "no file was written" about a document it had just written.

  /** Exactly what apps/web/src/App.tsx records, per tool. Auto-run tools carry `artifact`. */
  const MAKES_ARTIFACT = new Set([
    "create_document", "edit_document", "create_spreadsheet", "set_cell", "add_formula_column",
    "open_content", "draft_email", "send_email", "create_event", "update_event", "create_task", "add_task_group",
  ]);
  const evidenceFor = (tool: string): BuddyToolResultPayload => {
    if (tool === "generate_image") return { image: { ok: true } };
    if (tool === "generate_video" || tool === "generate_long_video" || tool === "stitch_videos") return { video: { ok: true } };
    if (tool === "write_file" || tool === "edit_file") return { writeFile: { path: "a.md", ok: true } };
    if (tool === "run_command" || tool === "delegate_coding_task") return { command: { stdout: "", stderr: "", code: 0 } };
    return MAKES_ARTIFACT.has(tool) ? { artifact: true } : {};
  };

  const CASES: [string, string][] = [
    ["Generate an image of a goat in a field", "generate_image"],
    ["Search the web for current Boston hotel prices", "search_web"],
    ["Write the recap to recap.md", "write_file"],
    ["Run the tests with pytest", "run_command"],
    ["Write it up as a PDF report", "create_document"],
    ["Create a Word document summarising the findings", "create_document"],
    ["Save the findings as a document", "create_document"],
    ["Build a spreadsheet of the results", "create_spreadsheet"],
    ["Create a budget spreadsheet file", "create_spreadsheet"],
    ["Draft an email to the team", "draft_email"],
    ["Add it to my calendar", "create_event"],
    ["Animate that image into a short clip", "generate_video"],
  ];

  for (const [text, tool] of CASES) {
    it(`"${text}" completes when ${tool} succeeds`, () => {
      const wf = compileWorkflow({ steps: [{ text, status: "pending" }] });
      const step = wf.steps[0]!;
      const outcome = evaluateStep(step, ev([{ call: { tool } as BuddyToolCall, result: evidenceFor(tool) }]));
      expect(outcome.done, `${JSON.stringify(step.doneWhen)} — ${outcome.reason ?? ""}`).toBe(true);
    });
  }

  it("an answer step is still satisfied by the answer, not by a tool running", () => {
    const wf = compileWorkflow({ steps: [{ text: "Summarise what you found", status: "pending" }] });
    expect(evaluateStep(wf.steps[0]!, ev([], "Here's what I found.")).done).toBe(true);
  });

  it("and a search that returned nothing durable still does NOT tick an answer step", () => {
    // The line that keeps this honest: work in progress is not a deliverable. Widening the collar to
    // fix the document case must not widen it to "any tool ran".
    const wf = compileWorkflow({ steps: [{ text: "Summarise what you found", status: "pending" }] });
    const searched = ev([{ call: { tool: "search_web", query: "x" }, result: { hits: [] } }]);
    expect(evaluateStep(wf.steps[0]!, searched).done).toBe(false);
  });
});
