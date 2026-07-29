/**
 * The deleted bible entries, with a way back. Shared by the character bible and the world bible.
 *
 * Shown because the deletion is permanent in the only sense that matters — it survives reading on
 * through the book — and a permanent, invisible suppression is a trap: an entry that stops
 * appearing with no record of why reads as a bug, and someone who deleted the wrong twin of a pair
 * has no way to say so. Collapsed by default; it's a footnote, not part of the list.
 */
export function RemovedBibleEntries({
  entries,
  what,
  onRestore,
}: {
  entries: { id: string; name: string }[];
  /** Singular noun for the tooltip, e.g. "character", "place". */
  what: string;
  onRestore: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <details style={{ marginTop: 12 }}>
      <summary style={summaryStyle}>
        Deleted ({entries.length}) — kept out of new images, and not re-added as the book is read
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
        {entries.map((e) => (
          <div key={e.id} style={rowStyle}>
            <span style={{ fontSize: 13 }}>{e.name}</span>
            <button
              style={restoreButtonStyle}
              title={`Bring this ${what} back, with everything it had`}
              onClick={() => onRestore(e.id)}
            >
              Restore
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}

const summaryStyle = { cursor: "pointer", fontSize: 12, opacity: 0.6 } as const;

const rowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "4px 8px",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 6,
} as const;

const restoreButtonStyle = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "inherit",
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 12,
  cursor: "pointer",
} as const;
