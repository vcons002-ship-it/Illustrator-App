import type { ImageResult, SpoilerEntity } from "@visual-reader/core";
import { BloomTransition } from "./BloomTransition.js";
import { SpoilerGate } from "./SpoilerGate.js";

/**
 * The reading-companion image panel. Composes the bloom reveal and the spoiler
 * gate over the current page's render, and shows status while the JIT buffer is
 * still working so the reader sees progress rather than a blank box.
 */
export interface ImagePanelProps {
  result: ImageResult | undefined;
  /** Spoiler ids depicted in this image (from the page's VisualRequest). */
  imageSpoilerIds: string[];
  spoilers: SpoilerEntity[];
  passedParagraphIds: ReadonlySet<string>;
  /** Bloom target 0..1, driven by reading proximity. */
  bloom: number;
}

export function ImagePanel({
  result,
  imageSpoilerIds,
  spoilers,
  passedParagraphIds,
  bloom,
}: ImagePanelProps) {
  if (!result || result.status === "queued" || result.status === "rendering") {
    return <Placeholder label="painting this page…" pulse />;
  }
  if (result.status === "error") {
    return <Placeholder label={`couldn't render: ${result.error ?? "unknown error"}`} />;
  }
  return (
    <BloomTransition target={bloom}>
      <SpoilerGate
        imageSpoilerIds={imageSpoilerIds}
        spoilers={spoilers}
        passedParagraphIds={passedParagraphIds}
      >
        <img
          src={result.imageUrl}
          alt="Illustration of the current passage"
          style={{ display: "block", width: "100%", height: "auto", borderRadius: 8 }}
        />
      </SpoilerGate>
    </BloomTransition>
  );
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
