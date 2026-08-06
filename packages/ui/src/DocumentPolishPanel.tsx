import { t } from "./design/tokens.js";
import { memo, useRef, useState } from "react";
import type { PolishMode, PolishPreset } from "@visual-reader/core";
import { fileForLang } from "./ChatPanel.js";

/**
 * Faithful document polish / summarize / rework. The user pastes (or uploads) a
 * document, picks a preset and/or types an instruction; the assistant first
 * CONFIRMS what it understood (asking one question if ambiguous), then PRODUCES a
 * reworked version that stays strictly within the source. The result is editable
 * and saveable. Pure presentation — all LLM/IO work is injected, so this stays in
 * packages/ui with no worker/provider dependency (mirrors ChatPanel).
 */

export interface PolishResult {
  plan?: string;
  question?: string;
  text?: string;
  error?: string;
}

export interface DocumentPolishPanelProps {
  /** Prefilled title/text (e.g. from an upload); both optional. */
  initial?: { title?: string; text?: string };
  presets: PolishPreset[];
  /** Stage 1: returns the model's plan + an optional clarifying question. */
  onUnderstand: (a: { mode?: PolishMode; freeText: string; source: string }) => Promise<PolishResult>;
  /** Stage 2: streams the reworked text via onToken; returns the final text + a cancel. */
  onProduce: (a: {
    mode?: PolishMode;
    freeText: string;
    source: string;
    confirmedPlan: string;
    onToken: (delta: string) => void;
  }) => { cancel: () => void; result: Promise<PolishResult> };
  onSaveFile?: (filename: string, content: string, mime: string) => Promise<string | true>;
  onClose: () => void;
}

type Step = "setup" | "confirm" | "producing" | "result";

