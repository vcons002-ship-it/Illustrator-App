import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_SOUL_IMAGES,
  renderSoulAppearanceFact,
  SOUL_ESSENCE_FACETS,
  soulEssenceViewForNotes,
  soulSourceFingerprint,
  type SoulEssence,
  type SoulEssenceExactList,
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
import {
  deleteSoulNoteAt,
  editSoulNoteAt,
  nextSoulNoteTimestamp,
  soulNoteRows,
} from "./soul-note-editing.js";

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
  /** APPEND photos without holding the existing ones — the linked phone's path. It never receives the
   * bytes (they'd be megabytes in every mirror frame), only the count, so it cannot save a whole
   * list: doing so would delete every photo it couldn't see. Given either handler, the section shows. */
  onAddImages?: (images: SoulImage[]) => Promise<void>;
  /** Drop one source-exact line from the generated Essence. Absent ⇒ the ✕ buttons don't render
   * (a linked phone, where the desktop owns the store). */
  onRemoveEssenceFact?: (list: SoulEssenceExactList, index: number) => Promise<void>;
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
  onAddImages,
  onRemoveEssenceFact,
  onClose,
  limits,
}: SoulPanelProps) {
  const copy = COPY[variant];
  const [list, setList] = useState<SoulNote[]>(notes);
  const [shownEssence, setShownEssence] = useState<SoulEssence | undefined>(essence);
  useEffect(() => setShownEssence(essence), [essence]);
  const [nameDraft, setNameDraft] = useState(name);
  useEffect(() => setNameDraft(name), [name]);
  const [pics, setPics] = useState<SoulImage[]>(images);
  useEffect(() => setPics(images), [images]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | undefined>();
  const [editText, setEditText] = useState("");
  const [savingBusy, setSavingBusy] = useState(false);
  const [essenceSubmitting, setEssenceSubmitting] = useState(false);
  const [essenceStartedAt, setEssenceStartedAt] = useState<number | undefined>();
  const [essenceNotice, setEssenceNotice] = useState("");
  const [essenceError, setEssenceError] = useState("");
  const [cancellingEssence, setCancellingEssence] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [error, setError] = useState("");

  useEffect(() => {
    setList(notes);
    // An assistant/linked-desktop update can replace the source array while this panel is open.
    // Cancel the local row edit rather than applying its now-stale array index to a different note.
    setEditingIndex(undefined);
    setEditText("");
    setEssenceNotice("");
    setEssenceError("");
  }, [notes]);

  const sorted = useMemo(() => soulNoteRows(list), [list]);
  const full = list.length >= limits.max;
  const essenceBusy = essenceSubmitting || Boolean(essenceProgress?.active);
  const operationBusy = savingBusy || essenceBusy;
  const activeStartedAt = essenceProgress?.startedAt ?? essenceStartedAt;
  const essenceIsStale = Boolean(
    shownEssence && shownEssence.sourceFingerprint !== soulSourceFingerprint(list),
  );
  // A stale synthesis remains useful as a personality baseline while its replacement is queued,
  // but old exact identity facts must never survive a source edit. Re-project those deterministic
  // fields from the current authoritative notes for both display and any in-flight refresh state.
  const visibleEssence = useMemo(
    () => shownEssence && essenceIsStale
      ? soulEssenceViewForNotes(shownEssence, list)
      : shownEssence,
    [shownEssence, list, essenceIsStale],
  );

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
      // Keep the previous synthesis visible and active while its idle replacement is prepared.
      // `visibleEssence` immediately re-projects exact identity from `next`, so only the generalized
      // synthesis/support remain stale during that short window.
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
    await persist([...list, { text, at: nextSoulNoteTimestamp(list) }]);
  };

  const saveEdit = async (): Promise<void> => {
    if (editingIndex === undefined || operationBusy) return;
    const text = editText.trim().slice(0, limits.note);
    if (!text) {
      await persist(deleteSoulNoteAt(list, editingIndex));
    } else if (list.some((n, index) => index !== editingIndex && n.text.toLowerCase() === text.toLowerCase())) {
      setError("Another note already says that.");
      return;
    } else {
      await persist(editSoulNoteAt(list, editingIndex, text));
    }
    setEditingIndex(undefined);
    setEditText("");
  };

  const remove = (sourceIndex: number): void =>
    void persist(deleteSoulNoteAt(list, sourceIndex));

  const refreshEssence = async (): Promise<void> => {
    if (!onRefreshEssence || operationBusy) return;
    setEssenceSubmitting(true);
    setEssenceStartedAt(Date.now());
    setEssenceNotice("");
    setEssenceError("");
    try {
      const generated = await onRefreshEssence();
      if (generated) {
        setShownEssence(generated);
        setEssenceNotice("Everyday essence generated and saved.");
      }
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
      // Append-only host (the phone): send just the NEW pictures and let the owner add them.
      if (!onSaveImages && onAddImages) {
        setSavingBusy(true);
        try {
          await onAddImages(read);
          setPics([...pics, ...read]);
        } finally {
          setSavingBusy(false);
        }
      } else {
        await persistPics([...pics, ...read]);
      }
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
  const staleEssenceNotice = essenceIsStale
    ? list.length > 0
      ? "Previous Essence remains active and will refresh automatically when the text model is idle."
      : "Previous Essence is retained, but there are no Soul items to regenerate it from."
    : "";
  const essenceStatusText = essenceError
    ? essenceError
    : cancellationNotice
      ? essenceNotice
      : essenceProgress?.message?.trim() ||
        (progressPhase ? ESSENCE_PHASE_LABELS[progressPhase] : "") ||
        (essenceBusy ? "Starting Soul integration\u2026" : essenceNotice || staleEssenceNotice);
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
            Everyday chat uses this generalized identity. Stories use it as a subtle baseline alongside
            the character&apos;s exact visual identity. The Creative window and explicit identity questions
            may consult the authoritative originals.
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

          {visibleEssence ? (
            <>
              {visibleEssence.generalizedEssence.text ? (
                <p
                  aria-label="Generalized everyday essence"
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    lineHeight: 1.55,
                    margin: 0,
                    padding: "9px 10px",
                    borderRadius: 7,
                    background: "rgba(130,170,255,0.1)",
                  }}
                >
                  {visibleEssence.generalizedEssence.text}
                </p>
              ) : (
                <span style={{ fontSize: 11, opacity: 0.58 }}>
                  No generalized personality traits; exact identity details remain below.
                </span>
              )}
              {visibleEssence.exactPersonalityDirections.length ? (
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
                    {visibleEssence.exactPersonalityDirections.map((fact, index) => (
                      <li key={`${fact.sourceIds.join("-")}-${index}`}>
                        {fact.text}
                        <EssenceFactRemove
                          {...(onRemoveEssenceFact
                            ? { onRemove: () => onRemoveEssenceFact("exactPersonalityDirections", index) }
                            : {})}
                          label={fact.text}
                        />
                      </li>
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
                {visibleEssence.exactAppearance.length ? (
                  <ul style={{ fontSize: 12, lineHeight: 1.4, margin: 0, paddingLeft: 18 }}>
                    {visibleEssence.exactAppearance.map((fact, index) => (
                      <li key={`${fact.sourceIds.join("-")}-${index}`}>
                        {renderSoulAppearanceFact(fact)}
                        <EssenceFactRemove
                          {...(onRemoveEssenceFact ? { onRemove: () => onRemoveEssenceFact("exactAppearance", index) } : {})}
                          label={fact.text}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span style={{ fontSize: 11, opacity: 0.58 }}>No physical appearance notes yet.</span>
                )}
              </div>
              <details
                style={{
                  paddingTop: 7,
                  borderTop: "1px solid rgba(255,255,255,0.09)",
                  fontSize: 11,
                }}
              >
                <summary style={{ cursor: "pointer", opacity: 0.68 }}>
                  Grounding details
                </summary>
                <p style={{ margin: "6px 0 8px", opacity: 0.58, lineHeight: 1.4 }}>
                  Supporting synthesis retained for provenance and explicit identity questions.
                </p>
                <dl style={{ display: "grid", gap: 7, margin: 0 }}>
                  {SOUL_ESSENCE_FACETS
                    .filter((key) => key !== "personalityDirections")
                    .map((key) => {
                    const text = visibleEssence.facets[key].text.trim();
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
              </details>
            </>
          ) : (
            <span style={{ fontSize: 11, opacity: 0.58 }}>
              {list.length
                ? "The generalized everyday essence will generate automatically when the text model is idle; use Generate to build it now. Until then, ordinary chat uses only source-exact identity details—not the raw interests/thought list."
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
            {sorted.map(({ note: n, sourceIndex, key }) =>
              editingIndex === sourceIndex ? (
                <div key={key} style={editRow}>
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
                        setEditingIndex(undefined);
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
                      setEditingIndex(undefined);
                      setEditText("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div key={key} style={noteRow}>
                  <span style={{ minWidth: 0, wordBreak: "break-word" }}>{n.text}</span>
                  <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      style={btn}
                      onClick={() => {
                        setError("");
                        setEditingIndex(sourceIndex);
                        setEditText(n.text);
                      }}
                    >
                      Edit
                    </button>
                    <button style={btn} onClick={() => remove(sourceIndex)} disabled={operationBusy}>
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
        {onSaveImages || onAddImages ? (
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
            {!onSaveImages && onAddImages ? " Added here, kept on your computer — remove one from the Soul panel there." : ""}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {/* On the phone a "photo" is a placeholder with no bytes — show it as a tile that says
                so rather than a broken <img>, and don't offer a delete the phone can't perform. */}
            {pics.map((im, i) =>
              im.dataBase64 ? (
                <div key={i} style={{ position: "relative" }}>
                  <img
                    src={`data:${im.mimeType};base64,${im.dataBase64}`}
                    alt="reference"
                    decoding="async"
                    style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)" }}
                  />
                  {onSaveImages ? (
                    <button style={removeBadge} onClick={() => removeImage(i)} disabled={operationBusy} title="Remove" aria-label="Remove reference photo">
                      ×
                    </button>
                  ) : null}
                </div>
              ) : (
                <div
                  key={i}
                  title="Stored on your computer — add more from here, or open the Soul panel there to remove one"
                  style={{
                    width: 64, height: 64, borderRadius: 6, border: "1px dashed rgba(255,255,255,0.25)",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, opacity: 0.6,
                  }}
                >
                  🖼
                </div>
              ),
            )}
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

/**
 * The ✕ beside one source-exact Essence line.
 *
 * The distillation files each note into a slot and gets it wrong sometimes — an interest in how the
 * brain perceives time landed under PHYSICAL APPEARANCE, from where it would describe the reader's
 * face to every image model that asks. Regenerating the whole Essence to dislodge one line is a poor
 * trade, and the note it came from may be perfectly good.
 *
 * Confirms first, quoting the line: these lists are short and the buttons sit close together, and
 * this is the one control here that destroys something a model spent minutes building.
 */
function EssenceFactRemove({ onRemove, label }: { onRemove?: () => Promise<void>; label: string }) {
  const [busy, setBusy] = useState(false);
  if (!onRemove) return null;
  const short = label.length > 60 ? `${label.slice(0, 60).trim()}…` : label;
  return (
    <button
      type="button"
      disabled={busy}
      title={`Remove “${short}” from the generated Soul`}
      aria-label={`Remove ${short}`}
      style={{
        marginLeft: 6,
        border: "none",
        background: "none",
        color: "inherit",
        opacity: busy ? 0.4 : 0.45,
        cursor: busy ? "default" : "pointer",
        fontSize: 11,
        padding: 0,
      }}
      onClick={() => {
        if (!window.confirm(`Remove this from the generated Soul?\n\n${short}`)) return;
        setBusy(true);
        void onRemove().finally(() => setBusy(false));
      }}
    >
      ✕
    </button>
  );
}
