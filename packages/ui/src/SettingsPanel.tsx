import { useState } from "react";
import {
  IMAGE_PROVIDERS,
  TEXT_PROVIDERS,
  LOCAL_IMAGE_MODELS,
  getProvider,
  type ProviderInfo,
} from "@visual-reader/core";

/**
 * Settings: pick a text provider and an image provider independently, each with
 * its own remembered key, plus the local-model picker when "On my computer" is
 * chosen. Keys are handed to the host to encrypt + persist. Provider lists come
 * from the core catalog so the UI and the engine wiring never drift.
 */

export type TextProviderId = "claude" | "gemini" | "openai" | "local";
export type ImageProviderId = "flux" | "gemini" | "openai" | "local";

export interface ReaderSettings {
  textProvider: TextProviderId;
  imageProvider: ImageProviderId;
  /** Per-provider API keys, keyed by provider id (e.g. keys.claude, keys.flux). */
  keys: Record<string, string>;
  /** Chosen local image checkpoint (desktop only). */
  localModel?: string;
  /** True once the first-run wizard has been completed. */
  configured?: boolean;
  /** Transient: base URL of the app-managed local engine (not persisted). */
  engineBaseUrl?: string;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  textProvider: "claude",
  imageProvider: "flux",
  keys: {},
};

/** A downloaded local model reported by the running engine. */
export interface InstalledModel {
  id: string;
  label: string;
}

export interface SettingsPanelProps {
  value: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
  /** True when running inside the desktop app (enables the local GPU engine). */
  isDesktop?: boolean;
  /** Models the running engine has downloaded. */
  installedModels?: InstalledModel[];
  /** Start downloading a curated model; desktop only. */
  onDownloadModel?: (id: string) => void;
}

export function SettingsPanel({
  value,
  onChange,
  isDesktop = false,
  installedModels = [],
  onDownloadModel,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<ReaderSettings>) => onChange({ ...value, ...patch });
  const setKey = (id: string, key: string) => set({ keys: { ...value.keys, [id]: key } });

  const textInfo = getProvider("text", value.textProvider);
  const imageInfo = getProvider("image", value.imageProvider);

  return (
    <div style={{ fontSize: 13 }}>
      <button onClick={() => setOpen((o) => !o)} style={buttonStyle}>
        {open ? "Hide settings" : "Settings"}
      </button>
      {open && (
        <div style={panelStyle}>
          <label style={rowStyle}>
            <span>Text (story understanding)</span>
            <select
              value={value.textProvider}
              onChange={(e) => set({ textProvider: e.target.value as TextProviderId })}
            >
              {TEXT_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {textInfo?.needsKey && <KeyField info={textInfo} value={value.keys[textInfo.id] ?? ""} onChange={(k) => setKey(textInfo.id, k)} />}

          <label style={rowStyle}>
            <span>Images</span>
            <select
              value={value.imageProvider}
              onChange={(e) => set({ imageProvider: e.target.value as ImageProviderId })}
            >
              {IMAGE_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {imageInfo?.needsKey && <KeyField info={imageInfo} value={value.keys[imageInfo.id] ?? ""} onChange={(k) => setKey(imageInfo.id, k)} />}

          {value.imageProvider === "local" && (
            <LocalModelPicker
              isDesktop={isDesktop}
              installedModels={installedModels}
              selected={value.localModel}
              onSelect={(id) => set({ localModel: id })}
              onDownload={onDownloadModel}
            />
          )}

          <p style={{ opacity: 0.6, margin: "4px 0 0" }}>
            Keys are stored encrypted on this device only.
          </p>
        </div>
      )}
    </div>
  );
}

function KeyField({ info, value, onChange }: { info: ProviderInfo; value: string; onChange: (k: string) => void }) {
  return (
    <label style={rowStyle}>
      <span>
        {info.label} key
        {info.keyUrl && (
          <>
            {" "}
            <a href={info.keyUrl} target="_blank" rel="noreferrer" style={{ opacity: 0.7 }}>
              Where do I get a key?
            </a>
          </>
        )}
      </span>
      <input type="password" value={value} placeholder={info.keyHint ?? ""} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function LocalModelPicker({
  isDesktop,
  installedModels,
  selected,
  onSelect,
  onDownload,
}: {
  isDesktop: boolean;
  installedModels: InstalledModel[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  onDownload: ((id: string) => void) | undefined;
}) {
  if (!isDesktop) {
    return (
      <p style={{ opacity: 0.7, margin: 0 }}>
        Running images on your own GPU (SD, SDXL, Flux) needs the desktop app — download it to generate
        locally, free and offline. In the browser this falls back to demo art.
      </p>
    );
  }
  const installedIds = new Set(installedModels.map((m) => m.id));
  return (
    <div style={rowStyle}>
      <span>Local model</span>
      {installedModels.length > 0 && (
        <select value={selected ?? ""} onChange={(e) => onSelect(e.target.value)}>
          <option value="" disabled>
            Choose a downloaded model…
          </option>
          {installedModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        {LOCAL_IMAGE_MODELS.map((m) => (
          <div key={m.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <span style={{ opacity: 0.85 }}>
              {m.label} · {m.sizeGB} GB{m.note ? ` · ${m.note}` : ""}
            </span>
            {installedIds.has(m.id) ? (
              <span style={{ opacity: 0.6 }}>Installed</span>
            ) : (
              <button style={buttonStyle} onClick={() => onDownload?.(m.id)}>
                Download
              </button>
            )}
          </div>
        ))}
      </div>
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
  maxWidth: 340,
} as const;

const rowStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
} as const;
