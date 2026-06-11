import { DataChart } from "./DataChart.js";
import type { ChapterDataset } from "@visual-reader/core";

/**
 * The reader-aside "Data" block for the current chapter's extracted datasets.
 * Renders NOTHING when the chapter has no clean numeric series — which is most
 * chapters, so absence is the designed steady state, not an error.
 */
export interface DataSectionProps {
  datasets: ChapterDataset[];
}

export function DataSection({ datasets }: DataSectionProps) {
  if (datasets.length === 0) return null;
  return (
    <details
      style={{
        marginTop: 10,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 8,
        padding: "6px 10px",
      }}
    >
      <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.85 }}>
        Data ({datasets.length}) — charts computed from this chapter’s real values
      </summary>
      {datasets.map((d) => (
        <DataChart key={d.id} dataset={d} />
      ))}
    </details>
  );
}
