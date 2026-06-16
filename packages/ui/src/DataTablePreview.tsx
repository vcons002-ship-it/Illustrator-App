import { memo, useMemo, useState } from "react";
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
  /** When set, cells become editable: click one, type, and commit (Enter/blur) to
   * fire this with the raw text. The host coerces + persists (see setTableCell). */
  onEditCell?: (rowIndex: number, colIndex: number, raw: string) => void;
  /** Structure edits (shown only when provided): add/remove rows + columns, rename a
   * column. The host applies them to the DataTable and persists. */
  onAddRow?: () => void;
  onDeleteRow?: (rowIndex: number) => void;
  onAddColumn?: () => void;
  onDeleteColumn?: (colIndex: number) => void;
  onRenameColumn?: (colIndex: number, name: string) => void;
}

export const DataTablePreview = memo(function DataTablePreview({
  table,
  maxRows = 100,
  maxHeight = 360,
  caption,
  onEditCell,
  onAddRow,
  onDeleteRow,
  onAddColumn,
  onDeleteColumn,
  onRenameColumn,
}: DataTablePreviewProps) {
  // Which cell is being edited + its in-progress draft (uncontrolled would lose focus).
  const [editing, setEditing] = useState<{ r: number; c: number; draft: string } | null>(null);
  // A header rename in progress (separate from cell edits; column index -1 = none).
  const [headerEdit, setHeaderEdit] = useState<{ c: number; draft: string } | null>(null);
  // Display-only sort + filter: reorder/hide WHICH rows are shown without touching the
  // underlying table, so formulas + data stay intact; edits map back to the real index.
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [filter, setFilter] = useState("");
  const viewIndexes = useMemo(() => {
    let idx = table.rows.map((_, i) => i);
    const q = filter.trim().toLowerCase();
    if (q) idx = idx.filter((i) => table.rows[i]!.some((v) => v !== null && String(v).toLowerCase().includes(q)));
    if (sort) {
      const { col, dir } = sort;
      const numeric = table.columns[col]?.type === "number";
      idx = idx.slice().sort((a, b) => {
        const va = table.rows[a]![col];
        const vb = table.rows[b]![col];
        const cmp = numeric
          ? (typeof va === "number" ? va : Number(va) || 0) - (typeof vb === "number" ? vb : Number(vb) || 0)
          : String(va ?? "").localeCompare(String(vb ?? ""));
        return dir === "asc" ? cmp : -cmp;
      });
    }
    return idx;
  }, [table, filter, sort]);
  const shown = viewIndexes.slice(0, Math.max(0, maxRows));
  const hidden = viewIndexes.length - shown.length;
  const cycleSort = (col: number) =>
    setSort((s) => (s?.col !== col ? { col, dir: "asc" } : s.dir === "asc" ? { col, dir: "desc" } : null));
  const commit = () => {
    if (editing) onEditCell?.(editing.r, editing.c, editing.draft);
    setEditing(null);
  };
  const commitHeader = () => {
    if (headerEdit) onRenameColumn?.(headerEdit.c, headerEdit.draft);
    setHeaderEdit(null);
  };
  const showRowControls = !!onDeleteRow;
  return (
    <figure style={{ margin: 0 }}>
      {caption ? <figcaption style={captionStyle}>{caption}</figcaption> : null}
      {table.rows.length > 4 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter rows…"
            style={filterInputStyle}
          />
          {filter || sort ? (
            <button
              onClick={() => {
                setFilter("");
                setSort(null);
              }}
              style={delBtnStyle}
              title="Clear sort + filter"
            >
              clear
            </button>
          ) : null}
          {filter ? <span style={{ fontSize: 11, opacity: 0.6 }}>{viewIndexes.length} match{viewIndexes.length === 1 ? "" : "es"}</span> : null}
        </div>
      ) : null}
      <div style={{ ...scrollStyle, maxHeight }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              {showRowControls ? <th style={{ ...thStyle, width: 22, padding: "4px 2px" }} aria-label="row controls" /> : null}
              {table.columns.map((c, i) => {
                const isHeaderEditing = headerEdit?.c === i;
                return (
                  <th key={i} style={{ ...thStyle, textAlign: c.type === "number" ? "right" : "left" }}>
                    {isHeaderEditing ? (
                      <input
                        autoFocus
                        value={headerEdit.draft}
                        onChange={(e) => setHeaderEdit({ c: i, draft: e.target.value })}
                        onBlur={commitHeader}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitHeader();
                          else if (e.key === "Escape") setHeaderEdit(null);
                        }}
                        style={{ ...cellInputStyle, textAlign: "left" }}
                      />
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span
                          onClick={onRenameColumn ? () => setHeaderEdit({ c: i, draft: c.name }) : undefined}
                          style={onRenameColumn ? { cursor: "text" } : undefined}
                          title={onRenameColumn ? "Click to rename column" : c.name}
                        >
                          {c.name}
                        </span>
                        <button
                          onClick={() => cycleSort(i)}
                          title={`Sort by "${c.name}"`}
                          style={{ ...sortBtnStyle, opacity: sort?.col === i ? 1 : 0.45 }}
                        >
                          {sort?.col === i ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}
                        </button>
                        {onDeleteColumn && table.columns.length > 1 ? (
                          <button onClick={() => onDeleteColumn(i)} title={`Delete column "${c.name}"`} style={delBtnStyle}>
                            ✕
                          </button>
                        ) : null}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((ri: number) => {
              const r = table.rows[ri]!;
              return (
              <tr key={ri}>
                {showRowControls ? (
                  <td style={{ ...tdStyle, width: 22, padding: "2px", textAlign: "center" }}>
                    <button onClick={() => onDeleteRow?.(ri)} title="Delete this row" style={delBtnStyle}>
                      ✕
                    </button>
                  </td>
                ) : null}
                {r.map((v, ci) => {
                  const formula = table.formulas?.[`${ri},${ci}`];
                  const text = formula && v === null ? "ƒ" : formatCell(v);
                  const isEditing = editing?.r === ri && editing?.c === ci;
                  const align = table.columns[ci]?.type === "number" ? "right" : "left";
                  if (isEditing) {
                    return (
                      <td key={ci} style={{ ...tdStyle, padding: 0, textAlign: align }}>
                        <input
                          autoFocus
                          value={editing.draft}
                          onChange={(e) => setEditing({ r: ri, c: ci, draft: e.target.value })}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commit();
                            else if (e.key === "Escape") setEditing(null);
                          }}
                          style={{ ...cellInputStyle, textAlign: align }}
                        />
                      </td>
                    );
                  }
                  const titleText = formula ? `=${formula}${v !== null ? ` → ${formatCell(v)}` : ""}` : onEditCell ? "Click to edit" : text;
                  return (
                    <td
                      key={ci}
                      title={titleText}
                      onClick={onEditCell ? () => setEditing({ r: ri, c: ci, draft: formula ? `=${formula}` : v === null ? "" : String(v) }) : undefined}
                      style={{
                        ...tdStyle,
                        textAlign: align,
                        ...(onEditCell ? { cursor: "cell" } : {}),
                        ...(formula ? { color: "#9fd2ff" } : {}),
                      }}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hidden > 0 ? (
        <div style={moreStyle}>…{hidden.toLocaleString("en-US")} more row{hidden === 1 ? "" : "s"}</div>
      ) : null}
      {onAddRow || onAddColumn ? (
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          {onAddRow ? (
            <button onClick={onAddRow} style={addBtnStyle} title="Add a blank row at the end">
              + Row
            </button>
          ) : null}
          {onAddColumn ? (
            <button onClick={onAddColumn} style={addBtnStyle} title="Add a new column">
              + Column
            </button>
          ) : null}
        </div>
      ) : null}
    </figure>
  );
});

const delBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "rgba(255,140,140,0.85)",
  border: "none",
  cursor: "pointer",
  fontSize: 10,
  padding: "0 2px",
  lineHeight: 1,
};

const addBtnStyle: React.CSSProperties = {
  background: "rgba(90,209,155,0.12)",
  color: "inherit",
  border: "1px solid rgba(90,209,155,0.5)",
  borderRadius: 6,
  padding: "2px 9px",
  fontSize: 11,
  cursor: "pointer",
};

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

const cellInputStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: "#0d1017",
  color: "#fff",
  border: "1px solid rgba(122,162,255,0.8)",
  borderRadius: 3,
  padding: "2px 7px",
  fontSize: 12,
  fontFamily: "inherit",
  outline: "none",
} as const;

const sortBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "inherit",
  border: "none",
  cursor: "pointer",
  fontSize: 9,
  padding: "0 1px",
  lineHeight: 1,
};
const filterInputStyle: React.CSSProperties = {
  background: "#0d1017",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 12,
  width: 180,
  fontFamily: "inherit",
};

const captionStyle = { fontSize: 11, opacity: 0.6, margin: "0 0 4px" } as const;

const moreStyle = { fontSize: 10, opacity: 0.5, marginTop: 4 } as const;
