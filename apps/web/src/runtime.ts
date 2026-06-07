/**
 * Runtime detection + thin bridge to the desktop shell.
 *
 * In the browser these are inert (isDesktop = false) and the local-GPU features
 * are hidden. Inside the Tauri desktop app, `window.__TAURI__` is present and the
 * Rust commands below manage the local inference engine (install/launch + model
 * downloads) so the renderer never deals with processes, ports, or CORS.
 */

interface TauriCore {
  core?: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
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

/**
 * Ensure the local engine is installed + running (downloads on first use) and
 * return its base URL. Emits progress through Tauri events on the Rust side.
 */
export function ensureEngine(): Promise<string> {
  return invoke<string>("ensure_engine");
}

export function listLocalModels(): Promise<InstalledModel[]> {
  return invoke<InstalledModel[]>("list_models");
}

export function downloadModel(id: string): Promise<void> {
  return invoke<void>("download_model", { id });
}
