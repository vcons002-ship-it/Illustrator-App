import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_SOUL_IMAGES,
  SOUL_ESSENCE_FACETS,
  type SoulEssence,
  type SoulImage,
  type SoulNote,
} from "@visual-reader/core";
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
 * Edit one of the two identity "souls" — authoritative durable notes, separate from
 * reader-memory. Ordinary chat uses a compact essence synthesized from these notes, while
 * creative and specific identity contexts can still consult the original sources:
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
  /** The compact identity synthesis used for ordinary conversation. */
  essence?: SoulEssence | undefined;
  /** Live progress for the dedicated, non-persisted text-model job that builds the essence. */
  essenceProgress?: SoulEssenceGenerationProgress | undefined;
  /** Regenerate the compact identity synthesis from the authoritative notes. */
  onRefreshEssence?: () => Promise<SoulEssence | undefined>;
  /** Cancel the active essence-generation job, when the host supports cancellation. */
  onCancelEssence?: () => void | Promise<void>;
  /** Persist the WHOLE notes list (the panel manages the array; App writes + reloads it). */
  onSaveNotes: (notes: SoulNote[]) => Promise<void>;
  /** Persist the played-character name. */
  onSaveName: (name: string) => Promise<void>;
  /** Reference photos (base64) the model uses when drawing this character. */
  images: SoulImage[];
  /** Persist the WHOLE reference-photo list (capped at MAX_SOUL_IMAGES). ABSENT on a linked phone,
   * where the photos live on the computer that owns them — the section is then hidden entirely. */
  onSaveImages?: (images: SoulImage[]) => Promise<void>;
  onClose: () => void;
  limits: { note: number; max: number; name: number };
}

export type SoulEssenceGenerationPhase =
  | "queued"
  | "loading"
  | "analyzing"
  | "merging"
  | "validating"
  | "saving"
  | "complete"
  | "cancelled"
  | "error";

export interface SoulEssenceGenerationProgress {
  active: boolean;
  phase?: SoulEssenceGenerationPhase | undefined;
  /** Human-readable detail supplied by the generation host. */
  message?: string | undefined;
  /** One-based model pass currently in progress. */
  pass?: number | undefined;
  /** Total model passes, when it can be determined in advance. */
  total?: number | undefined;
  /** Tokens processed or generated so far, when reported by the provider. */
  tokens?: number | undefined;
  /** Epoch milliseconds, used to show elapsed time. */
  startedAt?: number | undefined;
}

