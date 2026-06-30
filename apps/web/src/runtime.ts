/**
 * Runtime detection + thin bridge to the desktop shell.
 *
 * In the browser these are inert (isDesktop = false) and the local-GPU features
 * are hidden. Inside the Tauri desktop app, `window.__TAURI__` is present and the
 * Rust commands below manage the local inference engine (install/launch + model
 * downloads) so the renderer never deals with processes, ports, or CORS.
 */

import { base64ToBytes, classifyLoraHeader, parseNvidiaVramCsv, summarizeVram, type LocalFile, type CodingAgentBackend, type VramSummary } from "@visual-reader/core";

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
  folder?: "checkpoints" | "diffusion_models" | "text_encoders" | "vae" | "loras" | "latent_upscale_models";
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

/** Stop the bundled text model to free its VRAM for a burst of local image renders on the same
 * GPU. The next {@link ensureLocalLlm} relaunches it cold. No-op on the web / when nothing runs. */
export function stopLocalLlm(): Promise<void> {
  return invoke<void>("stop_llm");
}

/** Fully relaunch the desktop app (kills the bundled engine/LLM children on the way out). The call
 * never resolves — the process restarts. No-op on the web. */
export function restartApp(): Promise<void> {
  return invoke<void>("restart_app");
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

/**
 * Whole-GPU VRAM usage for the status-bar indicator (desktop + NVIDIA only), via `nvidia-smi`.
 * Its `memory.used` counts ALL processes, so a co-resident LLM is included — unlike ComfyUI's
 * /system_stats, which sees only its own torch context (the reason the indicator otherwise tracks
 * image-model VRAM but not LLM VRAM). undefined on web / no NVIDIA / any failure, so the caller
 * falls back to the engine's own reading.
 */
export async function gpuVramUsage(): Promise<VramSummary | undefined> {
  if (!isDesktop) return undefined;
  try {
    const csv = await invoke<string | null>("gpu_vram_usage");
    return csv ? summarizeVram(parseNvidiaVramCsv(csv)) : undefined;
  } catch {
    return undefined;
  }
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

/** Statuses a Response may not carry a body for (so `new Response(body, …)` doesn't throw). */
const NO_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * A `fetch`-shaped function backed by the Rust HTTP bridge (CORS-exempt), for MAIN-THREAD callers
 * that must reach a localhost server the WebView origin can't. The browser applies CORS to a plain
 * `fetch`, and in the PACKAGED desktop app the WebView origin is the Tauri custom scheme
 * (`http://tauri.localhost`), NOT the `http://localhost:5173` dev origin — so a self-hosted
 * AUTOMATIC1111 / ComfyUI server whose `--cors-allow-origins` was set for the dev origin blocks the
 * request. Routing through the Rust shell (same path the engine worker uses) makes CORS irrelevant.
 */
export async function desktopFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input as RequestInfo, init);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let bodyBase64: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.clone().arrayBuffer();
    if (body.byteLength > 0) bodyBase64 = bytesToBase64(new Uint8Array(body));
  }
  const reply = await desktopHttpFetch({ url: req.url, method: req.method, headers, ...(bodyBase64 ? { bodyBase64 } : {}) });
  if (reply.error || reply.status === 0) {
    throw new TypeError(reply.error ?? "The desktop fetch bridge failed.");
  }
  const bytes = reply.bodyBase64 ? base64ToBytes(reply.bodyBase64) : new ArrayBuffer(0);
  // The native fetch already decoded the body to identity bytes; drop the hop-by-hop/length headers
  // so `Response` doesn't claim a now-wrong content-length or an encoding the bytes no longer carry.
  const replyHeaders = { ...reply.headers };
  for (const k of Object.keys(replyHeaders)) {
    const lk = k.toLowerCase();
    if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding") delete replyHeaders[k];
  }
  return new Response(NO_BODY_STATUS.has(reply.status) ? null : bytes, {
    status: reply.status,
    statusText: reply.statusText,
    headers: replyHeaders,
  });
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
 * Open an existing file or folder in the OS default app (the "Open on PC" file-card
 * action; desktop only). The path must already exist on disk — typically the path
 * `saveExportFile` returned after writing to ~/VisualReader/exports. No-op on web.
 */
