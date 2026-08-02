import { BUDDY_TOOL_NAMES, type BuddyPlan, type BuddyToolCall, type BuddyToolName, type BuddyToolResultPayload } from "./buddy-tools.js";

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
  /**
   * The contract was GUESSED from the instruction's wording, not declared by the model (`needs` /
   * `produces`).
   *
   * This is the difference between a promise and a guess, and the collar has to treat them
   * differently. A declared contract is the model's own word about what would prove the step done, so
   * it stays strict. An inferred one is a regex reading English — and when a regex and reality
   * disagree about whether work happened, reality wins. See {@link evaluateStep}.
   */
  inferred?: boolean;
  /**
   * What this step is a continuation OF — the antecedent step's instruction, when this one only makes
   * sense after it ("now do the same for the barn").
   *
   * The executor hands each step to the model as a self-contained directive, and those directives are
   * EPHEMERAL: they're deliberately kept out of the saved transcript, and on a tool step the model's
   * own between-step narration is dropped too. So by the time step 3 runs, nothing in context says
   * what "the same" was — and a model told to do it without recapping renders whatever subject it can
   * still see, which is the previous picture. Resolving the ellipsis at COMPILE time is the fix; at
   * execution time the antecedent is already gone.
   */
  context?: string;
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
  // A bare tool name → require that tool to run without error — but ONLY when it names a REAL tool.
  // An unrecognized token (e.g. "research", a topic word the model wrote in `needs`) must fall through
  // to `undefined` so the caller runs `inferDoneWhen` on the instruction instead. Returning
  // `tool_ok("research")` would compile a contract no evidence can EVER satisfy (no tool by that name
  // ever runs), permanently wedging the step — the opposite of this function's documented fall-through.
  if (BUDDY_TOOL_NAMES.has(n as BuddyToolName)) return { kind: "tool_ok", tool: n as BuddyToolName };
  return undefined;
}

/** Heuristic fallback when a step declares no `needs`: read the instruction and guess the contract.
 * Conservative — a step we can't classify becomes a `text` (non-empty) check, which any real reply
 * satisfies, rather than something that could wrongly block. */
