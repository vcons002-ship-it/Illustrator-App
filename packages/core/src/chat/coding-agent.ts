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

/** Cap on the delegated task prompt. It's handed to the agent via a FILE / stdin (never the shell),
 * so there's no OS arg-length limit — this is just a sanity bound, kept generous so a detailed
 * multi-file spec isn't clipped. Over it, the parse flags truncation so the model is warned. */
export const MAX_DELEGATE_TASK_CHARS = 32_000;
/** Cap on how many files the model may seed the agent's editing context with. */
export const MAX_DELEGATE_FILES = 20;

/** Which external coding agent backend runs a delegate_coding_task (a user setting). */
export type CodingAgentBackend = "aider" | "codex";

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

export interface CodexTaskSpec {
  /** Ollama model id, also pinned in the generated config (see buildCodexConfigToml). */
  model: string;
}

/**
 * The argv for ONE non-interactive Codex run (the backup backend): `exec` reads the task prompt from
 * STDIN (the trailing `-`), `--full-auto` applies edits without prompting, and `--skip-git-repo-check`
 * lets it start even before the runtime's `git init` has landed. The prompt is piped in by the runtime
 * (so it never touches the shell); Codex takes the editing scope from the prompt, not file args. PURE.
 *
 * WHICH MODEL IT RUNS IS NOT SET HERE — it is set by the config file the runtime generates and points
 * `CODEX_HOME` at. This used to pass `--oss --local-provider ollama`, and `--local-provider` is not a
 * Codex flag at all: an unknown flag makes `codex exec` exit on its own usage error before it does any
 * work, which is why a delegated run could only ever fail. `-m` is still passed, so the model is
 * stated in both places and a config that failed to write cannot silently hand the job to a cloud
 * model — the failure mode a reader actually hit, watching a local-only setup answer from gpt-5.6.
 */
export function buildCodexArgs(spec: CodexTaskSpec): string[] {
  return ["exec", "-m", spec.model, "--full-auto", "--skip-git-repo-check", "-"];
}

/**
 * The `config.toml` that pins Codex to the reader's own Ollama server. PURE.
 *
 * Written to a directory the runtime points `CODEX_HOME` at, rather than passed as `-c` overrides,
 * because the override form needs a TOML string nested inside a shell argument — two quoting systems
 * deep, on both `sh` and `cmd`. A file has no quoting at all.
 *
 * `base_url` KEEPS its `/v1`, which is the opposite of what Aider wants from the same setting
 * (`ollamaApiBase` strips it): Aider is given the server root and appends the OpenAI path itself,
 * Codex is given the OpenAI-compatible endpoint whole. `wire_api = "responses"` is the pairing
 * Ollama documents for Codex. No `env_key`, so no API key is required or looked for.
 */
export function buildCodexConfigToml(spec: { model: string; baseUrl: string }): string {
  return [
    "# Generated by Visual Reader for delegate_coding_task. Edits here are overwritten each run.",
    'model_provider = "vr-ollama"',
    `model = ${JSON.stringify(spec.model)}`,
    "",
    "[model_providers.vr-ollama]",
    'name = "Ollama (Visual Reader)"',
    `base_url = ${JSON.stringify(spec.baseUrl)}`,
    'wire_api = "responses"',
    "",
  ].join("\n");
}

/** Codex's OpenAI-compatible endpoint for a configured LLM server URL: the server root plus `/v1`,
 * normalized so a URL that already carries it isn't doubled. PURE. */
export function codexBaseUrl(textServerUrl: string): string {
  return `${ollamaApiBase(textServerUrl)}/v1`;
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

/**
 * The paths in `git status --porcelain` output. PURE.
 *
 * Each line is `XY path`, where XY is the two-character status and the path starts at column 3. A
 * rename is reported as `old -> new`, and only the new name is a file that now exists. Quoted paths
 * (git quotes anything with unusual characters) are unwrapped so the name matches what is on disk.
 */
export function parsePorcelainPaths(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue;
    let path = line.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path) out.push(path);
  }
  return out;
}

/**
 * WHAT THE AGENT CHANGED, from the two things git can tell us without being asked to modify
 * anything. PURE.
 *
 * The run has to be reported WITHOUT staging or committing, because the working folder may sit
 * inside the reader's own repository — where `git add -A` reaches the whole repo, and a baseline
 * commit would sweep up work that has nothing to do with this task.
 *
 * So both halves are read-only, and it takes both. `git diff --name-only <baseline>` sees what was
 * COMMITTED (Aider commits its work) and nothing else; `git status --porcelain` sees what is
 * modified or untracked (Codex edits the tree and leaves committing to you) and nothing that was
 * already committed. Subtracting the files that were ALREADY dirty before the run is what keeps the
 * folder's pre-existing mess from being reported as the agent's doing.
 */
export function agentChangedFiles(input: {
  /** `git status --porcelain` before the run. */
  dirtyBefore: string;
  /** `git status --porcelain` after the run. */
  dirtyAfter: string;
  /** `git diff --name-only <baseline>` after the run — what got committed. */
  committed: string;
  /** Scaffolding of our own that must never be reported as the agent's work. */
  exclude?: readonly string[];
}): string[] {
  const before = new Set(parsePorcelainPaths(input.dirtyBefore));
  const skip = new Set(input.exclude ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string): void => {
    const path = p.trim();
    if (!path || skip.has(path) || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const p of parsePorcelainPaths(input.dirtyAfter)) if (!before.has(p)) add(p);
  for (const p of input.committed.split(/\r?\n/)) add(p);
  return out;
}