export async function openPathOnPC(path: string): Promise<void> {
  if (!isDesktop) return;
  await invoke("open_path", { path });
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
  /** The directory the command actually ran in (so the assistant/reader see WHERE it ran). */
  cwd?: string;
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
 * The Visual Reader SOURCE repo root (the clone the app runs from), or undefined on the web / when
 * the app isn't inside a git checkout. Used by the in-app "Software update" button to git-pull +
 * rebuild the web bundle in place. Best-effort: returns undefined rather than throwing on older
 * builds without the command.
 */
export async function appRepoRoot(): Promise<string | undefined> {
  if (!isDesktop) return undefined;
  try {
    return (await invoke<string | null>("app_repo_root")) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a working interpreter for the chat's ▶ Run button (`python`/`node`/`sh`) — returns a
 * shell-ready token to prepend (e.g. `python3`, `py -3`, or a quoted absolute path), or undefined
 * when none is installed (the caller then shows a clear "install X" message) or off the desktop.
 */
export async function whichInterpreter(kind: "python" | "node" | "sh"): Promise<string | undefined> {
  if (!isDesktop) return undefined;
  try {
    return (await invoke<string | null>("which_interpreter", { kind })) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a file the assistant authored (a script, data, config) INTO the desktop workspace so it can
 * then be run via {@link runCommand}. `relPath` is workspace-relative; the Rust side sanitizes it so
 * it can never escape the workspace folder. `cwd` pins the session's chosen working folder (else the
 * default workspace). Returns the absolute path written. Rejects on the web (no filesystem). Only
 * reached when Autonomous workspace is on (no per-write click) — see the write_file tool.
 */
export function writeWorkspaceFile(relPath: string, content: string, cwd?: string, append?: boolean): Promise<string> {
  const contentBase64 = bytesToBase64(new TextEncoder().encode(content));
  return invoke<string>("write_workspace_file", { relPath, contentBase64, ...(cwd ? { cwd } : {}), ...(append ? { append: true } : {}) });
}

/**
 * Read a workspace-RELATIVE file (the counterpart to {@link writeWorkspaceFile}): the Rust side resolves
 * + sanitizes the path the SAME way (never escapes the workspace) and returns `{ exists, text }` —
 * `exists:false` (not an error) when the file is absent, so callers can check existence cheaply. Used by
 * `edit_file` (read-modify-write), the AGENTS.md project guide, and deliverable verification. Rejects on
 * the web (no filesystem).
 */
export async function readWorkspaceFile(
  relPath: string,
  cwd?: string,
): Promise<{ exists: boolean; path: string; text: string }> {
  const r = await invoke<{ exists: boolean; path: string; bodyBase64: string }>("read_workspace_file", {
    relPath,
    ...(cwd ? { cwd } : {}),
  });
  return {
    exists: r.exists,
    path: r.path,
    text: r.exists ? new TextDecoder().decode(base64ToBytes(r.bodyBase64)) : "",
  };
}

/** Does a workspace-relative file exist (and is a file)? Convenience over {@link readWorkspaceFile}. */
export async function workspaceFileExists(relPath: string, cwd?: string): Promise<boolean> {
  return (await readWorkspaceFile(relPath, cwd)).exists;
}

// --------------------------------------------- External coding agent (Aider)
//
// "Option A" delegation: hand a hard, multi-file coding job to Aider running HEADLESS against the
// same local Ollama model, in the workspace folder, and capture the resulting git diff. The app
// stays the orchestrator; Aider does the edit loop. Pure command-building lives in core
// (coding-agent.ts); this is the desktop runner that spawns it via the existing run_command bridge.
// Desktop-only. The forward-looking "Option B" (embedding an agent over Zed's ACP) is tracked
// separately as a future upgrade.

export interface DelegateCodingResult {
  /** The agent ran AND (if a verify command was given) it passed. */
  ok: boolean;
  /** False when Aider isn't on PATH — the caller tells the model to install it or do it by hand. */
  installed: boolean;
  /** Model-facing summary: files changed + diffstat + verify outcome, or why it couldn't run. */
  summary: string;
  /** Workspace-relative paths the agent changed (for the host's file ledger + attachments). */
  files: string[];
}

export interface DelegateCodingOpts {
  task: string;
  /** Which external agent to drive: "aider" (default) or "codex". A user setting. */
  backend?: CodingAgentBackend;
  /** Ollama model id (Aider prefixes "ollama/"; Codex takes it bare via --oss). */
  model: string;
  /** Optional cheaper editor model → Aider's architect/editor split (ignored by Codex). */
  editorModel?: string;
  /** The app's LLM server URL (e.g. http://localhost:11434/v1) — the agent's Ollama base is derived. */
  textServerUrl: string;
  files?: string[];
  verify?: string;
  cwd?: string;
  githubToken?: string;
  shell?: "cmd" | "powershell";
}

/** Workspace-relative file the task prompt is written to (so it never has to be shell-escaped). */
const CODING_TASK_FILE = ".vr-coding-task.md";

/**
 * Run an external coding agent (Aider, or Codex CLI as the backup backend) headless on a coding task
 * and report what changed. Detects the chosen agent on PATH first (returns `installed:false` cleanly
 * when absent), writes the prompt to a file, records the pre-run commit, runs the agent against the
 * local Ollama model, then diffs to summarize the changes and (optionally) runs a verify command.
 * Best-effort + never throws — failures come back in `summary`. Desktop-only.
 */
export async function delegateCodingTask(opts: DelegateCodingOpts): Promise<DelegateCodingResult> {
  if (!isDesktop) return { ok: false, installed: false, summary: "(coding delegation is desktop-only)", files: [] };
  const backend: CodingAgentBackend = opts.backend ?? "aider";
  const label = backend === "codex" ? "Codex" : "Aider";
  const bin = backend === "codex" ? "codex" : "aider";
  const { buildAiderArgs, buildCodexArgs, quotePosixCommand, ollamaApiBase } = await import("@visual-reader/core");
  const run = (command: string) => runCommand(command, opts.githubToken, opts.cwd, opts.shell);

  // 1) Is the chosen agent installed?
  try {
    const v = await run(`${bin} --version`);
    if (v.code !== 0) return { ok: false, installed: false, summary: `${label} isn't installed.`, files: [] };
  } catch {
    return { ok: false, installed: false, summary: `${label} isn't installed.`, files: [] };
  }

  // 2) Stage the prompt as a file + record the pre-run commit (for the diff).
  await writeWorkspaceFile(CODING_TASK_FILE, opts.task, opts.cwd);
  let beforeSha = "";
  try {
    const r = await run("git rev-parse HEAD");
    if (r.code === 0) beforeSha = r.stdout.trim();
  } catch {
    /* not a git repo / no commits yet — the agent may auto-init; we fall back to a working-tree diff */
  }

  // 3) Build + run the agent against the local model. Aider takes the prompt via --message-file;
  //    Codex `exec -` reads it from STDIN (we redirect the same staged file in). Each gets the Ollama
  //    base via its own env var (Aider: OLLAMA_API_BASE; Codex: OLLAMA_HOST).
  const base = ollamaApiBase(opts.textServerUrl);
  const isWin = opts.shell === "cmd" || opts.shell === "powershell";
  let command: string;
  if (backend === "codex") {
    const argv = ["codex", ...buildCodexArgs({ model: opts.model })];
    command = isWin
      ? `set "OLLAMA_HOST=${base}" && ${argv.join(" ")} < ${CODING_TASK_FILE}`
      : `OLLAMA_HOST=${base} ${quotePosixCommand(argv)} < ${quotePosixCommand([CODING_TASK_FILE])}`;
  } else {
    const argv = ["aider", ...buildAiderArgs({
      messageFile: CODING_TASK_FILE,
      model: opts.model,
      ...(opts.editorModel ? { editorModel: opts.editorModel } : {}),
      ...(opts.files ? { files: opts.files } : {}),
    })];
    command = isWin
      ? `set "OLLAMA_API_BASE=${base}" && ${argv.join(" ")}`
      : `OLLAMA_API_BASE=${base} ${quotePosixCommand(argv)}`;
  }
  const agent = await run(command);

  // 4) Summarize what changed (committed range when we have a base, else the working tree).
  const range = beforeSha ? `${beforeSha} HEAD` : "";
  let stat = "";
  let names: string[] = [];
  try {
    stat = (await run(`git diff --stat ${range}`)).stdout.trim();
    const nm = (await run(`git diff --name-only ${range}`)).stdout.trim();
    names = nm ? nm.split(/\r?\n/).filter(Boolean) : [];
  } catch {
    /* diff is best-effort */
  }
  const changed = names.length > 0 || stat.length > 0;

  // 5) Optional verify (build/test) so success is checked, not assumed.
  let verifyLine = "";
  let verifyOk = true;
  if (opts.verify) {
    try {
      const vr = await run(opts.verify);
      verifyOk = vr.code === 0;
      const tail = (vr.stdout + vr.stderr).trim().slice(-1200);
      verifyLine = `\nVerify \`${opts.verify}\`: ${verifyOk ? "PASSED" : `FAILED (exit ${vr.code})`}${tail ? `\n${tail}` : ""}`;
    } catch (e) {
      verifyOk = false;
      verifyLine = `\nVerify \`${opts.verify}\`: could not run (${e instanceof Error ? e.message : String(e)})`;
    }
  }

  const ok = (agent.code === 0 || changed) && verifyOk;
  const summary = changed
    ? `[delegate_coding_task: ${label} changed ${names.length} file(s):\n${stat || names.join("\n")}${verifyLine}` +
      `\nReview the diff; if something's off, fix it with edit_file or delegate again with a sharper task.]`
    : `[delegate_coding_task: ${label} ran but changed no files (exit ${agent.code}). Output tail:\n` +
      `${(agent.stdout + agent.stderr).trim().slice(-1200)}${verifyLine}\nTry a clearer task, or do it yourself with write_file/edit_file.]`;
  return { ok, installed: true, summary, files: names };
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

export interface ConflictVersions {
  base: string;
  ours: string;
  theirs: string;
}

/** The three merge stages (base/ours/theirs) of a conflicted file, for auto-resolution. */
export function gitConflictVersions(repoDir: string, file: string): Promise<ConflictVersions> {
  return invoke<ConflictVersions>("git_conflict_versions", { repoDir, file });
}

/** Complete a conflicted merge after resolved files were written — REFUSES (non-zero code) if any
 * path is still unmerged or any staged content carries conflict markers, then commits. */
export function gitCompleteMerge(repoDir: string, message: string): Promise<CommandResult> {
  return invoke<CommandResult>("git_complete_merge", { repoDir, message });
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
