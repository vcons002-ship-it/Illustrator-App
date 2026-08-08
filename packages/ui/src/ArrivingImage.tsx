import type { CSSProperties } from "react";
import { cx } from "./design/classes.js";

/**
 * A GENERATED PICTURE, ARRIVING.
 *
 * The image blooms in — out of focus and slightly oversized, resolving into place — with a band of
 * light crossing it once as it lands. Every picture the app makes should arrive the same way,
 * whether it was painted for a book or asked for in the chat, which is the whole reason this is a
 * component and not a class applied twice.
 *
 * KEYED ON THE SOURCE. A CSS animation runs on mount and never again, so without a key a second
 * picture rendered into the same element would simply appear. Changing the key remounts it and the
 * arrival replays. The browser has the new bytes cached by then, so this costs a paint, not a
 * fetch.
 *
 * The sheen is a sibling rather than a pseudo-element on the image: `img::after` does not exist —
 * replaced elements have no generated content — which is exactly the kind of rule that looks
 * correct in a stylesheet and silently does nothing.
 */
export function ArrivingImage({
  src,
  alt,
  style,
  wrapStyle,
  onClick,
  title,
}: {
  src: string;
  alt: string;
  /** Applied to the <img>. The caller owns sizing; this component owns the arrival. */
  style?: CSSProperties;
  /** Applied to the positioned wrapper — usually just the margin the image used to carry. */
  wrapStyle?: CSSProperties;
  onClick?: (() => void) | undefined;
  title?: string | undefined;
}) {
  return (
    <span className={cx.arriveWrap} style={wrapStyle} {...(onClick ? { onClick, title } : {})}>
      <img key={src} className={cx.arrive} src={src} alt={alt} decoding="async" style={style} />
      {/* Its own key too: the band must cross the NEW picture, not sit finished over it. */}
      <span key={`${src}-sheen`} className={cx.arriveSheen} aria-hidden="true" />
    </span>
  );
}
