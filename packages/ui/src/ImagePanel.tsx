import { t } from "./design/tokens.js";
import { useEffect, useState } from "react";
import { BloomTransition } from "./BloomTransition.js";
import { useObjectUrl, type DisplayResult } from "./imageObjectUrl.js";
import { placeholderLabel } from "./imageStatus.js";
import { cx } from "./design/classes.js";
import { ArrivingImage } from "./ArrivingImage.js";

/**
 * The reading-companion image panel. The image "blooms" in as the reader
 * progresses through the page (driven by the `bloom` target, 0..1). Reveal timing
 * — including holding spoilers until the reader reaches them — is computed by the
 * caller via the core `reveal` helpers and passed in as `bloom`, so this stays a
 * pure presentation component.
 *
 * `pageKey` remounts the bloom on page change so a freshly-shown page always starts
 * blurred (a fast scroll to an unread page can never flash its image).
 */
export interface ImagePanelProps {
  result: DisplayResult | undefined;
  /** Bloom target 0..1, driven by reading progress through the current page. */
  bloom: number;
  /** Changes per page so the bloom resets (starts hidden) on navigation. */
  pageKey?: string | number;
  /**
   * Generation hasn't been started for this book yet. When there's no cached
   * image to show, prompt the reader to begin instead of implying work is
   * underway with "painting…".
   */
  awaitingStart?: boolean;
  /**
   * Size the picture to the BOX it's given instead of to the window.
   *
   * The default cap is `100dvh - 120px`, which assumes the image has the window to itself minus a
   * header. In the story view it doesn't: the chat docks beneath the reader, and taller still when
   * its history is open — so the picture alone could exceed the pane holding it, pushing the prompt
   * underneath out of reach. With `fit`, the image fills its container and no more, which is what
   * "the whole picture, as large as it goes" actually means. The container must have a definite
   * height (a flex column with a max-height) for it to resolve against.
   */
  fit?: boolean;
}

export function ImagePanel({ result, bloom, pageKey, awaitingStart, fit }: ImagePanelProps) {
  const imageUrl = useObjectUrl(result);
  // A retrieved figure may be hotlink-only (no downloadable bytes): display it
  // straight from its source URL — an <img src> renders inline regardless of CORS.
  const displaySrc = imageUrl ?? result?.sourceUrl;
  // Click-to-reveal: the reader can force the current image fully visible,
  // overriding the progress-driven bloom. Resets on navigation so the next page
  // starts blurred again.
  const [manualReveal, setManualReveal] = useState(false);
  useEffect(() => setManualReveal(false), [pageKey]);
  const effectiveBloom = manualReveal ? 1 : bloom;

  if (!result || result.status !== "ready" || !displaySrc) {
    const ph = placeholderLabel(result, awaitingStart);
    return <Placeholder label={ph.label} pulse={ph.pulse} />;
  }
  return (
    <div
      style={
        fit
          ? { position: "relative", cursor: "pointer", flex: "1 1 auto", minHeight: 0, display: "flex" }
          : { position: "relative", cursor: "pointer" }
      }
      onClick={() => setManualReveal((r) => !r)}
      title={manualReveal ? "Click to follow your reading again" : "Click to reveal the full image"}
    >
      <BloomTransition key={pageKey} target={effectiveBloom} {...(fit ? { fill: true } : {})}>
        {/* The SAME component the chat's generated pictures use, so the two can never drift apart.
            BloomTransition wraps this and animates its own element, so the two compose rather than
            fight over one property. */}
        <ArrivingImage
          src={displaySrc}
          alt="Illustration of the current passage"
          style={{
            display: "block",
            width: "100%",
            // `height: 100%` + contain is what makes it shrink INTO the pane rather than overflow it.
            height: fit ? "100%" : "auto",
            maxHeight: fit ? "100%" : "calc(100dvh - 120px)",
            objectFit: "contain",
            margin: "0 auto",
            borderRadius: 8,
          }}
        />
      </BloomTransition>
    </div>
  );
}

function Placeholder({ label, pulse }: { label: string; pulse?: boolean }) {
  return (
    <div
      className={pulse ? cx.breathing : undefined}
      style={{
        aspectRatio: "1 / 1",
        width: "100%",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 16,
        color: t.fill.strong,
        background:
          "linear-gradient(135deg, rgba(80,80,110,0.5), rgba(40,40,60,0.5))",
      }}
    >
      {label}
    </div>
  );
}
