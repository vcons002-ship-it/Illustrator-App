/**
 * Runtime detection + thin bridge to the desktop shell.
 *
 * In the browser these are inert (isDesktop = false) and the local-GPU features
 * are hidden. Inside the Tauri desktop app, `window.__TAURI__` is present and the
 * Rust commands below manage the local inference engine (install/launch + model
 * downloads) so the renderer never deals with processes, ports, or CORS.
 */

import { classifyLoraHeader } from "@visual-reader/core";

type UnlistenFn = () => void;

interface TauriCore {
  core?: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  event?: {
    listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<UnlistenFn>;
  };
}

function tauri(): TauriCore | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __TAURI__?: TauriCore }).__TAURI__;
}

export const isDesktop = tauri() !== undefined;

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = tauri()?.core;
  if (!core) return Promise.reject(new Error("Desktop bridge unavailable"));
  return core.invoke<T>(cmd, args);
}

export interface InstalledModel {
  id: string;
  label: string;
}

/** A model file the desktop app can fetch on demand (resolved from the core catalog). */
export interface DownloadableModel {
  id: string;
  filename: string;
  url: string;
  /** ComfyUI models subfolder for split-file components (default "checkpoints"). */
  folder?: "checkpoints" | "diffusion_models" | "text_encoders" | "vae";
}

/** Progress while the engine itself is being installed / launched. */
export interface EngineProgress {
  phase: "downloading" | "extracting" | "starting" | "ready" | "error";
  message: string;
  /** 0..100 when known. */
  percent?: number;
}

/** Progress while a model checkpoint downloads. */
export interface ModelProgress {
  id: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
}

/**
 * Ensure the local engine is installed + running (downloads on first use) and
 * return its base URL. Emits `engine://progress` events on the Rust side.
 */
export function ensureEngine(): Promise<string> {
  return invoke<string>("ensure_engine");
}

export function listLocalModels(): Promise<InstalledModel[]> {
  return invoke<InstalledModel[]>("list_models");
}

/**
 * Total VRAM of the primary GPU in MB, or undefined when unknown (web, or no NVIDIA
 * GPU). Used to keep Auto image-quality within what the card can render. Best-effort:
 * resolves undefined rather than rejecting.
 */
export function gpuVramMb(): Promise<number | undefined> {
  if (!isDesktop) return Promise.resolve(undefined);
  return invoke<number | null>("gpu_info")
    .then((mb) => mb ?? undefined)
    .catch(() => undefined);
}

/** Installed LoRA filenames in the managed engine (for style auto-download checks). */
export function listLoras(): Promise<string[]> {
  return invoke<string[]>("list_loras");
}

/**
 * Detected base-model family for each installed LoRA (desktop only), by reading the small
 * safetensors header off disk and classifying it. Lets the UI flag a LoRA that won't load
 * on the active model. Returns {} on the web or if the bridge/command is unavailable.
 */
export async function loraFamilies(): Promise<Record<string, string>> {
  if (!isDesktop) return {};
  try {
    const headers = await invoke<{ name: string; header: string }[]>("lora_headers");
    const out: Record<string, string> = {};
    for (const h of headers) {
      const fam = classifyLoraHeader(h.header);
      if (fam !== "unknown") out[h.name] = fam;
    }
    return out;
  } catch {
    return {};
  }
}

/** One proxied HTTP request/response (bodies base64 — invoke payloads are JSON). */
export interface DesktopFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
}

export interface DesktopFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  /** Set instead of the fields above when the native fetch itself failed. */
  error?: string;
}

/**
 * CORS-free fetch through the Rust shell — the desktop twin of the extension's
 * background proxy. Lets the chat buddy's keyless web search (DuckDuckGo) and
 * "open this URL" reach sites that block cross-origin browser requests. Never
 * rejects: failures come back as `{ error }` so the worker's fetch wrapper can
 * surface them as a normal TypeError.
 */
export async function desktopHttpFetch(request: DesktopFetchRequest): Promise<DesktopFetchResult> {
  try {
    return await invoke<DesktopFetchResult>("http_fetch", { request });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      statusText: "",
      headers: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Download a curated checkpoint; emits `model://progress` events while it runs. */
export function downloadModel(model: DownloadableModel): Promise<void> {
  return invoke<void>("download_model", { model });
}

/** Download a style LoRA into the engine's loras dir; emits `model://progress`. */
export function downloadLora(model: DownloadableModel): Promise<void> {
  return invoke<void>("download_lora", { model });
}

/** Base64-encode bytes for an invoke payload (invoke args are JSON, not binary).
 * Chunked so a multi-MB image can't overflow the argument stack of String.fromCharCode. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Save a generated artifact (an illustrated HTML/EPUB export, or a single image)
 * to disk. On the desktop the Rust shell writes it into `~/VisualReader/exports`
 * and returns the full path (shown to the reader). In the browser there's no
 * filesystem, so it falls back to a normal download and returns `true`.
 */
export async function saveExportFile(
  filename: string,
  data: string | Uint8Array,
  mimeType: string,
): Promise<string | true> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (isDesktop) {
    return invoke<string>("save_file", { filename, bodyBase64: bytesToBase64(bytes) });
  }
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Subscribe to engine install/launch progress. Returns undefined on the web. */
export function onEngineProgress(handler: (p: EngineProgress) => void): Promise<UnlistenFn> | undefined {
  return tauri()?.event?.listen<EngineProgress>("engine://progress", (e) => handler(e.payload));
}

/** Subscribe to model-download progress. Returns undefined on the web. */
export function onModelProgress(handler: (p: ModelProgress) => void): Promise<UnlistenFn> | undefined {
  return tauri()?.event?.listen<ModelProgress>("model://progress", (e) => handler(e.payload));
}
