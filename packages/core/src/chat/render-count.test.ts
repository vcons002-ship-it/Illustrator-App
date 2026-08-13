import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_REQUESTED_RENDERS,
  planIdentity,
  renderStepNumber,
  requestedRenderCount,
  requestedRendersNote,
} from "./render-count.js";

/**
 * "Generate 3 images of yourself" came back as one picture, with no checklist, across three separate
 * prompt fixes. The rule that says several images means a checklist was present and correct every
 * time; it simply lost to whichever neighbouring rule the model reached first. This counts instead.
 */
describe("counting the pictures a message asks for", () => {
  it("reads the number in front of the picture word", () => {
    for (const [text, n] of [
      ["generate 3 images of yourself", 3],
      ["make me five pictures of a dragon", 5],
      ["draw 4 portraits in different styles", 4],
      ["I'd like two illustrations for this chapter", 2],
      ["give me 6 photos of a rainy street", 6],
    ] as const) {
      expect(requestedRenderCount(text), text).toBe(n);
    }
  });

  it("tolerates a word between the count and the noun", () => {
    // "3 different images", "three quick sketches of…" — the count still attaches to the picture.
    expect(requestedRenderCount("generate 3 different images of yourself")).toBe(3);
  });

  it("does not count the SUBJECT of a single picture", () => {
    // The failure that would cost the reader real GPU time: one picture containing three cats is
    // not three pictures. The noun after the number is what settles it.
    expect(requestedRenderCount("draw a picture of 3 cats")).toBeUndefined();
    expect(requestedRenderCount("an illustration of five knights on a hill")).toBeUndefined();
  });

  it("says nothing for one picture, which needs no checklist", () => {
    expect(requestedRenderCount("draw me a dragon")).toBeUndefined();
    expect(requestedRenderCount("generate 1 image of a fox")).toBeUndefined();
  });

  it("ignores a count too large to be meant, rather than running it", () => {
    // A bound on what an accident costs, not a technical limit. Past it the model decides, and it
    // will ask.
    expect(requestedRenderCount(`generate ${MAX_REQUESTED_RENDERS} images`)).toBe(MAX_REQUESTED_RENDERS);
    expect(requestedRenderCount(`generate ${MAX_REQUESTED_RENDERS + 1} images`)).toBeUndefined();
    expect(requestedRenderCount("generate 100 images of a cat")).toBeUndefined();
  });

  it("is not fooled by a number elsewhere in the sentence", () => {
    expect(requestedRenderCount("draw the scene from chapter 3")).toBeUndefined();
    expect(requestedRenderCount("make an image at 4k")).toBeUndefined();
  });
});

describe("the note that rides the turn", () => {
  it("names the count and asks for that many steps", () => {
    const note = requestedRendersNote("generate 3 images of yourself", false);
    expect(note).toContain("3 SEPARATE PICTURES");
    expect(note).toMatch(/call set_plan with 3 steps/);
  });

  it("says why rendering first loses the rest", () => {
    // The mechanism, not an instruction to obey: a render suspends the turn, so a picture drawn
    // before the plan exists takes the plan with it.
    expect(requestedRendersNote("draw 4 pictures of a fox", false)).toMatch(/a render ends this turn/);
  });

  it("goes quiet once a checklist is running", () => {
    // The plan IS the instruction by then. A second voice telling it to plan is how a model calls
    // set_plan again mid-run and starts the whole thing over.
    expect(requestedRendersNote("generate 3 images of yourself", true)).toBe("");
  });

  it("stays silent on an ordinary request", () => {
    expect(requestedRendersNote("draw me a dragon", false)).toBe("");
    expect(requestedRendersNote("what's the capital of France?", false)).toBe("");
  });
});

/**
 * THE WIRING, WHICH IS THE HALF THAT HAS FAILED BEFORE.
 *
 * This migration's recurring failure is a correct thing that nothing reaches: rules defined and
 * never worn, a handler that ran while no element carried its class. A counter nobody calls would
 * be the same story, and the suite would be green.
 */
