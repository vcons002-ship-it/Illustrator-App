import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placePopover, type PopoverPlacement } from "./popover-position.js";
import { cx } from "./design/classes.js";

/**
 * A button with a dropdown panel that is guaranteed to be on screen.
 *
 * These menus used to be a native `<details>` with an absolutely-positioned panel, which put part of
 * the panel off the side in portrait and off the bottom in landscape — see `popover-position.ts` for
 * exactly how. The panel is now portalled to `document.body` and positioned by measurement, which is
 * also why it can't stay inside `<details>`: the panel has to leave the header subtree (whose
 * `backdrop-filter` would otherwise capture `position: fixed`), so its visibility has to be state.
 *
 * `children` is a render prop taking `close` — the menu deliberately does NOT close itself when
 * something inside is clicked, because some items ask for confirmation first and should stay open if
 * that's cancelled.
 */
export function AnchoredMenu({
  label,
  title,
  buttonStyle,
  panelStyle,
  width,
  children,
}: {
  label: ReactNode;
  title?: string | undefined;
  buttonStyle?: CSSProperties | undefined;
  /** Styling for the panel; position/size come from the measurement and can't be overridden. */
  panelStyle?: CSSProperties | undefined;
  width?: number | undefined;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<PopoverPlacement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  const measure = useCallback(() => {
    const el = buttonRef.current;
    if (!el || typeof window === "undefined") return;
    const r = el.getBoundingClientRect();
    setPlace(
      placePopover(
        { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        { width: window.innerWidth, height: window.innerHeight },
        width === undefined ? {} : { width },
      ),
    );
  }, [width]);

  // Measured BEFORE paint, so the panel never appears at a stale position for a frame.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Rotating the phone is the whole point of this; a resize (or the header re-wrapping under it)
    // moves the button, and scrolling the page moves it out from under the panel entirely.
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, measure]);

  const positioned: CSSProperties = place
    ? {
        position: "fixed",
        left: place.left,
        width: place.width,
        maxHeight: place.maxHeight,
        ...(place.top === undefined ? {} : { top: place.top }),
        ...(place.bottom === undefined ? {} : { bottom: place.bottom }),
        overflowY: "auto",
        overscrollBehavior: "contain",
        // Above the header (10) but below the full panels and modals (50+), which is where the old
        // in-header dropdown sat.
        zIndex: 41,
      }
    : {};

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cx.btn} style={buttonStyle}
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open &&
        place &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {/* Catches the tap that dismisses the menu — on touch there's no "click outside" without
                something to click on. */}
            <div
              style={{ position: "fixed", inset: 0, zIndex: 40 }}
              onClick={close}
              aria-hidden="true"
            />
            {/* Items cascade in rather than appearing all at once. The delay is computed in CSS from
                --vr-i and capped past the twelfth child, so a long menu never staggers for a second. */}
            <div role="menu" className={`${cx.settle} ${cx.stagger}`} style={{ ...panelStyle, ...positioned }}>
              {children(close)}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
