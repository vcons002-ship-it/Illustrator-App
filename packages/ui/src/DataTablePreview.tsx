import { memo } from "react";
import type { CellValue, DataTable } from "@visual-reader/core";

/**
 * A spreadsheet/CSV table shown AS a table — the structured `DataTable` we already
 * parse (BookSource.data), rendered with aligned columns instead of the flattened
 * "a | b | c" pipe-text the reader would otherwise show. Self-contained dark card so
 * it reads correctly on any surface (the reader column, a chat bubble, a modal):
 *
 * - bounded BOTH ways — horizontal scroll for wide sheets, a capped height with
 *   vertical scroll for tall ones, so a 5,000-row upload never pushes the page miles
 *   down. The header stays put (sticky) while the body scrolls.
 * - numeric columns right-aligned and locale-formatted; long text cells clip with an
 *   ellipsis and keep the full value on hover (`title`), so one verbose column can't
 *   blow the layout out.
 */
export interface DataTablePreviewProps {
  table: DataTable;
  /** Cap rendered rows (default 100); a footer notes how many more exist. */
  maxRows?: number;
  /** Cap the scroll area's height in px (default 360). */
  maxHeight?: number;
  /** Optional caption above the table, e.g. "Spreadsheet — 1,240 rows × 8 columns". */
  caption?: string;
}

export const DataTablePreview = memo(function DataTablePreview({
  table,
  maxRows = 100,
  maxHeight = 360,
  caption,
}: DataTablePreviewProps) {
  const rows = table.rows.slice(0, Math.max(0, maxRows));
  const hidden = table.rows.length - rows.length;
  return (
    <figure style={{ margin: 0 }}>
      {caption ? <figcaption style={captionStyle}>{caption}</figcaption> : null}
      <div style={{ ...scrollStyle, maxHeight }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              {table.columns.map((c, i) => (
                <th key={i} style={{ ...thStyle, textAlign: c.type === "number" ? "right" : "left" }}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((v, ci) => {
                  const text = formatCell(v);
                  return (
                    <td
                      key={ci}
                      title={text}
                      style={{ ...tdStyle, textAlign: table.columns[ci]?.type === "number" ? "right" : "left" }}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 ? (
        <div style={moreStyle}>…{hidden.toLocaleString("en-US")} more row{hidden === 1 ? "" : "s"}</div>
      ) : null}
    </figure>
  );
});

function formatCell(v: CellValue): string {
  if (v === null) return "";
  return typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : v;
}

const scrollStyle = {
  overflow: "auto",
  background: "#13161e",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
} as const;

const tableStyle = { borderCollapse: "collapse", fontSize: 12, width: "100%" } as const;

const thStyle = {
  position: "sticky",
  top: 0,
  background: "#1b1f2a",
  padding: "4px 8px",
  borderBottom: "1px solid rgba(255,255,255,0.25)",
  fontWeight: 600,
  whiteSpace: "nowrap",
  zIndex: 1,
} as const;

const tdStyle = {
  padding: "3px 8px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  whiteSpace: "nowrap",
  maxWidth: 260,
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

const captionStyle = { fontSize: 11, opacity: 0.6, margin: "0 0 4px" } as const;

const moreStyle = { fontSize: 10, opacity: 0.5, marginTop: 4 } as const;
