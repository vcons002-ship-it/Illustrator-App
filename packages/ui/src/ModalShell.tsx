import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { modalCardStyle, modalOverlayStyle } from "./tokens.js";

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
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Only take focus when nothing inside the card claimed it already (an autoFocus
    // input must win, or the modal would steal its own field's focus).
    if (!cardRef.current?.contains(document.activeElement)) cardRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCloseRef.current?.();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
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
