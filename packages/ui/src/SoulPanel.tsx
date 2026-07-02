import { memo, useEffect, useMemo, useRef, useState } from "react";
import { MAX_SOUL_IMAGES, type SoulImage, type SoulNote } from "@visual-reader/core";
import { ModalShell } from "./ModalShell.js";
import {
  DANGER_RED,
  modalAddRowStyle as addRow,
  modalBtnStyle as btn,
  modalBtnPrimaryStyle as btnPrimary,
  modalEditRowStyle as editRow,
  modalHeaderRowStyle as headerRow,
  modalInputStyle as input,
  modalNoteRowStyle as noteRow,
} from "./tokens.js";

/**
 * Edit one of the two identity "souls" — durable notes, separate from reader-memory, that
 * the assistant keeps and injects into every prompt:
 *  - variant "self": WHO THE ASSISTANT IS (its persona, look, voice) — so it stays itself,
 *    and can play itself in a "You & me" story.
 *  - variant "user": WHO THE READER IS (their own character's look + personality) — so the
 *    assistant can portray them when they play themselves.
 * Each soul also has a NAME (the played character's name in roleplay). Pure presentation:
 * the persisted list/name come in via props and changes are handed back through onSave*.
 */
export interface SoulPanelProps {
  variant: "self" | "user";
  name: string;
  notes: SoulNote[];
  /** Persist the WHOLE notes list (the panel manages the array; App writes + reloads it). */
  onSaveNotes: (notes: SoulNote[]) => Promise<void>;
  /** Persist the played-character name. */
  onSaveName: (name: string) => Promise<void>;
  /** Reference photos (base64) the model uses when drawing this character. */
  images: SoulImage[];
  /** Persist the WHOLE reference-photo list (capped at MAX_SOUL_IMAGES). */
  onSaveImages: (images: SoulImage[]) => Promise<void>;
  onClose: () => void;
  limits: { note: number; max: number; name: number };
}

const COPY = {
  self: {
    title: "🪞 Soul — who you are",
    namePlaceholder: "The assistant's name (e.g. Sage)",
    blurb:
      "The assistant's own durable identity — persona, look, and voice. It stays consistent with this " +
      "across every chat, and embodies it when it plays itself in a “You & me” story. Add a name plus a few " +
      "notes (appearance, personality, how it speaks).",
    notePlaceholder: "e.g. Warm, dry wit; silver hair; wears a long coat",
  },
  user: {
    title: "👤 You — who the reader is",
    namePlaceholder: "Your character name (e.g. Alex)",
    blurb:
      "What the assistant knows about YOUR own character — look and personality — so it can portray you " +
      "when you play yourself in a story. Add your character name plus a few notes (appearance, personality).",
    notePlaceholder: "e.g. Tall, dark curly hair; bold and curious",
  },
} as const;

