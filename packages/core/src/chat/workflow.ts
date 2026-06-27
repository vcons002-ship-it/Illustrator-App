import type { BuddyPlan, BuddyToolCall, BuddyToolName, BuddyToolResultPayload } from "./buddy-tools.js";

/**
 * Compiled workflows — the "App-managed steps" engine.
 *
 * The model COMPILES a plan once (via `set_plan`, optionally annotating each step with the tool/
 * condition that proves it's done) and then just works. The APP owns the workflow state machine and
 * marks a step done ONLY from observed evidence — a tool actually succeeded — never from the model's
 * self-report. That's the "collar": the model can't advance the workflow by *claiming* progress, so
 * the wildly different ways models drive checklist meta-tools stop mattering.
 *
 * Everything here is PURE (no host deps), so the completion logic — the part that has to be
 * trustworthy across every model — is deterministic and unit-tested. The host (App.tsx) gathers the
 * `StepEvidence` from a turn's tool results and calls `evaluateStep` / `advanceWorkflow`.
 */

/** A step's completion contract — what the app checks to decide the step is genuinely done. */
export type DoneWhen =
  | { kind: "tool_ok"; tool: BuddyToolName } // that tool ran and returned non-error this step
  | { kind: "image" } // generate_image produced an image (image.ok)
  | { kind: "file" } // write_file succeeded / a file artifact appeared
  | { kind: "command_ok" } // run_command exited 0
  | { kind: "text"; min?: number; regex?: string } // plain-text output non-empty / matches a pattern
  | { kind: "files"; paths: string[] } // these specific deliverable files exist + are non-empty (host-verified)
  | { kind: "user_reply" } // PARKS — satisfied by the reader's next message, not by a turn
  | { kind: "narration" }; // a pure "say X" step — done once the model produces any text

export type WorkflowStepStatus = "pending" | "active" | "done" | "failed" | "blocked";

/** What to do when a step never satisfies its contract within `maxAttempts`. */
export type OnFail = "skip" | "ask_user" | "abort";

export interface WorkflowStep {
  id: string;
  /** What the model should do this turn — phrased like a self-contained reader request. */
  instruction: string;
  doneWhen: DoneWhen;
  onFail: OnFail;
  maxAttempts: number;
  status: WorkflowStepStatus;
  attempts: number;
  /** A short note the app attaches (e.g. why it failed/was skipped). */
  note?: string;
}

export interface Workflow {
  goal?: string;
  steps: WorkflowStep[];
}

export const DEFAULT_MAX_ATTEMPTS = 2;

/** Evidence the app observed for the just-finished step: the tool calls + results of the turn (the
 * host folds in HOST-tool outcomes — generate_image/write_file/run_command — as synthetic entries so
 * this is uniform), plus the final plain-text the model produced. */
export interface StepEvidence {
  toolResults: { call: BuddyToolCall; result: BuddyToolResultPayload }[];
  text: string;
  /** Host-verified existence of a `files` step's declared deliverables (path → exists & non-empty), so
   * the collar checks the artifacts ACTUALLY landed, not just that a write tool ran. */
  filesPresent?: { path: string; ok: boolean }[];
}

/** The result of judging a step against its contract. `parks` means "correctly waiting on the reader"
 * (a user_reply step), which is NOT a failure. */
export interface StepOutcome {
  done: boolean;
  parks?: boolean;
  reason?: string;
}

const TOOL_NEED_ALIASES: Record<string, DoneWhen> = {
  image: { kind: "image" },
  picture: { kind: "image" },
  render: { kind: "image" },
  file: { kind: "file" },
  document: { kind: "file" },
  save: { kind: "file" },
  command: { kind: "command_ok" },
  run: { kind: "command_ok" },
  shell: { kind: "command_ok" },
  reply: { kind: "user_reply" },
  ask: { kind: "user_reply" },
  input: { kind: "user_reply" },
  text: { kind: "text", min: 1 },
  say: { kind: "narration" },
  narration: { kind: "narration" },
  none: { kind: "narration" },
};

