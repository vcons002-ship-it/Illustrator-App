import { memo } from "react";
import { DataChart } from "./DataChart.js";
import type { ChapterDataset } from "@visual-reader/core";

/**
 * The reader-aside "Data" block for the current chapter's extracted datasets.
 * Renders NOTHING when the chapter has no clean numeric series — which is most
 * chapters, so absence is the designed steady state, not an error.
 */
export interface DataSectionProps {
  datasets: ChapterDataset[];
  /** Where this data comes from (e.g. the chapter title) — grounds the block
   * visually instead of charts floating unexplained under the image. */
  sourceLabel?: string;
  /** Expanded on mount (technical books lead with their data). */
  defaultOpen?: boolean;
}

// Memoised: it renders inside the reader aside (re-rendered per reading-progress
// tick) while `datasets` only changes per chapter — props are stable in between.
export const DataSection = memo(function DataSection({ datasets, sourceLabel, defaultOpen }: DataSectionProps) {
  if (datasets.length === 0) return null;
  return (
    <details
      {...(defaultOpen ? { open: true } : {})}
      style={{
        marginTop: 10,
        background: "rgba(90,209,155,0.06)",
        border: "1px solid rgba(90,209,155,0.35)",
        borderLeft: "3px solid rgba(90,209,155,0.8)",
        borderRadius: 8,
        padding: "6px 10px",
      }}
    >
      <summary style={{ cursor: "pointer", fontSize: 12 }}>
        <strong>📊 Data ({datasets.length})</strong>
        <span style={{ opacity: 0.7 }}>
          {" "}
          — real values{sourceLabel ? ` from ${sourceLabel}` : " from this chapter"}, charted by
          the app (never AI-imagined numbers)
        </span>
      </summary>
      {datasets.map((d) => (
        <DataChart key={d.id} dataset={d} />
      ))}
    </details>
  );
});
