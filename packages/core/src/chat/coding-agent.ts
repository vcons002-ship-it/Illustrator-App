/**
 * Building blocks for delegating a scoped coding task to an EXTERNAL open-source coding agent —
 * Aider, run headless against the SAME local Ollama model the chat already uses. The app stays the
 * orchestrator (conversation, plan/collar, VRAM coordination, the file ledger) and hands the heavy
 * edit loop to a specialist whose whole job is exactly that. The desktop runner that spawns these
 * and captures the resulting git diff lives in `apps/web/src/runtime.ts` (`delegateCodingTask`).
 *
 * Everything here is PURE + platform-agnostic — the argv, the POSIX command string, the base-URL
 * derivation — so it unit-tests without a shell. The impure parts (spawning, diff capture, PATH
 * detection) live in the desktop runtime.
 *
 * This is the "Option A" delegation spike; "Option B" (embedding an agent over Zed's Agent Client
 * Protocol so it streams + calls back for permissions) is the documented future upgrade.
 */

/** Cap on the delegated task prompt (it's handed to Aider via a message FILE, never the shell). */
export const MAX_DELEGATE_TASK_CHARS = 8_000;
/** Cap on how many files the model may seed the agent's editing context with. */
export const MAX_DELEGATE_FILES = 20;

export interface AiderTaskSpec {
  /** Workspace-relative path to a file holding the task prompt (keeps the prompt off the shell). */
  messageFile: string;
  /** Ollama model id WITHOUT the "ollama/" prefix — Aider's LiteLLM convention adds it. */
  model: string;
  /** Optional cheaper editor model → Aider's architect/editor split (strong planner + fast editor). */
  editorModel?: string;
  /** Files to seed Aider's editing context (workspace-relative), when the model named them. */
  files?: string[];
}

/**
 * The argv for ONE non-interactive Aider run: apply automatically (`--yes-always`), no token
 * streaming, no cloud model-warning noise, the model (or architect+editor pair) pinned to Ollama,
 * optional seed files, and the task read from a FILE so its text never touches the shell. PURE.
 */
export function buildAiderArgs(spec: AiderTaskSpec): string[] {
  const args = ["--yes-always", "--no-stream", "--no-show-model-warnings"];
  if (spec.editorModel) {
    args.push("--architect", "--model", `ollama/${spec.model}`, "--editor-model", `ollama/${spec.editorModel}`);
  } else {
    args.push("--model", `ollama/${spec.model}`);
  }
  for (const f of (spec.files ?? []).slice(0, MAX_DELEGATE_FILES)) {
    if (f.trim()) args.push(f);
  }
  args.push("--message-file", spec.messageFile);
  return args;
}

const POSIX_SAFE = /^[A-Za-z0-9_./:@%+=-]+$/;
/** One token, POSIX-quoted only when it contains anything outside a shell-safe set. */
function posixQuote(token: string): string {
  if (token.length > 0 && POSIX_SAFE.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/** Join argv into one POSIX shell command string, quoting each token as needed. PURE. */
export function quotePosixCommand(parts: string[]): string {
  return parts.map(posixQuote).join(" ");
}

/**
 * Aider's `OLLAMA_API_BASE` from the app's configured LLM server URL: Ollama's OpenAI-compatible URL
 * ends in `/v1` (e.g. http://localhost:11434/v1) but Aider/LiteLLM want the ROOT. Strips a trailing
 * `/v1` and any trailing slash. PURE.
 */
export function ollamaApiBase(textServerUrl: string): string {
  return textServerUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}