const COPY = {
  self: {
    title: "🪞 Soul — who you are",
    namePlaceholder: "The assistant's name (e.g. Sage)",
    blurb:
      "The assistant's durable source identity — persona, look, and voice. Everyday chat uses an " +
      "integrated essence made from these notes, while creative work can draw on the originals.",
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

const ESSENCE_FACET_LABELS: Record<(typeof SOUL_ESSENCE_FACETS)[number], string> = {
  coreDisposition: "Core disposition",
  conversationalVoice: "Conversational voice",
  thinkingStyle: "Thinking style",
  valuesAndMotivations: "Values and motivations",
  relationalStyle: "Relational style",
  personalityDirections: "Personality directions",
  tensionsAndNuance: "Tensions and nuance",
};

const ESSENCE_PHASE_LABELS: Record<SoulEssenceGenerationPhase, string> = {
  queued: "Queued",
  loading: "Loading the text model",
  analyzing: "Analyzing source notes",
  merging: "Integrating Soul",
  validating: "Validating essence",
  saving: "Saving essence",
  complete: "Everyday essence generated and saved",
  cancelled: "Generation cancelled",
  error: "Essence generation failed",
};

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

export const SoulPanel = memo(function SoulPanel({
  variant,
  name,
  notes,
  essence,
  essenceProgress,
  onRefreshEssence,
  onCancelEssence,
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
  const [shownEssence, setShownEssence] = useState<SoulEssence | undefined>(essence);
  useEffect(() => setShownEssence(essence), [essence]);
  const [nameDraft, setNameDraft] = useState(name);
  useEffect(() => setNameDraft(name), [name]);
  const [pics, setPics] = useState<SoulImage[]>(images);
  useEffect(() => setPics(images), [images]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [editingAt, setEditingAt] = useState<number | undefined>();
  const [editText, setEditText] = useState("");
  const [savingBusy, setSavingBusy] = useState(false);
  const [essenceSubmitting, setEssenceSubmitting] = useState(false);
  const [essenceStartedAt, setEssenceStartedAt] = useState<number | undefined>();
  const [essenceNotice, setEssenceNotice] = useState("");
  const [essenceError, setEssenceError] = useState("");
  const [cancellingEssence, setCancellingEssence] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [error, setError] = useState("");

  const sorted = useMemo(() => [...list].sort((a, b) => b.at - a.at), [list]);
  const full = list.length >= limits.max;
  const essenceBusy = essenceSubmitting || Boolean(essenceProgress?.active);
  const operationBusy = savingBusy || essenceBusy;
  const activeStartedAt = essenceProgress?.startedAt ?? essenceStartedAt;

  useEffect(() => {
    if (!essenceBusy || activeStartedAt === undefined) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeStartedAt, essenceBusy]);

  const persist = async (next: SoulNote[]): Promise<void> => {
    setSavingBusy(true);
    setError("");
    try {
      await onSaveNotes(next);
      setList(next);
      // A source-note change makes the previously distilled identity stale.
      setShownEssence(undefined);
      setEssenceNotice("");
      setEssenceError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingBusy(false);
    }
  };

  const saveName = async (): Promise<void> => {
    const next = nameDraft.trim().slice(0, limits.name);
    if (next === name) return;
    setSavingBusy(true);
    setError("");
    try {
      await onSaveName(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    const text = draft.trim().slice(0, limits.note);
    if (!text || operationBusy) return;
    if (list.some((n) => n.text.toLowerCase() === text.toLowerCase())) {
      setError("That note is already there.");
      return;
    }
    setDraft("");
    await persist([...list, { text, at: Date.now() }]);
  };

  const saveEdit = async (): Promise<void> => {
    if (editingAt === undefined || operationBusy) return;
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

  const refreshEssence = async (): Promise<void> => {
    if (!onRefreshEssence || operationBusy) return;
    setEssenceSubmitting(true);
    setEssenceStartedAt(Date.now());
    setEssenceNotice("");
    setEssenceError("");
    try {
      const generated = await onRefreshEssence();
      setShownEssence(generated);
      if (generated) setEssenceNotice("Everyday essence generated and saved.");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setEssenceNotice("Generation cancelled.");
      } else {
        setEssenceError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setEssenceSubmitting(false);
      setEssenceStartedAt(undefined);
    }
  };

  const cancelEssence = async (): Promise<void> => {
    if (!onCancelEssence || !essenceBusy || cancellingEssence) return;
    setCancellingEssence(true);
    setEssenceError("");
    setEssenceNotice("Cancellation requested\u2026");
    try {
      await onCancelEssence();
    } catch (e) {
      setEssenceNotice("");
      setEssenceError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancellingEssence(false);
    }
  };

  const persistPics = async (next: SoulImage[]): Promise<void> => {
    setSavingBusy(true);
    setError("");
    try {
      if (!onSaveImages) return;
      await onSaveImages(next);
      setPics(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingBusy(false);
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

  const progressPhase = essenceProgress?.phase;
  const essenceNoticeIsCancellation =
    essenceNotice.startsWith("Cancellation") || essenceNotice.startsWith("Generation cancelled");
  const cancellationNotice = essenceBusy && essenceNoticeIsCancellation;
  const essenceStatusText = essenceError
    ? essenceError
    : cancellationNotice
      ? essenceNotice
      : essenceProgress?.message?.trim() ||
        (progressPhase ? ESSENCE_PHASE_LABELS[progressPhase] : "") ||
        (essenceBusy ? "Starting Soul integration\u2026" : essenceNotice);
  const essenceStatusIsError = Boolean(essenceError) || progressPhase === "error";
  const essenceStatusIsComplete =
    !essenceBusy &&
    (progressPhase === "complete" || (Boolean(essenceNotice) && !essenceNoticeIsCancellation));
  const progressPass =
    essenceProgress?.pass !== undefined && Number.isFinite(essenceProgress.pass)
      ? Math.max(1, Math.floor(essenceProgress.pass))
      : undefined;
  const progressTotal =
    essenceProgress?.total !== undefined && Number.isFinite(essenceProgress.total)
      ? Math.max(1, Math.floor(essenceProgress.total))
      : undefined;
  const elapsed =
    essenceBusy && activeStartedAt !== undefined ? formatElapsed(clock - activeStartedAt) : undefined;

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

        <section
          aria-labelledby={`${variant}-soul-essence-heading`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 10,
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            background: "rgba(255,255,255,0.035)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <strong id={`${variant}-soul-essence-heading`} style={{ fontSize: 13 }}>
              Everyday essence
            </strong>
            {onRefreshEssence ? (
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  type="button"
                  style={btn}
                  disabled={operationBusy || list.length === 0}
                  onClick={() => void refreshEssence()}
                  aria-label={
                    essenceBusy
                      ? "Everyday essence generation in progress"
                      : `${shownEssence ? "Refresh" : "Generate"} everyday essence`
                  }
                >
                  {essenceBusy ? "Generating\u2026" : shownEssence ? "Refresh" : "Generate"}
                </button>
                {essenceBusy && progressPhase !== "saving" && onCancelEssence ? (
                  <button
                    type="button"
                    style={btn}
                    disabled={cancellingEssence}
                    onClick={() => void cancelEssence()}
                  >
                    {cancellingEssence ? "Canceling\u2026" : "Cancel"}
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          <p style={{ fontSize: 11, opacity: 0.68, margin: 0, lineHeight: 1.45 }}>
            Ordinary chat uses this integrated identity. The original notes below remain authoritative,
            and creative work or a specific identity question can still consult those sources.
          </p>

          {essenceStatusText ? (
            <div
              role={essenceStatusIsError ? "alert" : "status"}
              aria-live={essenceStatusIsError ? "assertive" : "polite"}
              aria-atomic="true"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 5,
                padding: "8px 9px",
                borderRadius: 6,
                border: essenceStatusIsError
                  ? `1px solid ${DANGER_RED}`
                  : essenceStatusIsComplete
                    ? "1px solid rgba(98,210,145,0.42)"
                    : "1px solid rgba(130,170,255,0.4)",
                background: essenceStatusIsError
                  ? "rgba(190,45,45,0.12)"
                  : essenceStatusIsComplete
                    ? "rgba(60,160,105,0.1)"
                    : "rgba(80,120,210,0.11)",
              }}
            >
              <strong style={{ fontSize: 12, lineHeight: 1.35 }}>{essenceStatusText}</strong>
              {essenceBusy ? (
                <>
                  <span style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px", fontSize: 10, opacity: 0.72 }}>
                    {progressPass !== undefined ? (
                      <span>
                        Pass {progressPass}
                        {progressTotal !== undefined ? ` of ${progressTotal}` : ""}
                      </span>
                    ) : null}
                    {essenceProgress?.tokens !== undefined && Number.isFinite(essenceProgress.tokens) ? (
                      <span>{Math.max(0, Math.floor(essenceProgress.tokens)).toLocaleString()} tokens</span>
                    ) : null}
                    {elapsed ? <span>Elapsed {elapsed}</span> : null}
                  </span>
                  {progressTotal !== undefined ? (
                    <progress
                      aria-label="Soul integration progress"
                      value={Math.min(progressPass ?? 0, progressTotal)}
                      max={progressTotal}
                      style={{ width: "100%", height: 5, accentColor: "#8aa8ff" }}
                    />
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}

          {shownEssence ? (
            <>
              <dl style={{ display: "grid", gap: 7, margin: 0 }}>
                {SOUL_ESSENCE_FACETS.map((key) => {
                  if (key === "personalityDirections") return null;
                  const text = shownEssence.facets[key].text.trim();
                  return text ? (
                    <div key={key}>
                      <dt style={{ fontSize: 11, fontWeight: 600, opacity: 0.78 }}>
                        {ESSENCE_FACET_LABELS[key]}
                      </dt>
                      <dd style={{ fontSize: 12, margin: "2px 0 0", lineHeight: 1.4 }}>{text}</dd>
                    </div>
                  ) : null;
                })}
              </dl>
              {shownEssence.exactPersonalityDirections.length ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    paddingTop: 7,
                    borderTop: "1px solid rgba(255,255,255,0.09)",
                  }}
                >
                  <strong style={{ fontSize: 11, opacity: 0.78 }}>
                    Source-exact personality directions
                  </strong>
                  <ul style={{ fontSize: 12, lineHeight: 1.4, margin: 0, paddingLeft: 18 }}>
                    {shownEssence.exactPersonalityDirections.map((fact, index) => (
                      <li key={`${fact.sourceIds.join("-")}-${index}`}>{fact.text}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  paddingTop: 7,
                  borderTop: "1px solid rgba(255,255,255,0.09)",
                }}
              >
                <strong style={{ fontSize: 11, opacity: 0.78 }}>Exact physical appearance</strong>
                {shownEssence.exactAppearance.length ? (
                  <ul style={{ fontSize: 12, lineHeight: 1.4, margin: 0, paddingLeft: 18 }}>
                    {shownEssence.exactAppearance.map((fact, index) => (
                      <li key={`${fact.sourceIds.join("-")}-${index}`}>{fact.text}</li>
                    ))}
                  </ul>
                ) : (
                  <span style={{ fontSize: 11, opacity: 0.58 }}>No physical appearance notes yet.</span>
                )}
              </div>
            </>
          ) : (
            <span style={{ fontSize: 11, opacity: 0.58 }}>
              {list.length
                ? "Generate an everyday essence now. Small Souls may also be integrated automatically by a local text model."
                : "Add source notes before generating an essence."}
            </span>
          )}
        </section>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <strong style={{ fontSize: 12 }}>Source notes</strong>
          <span style={{ fontSize: 10, opacity: 0.5 }}>Authoritative originals</span>
        </div>

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
          <button
            style={btnPrimary}
            onClick={() => void add()}
            disabled={operationBusy || full || !draft.trim()}
          >
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
                        // Cancel just this inline edit — mark the event handled so the ModalShell's
                        // Escape doesn't also close the whole dialog.
                        e.preventDefault();
                        e.stopPropagation();
                        setEditingAt(undefined);
                        setEditText("");
                      }
                    }}
                  />
                  <button style={btn} onClick={() => void saveEdit()} disabled={operationBusy}>
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
                    <button style={btn} onClick={() => remove(n.at)} disabled={operationBusy}>
                      Delete
                    </button>
                  </span>
                </div>
              ),
            )}
          </div>
        )}

        {/* Hidden when the host can't save photos — on a linked phone they live on the computer,
            and an upload button that quietly discarded the picture would be worse than no button. */}
        {onSaveImages ? (
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
                <button style={removeBadge} onClick={() => removeImage(i)} disabled={operationBusy} title="Remove" aria-label="Remove reference photo">
                  ×
                </button>
              </div>
            ))}
            {pics.length < MAX_SOUL_IMAGES ? (
              <button style={addThumb} onClick={() => fileInput.current?.click()} disabled={operationBusy}>
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
        ) : null}

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, opacity: 0.5 }}>
          <span>
            {list.length}/{limits.max} notes
          </span>
          {error ? (
            <span style={{ color: DANGER_RED, opacity: 1 }}>{error}</span>
          ) : (
            <span>{savingBusy ? "Saving\u2026" : ""}</span>
          )}
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
