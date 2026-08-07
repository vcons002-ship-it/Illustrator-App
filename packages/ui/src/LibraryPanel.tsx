import { t } from "./design/tokens.js";
import { useState } from "react";
import type { BookSummary, LibraryType } from "@visual-reader/core";
import { ModalShell } from "./ModalShell.js";
import { cx } from "./design/classes.js";

/** Human labels + emoji for each library type tag (the filter chips + per-book badge). */
const TYPE_LABELS: Record<LibraryType, string> = {
  fiction: "📖 Fiction",
  technical: "🔬 Technical",
  code: "💻 Code",
  data: "📊 Data",
  story: "✍️ Story",
};

/**
 * The library: books you've opened, most-recent first. Open one, remove it, or —
 * for series continuity — carry its Visual Bible into the book you currently have
 * open (characters/creatures/locations/glossary come forward; the current book
 * keeps its own storyboard and updates as you read).
 */
export interface LibraryPanelProps {
  books: BookSummary[];
  /** Id of the book currently open, if any. */
  currentId?: string;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  /** Carry the chosen book's bible into the current book. */
  onCarryOver: (fromId: string) => void;
  onClose: () => void;
}

type LibrarySort = "recent" | "title" | "type";

export function LibraryPanel({ books, currentId, onOpen, onRemove, onCarryOver, onClose }: LibraryPanelProps) {
  const [filter, setFilter] = useState<LibraryType | "all">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recent");
  // The type tags actually present, in a stable order, so the chip row only offers real options.
  const typeOrder = Object.keys(TYPE_LABELS) as LibraryType[];
  const presentTypes = typeOrder.filter((t) => books.some((b) => (b.type ?? "fiction") === t));
  const q = search.trim().toLowerCase();
  const shown = books.filter(
    (b) =>
      (filter === "all" || (b.type ?? "fiction") === filter) &&
      (!q || b.title.toLowerCase().includes(q) || (b.author ?? "").toLowerCase().includes(q)),
  );
  // Recent = last-opened first (addedAt is bumped on open); Type groups in the chip row's
  // stable order, most recent first within each group.
  const sorted = [...shown].sort((a, b) =>
    sort === "title"
      ? a.title.localeCompare(b.title)
      : sort === "type"
        ? typeOrder.indexOf(a.type ?? "fiction") - typeOrder.indexOf(b.type ?? "fiction") || b.addedAt - a.addedAt
        : b.addedAt - a.addedAt,
  );
  return (
    <ModalShell title="Library" onClose={onClose} overlayStyle={overlayStyle} cardStyle={panelStyle}>
        <div style={headerStyle}>
          <strong>Library</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {books.length} book{books.length === 1 ? "" : "s"}
          </span>
          <button className={cx.btn} style={buttonStyle} onClick={onClose}>
            Close
          </button>
        </div>
        {books.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <input
              type="search"
              style={searchStyle}
              value={search}
              placeholder="Search title or author…"
              aria-label="Search library by title or author"
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              style={sortStyle}
              value={sort}
              aria-label="Sort library"
              onChange={(e) => setSort(e.target.value as LibrarySort)}
            >
              <option value="recent">Recent</option>
              <option value="title">Title A–Z</option>
              <option value="type">Type</option>
            </select>
          </div>
        )}
        {presentTypes.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <button style={filter === "all" ? chipActive : chipStyle} onClick={() => setFilter("all")}>
              All
            </button>
            {presentTypes.map((t) => (
              <button key={t} style={filter === t ? chipActive : chipStyle} onClick={() => setFilter(t)}>
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        )}
        {books.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No books yet — open an EPUB and it'll appear here.</p>
        ) : sorted.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No books match your search.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sorted.map((b) => {
              const current = b.id === currentId;
              return (
                <div key={b.id} style={current ? { ...rowStyle, ...rowCurrent } : rowStyle}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div title={b.title} style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {b.title}
                      {current && <span style={{ opacity: 0.6, fontWeight: 400 }}> · open now</span>}
                    </div>
                    <div style={{ opacity: 0.6, fontSize: 12 }}>
                      <span style={badgeStyle}>{TYPE_LABELS[b.type ?? "fiction"]}</span>
                      {b.author ? ` ${b.author} · ` : " "}
                      opened {relativeTime(b.addedAt)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {!current && (
                      <button className={cx.btn} style={buttonStyle} onClick={() => onOpen(b.id)}>
                        Open
                      </button>
                    )}
                    {!current && currentId && (
                      <button
                        className={cx.btn} style={buttonStyle}
                        title="Carry this book's characters/world into the book you have open (series continuity)"
                        onClick={() => onCarryOver(b.id)}
                      >
                        Carry bible →
                      </button>
                    )}
                    <button
                      className={cx.btn} style={buttonStyle}
                      title="Remove from library"
                      aria-label={`Remove ${b.title} from library`}
                      onClick={() => {
                        if (window.confirm(`Remove "${b.title}" from your library? Its illustrations and bible are deleted too.`)) onRemove(b.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </ModalShell>
  );
}

/** "just now" / "12m ago" / "3h ago" / "2d ago" from a ms-epoch timestamp. */
function relativeTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
  return `${Math.round(d / 86400000)}d ago`;
}

// Deltas from ModalShell's shared look (this panel predates the shell): a lighter
// un-blurred backdrop, top-aligned with the OVERLAY scrolling, a block-flow card.
const overlayStyle = {
  background: "rgba(0,0,0,0.5)",
  backdropFilter: "none",
  alignItems: "flex-start",
  padding: "8vh 16px",
  zIndex: 50,
  overflowY: "auto",
} as const;

const panelStyle = {
  width: "min(640px, 100%)",
  background: t.surface.card,
  border: `1px solid ${t.border.input}`,
  color: t.text.base,
  display: "block",
  gap: 0,
  maxHeight: "none",
  overflowY: "visible",
  padding: 16,
} as const;

const headerStyle = { display: "flex", alignItems: "center", gap: 12, marginBottom: 10 } as const;

const searchStyle = {
  flex: 1,
  minWidth: 0,
  background: t.fill.subtle,
  border: `1px solid ${t.border.button}`,
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 13,
  fontFamily: "inherit",
} as const;

const sortStyle = { ...searchStyle, flex: "0 0 auto", cursor: "pointer" } as const;

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  border: `1px solid ${t.border.subtle}`,
  borderRadius: 8,
} as const;

const rowCurrent = { borderColor: t.accent.edge, background: t.accent.edge } as const;

const buttonStyle = {
  background: "transparent",
  border: `1px solid ${t.border.button}`,
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 13,
} as const;

const chipStyle = {
  background: t.fill.subtle,
  border: `1px solid ${t.border.button}`,
  color: "inherit",
  borderRadius: 999,
  padding: "3px 10px",
  cursor: "pointer",
  fontSize: 12,
} as const;

const chipActive = { ...chipStyle, background: t.accent.edge, borderColor: t.accent.edge } as const;

const badgeStyle = {
  display: "inline-block",
  marginRight: 6,
  padding: "1px 6px",
  borderRadius: 4,
  background: t.fill.base,
  fontSize: 11,
} as const;
