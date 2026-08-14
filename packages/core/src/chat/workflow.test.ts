import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { producedArtifactFrom } from "./buddy-tools.js";
import type { BuddyPlan, BuddyToolCall, BuddyToolResultPayload } from "./buddy-tools.js";
import {
  type StepEvidence,
  type Workflow,
  type WorkflowStep,
  type WorkflowStepStatus,
  activeStep,
  advanceWorkflow,
  attemptedStepWork,
  checklistMetaOnly,
  compileWorkflow,
  doneWhenToNeeds,
  evaluateStep,
  inferDoneWhen,
  isPlanningStep,
  isWebSearchStep,
  isToolContract,
  needsToDoneWhen,
  adoptPlanProgress,
  reactivateWorkflow,
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

  it("reads ADOPTING a reference as the adoption tool, not as a render", () => {
    // The loop this pins: "save a reference image of X" contains "image of", so it was inferred as a
    // step needing a RENDER. Adopting produces no image, so the step could never be satisfied by its
    // own work — and `attemptedStepWork` saw no render attempt either, so the executor re-nudged
    // without spending an attempt. Told again and again that it still owed an image, the model
    // eventually made one nobody asked for, which DID satisfy the contract and moved the run on.
    const adopt = { kind: "tool_ok", tool: "use_image_reference" };
    expect(inferDoneWhen("Save a reference image of a victorian terrace")).toEqual(adopt);
    expect(inferDoneWhen("Set the reference photo for this chat")).toEqual(adopt);
    expect(inferDoneWhen("Use the second search result as a reference")).toEqual(adopt);
  });

  it("but a render step that merely MENTIONS the reference is still a render", () => {
    // The verb decides. Losing this would be the same bug pointing the other way: a step that really
    // does owe a picture, judged by whether a reference was adopted.
    expect(inferDoneWhen("Generate an image of the house from the reference photo")).toEqual({ kind: "image" });
    expect(inferDoneWhen("Draw the terrace using the reference picture")).toEqual({ kind: "image" });
  });

  it("reads an adoption however the model words it — one adjective was enough to lose it", () => {
    // The exact step off the reader's screen. The first pass matched "reference image/picture/photo"
    // and "as a reference"; this says "as a VISUAL reference", which is neither — so it compiled to
    // a render again, and the checklist's ADOPT step sat there generating a picture ("Preparing an
    // image… Generating the image…" under a step about adopting one). English has too many ways to
    // say this to enumerate; the shape is what holds.
    const adopt = { kind: "tool_ok", tool: "use_image_reference" };
    expect(inferDoneWhen("Adopt a high-quality image of Christian Bale as a visual reference for likeness")).toEqual(adopt);
    expect(inferDoneWhen("Pick a photo of the actor to use as the primary style reference")).toEqual(adopt);
    expect(inferDoneWhen("Find a reference photo of the terrace")).toEqual(adopt);
    expect(inferDoneWhen("Attach a headshot as reference for the likeness")).toEqual(adopt);
  });

  it("reads LOOKING for a picture as an image search, not as making one", () => {
    // Reported as: image search doesn't work as a checklist step — it generates an image instead of
    // searching, then moves on to adopting a reference from a search that never happened.
    //
    // "Search for an image of X" contains "image of", so it fell to the render test and compiled to
    // {kind:"image"}: the collar then demanded a picture from a step whose whole job was to go and
    // look at some. The step "succeeded" on a render nobody asked for, exactly as reported.
    const search = { kind: "tool_ok", tool: "search_images" };
    expect(inferDoneWhen("Search for an image of Christian Bale")).toEqual(search);
    expect(inferDoneWhen("Look up a picture of a red panda")).toEqual(search);
  });

  it("and sends an image search to search_images, not search_web", () => {
    // The quieter half of the same bug. These carry no render verb, so they fell PAST the render
    // test to the generic search rule and compiled to tool_ok(search_web) — the wrong tool. The
    // model does the right thing, calls search_images, and the collar waits for a web search that is
    // never coming: a step no correct behaviour can satisfy, which is the nudge loop.
    const search = { kind: "tool_ok", tool: "search_images" };
    expect(inferDoneWhen("Search for images of Jennifer Lawrence")).toEqual(search);
    expect(inferDoneWhen("Find a photo of the Eiffel Tower")).toEqual(search);
    expect(inferDoneWhen("Find images of a victorian terrace")).toEqual(search);
  });

  it("keeps a plain web search, a render, and an adoption on their own paths", () => {
    // The three neighbours this rule sits between. Each was correct before and has to stay correct:
    // a search with no picture in it is still the web; a render verb still wins; and an adoption
    // wins earlier still, because use_image_reference's query form searches AND adopts in one call.
    expect(inferDoneWhen("Search the web for tide tables")).toEqual({ kind: "tool_ok", tool: "search_web" });
    // "shot" is a picture word when a step is about adopting a reference, and is NOT one here —
    // which is why PICTURE_NOUN is the tighter list. This stays whatever the generic search rule
    // already made of it (search_web); what matters is that it is not an IMAGE search.
    expect(inferDoneWhen("Find the best shot of the quarter in the deck")).toEqual({ kind: "tool_ok", tool: "search_web" });
    expect(inferDoneWhen("Generate an image of a red castle")).toEqual({ kind: "image" });
    expect(inferDoneWhen("Find a reference and generate the portrait")).toEqual({ kind: "image" });
    expect(inferDoneWhen("Find a reference photo of the terrace")).toEqual({ kind: "tool_ok", tool: "use_image_reference" });
  });

  it("leaves a real deliverable that merely says “reference” alone", () => {
    // The broadening must not swallow steps that are about writing something. An inferred contract
    // no work can satisfy is the re-nudge loop this whole area exists to stop, so a false positive
    // here costs more than missing an unusual phrasing — hence the strict verb list.
    expect(inferDoneWhen("Write a reference document describing the photos")).toEqual({ kind: "file", fresh: true });
    expect(inferDoneWhen("List three reference books on the period")).toEqual({ kind: "text", min: 1 });
    expect(inferDoneWhen("Summarize the photos and add a reference list")).toEqual({ kind: "text", min: 1 });
    expect(inferDoneWhen("Use the photos to write a reference guide")).toEqual({ kind: "text", min: 1 });
  });
});

