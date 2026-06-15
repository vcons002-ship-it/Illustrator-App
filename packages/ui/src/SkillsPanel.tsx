import { memo, useMemo, useRef, useState } from "react";
import type { Skill } from "@visual-reader/core";

/**
 * Manage the assistant's SKILLS — its durable "intelligence docs" (named markdown
 * playbooks the buddy keeps across every conversation). View, edit, delete, add, or
 * IMPORT a downloaded `.md` playbook. Pure presentation: load/save/delete are injected,
 * so this stays dependency-light (App owns the store, the same one the worker reads).
 */
export interface SkillsPanelProps {
  skills: Skill[];
  /** Upsert by name (re-saving a name replaces it). */
  onSave: (name: string, description: string, body: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onClose: () => void;
  /** Per-field caps, surfaced so the editor can warn before a silent trim. */
  limits: { name: number; description: number; body: number };
}

type Editing = { original?: string; name: string; description: string; body: string } | undefined;

export const SkillsPanel = memo(function SkillsPanel({ skills, onSave, onDelete, onClose, limits }: SkillsPanelProps) {
  const [editing, setEditing] = useState<Editing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const sorted = useMemo(() => [...skills].sort((a, b) => a.name.localeCompare(b.name)), [skills]);

  const startNew = () => {
    setError("");
    setEditing({ name: "", description: "", body: "" });
  };
  const startEdit = (s: Skill) => {
    setError("");
    setEditing({ original: s.name, name: s.name, description: s.description, body: s.body });
  };

  const importMd = async (file: File) => {
    const text = await file.text();
    // Name from the first markdown heading, else the filename; body = the file.
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    const name = (heading || file.name.replace(/\.[^.]+$/, "")).slice(0, limits.name);
    setError("");
    setEditing({ name, description: "", body: text });
  };

  const save = async () => {
    if (!editing || busy) return;
    if (!editing.name.trim() || !editing.body.trim()) {
      setError("A skill needs a name and a body.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // A rename leaves the old skill behind — delete it so editing-as-rename works.
      if (editing.original && editing.original.toLowerCase() !== editing.name.trim().toLowerCase()) {
        await onDelete(editing.original);
      }
      await onSave(editing.name.trim(), editing.description.trim(), editing.body);
      setEditing(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try {
      await onDelete(name);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <strong>🧠 Skills — the assistant's playbooks</strong>
          <button style={btn} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
          Durable how-to notes the assistant keeps across every conversation and applies on its own. It can also
          write and refine these itself as it learns. Shared by all your chats.
        </p>

        {editing ? (
          <div style={editorBox}>
            <label style={fieldLabel}>
              Name <span style={{ opacity: 0.5 }}>(short handle the assistant matches on)</span>
              <input
                style={input}
                value={editing.name}
                maxLength={limits.name}
                placeholder="e.g. react-component"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label style={fieldLabel}>
              When to use it <span style={{ opacity: 0.5 }}>(one line — shows in the always-on index)</span>
              <input
                style={input}
                value={editing.description}
                maxLength={limits.description}
                placeholder="e.g. scaffold a typed React component with tests"
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </label>
            <label style={fieldLabel}>
              Playbook <span style={{ opacity: 0.5 }}>(markdown — the full steps, fetched on demand)</span>
              <textarea
                style={{ ...textarea, minHeight: 200 }}
                value={editing.body}
                maxLength={limits.body}
                placeholder={"1. …\n2. …"}
                onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              />
            </label>
            <div style={{ ...row, justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, opacity: 0.5 }}>{editing.body.length}/{limits.body} chars</span>
              <span style={{ display: "flex", gap: 6 }}>
                <button style={btn} onClick={() => setEditing(undefined)} disabled={busy}>
                  Cancel
                </button>
                <button style={btnPrimary} onClick={() => void save()} disabled={busy}>
                  {busy ? "Saving…" : "Save skill"}
                </button>
              </span>
            </div>
            {error ? <div style={errStyle}>{error}</div> : null}
          </div>
        ) : (
          <>
            <div style={{ ...row, justifyContent: "flex-end", gap: 6 }}>
              <button style={btn} onClick={() => fileRef.current?.click()}>
                ⬆ Import .md
              </button>
              <button style={btnPrimary} onClick={startNew}>
                + New skill
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.markdown,.txt"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importMd(f);
                  e.target.value = "";
                }}
              />
            </div>
            {sorted.length === 0 ? (
              <div style={{ opacity: 0.6, fontSize: 13, padding: "12px 0" }}>
                No skills yet. Add one, import a `.md`, or just ask the assistant to “remember how to…” and it
                will save its own.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sorted.map((s) => (
                  <div key={s.name} style={skillRow}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      {s.description ? (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>{s.description}</div>
                      ) : null}
                      <div style={{ fontSize: 11, opacity: 0.45 }}>{s.body.length} chars</div>
                    </div>
                    <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button style={btn} onClick={() => startEdit(s)}>
                        Edit
                      </button>
                      <button style={btn} onClick={() => void remove(s.name)} disabled={busy}>
                        Delete
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(8,9,13,0.7)",
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};
const card: React.CSSProperties = {
  width: "min(680px, 100%)",
  maxHeight: "92vh",
  overflowY: "auto",
  background: "#16181d",
  color: "#e6e6e6",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 18,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontFamily: "system-ui, sans-serif",
};
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const fieldLabel: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, opacity: 0.9 };
const textarea: React.CSSProperties = {
  resize: "vertical",
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  padding: 8,
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};
const input: React.CSSProperties = { ...textarea, resize: "none" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const editorBox: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  border: "1px solid rgba(122,162,255,0.4)",
  background: "rgba(122,162,255,0.06)",
  borderRadius: 8,
  padding: 12,
};
const skillRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "8px 10px",
};
const btn: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 13,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "rgba(122,162,255,0.25)",
  border: "1px solid rgba(122,162,255,0.6)",
};
const errStyle: React.CSSProperties = { color: "#ff9b9b", fontSize: 12 };
