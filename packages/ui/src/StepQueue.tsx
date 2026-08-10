import { cx } from "./design/classes.js";

/** One row of the checklist, as the chat holds it. */
export interface QueueStep {
  text: string;
  status: "pending" | "done";
  note?: string;
}

export type StepState = "done" | "active" | "waiting";

/**
 * WHICH STEP IS THE ONE HAPPENING NOW.
 *
 * Exactly one row may be active: the first that is not done. Pulled out of the render because the
 * old inline version asked `steps.slice(0, i).every(done)` for every row — quadratic, and quietly
 * wrong in the case that actually matters. A run that ticks out of order (step 2 done, step 1 still
 * open) left NO row marked current, so the reader saw a list with nothing happening in it while the
 * model was working. First-not-done cannot produce that.
 */
export function stepStates(steps: readonly QueueStep[]): StepState[] {
  const activeAt = steps.findIndex((s) => s.status !== "done");
  return steps.map((s, i) => (s.status === "done" ? "done" : i === activeAt ? "active" : "waiting"));
}

/** "3 of 6" — and the fraction the bar fills to. */
export function stepProgress(steps: readonly QueueStep[]): { done: number; total: number; pct: number } {
  const done = steps.filter((s) => s.status === "done").length;
  const total = steps.length;
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/**
 * THE CHECKLIST, AS A QUEUE YOU CAN WATCH.
 *
 * This replaces a list of "✓ / ▸ / ○" prefixes on plain lines, which was accurate and almost
 * unreadable: the state of a step was a character at the start of a sentence, at the same size and
 * weight as the sentence, so at a glance the whole thing was one grey paragraph. On a phone,
 * finding which of six steps was running meant reading all six.
 *
 * Each row now carries its state in a way the eye gets for free — a dot with its own colour, the
 * running one breathing — and there is a count and a bar, because "step 4 of 6" is the question
 * actually being asked and no arrangement of prefixes answers it.
 *
 * Rows stagger in on a spring via --vr-i, capped in CSS, so a long checklist arrives as a list
 * being written rather than a block appearing. The dismiss control is unchanged: this is still the
 * same checklist, in the same place, with the same button.
 */
export function StepQueue({
  goal,
  steps,
  onDismiss,
}: {
  goal?: string;
  steps: readonly QueueStep[];
  onDismiss?: () => void;
}) {
  if (steps.length === 0) return null;
  const states = stepStates(steps);
  const { done, total, pct } = stepProgress(steps);

  return (
    <div className={cx.queue}>
      <div style={headStyle}>
        {/* Clamped rather than truncated by overflow: a goal is a whole sentence and the old box cut
            it mid-word with no ellipsis, which reads as a rendering fault rather than a long title. */}
        <div className={cx.queueGoal} style={goalStyle}>
          📋 {goal || "Checklist"}
        </div>
        <span style={countStyle} aria-hidden="true">
          {done}/{total}
        </span>
        {onDismiss ? (
          <button type="button" onClick={onDismiss} title="Dismiss this checklist" aria-label="Dismiss this checklist" style={dismissStyle}>
            ✕
          </button>
        ) : null}
      </div>

      {/* One number, read at a glance, that no arrangement of tick marks gives you. */}
      <div className={cx.queueBar} style={barStyle} role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}>
        <i style={{ width: `${pct}%` }} />
      </div>

      <ol style={listStyle}>
        {steps.map((s, i) => (
          <li
            key={i}
            className={`${cx.step}${states[i] === "active" ? ` ${cx.stepActive}` : states[i] === "done" ? ` ${cx.stepDone}` : ""}`}
            style={{ ...rowStyle, ["--vr-i" as string]: i }}
            aria-current={states[i] === "active" ? "step" : undefined}
          >
            <span className={cx.stepDot} aria-hidden="true" />
            <span style={{ flex: 1, minWidth: 0 }}>
              {s.text}
              {s.status === "done" && s.note ? <span style={{ opacity: 0.6 }}> — {s.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const headStyle = { display: "flex", alignItems: "flex-start", gap: 8 } as const;

const goalStyle = { flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, lineHeight: 1.35 } as const;

const countStyle = {
  flexShrink: 0,
  fontSize: 11,
  opacity: 0.6,
  fontVariantNumeric: "tabular-nums",
  paddingTop: 1,
} as const;

const dismissStyle = {
  background: "none",
  border: "none",
  color: "inherit",
  opacity: 0.5,
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
  flexShrink: 0,
} as const;

const barStyle = { margin: "8px 0 9px" } as const;

const listStyle = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
} as const;

const rowStyle = { display: "flex", alignItems: "flex-start", gap: 9, fontSize: 12 } as const;