export const DocumentPolishPanel = memo(function DocumentPolishPanel(props: DocumentPolishPanelProps) {
  const [source, setSource] = useState(props.initial?.text ?? "");
  const [mode, setMode] = useState<PolishMode | undefined>(props.presets[0]?.id);
  const [freeText, setFreeText] = useState("");
  const [step, setStep] = useState<Step>("setup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [output, setOutput] = useState("");
  const [saved, setSaved] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef<(() => void) | undefined>(undefined);

  const wordCount = source.trim() ? source.trim().split(/\s+/).length : 0;
  const truncated = source.length > 120_000;

  const understand = async () => {
    if (!source.trim() || busy) return;
    setBusy(true);
    setError("");
    const r = await props.onUnderstand({ ...(mode ? { mode } : {}), freeText, source });
    setBusy(false);
    if (r.error) return setError(r.error);
    setPlan(r.plan ?? "");
    setQuestion(r.question ?? "");
    setAnswer("");
    setStep("confirm");
  };

  const produce = () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setOutput("");
    setStep("producing");
    // Carry a clarifying answer into the produce instruction.
    const withAnswer = answer.trim() ? `${freeText}\n\nClarification: ${answer.trim()}` : freeText;
    const { cancel, result } = props.onProduce({
      ...(mode ? { mode } : {}),
      freeText: withAnswer,
      source,
      confirmedPlan: plan,
      onToken: (d) => setOutput((prev) => prev + d),
    });
    cancelRef.current = cancel;
    void result.then((r) => {
      cancelRef.current = undefined;
      setBusy(false);
      if (r.error) {
        setError(r.error);
        setStep("confirm");
        return;
      }
      setOutput(r.text ?? "");
      setStep("result");
    });
  };

  const cancelProduce = () => {
    cancelRef.current?.();
    cancelRef.current = undefined;
    setBusy(false);
    setStep("confirm");
  };

  const { ext, mime } = fileForLang("md");
  const filename = `${safeBase(props.initial?.title) || "document"}.${ext}`;
  const save = async () => {
    if (!props.onSaveFile) return;
    const r = await props.onSaveFile(filename, output, mime);
    setSaved(typeof r === "string" ? r : "saved");
  };

  return (
    <div style={overlay}>
      <div style={card}>
        <div style={header}>
          <strong>Polish / summarize a document</strong>
          <button style={btn} onClick={props.onClose}>
            Close
          </button>
        </div>

        {/* SETUP */}
        {(step === "setup" || step === "confirm") && (
          <>
            <label style={fieldLabel}>
              <span>Your document {wordCount > 0 ? `· ${wordCount} words` : ""}</span>
              <textarea
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="Paste or upload the text to rework…"
                style={{ ...textarea, minHeight: 140 }}
                disabled={step !== "setup"}
              />
            </label>
            {truncated && (
              <div style={hint}>Only the first ~120,000 characters are sent to the model.</div>
            )}
            <div style={{ ...fieldLabel, gap: 6 }}>
              <span>What should I do with it?</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {props.presets.map((p) => (
                  <button
                    key={p.id}
                    title={p.blurb}
                    onClick={() => setMode((m) => (m === p.id ? undefined : p.id))}
                    disabled={step !== "setup"}
                    style={{ ...chip, ...(mode === p.id ? chipActive : {}) }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <label style={fieldLabel}>
              <span>Extra instructions (optional)</span>
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="e.g. one page, plain English, keep the bullet structure"
                style={{ ...textarea, minHeight: 50 }}
                disabled={step !== "setup"}
              />
            </label>
          </>
        )}

        {step === "setup" && (
          <div style={row}>
            <span style={{ opacity: 0.55, fontSize: 11 }}>
              Stays faithful to your text — it won't add facts. Review before saving (small/local
              models can drift).
            </span>
            <button
              style={primary}
              onClick={() => void understand()}
              disabled={!source.trim() || busy}
            >
              {busy ? "Understanding…" : "Understand my ask →"}
            </button>
          </div>
        )}

        {/* CONFIRM */}
        {step === "confirm" && (
          <div style={confirmBox}>
            <div style={{ fontSize: 12, opacity: 0.85 }}>Here's what I'll do:</div>
            <div style={{ fontSize: 13, margin: "4px 0 8px" }}>{plan || "(no plan returned)"}</div>
            {question && (
              <label style={fieldLabel}>
                <span style={{ color: t.state.warn }}>One question: {question}</span>
                <input
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Your answer (optional)"
                  style={input}
                />
              </label>
            )}
            <div style={{ ...row, marginTop: 8 }}>
              <button style={btn} onClick={() => setStep("setup")}>
                ← Edit my ask
              </button>
              <button style={primary} onClick={produce}>
                Looks right — produce →
              </button>
            </div>
          </div>
        )}

        {/* PRODUCING / RESULT */}
        {(step === "producing" || step === "result") && (
          <>
            <label style={fieldLabel}>
              <span>
                Result{step === "producing" ? " · writing…" : " · editable"}
              </span>
              <textarea
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                style={{ ...textarea, minHeight: 260 }}
                readOnly={step === "producing"}
              />
            </label>
            <div style={row}>
              {step === "producing" ? (
                <button style={btn} onClick={cancelProduce}>
                  Stop
                </button>
              ) : (
                <button style={btn} onClick={() => setStep("setup")}>
                  ↺ Start over
                </button>
              )}
              <span style={{ display: "flex", gap: 6 }}>
                <button
                  style={btn}
                  disabled={!output}
                  onClick={() => {
                    void navigator.clipboard?.writeText(output);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? "Copied" : "📋 Copy"}
                </button>
                {props.onSaveFile && (
                  <button style={primary} disabled={!output || step === "producing"} onClick={() => void save()}>
                    💾 Save
                  </button>
                )}
              </span>
            </div>
            {saved && (
              <div style={hint}>
                {saved === "saved" ? "✓ Saved (check your downloads)" : `✓ Saved to ${saved}`}
              </div>
            )}
          </>
        )}

        {error && <div style={{ ...hint, color: "#ff9d9d" }}>⚠ {error}</div>}
      </div>
    </div>
  );
});

function safeBase(title?: string): string {
  return (title ?? "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: t.surface.overlay,
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};
const card: React.CSSProperties = {
  width: "min(760px, 100%)",
  maxHeight: "92vh",
  overflowY: "auto",
  background: t.surface.card,
  color: t.text.base,
  border: `1px solid ${t.border.subtle}`,
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
  background: t.fill.subtle,
  color: "inherit",
  border: `1px solid ${t.border.input}`,
  borderRadius: 6,
  padding: 8,
  fontSize: 13,
  fontFamily: "inherit",
};
const input: React.CSSProperties = { ...textarea, minHeight: undefined };
const row: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const confirmBox: React.CSSProperties = {
  border: `1px solid ${t.accent.edge}`,
  background: t.accent.wash,
  borderRadius: 8,
  padding: 10,
};
const hint: React.CSSProperties = { fontSize: 11, opacity: 0.65 };
const btn: React.CSSProperties = {
  background: t.fill.base,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const primary: React.CSSProperties = { ...btn, background: t.accent.base, borderColor: t.accent.base, color: "white" };
const chip: React.CSSProperties = { ...btn, opacity: 0.75 };
const chipActive: React.CSSProperties = { background: t.accent.fill, borderColor: t.accent.base, opacity: 1 };
