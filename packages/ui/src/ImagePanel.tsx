import { useEffect, useState } from "react";
import type { ImageResult } from "@visual-reader/core";
import { BloomTransition } from "./BloomTransition.js";

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
  result: ImageResult | undefined;
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
   * Short sentence shown over the image (character names + the chapter's key
   * action). Fades in with the bloom so it never reveals before the picture.
   */
  caption?: string | undefined;
}

export function ImagePanel({ result, bloom, pageKey, awaitingStart, caption }: ImagePanelProps) {
  const imageUrl = useObjectUrl(result);

  // Front/back matter (title page, copyright, contents…) is never illustrated.
  if (result?.status === "skipped") {
    return <Placeholder label="No illustration — front/end matter" />;
  }

  if (!result || result.status === "queued" || result.status === "rendering" || !imageUrl) {
    if (result?.status === "error") {
      return <Placeholder label={`couldn't render: ${result.error ?? "unknown error"}`} />;
    }
    // Nothing cached and generation not begun → call to action, not a fake spinner.
    if (awaitingStart && (!result || result.status === "queued")) {
      return <Placeholder label={'Press “Begin generating book” to illustrate this page'} />;
    }
    const pct = result?.progress;
    const label =
      typeof pct === "number" && pct > 0 && pct < 1
        ? `painting this page… ${Math.round(pct * 100)}%`
        : "painting this page…";
    return <Placeholder label={label} pulse />;
  }
  return (
    <div style={{ position: "relative" }}>
      <BloomTransition key={pageKey} target={bloom}>
        <img
          src={imageUrl}
          alt="Illustration of the current passage"
          style={{
            display: "block",
            width: "100%",
            height: "auto",
            maxHeight: "calc(100vh - 120px)",
            objectFit: "contain",
            margin: "0 auto",
            borderRadius: 8,
          }}
        />
      </BloomTransition>
      {caption && (
        <div style={{ ...captionOverlayStyle, opacity: Math.max(0, Math.min(1, bloom)) }}>
          {caption}
        </div>
      )}
    </div>
  );
}

const captionOverlayStyle = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  padding: "20px 12px 10px",
  borderRadius: "0 0 8px 8px",
  fontSize: 13,
  lineHeight: 1.35,
  color: "#fff",
  textShadow: "0 1px 3px rgba(0,0,0,0.8)",
  background: "linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))",
  pointerEvents: "none",
} as const;

/** Turn the result's image bytes into an object URL, revoking it on change. */
function useObjectUrl(result: ImageResult | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const image = result?.image;
  useEffect(() => {
    if (!image) {
      setUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(new Blob([image.bytes], { type: image.mimeType }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image]);
  return url;
}

function Placeholder({ label, pulse }: { label: string; pulse?: boolean }) {
  return (
    <div
      style={{
        aspectRatio: "1 / 1",
        width: "100%",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 16,
        color: "rgba(255,255,255,0.7)",
        background:
          "linear-gradient(135deg, rgba(80,80,110,0.5), rgba(40,40,60,0.5))",
        animation: pulse ? "vr-pulse 1.6s ease-in-out infinite" : undefined,
      }}
    >
      {label}
    </div>
  );
}
