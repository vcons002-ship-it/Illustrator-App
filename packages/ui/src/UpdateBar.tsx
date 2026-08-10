import { cx } from "./design/classes.js";
import { t } from "./design/tokens.js";

/**
 * "A NEWER VERSION IS READY" — the one notice that must not auto-dismiss.
 *
 * Not a toast: a toast is for something that has happened and needs acknowledging, and it goes away
 * on its own. This is a standing offer, and on a phone the reader may not be looking when it first
 * appears. It stays until it is taken.
 *
 * A TAP, NEVER AN AUTOMATIC RELOAD. Reloading takes the page down with whatever is on it — a
 * half-typed message, a chat scrolled to the place being read. Deciding for the reader that a build
 * they did not ask about is worth losing that is not a trade the app gets to make on its own.
 */
export function UpdateBar({ onReload }: { onReload: () => void }) {
  return (
    <div style={barStyle} role="status" aria-live="polite">
      <span style={{ flex: 1, minWidth: 0 }}>A newer version of the app is ready.</span>
      <button className={cx.btn} style={buttonStyle} onClick={onReload}>
        Reload
      </button>
    </div>
  );
}

const barStyle = {
  position: "fixed",
  // Below a notch, and horizontally centred rather than pinned to a corner: this is worth reading,
  // and on a phone a corner is where the thumb rests.
  top: "calc(10px + env(safe-area-inset-top, 0px))",
  left: "50%",
  transform: "translateX(-50%)",
  width: "min(420px, calc(100vw - 24px))",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "9px 10px 9px 14px",
  borderRadius: 999,
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
  color: t.text.base,
  background: t.surface.raised,
  border: `1px solid ${t.accent.edge}`,
  boxShadow: t.elev[3],
  // Above a modal overlay (100) and OrderReviewModal (120), below the toast stack (130) so a real
  // error still wins, and far below the privacy curtain, which must cover everything.
  zIndex: 125,
} as const;

const buttonStyle = { padding: "5px 12px", fontSize: 12.5, flexShrink: 0 } as const;