describe("the count actually reaches the turn", () => {
  const worker = readFileSync(join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "engine.worker.ts"), "utf8");

  it("is computed from THIS turn's message", () => {
    // The message it reads. Which plans silence it is asserted separately, below.
    expect(worker).toMatch(/const rendersBlock = requestedRendersNote\(msg\.userText \?\? ""/);
  });

  it("rides the volatile block, so it is never stored", () => {
    // Persisting it would replay "the reader asked for 3 pictures" on every later turn — the exact
    // failure `stripPersistedDirectives` exists to undo, and one this app has already had once.
    const line = /const volatile = \[([^\]]*)\]/.exec(worker)?.[1] ?? "";
    expect(line, "the volatile assembly moved").toBeTruthy();
    expect(line, "the note is not in the volatile block").toContain("rendersBlock");
  });
});

/**
 * The second picture was labelled "Step 1 of 3", the same as the first. The label was honest: it
 * read the first UNFINISHED step, and the model had narrated "Image 1 is done. Now generating the
 * second image" rather than calling complete_step, so step 1 really was still open. The app does not
 * have to take the model's word for it — it knows how many pictures it has made.
 */
describe("labelling a render when the ticks are behind", () => {
  const open3 = ["pending", "pending", "pending"];

  it("counts the pictures when nothing has been ticked", () => {
    expect(renderStepNumber(open3, 1)).toBe(1);
    expect(renderStepNumber(open3, 2), "the second picture was labelled step 1").toBe(2);
    expect(renderStepNumber(open3, 3)).toBe(3);
  });

  it("still follows the ticks when the model IS keeping up", () => {
    expect(renderStepNumber(["done", "pending", "pending"], 2)).toBe(2);
    expect(renderStepNumber(["done", "done", "pending"], 3)).toBe(3);
  });

  it("trusts the ticks when they are AHEAD, which a mixed checklist needs", () => {
    // "write, draw, write, draw": the first render belongs to step 2, and only the tick count knows
    // that. Taking the higher of the two is what lets one rule serve both shapes.
    expect(renderStepNumber(["done", "pending", "pending", "pending"], 1)).toBe(2);
  });

  it("never runs past the end of the checklist", () => {
    expect(renderStepNumber(open3, 9)).toBe(3);
    expect(renderStepNumber(["done", "done", "done"], 5)).toBe(3);
  });

  it("says nothing for an empty checklist rather than inventing a step", () => {
    expect(renderStepNumber([], 3)).toBe(0);
  });
});

