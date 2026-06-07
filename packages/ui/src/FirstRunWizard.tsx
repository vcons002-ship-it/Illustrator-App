import { useState } from "react";
import { getProvider } from "@visual-reader/core";
import type { ReaderSettings } from "./SettingsPanel.js";

/**
 * First-run experience. One friendly question — how should we create images —
 * with two paths: bring a cloud account (paste one key) or run on your own
 * computer (the desktop app sets everything up). A quiet third link starts a
 * keyless demo. The goal is zero jargon and zero config to the first image.
 */

export interface FirstRunWizardProps {
  current: ReaderSettings;
  onComplete: (next: ReaderSettings) => void;
  isDesktop?: boolean;
}

// Providers that can do BOTH text and images from a single key (keeps setup to
// one field). Mixing (e.g. Claude for text + Flux for images) lives in Settings.
const CLOUD_CHOICES = ["gemini", "openai"] as const;

export function FirstRunWizard({ current, onComplete, isDesktop = false }: FirstRunWizardProps) {
  const [path, setPath] = useState<"none" | "cloud">("none");
  const [provider, setProvider] = useState<(typeof CLOUD_CHOICES)[number]>("gemini");
  const [key, setKey] = useState("");

  const finishCloud = () => {
    if (!key.trim()) return;
    onComplete({
      ...current,
      textProvider: provider,
      imageProvider: provider,
      keys: { ...current.keys, [provider]: key.trim() },
      configured: true,
    });
  };

  const finishLocal = () =>
    onComplete({
      ...current,
      textProvider: "local",
      imageProvider: "local",
      localModel: current.localModel ?? "sd-turbo",
      configured: true,
    });

  const finishDemo = () => onComplete({ ...current, configured: true });

  return (
    <div style={overlay}>
      <div style={card}>
        <h2 style={{ margin: "0 0 4px" }}>Welcome to Visual Reader</h2>
        <p style={{ marginTop: 0, opacity: 0.75 }}>How should we create images for what you read?</p>

        {path === "none" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button style={choice} onClick={() => setPath("cloud")}>
              <strong>Use my AI account</strong>
              <span style={sub}>Paste one key from Google or OpenAI. Works everywhere.</span>
            </button>
            <button style={choice} onClick={finishLocal} disabled={!isDesktop}>
              <strong>Run on my computer (free &amp; private)</strong>
              <span style={sub}>
                {isDesktop
                  ? "Uses your GPU. We set everything up — the model downloads on first use."
                  : "Available in the desktop app. Download it to generate on your own GPU."}
              </span>
            </button>
            <button style={linkBtn} onClick={finishDemo}>
              Just show me a demo
            </button>
          </div>
        )}

        {path === "cloud" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Provider</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value as (typeof CLOUD_CHOICES)[number])}>
                {CLOUD_CHOICES.map((id) => (
                  <option key={id} value={id}>
                    {getProvider("text", id)?.label ?? id}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>
                API key{" "}
                <a href={getProvider("text", provider)?.keyUrl} target="_blank" rel="noreferrer" style={{ opacity: 0.7 }}>
                  Where do I get one?
                </a>
              </span>
              <input
                type="password"
                value={key}
                placeholder={getProvider("text", provider)?.keyHint ?? ""}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
              <button style={linkBtn} onClick={() => setPath("none")}>
                Back
              </button>
              <button style={primary} onClick={finishCloud} disabled={!key.trim()}>
                Start reading
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
  width: "min(460px, 100%)",
  background: "#1a1d27",
  color: "#e7e7ee",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 14,
  padding: 24,
  fontFamily: "system-ui, sans-serif",
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
  color: "#9db4ff",
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
