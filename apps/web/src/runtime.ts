/**
 * Runtime detection + thin bridge to the desktop shell.
 *
 * In the browser these are inert (isDesktop = false) and the local-GPU features
 * are hidden. Inside the Tauri desktop app, `window.__TAURI__` is present and the
 * Rust commands below manage the local inference engine (install/launch + model
 * downloads) so the renderer never deals with processes, ports, or CORS.
 */

import { base64ToBytes, classifyLoraHeader, type LocalFile } from "@visual-reader/core";

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
export function ensureEngine(lowVram?: boolean): Promise<string> {
  return invoke<string>("ensure_engine", lowVram ? { lowVram: true } : {});
}

export function listLocalModels(): Promise<InstalledModel[]> {
  return invoke<InstalledModel[]>("list_models");
}

/** Where the bundled local LLM server is running + the model id it serves. */
export interface LocalLlm {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11435/v1. */
  baseUrl: string;
  /** Model id the server reports (passed straight to the local-server provider). */
  model: string;
}

/**
 * Ensure the DESKTOP-bundled text model is running and return where to reach it.
 * The Rust shell launches a bundled `llama-server` over a small GGUF on first use
 * (downloading the binary/weights into ~/VisualReader/llm if they weren't bundled
 * into the installer), then the renderer points the ordinary OpenAI-compatible
 * `LocalServerProvider` at it. Emits `llm://progress` while it sets up.
 */
export function ensureLocalLlm(): Promise<LocalLlm> {
  return invoke<LocalLlm>("ensure_llm");
}

/** Subscribe to bundled-LLM setup progress (download/launch). Undefined on the web. */
export function onLlmProgress(handler: (p: EngineProgress) => void): Promise<UnlistenFn> | undefined {
  return tauri()?.event?.listen<EngineProgress>("llm://progress", (e) => handler(e.payload));
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

/**
 * Search the user's local files for importable books (desktop only). Returns
 * coarse filename matches the caller ranks with `rankLocalFiles`. Empty on the
 * web (no filesystem). `root` scopes the walk to a folder (default: home dir).
 */
export async function searchLocalFiles(query: string, root?: string): Promise<LocalFile[]> {
  if (!isDesktop) return [];
  return invoke<LocalFile[]>("search_files", { query, ...(root ? { root } : {}) });
}

/**
 * Read one chosen local file's bytes (desktop only), wrapped as a `File` so it
 * flows through the SAME importer as an uploaded file. Rejects on the web.
 */
export async function readLocalFile(path: string): Promise<File> {
  const r = await invoke<{ name: string; ext: string; bodyBase64: string }>("read_file", { path });
  return new File([base64ToBytes(r.bodyBase64) as BlobPart], r.name);
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

/**
 * Run ONE approved shell command in the desktop app's workspace folder and return
 * its output. Only reached AFTER the reader approves the exact command in the chat
 * (the run_command tool). Rejects on the web (no shell). A configured GitHub token is
 * passed out-of-band as an ENV var (GH_TOKEN/GITHUB_TOKEN) for the child — never in
 * the command string — so `gh`/`git` are authenticated without exposing it.
 */
export function runCommand(
  command: string,
  githubToken?: string,
  cwd?: string,
  shell?: "cmd" | "powershell",
): Promise<CommandResult> {
  return invoke<CommandResult>("run_command", {
    command,
    ...(githubToken ? { githubToken } : {}),
    ...(cwd ? { cwd } : {}),
    // Windows only: "powershell" runs the command via PowerShell instead of cmd /C.
    ...(shell ? { shell } : {}),
  });
}

/**
 * Write a file the assistant authored (a script, data, config) INTO the desktop workspace so it can
 * then be run via {@link runCommand}. `relPath` is workspace-relative; the Rust side sanitizes it so
 * it can never escape the workspace folder. `cwd` pins the session's chosen working folder (else the
 * default workspace). Returns the absolute path written. Rejects on the web (no filesystem). Only
 * reached when Autonomous workspace is on (no per-write click) — see the write_file tool.
 */
export function writeWorkspaceFile(relPath: string, content: string, cwd?: string): Promise<string> {
  const contentBase64 = bytesToBase64(new TextEncoder().encode(content));
  return invoke<string>("write_workspace_file", { relPath, contentBase64, ...(cwd ? { cwd } : {}) });
}

// ----------------------------------------------------------- Git worktrees
//
// App-managed worktrees for parallel write-capable coding agents — the host owns the whole
// lifecycle (create → diff → merge → cleanup), so branches are never the reader's problem.
// All desktop-only; reject on the web.

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** The base commit the worktree branched from — the diff/merge reference. */
  base: string;
}

/** The git repo root for a folder, or undefined when it isn't a repo (or on the web). */
export async function gitRepoRoot(dir: string): Promise<string | undefined> {
  if (!isDesktop) return undefined;
  return (await invoke<string | null>("git_repo_root", { dir })) ?? undefined;
}

/** Ensure a folder is a git repo (init + base commit if needed); returns its root. */
export function gitEnsureRepo(dir: string): Promise<string> {
  return invoke<string>("git_ensure_repo", { dir });
}

/** Create a worktree + branch for one agent (outside the repo); returns its path. */
export function gitWorktreeCreate(repoDir: string, branch: string): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("git_worktree_create", { repoDir, branch });
}