/** Compile a `needs` token (a model-declared contract) into a DoneWhen. A bare tool NAME
 * ("search_web", "generate_image") becomes `tool_ok`/`image`; aliases map common words; unknown
 * tokens fall through so the caller can `inferDoneWhen` from the instruction instead. */
export function needsToDoneWhen(needs: string | undefined): DoneWhen | undefined {
  const n = (needs ?? "").trim().toLowerCase();
  if (!n) return undefined;
  if (TOOL_NEED_ALIASES[n]) return TOOL_NEED_ALIASES[n];
  if (n === "generate_image") return { kind: "image" };
  if (n === "write_file") return { kind: "file" };
  if (n === "run_command") return { kind: "command_ok" };
  // A bare tool name → require that tool to run without error.
  return { kind: "tool_ok", tool: n as BuddyToolName };
}

/** Heuristic fallback when a step declares no `needs`: read the instruction and guess the contract.
 * Conservative — a step we can't classify becomes a `text` (non-empty) check, which any real reply
 * satisfies, rather than something that could wrongly block. */
export function inferDoneWhen(instruction: string): DoneWhen {
  const t = instruction.toLowerCase();
  if (/\b(generate|draw|render|paint|illustrate|create|make)\b[^.]*\b(image|picture|photo|art|portrait|drawing|render)\b/.test(t) || /\bimage of\b/.test(t))
    return { kind: "image" };
  if (/\b(save|write|export|create)\b[^.]*\b(file|\.md|\.csv|\.txt|\.json|document|script|doc)\b/.test(t))
    return { kind: "file" };
  if (/\b(run|execute|exec)\b[^.]*\b(command|script|test|build|it)\b/.test(t)) return { kind: "command_ok" };
  if (/\b(search|find|look up|google)\b/.test(t)) return { kind: "tool_ok", tool: "search_web" };
  // "ask me / ask the reader / your favorite / what's your …" → wait for the reader.
  if (/\bask (me|the reader|them|you)\b/.test(t) || /\byour (favorite|favourite|name|preference)\b/.test(t))
    return { kind: "user_reply" };
  return { kind: "text", min: 1 };
}

function normalizeOnFail(onFail: string | undefined): OnFail {
  switch ((onFail ?? "").trim().toLowerCase()) {
    case "skip":
      return "skip";
    case "abort":
      return "abort";
    case "ask_user":
    case "ask":
    case "retry": // "retry forever" would loop — after maxAttempts, surface to the reader instead
      return "ask_user";
    default:
      return "ask_user";
  }
}

/** Compile a model-authored plan (the existing `BuddyPlan`, whose steps may carry `needs`/`onFail`)
 * into an executable Workflow: every step gets a concrete DoneWhen (declared or inferred), defaults
 * filled, ids assigned, all `pending` and the first `active`. PURE. */
export function compileWorkflow(plan: BuddyPlan): Workflow {
  const steps: WorkflowStep[] = [];
  const mk = (instruction: string, doneWhen: DoneWhen, onFail: OnFail): WorkflowStep => ({
    id: `s${steps.length + 1}`,
    instruction,
    doneWhen,
    onFail,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    status: "pending",
    attempts: 0,
  });
  for (const s of plan.steps) {
    // G5 — declared deliverable files (`produces`) become a `files` contract the host VERIFIES exist,
    // instead of trusting that a write tool merely ran. Otherwise fall back to needs/inference.
    const produces = s.produces?.map((p) => p.trim()).filter(Boolean);
    const doneWhen: DoneWhen = produces?.length ? { kind: "files", paths: produces } : (needsToDoneWhen(s.needs) ?? inferDoneWhen(s.text));
    steps.push(mk(s.text, doneWhen, normalizeOnFail(s.onFail)));
    // G6 — a `verify` command becomes an ENFORCED follow-up step that must exit 0 (the model can't
    // declare code "done" without it actually building/passing).
    const verify = s.verify?.trim();
    if (verify) steps.push(mk(`Verify the previous step: run \`${verify}\` with run_command and fix any failure until it exits 0.`, { kind: "command_ok" }, "ask_user"));
  }
  if (steps[0]) steps[0].status = "active";
  return { ...(plan.goal ? { goal: plan.goal } : {}), steps };
}

