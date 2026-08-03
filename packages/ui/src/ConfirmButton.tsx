import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * A destructive button that asks TWICE, in place, without a browser dialog.
 *
 * `window.confirm` is unusable in this app whenever a phone is linked, and the task-delete buttons
 * were the proof. Deleting a task ON THE PHONE relays the command to the desktop, and the desktop
 * handler opened `window.confirm` — a dialog on a screen the reader wasn't looking at, that they had
 * no way to answer from the phone, so the delete simply never happened. Worse, `window.confirm`
 * BLOCKS the desktop's main thread while it's up, and that thread is what pumps the mirror and the
 * relay: the phone stopped receiving frames and stopped getting answers to everything else it sent.
 * From the phone it looked like the app had frozen, and in every way that mattered it had.
 *
 * Two presses on the same button is the whole mechanism: nothing blocks, nothing renders off-screen,
 * and it behaves identically on the desktop and the phone because it's just the button. The state
 * machine below is `confirmPress`, kept pure so the two mis-tap guards are actually tested.
 */

/** How long the armed state waits for the second press before giving up. */
export const CONFIRM_WINDOW_MS = 5_000;
/**
 * How long after arming a second press is IGNORED.
 *
 * A phone is a small target and a double-tap is a normal accident on one; without this, two fast
 * taps on ✕ Remove would arm and confirm in the same gesture, which is a one-tap delete wearing a
 * confirmation's clothes.
 */
export const CONFIRM_MIN_MS = 350;

export type ConfirmState = { armedAt: number } | undefined;

/** What a press does, given how long the button has been armed. PURE. */
export function confirmPress(state: ConfirmState, now: number): { next: ConfirmState; fire: boolean } {
  if (!state) return { next: { armedAt: now }, fire: false };
  const held = now - state.armedAt;
  if (held < CONFIRM_MIN_MS) return { next: state, fire: false }; // a double-tap, not a decision
  if (held > CONFIRM_WINDOW_MS) return { next: { armedAt: now }, fire: false }; // stale — ask again
  return { next: undefined, fire: true };
}

export function ConfirmButton({
  label,
  confirmLabel,
  title,
  confirmTitle,
  style,
  confirmStyle,
  onConfirm,
}: {
  label: ReactNode;
  /** What the button says once armed — make it a question, so the second press is a real answer. */
  confirmLabel: ReactNode;
  title?: string;
  confirmTitle?: string;
  style?: CSSProperties;
  /** Merged over `style` while armed (default: a red tint). */
  confirmStyle?: CSSProperties;
  onConfirm: () => void;
}): JSX.Element {
  const [state, setState] = useState<ConfirmState>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Disarm on its own, so a stray first press never leaves a live delete button sitting there for
  // the next person who scrolls past it.
  useEffect(() => {
    if (!state) return;
    const t = setTimeout(() => setState(undefined), CONFIRM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [state]);
  const armed = !!state;
  return (
    <button
      style={armed ? { ...style, background: "#5a1f1f", borderColor: "#b45", ...confirmStyle } : style}
      title={armed ? (confirmTitle ?? "Press again to confirm") : title}
      aria-live="polite"
      onClick={() => {
        const { next, fire } = confirmPress(stateRef.current, Date.now());
        setState(next);
        if (fire) onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