describe("compileWorkflow — an adopt-then-draw plan for a chat that already has the picture", () => {
  const adoptThenDraw: BuddyPlan = {
    goal: "Generate an image of Christian Bale in a Christmas setting.",
    steps: [
      { text: "Adopt a high-quality image of Christian Bale as a visual reference for likeness", status: "pending" },
      { text: "Generate the image of him posing for a festive Christmas photo", status: "pending" },
    ],
  };

  it("drops the adoption step, because there is nothing left to adopt", () => {
    // The reader saves a picture from a search, asks for an image, and watches a two-step checklist
    // go looking for a reference it already has. buildImageReferenceBlock says not to in words, and
    // words are the right place for it — but words are advice, and a model that plans the step
    // anyway isn't corrected by re-reading them. Drawing is one step; the app makes it one.
    const wf = compileWorkflow(adoptThenDraw, { hasChatReferences: true });
    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0]).toMatchObject({ id: "s1", doneWhen: { kind: "image" }, status: "active" });
  });

  it("keeps it when the chat has no reference yet — that step is real work", () => {
    const wf = compileWorkflow(adoptThenDraw, { hasChatReferences: false });
    expect(wf.steps).toHaveLength(2);
    // And it is an ADOPTION, not a render — this is the step that used to generate a picture.
    expect(wf.steps[0]!.doneWhen).toEqual({ kind: "tool_ok", tool: "use_image_reference" });
    expect(wf.steps[1]!.doneWhen).toEqual({ kind: "image" });
  });

  it("keeps it when the reader asked ONLY to adopt — the drop is for an invented precursor", () => {
    // No render in the plan means this isn't the "first I need a reference" shape; it's the job.
    const wf = compileWorkflow(
      { steps: [{ text: "Save the second search result as a reference picture", status: "pending" }] },
      { hasChatReferences: true },
    );
    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0]!.doneWhen).toEqual({ kind: "tool_ok", tool: "use_image_reference" });
  });

  it("never empties a checklist: a plan of nothing but adoptions keeps its steps", () => {
    const wf = compileWorkflow(
      {
        steps: [
          { text: "Adopt a photo of the terrace as a reference", status: "pending" },
          { text: "Adopt a photo of the barn as a reference", status: "pending" },
        ],
      },
      { hasChatReferences: true },
    );
    expect(wf.steps).toHaveLength(2);
    expect(wf.steps[0]!.status).toBe("active");
  });

  it("re-compiling mid-run applies the same drop", () => {
    // set_plan is how a model REVISES a checklist, and a confused model revises — so the rule has to
    // hold on the way back in, not just the first time.
    const wf = recompileWorkflow(undefined, adoptThenDraw, { hasChatReferences: true });
    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0]!.doneWhen).toEqual({ kind: "image" });
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

  it("a GUESSED tool_ok loses to observed work, so a mis-inferred contract can't circle forever", () => {
    // A regex naming one specific tool is the easiest contract to get wrong, and when it is wrong the
    // step is unsatisfiable by the work it describes — the run doesn't fail, it circles. Same rule
    // `text` and `narration` already carry: when a regex and reality disagree, reality wins.
    const rendered = ev([{ call: { tool: "generate_image", prompt: "a house" }, result: { image: { ok: true } } }]);
    const guessed = step({ doneWhen: { kind: "tool_ok", tool: "use_image_reference" }, inferred: true });
    expect(evaluateStep(guessed, rendered).done).toBe(true);

    // A contract the MODEL declared stays strict — it's a promise, not a guess.
    const declared = step({ doneWhen: { kind: "tool_ok", tool: "use_image_reference" } });
    expect(evaluateStep(declared, rendered).done).toBe(false);

    // And a guess still isn't satisfied by nothing happening.
    expect(evaluateStep(guessed, ev([])).done).toBe(false);
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
    expect(d).toContain("step 1 of 3");
  });

  /**
   * THESE ARE STATEMENTS NOW, NOT ORDERS — asserted, because the wording IS the fix.
   *
   * They arrive under role "user" and there is no other channel, so the model reads them as the
   * reader talking. Written as imperatives ("Now do ONLY step 4 of 25 … Call its tool and stop") they
   * contradicted the model's own assistant turn two lines above, and it resolved the conflict the way
   * it should — by trusting the apparent human — and re-sent a letter it had already sent.
   *
   * Anthropic's guidance for harness text injected into a conversation is explicit: "Write the text
   * as factual statements rather than imperative system instructions… Text framed as out-of-band
   * system commands can trigger Claude's prompt-injection defenses."
   */
  it("states the position instead of commanding, and claims nothing about what the model just did", () => {
    const d = stepDirective(wf, wf.steps[1]!, "advance");
    expect(d, "still an out-of-band command").not.toMatch(/Now do ONLY/);
    expect(d, "still orders the turn ended, which a text step has no tool to do").not.toMatch(/and stop/);
    // "✓ Previous step done" was a claim about the MODEL's work — the one thing it had grounds to
    // dispute, and did. The checklist's position is not its to argue with.
    expect(d, "still tells the model what it did").not.toMatch(/Previous step done/);
    expect(d).toMatch(/step 2 of 3 is now current/);
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
    // Same two facts as before the register changed — the tool the contract wants, and that the app
    // does its own ticking — stated rather than ordered.
    const d = stepDirective(wf, wf.steps[1]!, "nudge", { needsTool: "generate_image", checklistMeta: true });
    expect(d).toContain("actual generate_image call");
    expect(d).toMatch(/complete_step and re-planning are not needed/);
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

  /** The payload each tool really hands back, so the audit reads the HOST's own summary rather than a
   * hand-kept list that can drift from it. Auto-run results reach the collar as `artifact`, which is
   * exactly `producedArtifactFrom` of this payload — the same call apps/web/src/engine.worker.ts makes. */
  const PAYLOAD: Record<string, BuddyToolResultPayload> = {
    generate_image: { image: { ok: true } },
    generate_video: { video: { ok: true } },
    generate_long_video: { video: { ok: true } },
    stitch_videos: { video: { ok: true } },
    write_file: { writeFile: { path: "a.md", ok: true } },
    edit_file: { writeFile: { path: "a.md", ok: true } },
    run_command: { command: { stdout: "", stderr: "", code: 0 } },
    delegate_coding_task: { command: { stdout: "", stderr: "", code: 0 } },
    create_document: { document: { ok: true, id: "d1", title: "t", words: 10 } },
    edit_document: { documentEdit: { ok: true, title: "t", applied: 1, failures: 0, words: 10, summary: "1 edit applied" } },
    create_spreadsheet: { opened: { title: "t", chapters: 1, pages: 1, visuals: false } },
    set_cell: { dataEdit: { ok: true } },
    add_formula_column: { dataEdit: { ok: true } },
    open_content: { opened: { title: "t", chapters: 1, pages: 1, visuals: false } },
    draft_email: { email: { sent: false, to: ["a@b.c"], subject: "s", id: "d1" } },
    send_email: { email: { sent: true, to: ["a@b.c"], subject: "s", id: "d1" } },
    create_event: { eventCreated: { id: "e1", summary: "s", start: "2026-08-02T10:00:00Z", end: "2026-08-02T11:00:00Z" } },
    update_event: { eventCreated: { id: "e1", summary: "s", start: "2026-08-02T10:00:00Z", end: "2026-08-02T11:00:00Z" } },
    create_task: { taskCreated: { id: "t1", title: "t" } },
    add_task_group: { taskCreated: { id: "t1", title: "t" } },
    search_web: { hits: [] },
  };
  const evidenceFor = (tool: string): BuddyToolResultPayload => {
    const payload = PAYLOAD[tool] ?? {};
    // Host tools suspend the turn and record their own payload; auto-run tools cross the worker
    // boundary as just this summary. Both shapes are exercised by keeping the payload AND the summary.
    const kind = producedArtifactFrom(payload);
    return kind ? { ...payload, artifact: kind } : payload;
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

describe("three separate documents must come out as three documents", () => {
  // Reported: "create 3 individual haikus in separate documents" — the model plans three, then
  // delivers all three inside the ONE document already open in the chat.
  //
  // Two things conspire. Once a document exists it becomes the ACTIVE DOCUMENT, and both the
  // create_document result and the active-document block tell the model, loudly, not to call
  // create_document again — advice meant for REVISING this document, which reads as a blanket ban.
  // So on step 2 it reaches for edit_document and appends. And the collar then TICKS that step,
  // because every durable outcome had been reduced to one bit: "something was produced". Changing a
  // document that already existed is not producing the second one the step asked for.
  const doc = (): BuddyToolResultPayload => ({ artifact: "created" });
  const edit = (): BuddyToolResultPayload => ({ artifact: "changed" });
  const plan: BuddyPlan = {
    steps: [
      { text: "Create a document containing the first haiku", status: "pending" },
      { text: "Create a second document containing the second haiku", status: "pending" },
      { text: "Create a third document containing the third haiku", status: "pending" },
    ],
  };

  it("a step asking for a NEW document is not satisfied by editing the open one", () => {
    const wf = compileWorkflow(plan);
    const second = wf.steps[1]!;
    const outcome = evaluateStep(second, ev([{ call: { tool: "edit_document", edits: [] } as unknown as BuddyToolCall, result: edit() }]));
    expect(outcome.done).toBe(false);
    expect(outcome.reason).toMatch(/new|separate|own/i);
  });

  it("but IS satisfied by actually creating one", () => {
    const wf = compileWorkflow(plan);
    const outcome = evaluateStep(wf.steps[1]!, ev([{ call: { tool: "create_document", title: "Haiku 2", content: "x" }, result: doc() }]));
    expect(outcome.done).toBe(true);
  });

  it("the whole run: three create_documents finish, three edits do not", () => {
    let wf = compileWorkflow(plan);
    const actions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const active = wf.steps.find((s) => s.status === "active")!;
      const adv = advanceWorkflow(wf, evaluateStep(active, ev([{ call: { tool: "create_document", title: "t", content: "x" }, result: doc() }])));
      actions.push(adv.action);
      wf = adv.workflow;
    }
    expect(actions).toEqual(["advance", "advance", "finish"]);

    // The reported run: haiku 1 creates, haikus 2 and 3 get appended to it. The collar must NOT
    // sign that off as three documents.
    let wf2 = compileWorkflow(plan);
    const first = advanceWorkflow(wf2, evaluateStep(wf2.steps[0]!, ev([{ call: { tool: "create_document", title: "t", content: "x" }, result: doc() }])));
    expect(first.action).toBe("advance");
    wf2 = first.workflow;
    const second = advanceWorkflow(wf2, evaluateStep(wf2.steps.find((s) => s.status === "active")!, ev([{ call: { tool: "edit_document", edits: [] } as unknown as BuddyToolCall, result: edit() }])));
    expect(second.action).toBe("retry");
  });

  it("a step that asks to CHANGE a document is still satisfied by an edit", () => {
    // The fix must not swing the other way: revising the open document is what edit_document is for.
    const wf = compileWorkflow({ steps: [{ text: "Tighten the introduction of the report", status: "pending" }] });
    expect(evaluateStep(wf.steps[0]!, ev([{ call: { tool: "edit_document", edits: [] } as unknown as BuddyToolCall, result: edit() }])).done).toBe(true);
  });

  it("an elliptical continuation inherits the NEW-document requirement", () => {
    // "Now the second one" carries no words of its own — it means what step 1 meant.
    const wf = compileWorkflow({
      steps: [
        { text: "Create a document containing the first haiku", status: "pending" },
        { text: "Now the second one", status: "pending" },
      ],
    });
    expect(evaluateStep(wf.steps[1]!, ev([{ call: { tool: "edit_document", edits: [] } as unknown as BuddyToolCall, result: edit() }])).done).toBe(false);
  });
});

describe("a search VERB, not the word appearing somewhere in a sentence", () => {
  // Reported as: any line with "find" in it goes off searching instead of reading the word in
  // context. The rule tested the WHOLE instruction, so it fired wherever the word landed — and the
  // collar then REQUIRED a web search to succeed, which is an instruction to go and search.
  it("leaves a search word that is describing the object, not the action", () => {
    expect(inferDoneWhen("Read 'documents/daily.md', find the entry for that specific day")).toEqual({ kind: "text", min: 1 });
    expect(inferDoneWhen("Calculate the day number, then find it in the table")).toEqual({ kind: "text", min: 1 });
  });

  it("does not read GOOGLE CALENDAR as an instruction to search the web", () => {
    // The sharpest case, and not "find" at all: the step says Google Calendar, "google" was read as
    // the verb, and a step about writing a calendar entry was compiled into a step about searching.
    // The model then did what its contract demanded.
    expect(inferDoneWhen("Create a Google Calendar event with the fact you found")).toEqual({ kind: "text", min: 1 });
    expect(isWebSearchStep("google docs export of the notes")).toBe(false);
    expect(isWebSearchStep("google drive backup check")).toBe(false);
  });

  it("still catches a step whose actual job IS a web search", () => {
    const web = { kind: "tool_ok", tool: "search_web" };
    expect(inferDoneWhen("Search the web for tide tables")).toEqual(web);
    expect(inferDoneWhen("Find the tide tables")).toEqual(web);
    expect(inferDoneWhen("Look up the population of France")).toEqual(web);
    // Ordering words are stepped over — a checklist step often opens with one.
    expect(inferDoneWhen("Then find the current mortgage rates")).toEqual(web);
    expect(isWebSearchStep("Now search for the venue's opening hours")).toBe(true);
    // "google" as a real verb survives; only the product names are excluded.
    expect(isWebSearchStep("google the error message")).toBe(true);
  });

  it("reads “find out” as determine, not as search", () => {
    // Satisfied by reading a file or checking mail as often as by the web, so requiring a web search
    // would be a contract the right behaviour cannot meet.
    expect(isWebSearchStep("find out whether the shipment arrived")).toBe(false);
    expect(inferDoneWhen("Find out whether the shipment arrived")).toEqual({ kind: "text", min: 1 });
  });
});

/**
 * THE STOP THAT SAID NOTHING.
 *
 * Reported as: "it just stopped running the plan and returned the turn back to the user", with the
 * card still reading 0/26. `activeStep` matches `status === "active"` and nothing else, so a
 * workflow holding only `pending` steps has no active step, and the executor that asks for one
 * stops on it — the single ending in the whole run with no message attached, which is what made it
 * indistinguishable from a finished one.
 */
describe("a run with no step holding the baton", () => {
  const wf = (statuses: WorkflowStepStatus[]): Workflow => ({
    steps: statuses.map((status, i) => ({
      id: `s${i}`,
      instruction: `Send letter ${String.fromCharCode(65 + i)}`,
      doneWhen: { kind: "text", min: 1 } as const,
      onFail: "ask_user" as const,
      maxAttempts: 2,
      status,
      attempts: 0,
    })),
  });

  it("has no active step to run — which is how the run stalls in the first place", () => {
    expect(activeStep(wf(["pending", "pending"]))).toBeUndefined();
  });

  it("hands the baton to the first unfinished step", () => {
    const back = reactivateWorkflow(wf(["done", "pending", "pending"]));
    expect(activeStep(back)?.instruction).toBe("Send letter B");
  });

  it("leaves a healthy run alone, so it is safe on the happy path", () => {
    const healthy = wf(["done", "active", "pending"]);
    expect(reactivateWorkflow(healthy)).toBe(healthy);
  });

  it("never resurrects a finished run", () => {
    const finished = wf(["done", "done"]);
    expect(activeStep(reactivateWorkflow(finished))).toBeUndefined();
  });

  it("does not park a run that is merely waiting on the reader", () => {
    // A blocked step is `resumeWorkflow`'s business — that run is waiting on an answer and must not
    // be restarted behind the reader's back. Nothing here is pending, so there is nothing to revive.
    const parked = wf(["done", "blocked", "pending"]);
    expect(reactivateWorkflow(parked).steps[1]!.status).toBe("blocked");
  });

  it("keeps the step's attempts, so a state that recurs still parks instead of looping", () => {
    const tried = wf(["pending"]);
    tried.steps[0]!.attempts = 1;
    expect(reactivateWorkflow(tried).steps[0]!.attempts).toBe(1);
  });
});

/**
 * THE CARD READ 0/25 WHILE THE CHAT SHOWED 25 SENT MESSAGES.
 *
 * The app's own step executor advanced the run and posted the result down the same wire `set_plan`
 * uses. The host read that as the model re-issuing its checklist and ran it through
 * `recompileWorkflow`, which takes statuses only from the copy it already held — the pre-turn one,
 * which by definition has not advanced. `compileWorkflow` hardcodes every step to pending, so a
 * done-marked projection had no way back in. Every advance regressed the run to zero, and the next
 * turn re-issued step 1: the reader watched the alphabet start again at A.
 */
describe("adopting progress the app itself made", () => {
  const plan: BuddyPlan = {
    goal: "letters",
    steps: [{ text: "send Z", status: "pending" }, { text: "send Y", status: "pending" }, { text: "send X", status: "pending" }],
  };
  const advanced = (done: number): BuddyPlan => ({
    ...plan,
    steps: plan.steps.map((s, i) => ({ ...s, status: i < done ? "done" : "pending" })),
  });

  it("takes the ticks from the projection, which recompiling threw away", () => {
    const wf = compileWorkflow(plan);
    // The regression, stated as the assertion that fails against it: recompile reports nothing done.
    expect(recompileWorkflow(wf, advanced(2)).steps.filter((s) => s.status === "done")).toHaveLength(0);
    expect(adoptPlanProgress(wf, advanced(2)).steps.filter((s) => s.status === "done")).toHaveLength(2);
  });

  it("arms the next step, so the run still has a position", () => {
    // Without this every remaining step reads "pending" and `activeStep` finds nothing at all.
    const after = adoptPlanProgress(compileWorkflow(plan), advanced(2));
    expect(activeStep(after)?.instruction).toBe("send X");
  });

  it("keeps everything the projection drops", () => {
    // `workflowToPlan` emits only {text,status,note,needs} — a re-compile would have to guess the
    // rest again, and guesses a `files` contract wrong. Adopting copies progress onto what we hold.
    const wf = compileWorkflow({
      goal: "g",
      steps: [{ text: "write report.md", status: "pending", needs: "file", onFail: "skip" }, { text: "send Y", status: "pending" }],
    });
    const after = adoptPlanProgress(wf, {
      goal: "g",
      steps: [{ text: "write report.md", status: "done" }, { text: "send Y", status: "pending" }],
    });
    expect(after.steps[0]!.onFail).toBe(wf.steps[0]!.onFail);
    expect(after.steps[0]!.doneWhen).toEqual(wf.steps[0]!.doneWhen);
    expect(after.steps[0]!.status).toBe("done");
  });

  it("never un-ticks a step the projection has fallen behind on", () => {
    // Progress only moves forward. A stale projection must not resurrect finished work.
    const wf = adoptPlanProgress(compileWorkflow(plan), advanced(2));
    expect(adoptPlanProgress(wf, advanced(1)).steps.filter((s) => s.status === "done")).toHaveLength(2);
  });

  it("fails CLOSED on a projection that isn't ours", () => {
    // A stalled card is a visible nuisance; a workflow advanced by someone else's plan is silent
    // corruption. Different length or different instructions → the workflow is returned untouched.
    const wf = compileWorkflow(plan);
    expect(adoptPlanProgress(wf, { steps: [{ text: "send Z", status: "done" }] })).toBe(wf);
    expect(adoptPlanProgress(wf, { steps: [{ text: "draw a cat", status: "done" }, ...advanced(0).steps.slice(1)] })).toBe(wf);
  });
});

/**
 * THE WIRING. A correct function nothing reaches is this migration's signature failure, and it
 * leaves the suite green — so the channel that carries the distinction is asserted too.
 */
describe("the host can tell who moved the checklist", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", "..", "..", "apps", "web", "src", p), "utf8");

  it("the app's own advance is tagged at the source", () => {
    expect(read("engine.worker.ts")).toMatch(/post\(\{ type: "buddyPlan", requestId: msg\.requestId, plan, origin: "app" \}\)/);
  });

  it("the tag survives the hop to the host", () => {
    expect(read("useEngineWorker.ts")).toMatch(/kind: "plan", plan: msg\.plan, origin: msg\.origin \?\? "model"/);
  });

  it("the host branches on it instead of recompiling everything", () => {
    const app = read("App.tsx");
    expect(app, "the app's own advance still runs through recompileWorkflow").toMatch(
      /appManagedActive && e\.origin === "app"/,
    );
    expect(app).toMatch(/applyWorkflow\(adoptPlanProgress\(prev, e\.plan\)\)/);
  });
});