/** The step currently being worked (the single `active` one), or undefined when none. */
export function activeStep(wf: Workflow | undefined): WorkflowStep | undefined {
  return wf?.steps.find((s) => s.status === "active");
}

/** Whether every step has reached a terminal state (no `pending`/`active` left). */
export function workflowFinished(wf: Workflow | undefined): boolean {
  return !!wf && !wf.steps.some((s) => s.status === "pending" || s.status === "active");
}

/** True when a tool of `name` ran this turn and didn't error. */
function toolSucceeded(evidence: StepEvidence, name: BuddyToolName): boolean {
  return evidence.toolResults.some((r) => r.call.tool === name && !r.result.error);
}

/**
 * THE COLLAR. Judge the active step against its contract using ONLY observed evidence — never the
 * model's claim. The host folds host-tool outcomes (generate_image → `image.ok`, write_file →
 * `writeFile.ok`, run_command → `command.code`) into `evidence.toolResults`, so every kind is a
 * uniform scan. PURE.
 */
export function evaluateStep(step: WorkflowStep, evidence: StepEvidence): StepOutcome {
  const dw = step.doneWhen;
  switch (dw.kind) {
    case "image":
      return evidence.toolResults.some((r) => r.result.image?.ok === true)
        ? { done: true }
        : { done: false, reason: "no image was rendered" };
    case "file":
      return evidence.toolResults.some((r) => r.result.writeFile?.ok === true)
        ? { done: true }
        : { done: false, reason: "no file was written" };
    case "command_ok":
      return evidence.toolResults.some((r) => r.result.command?.code === 0)
        ? { done: true }
        : { done: false, reason: "no command exited cleanly" };
    case "tool_ok":
      return toolSucceeded(evidence, dw.tool)
        ? { done: true }
        : { done: false, reason: `the ${dw.tool} tool didn't run successfully` };
    case "text": {
      const body = evidence.text.trim();
      if (body.length < (dw.min ?? 1)) return { done: false, reason: "no answer was produced" };
      if (dw.regex) {
        let re: RegExp | undefined;
        try {
          re = new RegExp(dw.regex, "i");
        } catch {
          re = undefined; // a malformed pattern shouldn't wedge the step
        }
        if (re && !re.test(body)) return { done: false, reason: "the answer didn't match the expected pattern" };
      }
      return { done: true };
    }
    case "files": {
      const present = evidence.filesPresent ?? [];
      const missing = dw.paths.filter((p) => !present.some((f) => f.path === p && f.ok));
      return missing.length === 0
        ? { done: true }
        : { done: false, reason: `these files aren't on disk yet (or are empty): ${missing.join(", ")}` };
    }
    case "narration":
      return evidence.text.trim().length > 0 ? { done: true } : { done: false, reason: "nothing was said" };
    case "user_reply":
      // The model asked; the step is satisfied by the reader's NEXT message, not by this turn.
      return { done: false, parks: true };
  }
}

/** What the executor should do next after judging the active step. */
export type WorkflowAction = "advance" | "retry" | "park" | "skip" | "finish" | "abort";

export interface AdvanceResult {
  workflow: Workflow;
  action: WorkflowAction;
  /** The newly-active step after an advance/skip (undefined on retry/park/finish/abort). */
  next?: WorkflowStep;
}

/**
 * Apply a step outcome to the workflow and decide the next move. PURE (returns a new Workflow):
 *  - parks            → active step `blocked`, action "park" (wait for the reader).
 *  - done             → active step `done`; next pending becomes `active` ("advance"), or "finish".
 *  - not done, attempts left → bump attempts, stay active, action "retry".
 *  - not done, exhausted     → apply onFail: "skip" (fail this step, move on), "ask_user"
 *                              (active step `blocked`, action "park"), or "abort".
 */
