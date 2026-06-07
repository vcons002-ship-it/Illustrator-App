import { useState } from "react";
import type { ComputeTier } from "@visual-reader/core";

/**
 * Settings: choose the compute tier and enter bring-your-own keys (v1 is
 * client-only). Keys are handed to the host to encrypt + persist; this
 * component never stores them in plain global state beyond the input.
 */
export interface ReaderSettings {
  tier: ComputeTier;
  llmKey: string;
  imageKey: string;
}

export interface SettingsPanelProps {
  value: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
}

export function SettingsPanel({ value, onChange }: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<ReaderSettings>) => onChange({ ...value, ...patch });

  return (
    <div style={{ fontSize: 13 }}>
      <button onClick={() => setOpen((o) => !o)} style={buttonStyle}>
        {open ? "Hide settings" : "Settings"}
      </button>
      {open && (
        <div style={panelStyle}>
          <label style={rowStyle}>
            <span>Compute tier</span>
            <select
              value={value.tier}
              onChange={(e) => set({ tier: e.target.value as ComputeTier })}
            >
              <option value="cloud">Cloud (Claude + Flux)</option>
              <option value="local">Local (on-device, experimental)</option>
            </select>
          </label>
          {value.tier === "cloud" && (
            <>
              <label style={rowStyle}>
                <span>Claude API key</span>
                <input
                  type="password"
                  value={value.llmKey}
                  placeholder="sk-ant-…"
                  onChange={(e) => set({ llmKey: e.target.value })}
                />
              </label>
              <label style={rowStyle}>
                <span>Image API key</span>
                <input
                  type="password"
                  value={value.imageKey}
                  placeholder="flux key"
                  onChange={(e) => set({ imageKey: e.target.value })}
                />
              </label>
              <p style={{ opacity: 0.6, margin: "4px 0 0" }}>
                Keys are stored encrypted on this device only.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const buttonStyle = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
} as const;

const panelStyle = {
  marginTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
} as const;

const rowStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
} as const;
