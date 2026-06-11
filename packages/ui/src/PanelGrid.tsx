import type { ImageResult } from "@visual-reader/core";
import { BloomTransition } from "./BloomTransition.js";
import { useObjectUrl } from "./imageObjectUrl.js";

/**
 * Multi-panel "comic page" view. Composes several consecutive render-unit images into a
 * grid — each panel is still its own independently-rendered image (so characters stay
 * consistent and it works with every model). Chapter-aware grouping is done by the caller
 * (`panelGroup` in core); this component just lays the group out and drives the reveal:
 *
 *  - panels already read → shown fully,
 *  - the current panel → blooms in with reading progress (and gets a highlight ring),
 *  - panels not yet reached → a faint placeholder, so the page fills in as you read
 *    without spoiling what's ahead.
 *
 * `direction` is "rtl" for manga (panel 1 sits top-right) and "ltr" for comics/default.
 */
export interface PanelGridProps {
  /** The group's units in reading order: ascending unit index + its cached result. */
  panels: { unitIndex: number; result: ImageResult | undefined }[];
  /** The unit the reader is currently on (gets the live bloom + highlight). */
  currentUnit: number;
  /** Bloom target 0..1 for the current panel, from reading progress. */
  bloom: number;
  /** Reading direction of the grid. */
  direction: "ltr" | "rtl";
  /** Changes per unit so the current panel's bloom resets on navigation. */
  pageKey?: string | number;
}

export function PanelGrid({ panels, currentUnit, bloom, direction, pageKey }: PanelGridProps) {
  // 4 → 2 columns (2×2); 6 → 3 columns (3×2); 9 → 3 columns (3×3).
  const columns = panels.length <= 4 ? 2 : 3;
  return (
    <div
      style={{
        direction,
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: 6,
        maxHeight: "calc(100vh - 120px)",
      }}
    >
      {panels.map((p) => {
        const state =
          p.unitIndex === currentUnit ? "current" : p.unitIndex < currentUnit ? "read" : "unread";
        return (
          <Panel
            key={p.unitIndex}
            result={p.result}
            // Read panels are fully shown; the current one blooms with progress; unread
            // panels stay hidden (placeholder) until the reader reaches them.
            target={state === "read" ? 1 : state === "current" ? bloom : 0}
            highlight={state === "current"}
            showImage={state !== "unread"}
            bloomKey={state === "current" ? pageKey : p.unitIndex}
          />
        );
      })}
    </div>
  );
}

function Panel({
  result,
  target,
  highlight,
  showImage,
  bloomKey,
}: {
  result: ImageResult | undefined;
  target: number;
  highlight: boolean;
  showImage: boolean;
  bloomKey: string | number | undefined;
}) {
  const imageUrl = useObjectUrl(result);
  const ready = showImage && result?.status === "ready" && imageUrl;
  return (
    <div
      style={{
        // `direction` is inherited from the grid for layout order; the panel's own
        // content reads normally.
        direction: "ltr",
        position: "relative",
        aspectRatio: "1 / 1",
        borderRadius: 6,
        overflow: "hidden",
        background: "linear-gradient(135deg, rgba(80,80,110,0.35), rgba(40,40,60,0.35))",
        outline: highlight ? "2px solid rgba(140,170,255,0.9)" : "1px solid rgba(255,255,255,0.06)",
        outlineOffset: highlight ? -2 : 0,
      }}
    >
      {ready ? (
        <BloomTransition key={bloomKey} target={target}>
          <img
            src={imageUrl}
            alt="Comic panel"
            style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
          />
        </BloomTransition>
      ) : null}
    </div>
  );
}
