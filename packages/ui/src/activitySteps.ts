/**
 * THE TRACE OF WHAT A TURN DID, without one row per round.
 *
 * Every tool call appends a line to the turn's visible trace. That reads well for a turn that
 * searches, reads and writes — three different things, three rows. It reads as nothing at all for a
 * turn that does the same thing twenty-six times: asked to count, the reader got a column of "✓
 * Working" tall enough to fill the screen, every row identical and none of them saying what was
 * worked on.
 *
 * Consecutive identical steps collapse into one row carrying a count. A count is kept rather than
 * silently dropping the repeats, because "it searched five times" is worth knowing — it is the
 * difference between a model working and a model stuck, which is the whole reason the trace exists.
 * Only ADJACENT rows collapse, so search → read → search stays three rows and does not pretend the
 * two searches were together.
 *
 * PURE.
 */

/** How a repeat is shown. Kept here so the parser below and the renderer cannot drift apart. */
const REPEAT = /\s+×(\d+)$/;

/** The label without its count, whether or not it carries one. */
export function stepLabel(step: string): string {
  return step.replace(REPEAT, "");
}

/** How many times this step happened in a row. */
export function stepCount(step: string): number {
  const n = REPEAT.exec(step);
  return n ? Number(n[1]) : 1;
}

/**
 * Append `label` to the trace, folding it into the previous row when it repeats that row.
 * Returns a new array; never mutates. An empty label is ignored rather than adding a blank row.
 */
export function pushActivityStep(steps: readonly string[], label: string): string[] {
  const next = label.trim();
  if (!next) return [...steps];
  const last = steps[steps.length - 1];
  if (last !== undefined && stepLabel(last) === next) {
    return [...steps.slice(0, -1), `${next} ×${stepCount(last) + 1}`];
  }
  return [...steps, next];
}

/** Longest message echoed into a step row. Long enough to tell two messages apart, short enough that
 * a paragraph doesn't become the row. */
export const STEP_ECHO_MAX = 24;

/**
 * The trace row for a message a series just sent.
 *
 * "Working" told the reader nothing, twenty-six times over. The message itself is the one fact worth
 * showing, and it is already in hand at the point the row is written — no extra call, no extra
 * state. A message too long to fit falls back to a plain label rather than a clipped sentence that
 * reads like an error.
 */
export function sentStepLabel(message: string): string {
  const one = message.trim().replace(/\s+/g, " ");
  if (!one) return "Continuing";
  return one.length <= STEP_ECHO_MAX ? `Sent “${one}”` : "Sent a message";
}
