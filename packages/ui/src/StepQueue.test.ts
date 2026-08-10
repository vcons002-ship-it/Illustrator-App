import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stepProgress, stepStates, type QueueStep } from "./StepQueue.js";

const steps = (...spec: ("done" | "pending")[]): QueueStep[] =>
  spec.map((status, i) => ({ text: `step ${i + 1}`, status }));

describe("which step is happening now", () => {
  it("marks exactly one row active — the first that is not done", () => {
    expect(stepStates(steps("done", "pending", "pending"))).toEqual(["done", "active", "waiting"]);
  });

  /**
   * THE CASE THE OLD INLINE VERSION GOT WRONG.
   *
   * It asked `steps.slice(0, i).every(done)` per row, so a run that ticked out of order — step 2
   * done while step 1 was still open — matched NOTHING, and the reader saw a checklist with nothing
   * happening in it while the model was working. First-not-done cannot produce that.
   */
  it("still marks something active when steps tick out of order", () => {
    const s = stepStates(steps("pending", "done", "pending"));
    expect(s.filter((x) => x === "active"), `nothing is happening: ${s.join(",")}`).toHaveLength(1);
    expect(s[0]).toBe("active");
  });

  it("marks nothing active once every step is done", () => {
    expect(stepStates(steps("done", "done"))).toEqual(["done", "done"]);
  });

  it("survives an empty checklist", () => {
    expect(stepStates([])).toEqual([]);
    expect(stepProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
  });

  it("counts what the reader is actually asking — step N of M", () => {
    expect(stepProgress(steps("done", "done", "pending", "pending"))).toEqual({
      done: 2,
      total: 4,
      pct: 50,
    });
  });
});

/**
 * The prefixes were accurate and nearly unreadable: a step's state was one character at the head of
 * a sentence, at the same size and weight as the sentence, so six steps were one grey paragraph and
 * finding the running one meant reading all of them. These assert that the state is carried by
 * something other than the text itself.
 */
describe("the queue shows state without being read", () => {
  const css = readFileSync(join(__dirname, "styles", "components.css"), "utf8");
  const motion = readFileSync(join(__dirname, "styles", "motion.css"), "utf8");

  it("gives the running step the only thing on screen that moves", () => {
    expect(css).toMatch(/\.vr-step--active \.vr-step-dot \{[\s\S]*?animation: vr-breathe/);
    expect(motion).toMatch(/@keyframes vr-breathe/);
  });

  it("breathes with opacity, never size", () => {
    // A dot that changed size pushed its row's text, and a checklist that shifts while you are
    // reading it is worse than one that does not move at all.
    const kf = /@keyframes vr-breathe \{([\s\S]*?)\n\}/.exec(motion)?.[1] ?? "";
    expect(kf, "vr-breathe not found").toBeTruthy();
    expect(kf, "the dot resizes, which reflows the row beside it").not.toMatch(/transform|width|height/);
  });

  it("colours done and running differently from each other and from waiting", () => {
    expect(css).toMatch(/\.vr-step--done \.vr-step-dot \{[\s\S]*?--vr-good/);
    expect(css).toMatch(/\.vr-step--active \{[\s\S]*?--vr-accent-rgb/);
  });

  it("caps the stagger, so a long plan does not perform its own arrival", () => {
    const rule = /\.vr-step \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/animation-delay:.*min\(/);
  });

  it("clamps a long goal instead of cutting it mid-word", () => {
    expect(css).toMatch(/\.vr-queue-goal \{[\s\S]*?line-clamp/);
  });
});

describe("the panel actually uses it", () => {
  const panel = readFileSync(join(__dirname, "ChatBuddyPanel.tsx"), "utf8");

  it("renders the queue rather than the old prefixed lines", () => {
    expect(panel).toContain("<StepQueue");
    // The tell-tale of the old renderer. Its transient tool-trace sibling keeps its own ✓/▸, which
    // is a different list — this asserts the CHECKLIST no longer draws state as text.
    expect(panel, "the plan is still drawn with ○ prefixes").not.toContain('"▸ " : "○ "');
  });

  it("keeps the dismiss control the checklist always had", () => {
    expect(panel).toContain("onDismiss: props.onDismissPlan");
  });
});
