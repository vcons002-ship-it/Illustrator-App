import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { modalCardStyle, modalOverlayStyle } from "./tokens.js";

/**
 * Module-level stack of the currently-mounted shells (most-recently-mounted last). `aria-modal` claims
 * the background is inert, so for stacked shells only the top-most may respond to a single Escape — and
 * only the top-most traps Tab. Each shell registers a unique token; the handlers act only when their
 * token is on top.
 */
const openShellStack: symbol[] = [];

/** Focusable descendants of the card, in DOM order, that a real Tab press would visit. */
function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const sel =
    'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Pure focus-trap decision: given the card's focusables (DOM order), the currently-focused element, and
 * whether Shift is held, return the element Tab should wrap to — or `null` to let the browser move focus
 * normally (no wrap needed). Exported so the wrap-around logic is unit-testable without a DOM. `active`
 * outside the list (e.g. the card itself, or the page) is treated as "focus is leaving" → wrap to the
 * edge Tab would re-enter from.
 */
export function nextTrapFocus<T>(focusables: readonly T[], active: T | null, shiftKey: boolean): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const inList = active != null && focusables.includes(active);
  if (shiftKey) return !inList || active === first ? last : null;
  return !inList || active === last ? first : null;
}

/**
 * Shared overlay+card wrapper for the centered modals — owns the accessibility
 * contract the hand-rolled overlays lacked: role="dialog"/aria-modal with the
 * dialog named from `title`, Escape to close, focus moved into the card on mount
 * and returned to the opener on unmount, and backdrop-click close. The default
 * look is MemoriesPanel's overlay/card (the shared pattern); panels that predate
 * the shell pass width/style overrides so their rendered look doesn't shift.
 * Internal to packages/ui — imported by relative path, NOT exported from index.ts.
 */
export interface ModalShellProps {
  /** Accessible dialog name (becomes aria-label). */
  title: string;
  /** Omitted (e.g. the first-run wizard): the modal is non-dismissable — Escape and
   * backdrop clicks do nothing; only the panel's own buttons move forward. */
  onClose?: (() => void) | undefined;
  /** Ignore backdrop clicks while true (Escape + explicit buttons still work) — for
   * flows a stray tap must not dismiss, e.g. a real-money order while it places. */
  disableBackdropClose?: boolean | undefined;
  /** Card width/maxWidth overrides (defaults come from the shared card style). */
  width?: CSSProperties["width"] | undefined;
  maxWidth?: CSSProperties["maxWidth"] | undefined;
  /** Per-panel deltas from the default overlay/card look. */
  overlayStyle?: CSSProperties | undefined;
  cardStyle?: CSSProperties | undefined;
  children: ReactNode;
}

export function ModalShell({
  title,
  onClose,
  disableBackdropClose,
  width,
  maxWidth,
  overlayStyle,
  cardStyle,
  children,
}: ModalShellProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Latest onClose read from a ref so the mount effect never re-runs (re-running
  // would re-steal focus from whatever field the user tabbed into).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Stable per-mount token for this shell's slot in the open-shell stack.
  const tokenRef = useRef<symbol | null>(null);
  tokenRef.current ??= Symbol("modal-shell");
  useEffect(() => {
    const token = tokenRef.current!;
    openShellStack.push(token);
    const isTop = (): boolean => openShellStack[openShellStack.length - 1] === token;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Only take focus when nothing inside the card claimed it already (an autoFocus
    // input must win, or the modal would steal its own field's focus).
    if (!cardRef.current?.contains(document.activeElement)) cardRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (!isTop()) return; // stacked: only the top-most shell handles keys
      if (e.key === "Escape") {
        // An inner control (an inline-edit input cancelling just its edit) may have already handled
        // this Escape — respect that and don't also close the whole dialog.
        if (e.defaultPrevented) return;
        onCloseRef.current?.();
        return;
      }
      if (e.key === "Tab") {
        // Real focus trap: `aria-modal` says the background is inert, so Tab/Shift+Tab must wrap within
        // the card (the non-dismissable wizard especially must never let focus escape to the page).
        const focusables = focusablesIn(cardRef.current);
        if (focusables.length === 0) {
          e.preventDefault();
          cardRef.current?.focus();
          return;
        }
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const target = nextTrapFocus(focusables, active, e.shiftKey);
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = openShellStack.indexOf(token);
      if (i >= 0) openShellStack.splice(i, 1);
      opener?.focus();
    };
  }, []);
  return (
    <div
      style={{ ...modalOverlayStyle, ...overlayStyle }}
      onClick={disableBackdropClose || !onClose ? undefined : onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{
          ...modalCardStyle,
          outline: "none",
          ...(width !== undefined ? { width } : {}),
          ...(maxWidth !== undefined ? { maxWidth } : {}),
          ...cardStyle,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
