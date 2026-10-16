import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "./design/classes.js";
import { smallButtonStyle } from "./design/recipes.js";
import { t } from "./design/tokens.js";

const openDrawers: symbol[] = [];

/** A non-modal drawer: chat stays usable, and existing portalled menus/dialogs keep their focus. */
export function CollapsibleSidebar({ open, title, side = "left", onClose, children }: {
  open: boolean;
  title: string;
  side?: "left" | "right";
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const token = useRef(Symbol("sidebar"));
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const key = token.current;
    openDrawers.push(key);
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Menus and full dialogs own their own Escape before the underlying drawer does.
      if (event.key !== "Escape" || event.defaultPrevented ||
          openDrawers[openDrawers.length - 1] !== key ||
          document.querySelector('[role="dialog"], [role="menu"], .vr-modal-card')) return;
      event.preventDefault();
      close.current();
      opener.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const index = openDrawers.indexOf(key);
      if (index >= 0) openDrawers.splice(index, 1);
    };
  }, [open]);
  if (typeof document === "undefined") return null;
  // Keep forms mounted while collapsed: switching drawers must not discard a project edit or
  // unmount Settings while one of its own dialogs is open. `hidden` removes closed controls from Tab.
  return createPortal(
    <aside ref={panel} hidden={!open} tabIndex={-1} aria-label={title}
      className={`${cx.app} vr-sidebar`} data-side={side}>
      <div className="vr-sidebar-heading">
        <strong>{title}</strong>
        <button type="button" className={cx.btn} style={{ ...smallButtonStyle, minHeight: 44 }}
          aria-label={`Close ${title}`} onClick={() => {
            close.current();
            opener.current?.focus();
          }}>✕ Close</button>
      </div>
      <div className="vr-sidebar-content" style={{ color: t.text.base }}>{children}</div>
    </aside>, document.body,
  );
}