export const SoulPanel = memo(function SoulPanel({
  variant,
  name,
  notes,
  onSaveNotes,
  onSaveName,
  images,
  onSaveImages,
  onClose,
  limits,
}: SoulPanelProps) {
  const copy = COPY[variant];
  const [list, setList] = useState<SoulNote[]>(notes);
  useEffect(() => setList(notes), [notes]);
  const [nameDraft, setNameDraft] = useState(name);
  useEffect(() => setNameDraft(name), [name]);
  const [pics, setPics] = useState<SoulImage[]>(images);
  useEffect(() => setPics(images), [images]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [editingAt, setEditingAt] = useState<number | undefined>();
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const sorted = useMemo(() => [...list].sort((a, b) => b.at - a.at), [list]);
  const full = list.length >= limits.max;

  const persist = async (next: SoulNote[]): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await onSaveNotes(next);
      setList(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveName = async (): Promise<void> => {
    const next = nameDraft.trim().slice(0, limits.name);
    if (next === name) return;
    setBusy(true);
    setError("");
    try {
      await onSaveName(next);
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
      setError("That note is already there.");
      return;
    }
    setDraft("");
    await persist([...list, { text, at: Date.now() }]);
  };

  const saveEdit = async (): Promise<void> => {
    if (editingAt === undefined || busy) return;
    const text = editText.trim().slice(0, limits.note);
    if (!text) {
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

  const persistPics = async (next: SoulImage[]): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await onSaveImages(next);
      setPics(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const addImageFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    const room = MAX_SOUL_IMAGES - pics.length;
    if (room <= 0) {
      setError(`Up to ${MAX_SOUL_IMAGES} reference photos.`);
      return;
    }
    const picked = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, room);
    if (!picked.length) return;
    try {
      const read = await Promise.all(
        picked.map(
          (f) =>
            new Promise<SoulImage>((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => {
                const url = String(r.result || "");
                const comma = url.indexOf(","); // strip the "data:<mime>;base64," prefix
                resolve({ mimeType: f.type || "image/png", dataBase64: comma >= 0 ? url.slice(comma + 1) : url });
              };
              r.onerror = () => reject(new Error("couldn't read the image"));
              r.readAsDataURL(f);
            }),
        ),
      );
      await persistPics([...pics, ...read]);
    } catch (err) {
      // Callers fire-and-forget (`void addImageFiles(...)`) — an unreadable file must land in the
      // panel's error line, not as an unhandled rejection.
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const removeImage = (i: number): void => void persistPics(pics.filter((_, idx) => idx !== i));

  return (
    <ModalShell title={copy.title} onClose={onClose}>
        <div style={headerRow}>
          <strong>{copy.title}</strong>
          <button style={btn} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>{copy.blurb}</p>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, opacity: 0.85 }}>
          Name
          <span style={addRow}>
            <input
              style={{ ...input, flex: 1 }}
              value={nameDraft}
              maxLength={limits.name}
              placeholder={copy.namePlaceholder}
              onChange={(e) => {
                setError("");
                setNameDraft(e.target.value);
              }}
              onBlur={() => void saveName()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
              }}
            />
          </span>
        </label>

        <div style={addRow}>
          <input
            style={{ ...input, flex: 1 }}
            value={draft}
            maxLength={limits.note}
            placeholder={full ? "Full — delete one to add another" : copy.notePlaceholder}
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
            No notes yet. Add one above, or just tell the assistant (“remember about{" "}
            {variant === "self" ? "yourself" : "me"}…”) and it will save it here.
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

        <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.85, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>📷 Reference photos</span>
            <span style={{ fontSize: 11, opacity: 0.6 }}>
              {pics.length}/{MAX_SOUL_IMAGES}
            </span>
          </div>
          <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
            Photos of {variant === "self" ? "the assistant" : "you"}, used when it draws{" "}
            {variant === "self" ? "itself" : "you"}. (Gemini & OpenAI image models and ComfyUI use these; some
            models, like Flux, ignore them.)
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {pics.map((im, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img
                  src={`data:${im.mimeType};base64,${im.dataBase64}`}
                  alt="reference"
                  decoding="async"
                  style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)" }}
                />
                <button style={removeBadge} onClick={() => removeImage(i)} disabled={busy} title="Remove" aria-label="Remove reference photo">
                  ×
                </button>
              </div>
            ))}
            {pics.length < MAX_SOUL_IMAGES ? (
              <button style={addThumb} onClick={() => fileInput.current?.click()} disabled={busy}>
                + Photo
              </button>
            ) : null}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void addImageFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, opacity: 0.5 }}>
          <span>
            {list.length}/{limits.max} notes
          </span>
          {error ? <span style={{ color: DANGER_RED, opacity: 1 }}>{error}</span> : <span>{busy ? "Saving…" : ""}</span>}
        </div>
    </ModalShell>
  );
});

const addThumb: React.CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: 6,
  border: "1px dashed rgba(255,255,255,0.3)",
  background: "rgba(255,255,255,0.05)",
  color: "inherit",
  fontSize: 12,
  cursor: "pointer",
};
const removeBadge: React.CSSProperties = {
  position: "absolute",
  top: -6,
  right: -6,
  width: 18,
  height: 18,
  borderRadius: "50%",
  border: "none",
  background: "rgba(0,0,0,0.75)",
  color: "#fff",
  fontSize: 13,
  lineHeight: "16px",
  cursor: "pointer",
  padding: 0,
};