/** Stage + commit everything in a folder (agent worktree, or base after a resolve). */
export function gitCommitAll(dir: string, message: string): Promise<CommandResult> {
  return invoke<CommandResult>("git_commit_all", { dir, message });
}

/** A worktree branch's diff against base (stat + full patch). */
export function gitWorktreeDiff(path: string, base: string): Promise<string> {
  return invoke<string>("git_worktree_diff", { path, base });
}

/** Merge an agent branch into base (no-ff); returns raw git output to parse for conflicts. */
export function gitMergeBranch(repoDir: string, branch: string): Promise<CommandResult> {
  return invoke<CommandResult>("git_merge_branch", { repoDir, branch });
}

/** Abort an in-progress (conflicted) merge, restoring a clean base. */
export function gitMergeAbort(repoDir: string): Promise<CommandResult> {
  return invoke<CommandResult>("git_merge_abort", { repoDir });
}

/** Remove an agent worktree + delete its branch (best-effort cleanup). */
export function gitWorktreeRemove(repoDir: string, path: string, branch: string): Promise<void> {
  return invoke<void>("git_worktree_remove", { repoDir, path, branch });
}

/** Native "choose a folder" dialog (desktop). Resolves to the path, or undefined on
 * cancel / on the web. */
export async function pickFolder(): Promise<string | undefined> {
  if (!isDesktop) return undefined;
  const path = await invoke<string | null>("pick_folder");
  return path ?? undefined;
}

/** Run the Google OAuth consent + loopback redirect (desktop): opens the browser and
 * returns the consent `code` + the redirect_uri it was issued for. */
export function googleOauthLoopback(args: {
  clientId: string;
  scope: string;
  codeChallenge: string;
  state: string;
}): Promise<{ code: string; redirectUri: string }> {
  return invoke<{ code: string; redirectUri: string }>("oauth_loopback", args);
}

/**
 * TradingView Desktop bridge (desktop only): run one JS expression in the user's
 * TradingView Desktop chart via its Chrome DevTools port and return the JSON value.
 * Inert (reports unavailable) on the web and on older desktop builds. See MARKETS-BRIDGE.md.
 */
export async function tvBridgeEval(expression: string, port?: number): Promise<{ ok: boolean; value?: string; error?: string }> {
  if (!isDesktop) return { ok: false, error: "The TradingView bridge needs the desktop app." };
  try {
    return await invoke<{ ok: boolean; value?: string; error?: string }>("tv_cdp_eval", { request: { expression, ...(port ? { port } : {}) } });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "TradingView bridge backend unavailable (rebuild the desktop app)." };
  }
}