describe("knowing when the tally belongs to a different checklist", () => {
  const plan = { goal: "turtles", steps: [{ text: "one" }, { text: "two" }] };

  it("is unchanged by progress, so the tally is not reset on every tick", () => {
    expect(planIdentity(plan)).toBe(planIdentity({ ...plan, steps: [{ text: "one" }, { text: "two" }] }));
  });

  it("changes when the checklist does", () => {
    expect(planIdentity(plan)).not.toBe(planIdentity({ goal: "otters", steps: plan.steps }));
    expect(planIdentity(plan)).not.toBe(planIdentity({ goal: "turtles", steps: [{ text: "one" }] }));
  });

  it("does not let step text run together into a false match", () => {
    // "a" + "bc" and "ab" + "c" are different checklists and must not share a key.
    expect(planIdentity({ steps: [{ text: "a" }, { text: "bc" }] })).not.toBe(
      planIdentity({ steps: [{ text: "ab" }, { text: "c" }] }),
    );
  });

  /**
   * A FINISHED CHECKLIST WAS STILL THE ACTIVE ONE.
   *
   * Straight after a three-bird run completed, "I want to generate 3 images. Create 3 prompts for
   * images of elephants" produced ONE elephant, captioned "Step 3 of 3 · Generate 3 separate images
   * of birds". Three symptoms, one cause: the finished plan never stopped being installed.
   *
   *   - `hasPlan` stayed true, so the prompt swapped MULTI-STEP vs SINGLE for mid-checklist
   *     discipline, and the new request never met the rule that would have planned it;
   *   - the render note was suppressed, because it goes quiet while a checklist is running;
   *   - the new picture was tagged with the old checklist's goal.
   *
   * All three now ask the same question — has this checklist got work left? — instead of merely
   * whether one exists.
   */
  it("the render note fires again once the previous checklist is finished", () => {
    // The gate is a plan with work LEFT, not any plan. A finished one must not silence the counter,
    // which is exactly how the elephants came back as a single picture.
    expect(requestedRendersNote("generate 3 images of elephants", false)).toContain("3 SEPARATE PICTURES");
    expect(requestedRendersNote("generate 3 images of elephants", true)).toBe("");
  });

  it("asks whether the checklist has work left, not whether one exists", () => {
    const worker = readFileSync(
      join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "engine.worker.ts"),
      "utf8",
    );
    expect(worker, "a finished checklist still claims the prompt's mid-plan branch").toMatch(
      /\.\.\.\(planHasPendingStep\(msg\.plan\) \? \{ activePlan: msg\.plan \} : \{\}\)/,
    );
    expect(worker, "a finished checklist still silences the render note").toMatch(
      /requestedRendersNote\(msg\.userText \?\? "", planHasPendingStep\(msg\.plan\)\)/,
    );
  });

  it("does not let a finished checklist caption a new picture", () => {
    const app = readFileSync(join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8");
    expect(app, "an elephant can still be captioned with a bird checklist").toMatch(
      /if \(!out\.error && plan && planHasPendingStep\(plan\)\) \{/,
    );
  });

  it("is what the render label actually uses", () => {
    // Same reason the note's wiring is asserted above: a rule nothing calls is this migration's
    // signature failure, and it leaves the suite green.
    const app = readFileSync(join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8");
    expect(app).toMatch(/const key = planIdentity\(plan\)/);
    expect(app, "the label still reads only the first unfinished step").toMatch(
      /const stepNo = renderStepNumber\(/,
    );
  });
});

/**
 * THE WIRING FOR THE IN-TURN CHECKLIST.
 *
 * The capability is in buddy-session and tested there. This asserts it is REACHED — a hook nothing
 * calls is this migration's signature failure, and it leaves the suite green.
 */
describe("the checklist tick reaches the turn", () => {
  const worker = readFileSync(
    join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "engine.worker.ts"),
    "utf8",
  );

  it("is handed to runBuddyTurn", () => {
    expect(worker).toMatch(/\.\.\.\(appManagedTick \? \{ appManagedTick \} : \{\}\)/);
  });

  it("rebuilds the contracts from the plan the host already mirrors", () => {
    // workflowToPlan writes each step's `needs` into the projection and compileWorkflow reads it
    // back, so there is no second copy of the run's state to fall out of date.
    expect(worker).toMatch(/compileWorkflow\(msg\.plan!\)/);
    expect(worker, "the tick judges without the collar").toMatch(/evaluateStep\(step, evidence\)/);
  });

  it("mirrors every advance to the host, or the card never moves", () => {
    const tick = /const appManagedTick = wf[\s\S]*?\n {6}: undefined;/.exec(worker)?.[0] ?? "";
    expect(tick, "the tick moved").toBeTruthy();
    expect(tick, "an advance is not posted, so the plan card stays where it was").toMatch(
      /post\(\{ type: "buddyPlan"/,
    );
  });

  it("only runs while the checklist has work", () => {
    expect(worker).toMatch(/msg\.appManagedSteps && planHasPendingStep\(msg\.plan\)/);
  });

  it("publishes each step's text, which nothing else would", () => {
    const app = readFileSync(join(__dirname, "..", "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8");
    expect(worker, "the worker never forwards the boundary").toMatch(/type: "buddyStepDone"/);
    expect(app, "the app never renders the step's message").toMatch(/e\.kind === "stepDone"/);
  });
});