export function inferDoneWhen(instruction: string): DoneWhen {
  const t = instruction.toLowerCase();
  if (
    /\b(generate|draw|render|paint|illustrate|create|make)\b[^.]*\b(image|images|picture|pictures|photo|art|artwork|portrait|drawing|illustration|illustrations|scene|render)\b/.test(t) ||
    /\bimage of\b/.test(t)
  )
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

/**
 * Whether a step is written as a CONTINUATION of the one before it — "do the same for the barn",
 * "repeat for the tractor", "the second one", "now the chicken".
 *
 * A checklist is prose, and prose is elliptical: only the first item of a run spells out what the
 * work is. Read on its own, "now do the same for the barn" contains no evidence that an image is
 * wanted, so the contract came out as the generic text fallback — and the step then judged a turn
 * that rendered a picture by whether it had also written a paragraph. In a LIST, the sentence before
 * it is part of its meaning. PURE.
 */
export function isContinuationStep(instruction: string): boolean {
  const t = instruction.trim().toLowerCase();
  return (
    /\b(do|repeat|now)\b[^.]*\b(the same|likewise|again)\b/.test(t) ||
    /^(and |then |now |next[,: ])/.test(t) ||
    /\bsame (for|with|thing)\b/.test(t) ||
    /\b(second|third|fourth|fifth|next|last|final|remaining|other|another)\b/.test(t) ||
    /\brepeat\b/.test(t)
  );
}

/**
 * Whether a step is the model PLANNING rather than working — "plan the actions", "decide the prompts
 * for each image", "outline the approach".
 *
 * A checklist made of observable work has no such step in it: `set_plan` IS the planning, and it has
 * already happened by the time the checklist exists. But models write one anyway, and it is the worst
 * possible first step — nothing about it can be observed, so its contract falls to the generic text
 * check, which any sentence satisfies. The run then ticks a step off before doing anything, which is
 * exactly what the collar exists to prevent, and the reader watches it congratulate itself.
 *
 * Deliberately narrow. "Draft the itinerary" and "List 3 follow-ups" are deliverables, not planning:
 * the object has to refer to the WORK ITSELF (its steps, prompts, approach, order) before a verb like
 * "draft" or "decide" counts. Only a bare "plan …" is meta on the verb alone. PURE.
 */
export function isPlanningStep(instruction: string): boolean {
  const t = instruction.trim().toLowerCase().replace(/^(?:first|then|next)[,:]?\s+/, "").replace(/^i(?:'ll| will|'m going to)\s+/, "");
  // "Plan the actions" / "Plan the three images" is the checklist talking about itself. "Plan MY trip
  // to Rome" is the reader's deliverable — a possessive is the tell, and dropping it would throw away
  // the very thing they asked for.
  if (/^plan\b/.test(t) && !/^plan\s+(?:my|our|his|her|their|your|the reader's)\b/.test(t)) return true;
  return /^(?:decide|determine|outline|prepare|design|identify|choose|pick|draft|brainstorm|think about|figure out|work out)\b[^.]*\b(?:plans?|steps?|prompts?|approach|order|sequence|actions?|tasks?|outline|checklist|what to|which)\b/.test(
    t,
  );
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
  const mk = (instruction: string, doneWhen: DoneWhen, onFail: OnFail, inferred = false, context?: string): WorkflowStep => ({
    id: `s${steps.length + 1}`,
    instruction,
    doneWhen,
    onFail,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    status: "pending",
    attempts: 0,
    ...(inferred ? { inferred: true } : {}),
    ...(context ? { context } : {}),
  });
  // A leading "plan the actions" step is dropped before anything is compiled — see isPlanningStep.
  // Only when the model didn't DECLARE a contract for it (a step it tagged `needs:"text"` is a real
  // written deliverable), and only when there is actual work behind it to run.
  const authored = plan.steps.filter((s, i) => !(i === 0 && plan.steps.length > 1 && !s.needs && !s.produces?.length && isPlanningStep(s.text)));
  for (const s of authored) {
    // G5 — declared deliverable files (`produces`) become a `files` contract the host VERIFIES exist,
    // instead of trusting that a write tool merely ran. Otherwise fall back to needs/inference.
    const produces = s.produces?.map((p) => p.trim()).filter(Boolean);
    const declared: DoneWhen | undefined = produces?.length ? { kind: "files", paths: produces } : needsToDoneWhen(s.needs);
    let doneWhen: DoneWhen = declared ?? inferDoneWhen(s.text);
    // A step that classified only as the generic text FALLBACK, written as a continuation of the one
    // before it, means what that one meant: "generate an image of the goat" / "now do the same for the
    // barn" is two image steps, and reading the second alone turned it into a "write me a paragraph"
    // contract that no amount of rendering could satisfy.
    const prior = steps[steps.length - 1];
    const continues = !!prior && isContinuationStep(s.text);
    if (!declared && doneWhen.kind === "text" && continues && isToolContract(prior!.doneWhen.kind)) {
      doneWhen = prior!.doneWhen.kind === "files" ? { kind: "file" } : prior!.doneWhen;
    }
    // Carry the antecedent so the step can be handed over as a self-contained instruction later. Its
    // OWN antecedent is followed back, so a run of three keeps pointing at the one that spelt the work
    // out rather than at another ellipsis.
    const context = continues ? (prior!.context ?? prior!.instruction) : undefined;
    steps.push(mk(s.text, doneWhen, normalizeOnFail(s.onFail), !declared, context));
    // G6 — a `verify` command becomes an ENFORCED follow-up step that must exit 0 (the model can't
    // declare code "done" without it actually building/passing).
    const verify = s.verify?.trim();
    if (verify) steps.push(mk(`Verify the previous step: run \`${verify}\` with run_command and fix any failure until it exits 0.`, { kind: "command_ok" }, "ask_user"));
  }
  if (steps[0]) steps[0].status = "active";
  return { ...(plan.goal ? { goal: plan.goal } : {}), steps };
}

/**
 * Re-compile a plan the model has just RE-issued mid-run, keeping the work already finished.
 *
 * `set_plan` is how a model both starts and revises a checklist, and revising is exactly what a
 * confused model does — it apologises, re-plans, and carries on. Compiling that from scratch reset
 * every step to pending and armed step 1 again, so finished work was redone and unfinished work was
 * reached in the wrong order. The reader sees three renders and the wrong pictures.
 *
 * A step is "the same step" if its instruction matches one that was already settled — matched on
 * text, since ids are positional and a revision may insert or drop steps. Genuinely new steps start
 * pending, so a real change of plan still takes effect. PURE.
 */
export function recompileWorkflow(prev: Workflow | undefined, plan: BuddyPlan): Workflow {
  const fresh = compileWorkflow(plan);
  if (!prev) return fresh;
  const settled = new Map<string, WorkflowStep>();
  for (const s of prev.steps) if (s.status === "done" || s.status === "failed") settled.set(s.instruction.trim().toLowerCase(), s);
  const steps = fresh.steps.map((s) => {
    const was = settled.get(s.instruction.trim().toLowerCase());
    return was ? { ...s, status: was.status, attempts: was.attempts, ...(was.note ? { note: was.note } : {}) } : { ...s, status: "pending" as WorkflowStepStatus };
  });
  // Arm the first step that still needs doing — not step 1, which may well be finished.
  const next = steps.find((s) => s.status === "pending");
  if (next) next.status = "active";
  return { ...fresh, steps };
}

/** Why the executor is handing this step to the model. */
export type DirectiveKind =
  | "start" // the checklist was just compiled — drive its first step
  | "advance" // the previous step is settled; do the next one
  | "retry" // the attempt didn't satisfy the contract
  | "nudge"; // the model didn't attempt this step's work at all

/**
 * The instruction the model is given for a step — the executor's whole control surface, in one place.
 *
 * It lives here because it was the ASYMMETRY that broke a multi-image run: steps two onward were each
 * reached by a directive naming them ("now do ONLY step 2 of 3: …"), and the first was reached by
 * nothing at all. It ran on whatever the model chose to do in the turn it wrote the plan, before any
 * marker existed to say where it was — and since the collar can see that an image rendered but not
 * WHAT it depicts, whatever came back was credited to step 1. A model that planned goat/barn/tractor
 * and reached for the barn ticked step 1 off with it, and the goat was never drawn.
 *
 * Every kind names the step and its position, so no step can be reached anonymously again. PURE.
 */
export function stepDirective(
  wf: Workflow,
  step: WorkflowStep,
  kind: DirectiveKind,
  extra: { reason?: string; needsTool?: string; checklistMeta?: boolean } = {},
): string {
  const total = wf.steps.length;
  const n = wf.steps.findIndex((s) => s.id === step.id) + 1;
  const where = `step ${n} of ${total}`;
  // An elliptical step ("now do the same for the barn") loses its antecedent: these directives are
  // ephemeral by design and a tool step's narration is dropped, so nothing in context says what "the
  // same" was. The compiler recorded it; hand it over with the step.
  const context = step.context
    ? ` (This continues the kind of work in “${step.context}” — apply it to THIS step's subject, not the previous one's.)`
    : "";
  const lead =
    kind === "start"
      ? `Checklist ready — ${total} step${total === 1 ? "" : "s"}. Now do ONLY ${where}:`
      : kind === "advance"
        ? `✓ Previous step done. Now do ONLY ${where}:`
        : kind === "retry"
          ? `Your last attempt didn't satisfy ${where}${extra.reason ? ` (${extra.reason})` : ""}. Do it again now:`
          : `You haven't done ${where} yet.${
              extra.checklistMeta
                ? " The app tracks progress and ticks steps off itself — do NOT call complete_step or re-plan; just do the step."
                : ""
            }${extra.needsTool ? ` This step needs an ACTUAL ${extra.needsTool} call this turn (not a description).` : ""} Do it now:`;
  const tail = kind === "advance" || kind === "start" ? "Call its tool and stop — don't recap or explain." : "Call the tool and stop — no commentary.";
  return `[${lead} ${step.instruction}.${context} ${tail}]`;
}

/** The step currently being worked (the single `active` one), or undefined when none. */
export function activeStep(wf: Workflow | undefined): WorkflowStep | undefined {
  return wf?.steps.find((s) => s.status === "active");
}

/**
 * Whether a step's contract is satisfied by a TOOL effect (an image/file/command/named tool) rather
 * than by plain text. On a tool step the model's only legitimate output is the tool call itself, so
 * the host can safely DROP any between-step prose it emits (the confused "I already did X, moving on"
 * narration) — the app advances from observed evidence, never the words. An ANSWER contract
 * (`text`/`narration`/`user_reply`) is the opposite: the text IS the deliverable, so it's shown. PURE.
 */
export function isToolContract(kind: DoneWhen["kind"]): boolean {
  return kind === "image" || kind === "file" || kind === "files" || kind === "command_ok" || kind === "tool_ok";
}

/** Whether every step has reached a terminal state (no `pending`/`active` left). */
export function workflowFinished(wf: Workflow | undefined): boolean {
  return !!wf && !wf.steps.some((s) => s.status === "pending" || s.status === "active");
}

/** True when a tool of `name` ran this turn and didn't error. Host tools report failure NESTED, not at
 * the top level: a failed render/clip carries `{video:{ok:false}}`, a failed write `{writeFile:{ok:false}}`,
 * a failed image `{image:{ok:false}}` — all with a top-level `error` absent. Checking only `!r.result.error`
 * would call those SUCCESSES (the collar hole: a `tool_ok("generate_video")` step marked done off a failed
 * render). So a match counts as success only when it has no top-level `error` AND no nested `ok:false`. */
function toolSucceeded(evidence: StepEvidence, name: BuddyToolName): boolean {
  return evidence.toolResults.some(
    (r) =>
      r.call.tool === name &&
      !r.result.error &&
      r.result.video?.ok !== false &&
      r.result.writeFile?.ok !== false &&
      r.result.image?.ok !== false,
  );
}

/**
 * Did this turn actually PRODUCE something — a rendered image or clip, a written file, a command that
 * exited cleanly?
 *
 * Deliberately narrower than "a tool ran": a web search that returned hits is work in progress, not a
 * deliverable, and must not tick off a step that asked for an answer. This is only ever consulted to
 * stop a GUESSED contract from denying visible work. PURE.
 */
function producedArtifact(evidence: StepEvidence): boolean {
  return evidence.toolResults.some(
    (r) =>
      r.result.image?.ok === true ||
      r.result.video?.ok === true ||
      r.result.writeFile?.ok === true ||
      r.result.command?.code === 0 ||
      // Anything the host summarised as durable: a document, a spreadsheet, an edit that landed.
      r.result.artifact === true,
  );
}

/** The same set, but counting an ATTEMPT — a failed render is still the model doing the step, so it
 * should burn one of the step's attempts rather than loop on "you haven't started yet". PURE. */
function attemptedArtifact(evidence: StepEvidence): boolean {
  return evidence.toolResults.some(
    (r) => "image" in r.result || "video" in r.result || "writeFile" in r.result || "command" in r.result || "artifact" in r.result,
  );
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
      // A DOCUMENT is a file. create_document saves to the workspace and hands back a downloadable
      // card, and a spreadsheet opens and is saved — but neither goes through write_file, so a step
      // that asked for "a Word document summarising the findings" sat unfinished beside the document
      // it had asked for. `artifact` is the host's word that something durable landed.
      return evidence.toolResults.some((r) => r.result.writeFile?.ok === true || r.result.artifact === true)
        ? { done: true }
        : { done: false, reason: "no file or document was produced" };
    case "command_ok":
      return evidence.toolResults.some((r) => r.result.command?.code === 0)
        ? { done: true }
        : { done: false, reason: "no command exited cleanly" };
    case "tool_ok":
      return toolSucceeded(evidence, dw.tool)
        ? { done: true }
        : { done: false, reason: `the ${dw.tool} tool didn't run successfully` };
    case "text": {
      // A GUESSED answer-contract loses to observed work. The model rendered the picture, the render
      // suspended the turn (so there is no prose by construction), and a regex that had read the step
      // as "write something" then reported it undone — for ever, because doing it again produced the
      // same nothing. A contract the MODEL declared still holds; this only overrides a guess.
      if (step.inferred && producedArtifact(evidence)) return { done: true };
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
      if (step.inferred && producedArtifact(evidence)) return { done: true }; // same rule as `text`
      return evidence.text.trim().length > 0 ? { done: true } : { done: false, reason: "nothing was said" };
    case "user_reply":
      // The model asked; the step is satisfied by the reader's NEXT message, not by this turn.
      return { done: false, parks: true };
  }
}

/**
 * Did the turn make a GENUINE attempt at THIS step's work — the contract's tool actually ran (whether
 * it succeeded OR failed), or (for a text/narration step) some text was produced? Returns FALSE when
 * the model instead only poked the checklist meta-tools (set_plan/complete_step — the "let me check
 * the box" instinct, which is withdrawn in app-managed mode) or narrated on a TOOL step without
 * calling the tool. The executor uses this to RE-NUDGE toward the real tool WITHOUT spending one of
 * the step's few attempts, so a model confused about who tracks progress doesn't march the step into
 * a premature "stuck — how do I proceed?" park (the checklist-image bug). PURE.
 */
export function attemptedStepWork(step: WorkflowStep, evidence: StepEvidence): boolean {
  const dw = step.doneWhen;
  const ran = (pred: (r: StepEvidence["toolResults"][number]) => boolean): boolean => evidence.toolResults.some(pred);
  switch (dw.kind) {
    case "image":
      return ran((r) => "image" in r.result); // a render was attempted (image.ok true OR false)
    case "file":
    case "files":
      return ran((r) => "writeFile" in r.result || "artifact" in r.result);
    case "command_ok":
      return ran((r) => "command" in r.result);
    case "tool_ok":
      return ran((r) => r.call.tool === dw.tool);
    case "text":
    case "narration":
      // For answer steps the text IS the attempt — unless the contract was only guessed, in which
      // case a real render/write/run is an attempt too. Without this the model that DID the work is
      // told it hasn't started, re-nudged, and does it again.
      return evidence.text.trim().length > 0 || (!!step.inferred && attemptedArtifact(evidence));
    case "user_reply":
      return true; // parks by design — never a "no attempt" nudge
  }
}

/** The turn's ONLY tool activity was the checklist meta-tools (set_plan/complete_step) — the model
 * tried to MANAGE the checklist instead of doing the step. Lets the nudge be specific ("the app tracks
 * progress; don't check it off"), distinct from a plain narration miss. PURE. */
export function checklistMetaOnly(evidence: StepEvidence): boolean {
  const meta = new Set(["set_plan", "complete_step"]);
  return evidence.toolResults.length > 0 && evidence.toolResults.every((r) => meta.has(r.call.tool));
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
