import { memo, useEffect, useMemo, useState } from "react";
import type { MemoryNote } from "@visual-reader/core";
import { ModalShell } from "./ModalShell.js";
import {
  DANGER_RED,
  modalAddRowStyle as addRow,
  modalBtnStyle as btn,
  modalBtnPrimaryStyle as btnPrimary,
  modalEditRowStyle as editRow,
  modalHeaderRowStyle as header,
  modalInputStyle as input,
  modalNoteRowStyle as noteRow,
} from "./tokens.js";

/**
 * Manage the chat's READER MEMORY — the durable notes the assistant keeps about you across every
 * conversation ("prefers oil-painting style", "reading the Empyrean series") and injects into every
 * system prompt. View, add, edit, or delete them. Pure presentation: the persisted list comes in via
 * `notes` and every change is handed back through `onSave` (App owns the store the worker reads).
 */
export interface MemoriesPanelProps {
  notes: MemoryNote[];
  /** Persist the WHOLE list (the panel manages the array; App writes + reloads it). */
  onSave: (notes: MemoryNote[]) => Promise<void>;
  onClose: () => void;
  /** Caps surfaced so the editor can warn before a silent trim. */
  limits: { note: number; max: number };
}

export const MemoriesPanel = memo(function MemoriesPanel({ notes, onSave, onClose, limits }: MemoriesPanelProps) {
  // Local working copy so edits feel instant; re-synced if the stored list changes underneath.
  const [list, setList] = useState<MemoryNote[]>(notes);
  useEffect(() => setList(notes), [notes]);
  const [draft, setDraft] = useState("");
  const [editingAt, setEditingAt] = useState<number | undefined>();
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Newest first (the array is stored oldest→newest); `at` is a stable key per note.
  const sorted = useMemo(() => [...list].sort((a, b) => b.at - a.at), [list]);
  const full = list.length >= limits.max;

  const persist = async (next: MemoryNote[]): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await onSave(next);
      setList(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    const text = draft.trim().slice(0, limits.note);
    if (!text || busy) return;
    if (list.some((n) => n.text.toLowerCase() === text.toLowerCase())) {
      setError("That note is already remembered.");
      return;
    }
    setDraft("");
    await persist([...list, { text, at: Date.now() }]);
  };

  const saveEdit = async (): Promise<void> => {
    if (editingAt === undefined || busy) return;
    const text = editText.trim().slice(0, limits.note);
    if (!text) {
      // Empty = delete.
      await persist(list.filter((n) => n.at !== editingAt));
    } else if (list.some((n) => n.at !== editingAt && n.text.toLowerCase() === text.toLowerCase())) {
      setError("Another note already says that.");
      return;
    } else {
      await persist(list.map((n) => (n.at === editingAt ? { ...n, text } : n)));
    }
    setEditingAt(undefined);
    setEditText("");
  };

  const remove = (at: number): void => void persist(list.filter((n) => n.at !== at));

  return (
    <ModalShell title="Memory — what the assistant remembers about you" onClose={onClose}>
        <div style={header}>
          <strong>💭 Memory — what the assistant remembers about you</strong>
          <button style={btn} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
          Durable notes the assistant keeps across every conversation and applies on its own — your
          preferences, what you're reading, things to avoid. It updates these itself when you state a
          lasting preference; you can add, edit, or delete any of them here. Shared by all your chats.
        </p>

        <div style={addRow}>
          <input
            style={{ ...input, flex: 1 }}
            value={draft}
            maxLength={limits.note}
            placeholder={full ? "Memory is full — delete one to add another" : "e.g. Prefers concise answers"}
            disabled={full}
            onChange={(e) => {
              setError("");
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          <button style={btnPrimary} onClick={() => void add()} disabled={busy || full || !draft.trim()}>
            + Add
          </button>
        </div>

        {sorted.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 13, padding: "12px 0" }}>
            No memories yet. Add one above, or just tell the assistant something to remember
            (“remember that I…”) and it will save it here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sorted.map((n) =>
              editingAt === n.at ? (
                <div key={n.at} style={editRow}>
                  <input
                    style={{ ...input, flex: 1 }}
                    value={editText}
                    maxLength={limits.note}
                    autoFocus
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveEdit();
                      if (e.key === "Escape") {
                        setEditingAt(undefined);
                        setEditText("");
                      }
                    }}
                  />
                  <button style={btn} onClick={() => void saveEdit()} disabled={busy}>
                    Save
                  </button>
                  <button
                    style={btn}
                    onClick={() => {
                      setEditingAt(undefined);
                      setEditText("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div key={n.at} style={noteRow}>
                  <span style={{ minWidth: 0, wordBreak: "break-word" }}>{n.text}</span>
                  <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      style={btn}
                      onClick={() => {
                        setError("");
                        setEditingAt(n.at);
                        setEditText(n.text);
                      }}
                    >
                      Edit
                    </button>
                    <button style={btn} onClick={() => remove(n.at)} disabled={busy}>
                      Delete
                    </button>
                  </span>
                </div>
              ),
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, opacity: 0.5 }}>
          <span>
            {list.length}/{limits.max} notes
          </span>
          {error ? <span style={{ color: DANGER_RED, opacity: 1 }}>{error}</span> : <span>{busy ? "Saving…" : ""}</span>}
        </div>
    </ModalShell>
  );
});
