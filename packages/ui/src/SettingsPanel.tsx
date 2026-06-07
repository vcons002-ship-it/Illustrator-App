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
/** Which local engine HTTP API to speak when the image provider is "local". */
export type LocalBackendId = "comfyui" | "a1111";

/** Default localhost URL for each local engine, used as the field placeholder. */
export const LOCAL_ENGINE_DEFAULT_URL: Record<LocalBackendId, string> = {
  comfyui: "http://127.0.0.1:8188",
  a1111: "http://127.0.0.1:7860",
};

const LOCAL_BACKEND_LABEL: Record<LocalBackendId, string> = {
  a1111: "AUTOMATIC1111",
  comfyui: "ComfyUI",
};

export interface ReaderSettings {
  textProvider: TextProviderId;
  imageProvider: ImageProviderId;
  /** Per-provider API keys, keyed by provider id (e.g. keys.claude, keys.flux). */
  keys: Record<string, string>;
  /** Chosen local image checkpoint. */
  localModel?: string;
  /** Which local engine API to talk to (browser "your own server" path). */
  localBackend?: LocalBackendId;
  /** Base URL of a local engine you run yourself (browser path; persisted). */
  localServerUrl?: string;
  /** True once the first-run wizard has been completed. */
  configured?: boolean;
  /** Transient: base URL of the app-managed local engine (desktop; not persisted). */
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
  /** Connect to a self-hosted engine and load its model list (browser path). */
  onConnectLocalServer?: (backend: LocalBackendId, url: string) => void;
  /** True while a connection attempt is in flight. */
  connectingLocal?: boolean;
}

export function SettingsPanel({
  value,
  onChange,
  isDesktop = false,
  installedModels = [],
  onDownloadModel,
  onConnectLocalServer,
  connectingLocal = false,
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
            <LocalEngine
              isDesktop={isDesktop}
              installedModels={installedModels}
              backend={value.localBackend ?? "a1111"}
              serverUrl={value.localServerUrl ?? ""}
              selected={value.localModel}
              connecting={connectingLocal}
              onSet={set}
              onSelect={(id) => set({ localModel: id })}
              onDownload={onDownloadModel}
              onConnect={onConnectLocalServer}
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

/**
 * Local-engine settings. Two ways to generate on your own hardware:
 *  - Desktop: the app-managed engine, with a curated one-click model download.
 *  - Anywhere (incl. the browser): connect to a Stable Diffusion server you run
 *    yourself — AUTOMATIC1111 or ComfyUI — and pick from its installed models.
 */
function LocalEngine({
  isDesktop,
  installedModels,
  backend,
  serverUrl,
  selected,
  connecting,
  onSet,
  onSelect,
  onDownload,
  onConnect,
}: {
  isDesktop: boolean;
  installedModels: InstalledModel[];
  backend: LocalBackendId;
  serverUrl: string;
  selected: string | undefined;
  connecting: boolean;
  onSet: (patch: Partial<ReaderSettings>) => void;
  onSelect: (id: string) => void;
  onDownload: ((id: string) => void) | undefined;
  onConnect: ((backend: LocalBackendId, url: string) => void) | undefined;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {isDesktop && (
        <ManagedEngine installedModels={installedModels} selected={selected} onSelect={onSelect} onDownload={onDownload} />
      )}

      <div style={rowStyle}>
        <span>{isDesktop ? "Or use your own server" : "Your Stable Diffusion server"}</span>
        <select value={backend} onChange={(e) => onSet({ localBackend: e.target.value as LocalBackendId })}>
          {(["a1111", "comfyui"] as LocalBackendId[]).map((id) => (
            <option key={id} value={id}>
              {LOCAL_BACKEND_LABEL[id]}
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={{ flex: 1 }}
            value={serverUrl}
            placeholder={LOCAL_ENGINE_DEFAULT_URL[backend]}
            onChange={(e) => onSet({ localServerUrl: e.target.value })}
          />
          <button
            style={buttonStyle}
            disabled={connecting}
            onClick={() => onConnect?.(backend, serverUrl.trim() || LOCAL_ENGINE_DEFAULT_URL[backend])}
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </div>
        <ModelSelect installedModels={installedModels} selected={selected} onSelect={onSelect} />
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          Start {LOCAL_BACKEND_LABEL[backend]} with its API and allow this app's origin —
          {backend === "a1111"
            ? " e.g. ./webui.sh --api --cors-allow-origins=" + location.origin
            : " e.g. python main.py --enable-cors-header " + location.origin}
          .
        </span>
      </div>
    </div>
  );
}

/** Desktop app-managed engine: pick a downloaded model or grab a curated one. */
function ManagedEngine({
  installedModels,
  selected,
  onSelect,
  onDownload,
}: {
  installedModels: InstalledModel[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  onDownload: ((id: string) => void) | undefined;
}) {
  const installedIds = new Set(installedModels.map((m) => m.id));
  return (
    <div style={rowStyle}>
      <span>Local model (app-managed)</span>
      <ModelSelect installedModels={installedModels} selected={selected} onSelect={onSelect} />
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

/** Checkpoint dropdown; always includes the current selection so it survives reloads. */
function ModelSelect({
  installedModels,
  selected,
  onSelect,
}: {
  installedModels: InstalledModel[];
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  const options = [...installedModels];
  if (selected && !options.some((m) => m.id === selected)) options.unshift({ id: selected, label: selected });
  if (options.length === 0) {
    return <span style={{ opacity: 0.6, fontSize: 12 }}>Connect to load the available models.</span>;
  }
  return (
    <select value={selected ?? ""} onChange={(e) => onSelect(e.target.value)}>
      <option value="" disabled>
        Choose a model…
      </option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
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