export function advanceWorkflow(wf: Workflow, outcome: StepOutcome): AdvanceResult {
  const idx = wf.steps.findIndex((s) => s.status === "active");
  if (idx === -1) return { workflow: wf, action: workflowFinished(wf) ? "finish" : "park" };
  const steps = wf.steps.map((s) => ({ ...s }));
  const step = steps[idx]!;

  const activateNext = (): { action: WorkflowAction; next?: WorkflowStep } => {
    // Prefer the next later pending step; otherwise any remaining pending one; otherwise finish.
    const laterIdx = steps.findIndex((s, i) => i > idx && s.status === "pending");
    const targetIdx = laterIdx === -1 ? steps.findIndex((s) => s.status === "pending") : laterIdx;
    if (targetIdx === -1) return { action: "finish" };
    const target = steps[targetIdx]!;
    target.status = "active";
    return { action: "advance", next: target };
  };

  if (outcome.parks) {
    step.status = "blocked";
    return { workflow: { ...wf, steps }, action: "park" };
  }
  if (outcome.done) {
    step.status = "done";
    const { action, next } = activateNext();
    return { workflow: { ...wf, steps }, action, ...(next ? { next } : {}) };
  }
  // Not done.
  step.attempts += 1;
  if (step.attempts < step.maxAttempts) {
    return { workflow: { ...wf, steps }, action: "retry" };
  }
  // Attempts exhausted → terminal handling.
  if (step.onFail === "skip") {
    step.status = "failed";
    step.note = outcome.reason ? `skipped: ${outcome.reason}` : "skipped after retries";
    const { action, next } = activateNext();
    // Report it as a skip when we moved on; "finish" if it was the last step.
    return { workflow: { ...wf, steps }, action: action === "advance" ? "skip" : action, ...(next ? { next } : {}) };
  }
  if (step.onFail === "abort") {
    step.status = "failed";
    step.note = outcome.reason ?? "failed after retries";
    return { workflow: { ...wf, steps }, action: "abort" };
  }
  // ask_user (default): block and surface to the reader.
  step.status = "blocked";
  step.note = outcome.reason ?? "needs the reader";
  return { workflow: { ...wf, steps }, action: "park" };
}

/** Resume a parked step when the reader replies (or the executor decides to retry a blocked step):
 * flip the first `blocked` step back to `active` so the run continues. PURE. */
export function resumeWorkflow(wf: Workflow): Workflow {
  const idx = wf.steps.findIndex((s) => s.status === "blocked");
  if (idx === -1) return wf;
  const steps = wf.steps.map((s, i) => (i === idx ? { ...s, status: "active" as WorkflowStepStatus, attempts: 0 } : s));
  return { ...wf, steps };
}

/** Whether the run is waiting on the reader (a step is `blocked`). */
export function workflowParked(wf: Workflow | undefined): boolean {
  return !!wf && wf.steps.some((s) => s.status === "blocked");
}

/**
 * A read-only `BuddyPlan` VIEW of a workflow, for the worker's prompt + the existing plan UI/mirror.
 * Done steps map to `done`; everything else to `pending` (the `active` one renders as the ▸ current
 * step). The host feeds this as `activePlan` so no worker-side structure changes.
 */
export function workflowToPlan(wf: Workflow): BuddyPlan {
  return {
    ...(wf.goal ? { goal: wf.goal } : {}),
    steps: wf.steps.map((s) => {
      // Carry the tool the step's contract demands (if any) so the worker can grammar-CONSTRAIN that
      // turn's reply to a real call — a small model then can't narrate instead of acting (G3).
      const needs = doneWhenToNeeds(s.doneWhen);
      return {
        text: s.instruction,
        status: s.status === "done" ? ("done" as const) : ("pending" as const),
        ...(s.note ? { note: s.note } : {}),
        ...(needs ? { needs } : {}),
      };
    }),
  };
}

/** The specific tool a step's completion contract demands, as a `needs` token — for grammar-constrained
 * tool calling. `undefined` for text/narration/user_reply steps (no tool required). PURE. */
export function doneWhenToNeeds(dw: DoneWhen): string | undefined {
  switch (dw.kind) {
    case "image":
      return "generate_image";
    case "file":
      return "write_file";
    case "command_ok":
      return "run_command";
    case "tool_ok":
      return dw.tool;
    default:
      return undefined;
  }
}