/** Remote-link (LAN) server status: running + the URL/token to show as text/QR. */
export interface RemoteServerStatus {
  running: boolean;
  url?: string;
  token?: string;
  port?: number;
  error?: string;
}

/**
 * Start the desktop LAN relay so a phone on the same Wi-Fi can drive the assistant.
 * Best-effort: needs a desktop build that includes the `remote_server` command (rebuild the
 * desktop app), and real-device verification. On the web / older builds it degrades to a clear
 * error instead of throwing.
 */
export async function startRemoteServer(token: string, port?: number): Promise<RemoteServerStatus> {
  if (!isDesktop) return { running: false, error: "The phone link needs the desktop app." };
  try {
    return await invoke<RemoteServerStatus>("start_remote_server", { request: { token, ...(port ? { port } : {}) } });
  } catch (err) {
    return { running: false, error: err instanceof Error ? err.message : "Phone-link backend unavailable (rebuild the desktop app)." };
  }
}

export async function stopRemoteServer(): Promise<void> {
  if (!isDesktop) return;
  try {
    await invoke("stop_remote_server");
  } catch {
    /* already stopped or not present */
  }
}

/**
 * Current LAN relay status — so the UI can reuse an already-running server (same URL + pairing
 * token) instead of restarting it (which would mint a new token and drop any paired phone).
 * Returns `running: false` on the web / older builds.
 */
export async function remoteServerStatus(): Promise<RemoteServerStatus> {
  if (!isDesktop) return { running: false };
  try {
    return await invoke<RemoteServerStatus>("remote_server_status");
  } catch {
    return { running: false };
  }
}

/**
 * Run a stdio MCP server (desktop): spawn the command, write the JSON-RPC request lines to its
 * stdin, and return the server's stdout lines. Rejects on web / older builds (no command).
 */
export async function mcpStdioExchange(command: string, args: string[], input: string[]): Promise<string[]> {
  if (!isDesktop) throw new Error("stdio MCP servers need the desktop app.");
  return invoke<string[]>("mcp_stdio_exchange", { request: { command, args, input } });
}

/**
 * Open a live web page in its own desktop window (the in-app browser's "live" mode). The page
 * runs isolated — no Visual Reader APIs are exposed to it. Best-effort: needs a desktop build
 * with the `open_browser_window` command; degrades to a clear error on web / older builds.
 */
export async function openBrowserWindow(url: string): Promise<{ ok: boolean; error?: string }> {
  if (!isDesktop) return { ok: false, error: "Opening a live page needs the desktop app." };
  try {
    await invoke("open_browser_window", { url });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Live browser unavailable (rebuild the desktop app)." };
  }
}

/**
 * Capture a screenshot to PNG bytes (desktop), for the chat's screenshot tool.
 * `window` (a title substring) captures just that window — e.g. a game — even when
 * the app is focused; omit it to capture the primary screen. Only reached after the
 * reader approves the capture. Rejects on the web.
 */
export async function captureScreen(window?: string): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  const r = await invoke<{ bytesBase64: string; mimeType: string }>("capture_screen", window ? { window } : {});
  return { bytes: base64ToBytes(r.bytesBase64), mimeType: r.mimeType };
}

/** Subscribe to engine install/launch progress. Returns undefined on the web. */
export function onEngineProgress(handler: (p: EngineProgress) => void): Promise<UnlistenFn> | undefined {
  return tauri()?.event?.listen<EngineProgress>("engine://progress", (e) => handler(e.payload));
}

/** Subscribe to model-download progress. Returns undefined on the web. */
export function onModelProgress(handler: (p: ModelProgress) => void): Promise<UnlistenFn> | undefined {
  return tauri()?.event?.listen<ModelProgress>("model://progress", (e) => handler(e.payload));
}
