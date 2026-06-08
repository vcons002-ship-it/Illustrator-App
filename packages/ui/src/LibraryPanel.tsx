import type { BookSummary } from "@visual-reader/core";

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

export function LibraryPanel({ books, currentId, onOpen, onRemove, onCarryOver, onClose }: LibraryPanelProps) {
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <strong>Library</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {books.length} book{books.length === 1 ? "" : "s"}
          </span>
          <button style={buttonStyle} onClick={onClose}>
            Close
          </button>
        </div>
        {books.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No books yet — open an EPUB and it'll appear here.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {books.map((b) => {
              const current = b.id === currentId;
              return (
                <div key={b.id} style={current ? { ...rowStyle, ...rowCurrent } : rowStyle}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {b.title}
                      {current && <span style={{ opacity: 0.6, fontWeight: 400 }}> · open now</span>}
                    </div>
                    <div style={{ opacity: 0.6, fontSize: 12 }}>
                      {b.author ? `${b.author} · ` : ""}
                      opened {relativeTime(b.addedAt)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {!current && (
                      <button style={buttonStyle} onClick={() => onOpen(b.id)}>
                        Open
                      </button>
                    )}
                    {!current && currentId && (
                      <button
                        style={buttonStyle}
                        title="Carry this book's characters/world into the book you have open (series continuity)"
                        onClick={() => onCarryOver(b.id)}
                      >
                        Carry bible →
                      </button>
                    )}
                    <button style={buttonStyle} title="Remove from library" onClick={() => onRemove(b.id)}>
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
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

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "8vh 16px",
  zIndex: 50,
  overflowY: "auto",
} as const;

const panelStyle = {
  width: "min(640px, 100%)",
  background: "#171922",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 12,
  padding: 16,
  fontFamily: "system-ui, sans-serif",
  color: "#e9ecf2",
} as const;

const headerStyle = { display: "flex", alignItems: "center", gap: 12, marginBottom: 10 } as const;

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
} as const;

const rowCurrent = { borderColor: "rgba(120,180,255,0.6)", background: "rgba(96,170,255,0.10)" } as const;

const buttonStyle = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 13,
} as const;
