import { useState } from "react";
import { getProvider } from "@visual-reader/core";
import type { ReaderSettings } from "./SettingsPanel.js";
import { ModalShell } from "./ModalShell.js";
import { ACCENT_BLUE } from "./tokens.js";

/**
 * First-run experience. Visual Reader is an AI assistant that also illustrates
 * whatever you read, so the welcome offers three honest starting points: bring a
 * cloud account (one key powers the assistant, reading analysis AND images), run
 * on your own computer (the desktop app sets everything up), or "just chat & read"
 * — set up a text model only and skip image generation (it stays on placeholder
 * art until you add an image provider in Settings). A quiet link starts a keyless
 * look-around. The goal is zero jargon and a working app in one choice.
 */

export interface FirstRunWizardProps {
  current: ReaderSettings;
  onComplete: (next: ReaderSettings) => void;
  isDesktop?: boolean;
}

// Providers that can do BOTH text and images from a single key (keeps setup to
// one field). Mixing (e.g. Claude for text + Flux for images) lives in Settings.
const CLOUD_CHOICES = ["gemini", "openai"] as const;
// The "just chat & read" path sets up a TEXT brain only — so it also offers Claude,
// which has no image model. Images stay on placeholder until configured in Settings.
const TEXT_CHOICES = ["claude", "gemini", "openai"] as const;

export function FirstRunWizard({ current, onComplete, isDesktop = false }: FirstRunWizardProps) {
  const [path, setPathState] = useState<"none" | "cloud" | "text">("none");
  const [provider, setProvider] = useState<(typeof TEXT_CHOICES)[number]>("gemini");
  const [key, setKey] = useState("");
  const textOnly = path === "text";
  const choices = textOnly ? TEXT_CHOICES : CLOUD_CHOICES;
  // Clamp the provider to the new path's list — text-only offers Claude, cloud doesn't, so
  // text→back→cloud would otherwise leave a selection the dropdown can't even display.
  const setPath = (next: "none" | "cloud" | "text"): void => {
    setPathState(next);
    const valid: readonly string[] = next === "text" ? TEXT_CHOICES : CLOUD_CHOICES;
    if (!valid.includes(provider)) setProvider(valid[0] as (typeof TEXT_CHOICES)[number]);
  };

  const finishCloud = () => {
    if (!key.trim()) return;
    onComplete({
      ...current,
      textProvider: provider,
      // Text-only start: leave the image provider untouched (placeholder art) so the
      // assistant + reading work now and images can be added later. Cloud start: the
      // one key serves images too, so point the image provider at it as well — except
      // Claude, which has no image model (only offered on the text-only path anyway).
      ...(textOnly || provider === "claude" ? {} : { imageProvider: provider }),
      keys: { ...current.keys, [provider]: key.trim() },
      configured: true,
    });
  };

  const finishLocal = () =>
    onComplete({
      ...current,
      textProvider: "local",
      imageProvider: "local",
      // Desktop auto-manages an engine (curated download) AND ships a built-in text
      // model that launches itself; the browser path connects to servers you run
      // yourself (image) and defaults text to on-device WebGPU.
      ...(isDesktop
        ? { localModel: current.localModel ?? "z-image-turbo", localTextBackend: "bundled" as const }
        : { localBackend: current.localBackend ?? "a1111" }),
      configured: true,
    });

  const finishDemo = () => onComplete({ ...current, configured: true });

  return (
    // No onClose: first-run setup is non-dismissable (there is nothing behind it yet),
    // so ModalShell contributes the dialog semantics + focus handling only.
    <ModalShell title="Welcome to Visual Reader" cardStyle={card}>
        <h2 style={{ margin: "0 0 4px" }}>Welcome to Visual Reader</h2>
        <p style={{ marginTop: 0, opacity: 0.75 }}>
          An AI assistant that also illustrates whatever you read. How do you want to start?
        </p>

        {path === "none" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button style={choice} onClick={() => setPath("cloud")}>
              <strong>Use my AI account</strong>
              <span style={sub}>
                One key from Google or OpenAI — powers the assistant, reading, and image
                generation. Works everywhere.
              </span>
            </button>
            <button style={choice} onClick={finishLocal}>
              <strong>Run on my computer (free &amp; private)</strong>
              <span style={sub}>
                {isDesktop
                  ? "Uses your GPU for the assistant and images. We set everything up — the model downloads on first use."
                  : "Connect your own local model (Ollama) and Stable Diffusion server (AUTOMATIC1111 or ComfyUI) in Settings."}
              </span>
            </button>
            <button style={choice} onClick={() => setPath("text")}>
              <strong>Just chat &amp; read — skip image setup</strong>
              <span style={sub}>
                Set up a text model only (Claude, Gemini, or OpenAI) for the assistant,
                document reading, and study help. Add image generation anytime in Settings.
              </span>
            </button>
            <button style={linkBtn} onClick={finishDemo}>
              Just look around first (placeholder art, no setup)
            </button>
          </div>
        )}

        {(path === "cloud" || path === "text") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>{textOnly ? "Which AI should power the assistant & reading?" : "Provider"}</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value as (typeof TEXT_CHOICES)[number])}>
                {choices.map((id) => (
                  <option key={id} value={id}>
                    {getProvider("text", id)?.label ?? id}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>API key</span>
                <a href={getProvider("text", provider)?.keyUrl} target="_blank" rel="noreferrer" style={{ color: ACCENT_BLUE }}>
                  Get a key ↗
                </a>
              </span>
              <input
                type="password"
                value={key}
                placeholder={getProvider("text", provider)?.keyHint ?? ""}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setKey(e.target.value)}
              />
              {getProvider("text", provider)?.keyBlurb && (
                <span style={{ opacity: 0.6, fontSize: 12 }}>{getProvider("text", provider)?.keyBlurb}</span>
              )}
              <span style={{ opacity: 0.6, fontSize: 12 }}>
                Stored encrypted on this device only.
                {textOnly ? " Images stay on placeholder art until you set up an image provider in Settings." : ""}
              </span>
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
              <button style={linkBtn} onClick={() => setPath("none")}>
                Back
              </button>
              <button style={primary} onClick={finishCloud} disabled={!key.trim()}>
                {textOnly ? "Start" : "Start reading"}
              </button>
            </div>
          </div>
        )}
    </ModalShell>
  );
}

const card: React.CSSProperties = {
  width: "min(460px, 100%)",
  background: "#1a1d27",
  color: "#e7e7ee",
  borderRadius: 14,
  padding: 24,
  // Back to the browser defaults ModalShell's shared card overrides — this card is
  // block-flow (spacing from the h2/p margins) and never taller than its content.
  display: "block",
  gap: 0,
  maxHeight: "none",
  overflowY: "visible",
};

const choice: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  alignItems: "flex-start",
  textAlign: "left",
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.03)",
  color: "inherit",
  cursor: "pointer",
};

const sub: React.CSSProperties = { fontSize: 13, opacity: 0.7, fontWeight: 400 };

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: ACCENT_BLUE,
  cursor: "pointer",
  padding: 4,
  fontSize: 13,
};

const primary: React.CSSProperties = {
  background: "#4663d6",
  border: "none",
  color: "white",
  borderRadius: 8,
  padding: "8px 16px",
  cursor: "pointer",
};
