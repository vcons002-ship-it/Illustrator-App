# External coding-agent delegation

The app can hand a hard, multi-file coding job to an **external open-source coding agent**
([Aider](https://aider.chat) by default, or [Codex CLI](https://developers.openai.com/codex/cli)
as a backup — a settings toggle) instead of grinding it out edit-by-edit with the in-app
`write_file`/`edit_file` tools. The app stays the orchestrator — conversation, the
plan/collar, VRAM coordination, the file ledger — and delegates the heavy edit loop to a
specialist whose whole job is exactly that.

This is **"Option A" (subprocess delegation)**: run the agent once with a written task, let
it edit the workspace and commit, then read back the diff. It's the pragmatic, available-today
integration. **"Option B" (ACP)** is the documented future upgrade — see the bottom.

## How it works

- Tool: `delegate_coding_task` (in `packages/core/src/chat/buddy-tools.ts`). Args: `task`
  (a full self-contained spec — the agent doesn't see the chat), optional `files` (known
  starting files), optional `verify` (a build/test command run after).
- Gating: desktop + **Allow commands** + the **"Delegate hard coding jobs to an external
  agent (Aider)"** setting + an Ollama chat model. The tool is only advertised to the model
  when all hold; the runtime additionally checks Aider is on `PATH` and returns a clear
  "install Aider" message if not.
- Pure command-building lives in `packages/core/src/chat/coding-agent.ts` (`buildAiderArgs`,
  `buildCodexArgs`, `buildCodexConfigToml`, `codexBaseUrl`, `agentChangedFiles`,
  `quotePosixCommand`, `ollamaApiBase`) — unit-tested without a shell.
- The desktop runner is `delegateCodingTask` in `apps/web/src/runtime.ts`: it detects the agent,
  writes the task to a file (so the prompt never hits the shell), makes sure the folder is a git
  repo, records the pre-run commit and the already-dirty files, runs the agent headless against the
  **same local Ollama model** the chat uses, reports what changed, and runs the optional verify
  command.
- Host wiring is `runDelegateCodingTask` in `apps/web/src/App.tsx` (mirrors `runEditFile`):
  it surfaces changed files into the file ledger and folds the run into the app-managed
  workflow as a command-style step (a clean run + verify pass satisfies the collar).
- **Architect/editor split for free:** when a sub-agent model (`subAgentModel`) is configured,
  Aider runs in `--architect` mode with the main model planning and the cheaper model applying
  edits — Aider's most reliable local-model mode (this is the "G9" idea, realized by Aider
  rather than re-implemented in-app).

## What a first real run taught us

Everything below was found by running it on a real box, and every one of them produced the same
misleading sentence — *"ran but changed no files"* — which reads as "your task was wrong, rewrite
it" when the truth was the opposite each time. They are recorded here because each was invisible to
a green test suite: the pure builders were checked against themselves, never against the CLI.

- **`--local-provider` is not a Codex flag.** The argv passed `--oss --local-provider ollama`, and an
  unknown flag makes `codex exec` exit on its own usage error before doing any work. Delegation via
  Codex could never have succeeded.
- **`OLLAMA_HOST` is not a variable Codex reads.** It was being set as the way to point Codex at the
  local server, and had no effect at all — so Codex used whatever the reader's own
  `~/.codex/config.toml` said, which for anyone who has ever run Codex normally is an OpenAI model.
  A local-only machine quietly sent the job to the cloud and answered from `gpt-5.6`.
  The fix is a generated `config.toml` in `<workspace>/.vr-codex`, selected with `CODEX_HOME` —
  a file, so there is no TOML-inside-a-shell-argument quoting problem on either `sh` or `cmd`, and
  written inside the workspace so delegation never edits the reader's own Codex setup.
- **`base_url` keeps its `/v1` for Codex** and must NOT for Aider. Same setting, two shapes:
  `ollamaApiBase` strips it (Aider appends the OpenAI path itself), `codexBaseUrl` keeps it.
  `wire_api = "responses"` is the pairing Ollama documents for Codex.
- **Four minutes was not a deadline, it was a guillotine.** `run_command` capped every command at
  `COMMAND_TIMEOUT_SECS` (240s); an agent editing several files against a local 27B model runs for
  tens of minutes, so it was killed mid-edit — a half-applied change AND a report of no change.
  `run_command` now takes an optional per-call `timeout_secs`, clamped to `[240s, 3h]` by the host so
  it can only ever EXTEND a wait; delegation asks for 90 minutes. A run stopped at the deadline now
  says so, because "split the task" and "rewrite the task" are opposite next steps.
- **The diff saw only committed work.** `git diff <sha> HEAD` compares two *commits*. Aider commits;
  Codex edits the working tree and leaves committing to you, so its work was invisible — and a
  brand-new file is untracked, so a plain diff missed it either way. The obvious repair, staging
  first, is worse than the bug: `git add -A` reaches the whole repository from any subdirectory, so a
  workspace inside the reader's own project would sweep up unrelated work, and a baseline commit
  would bury it. `agentChangedFiles` instead unions `git diff --name-only <baseline>` (committed)
  with `git status --porcelain` (modified + untracked), subtracting what was already dirty before the
  run. Entirely read-only.
- **The workspace was not a repo.** The whole report is a git diff, so a plain directory — which the
  default workspace is — reported nothing regardless. It also earns Codex's trust, which refuses a
  folder it doesn't recognize as a repo ("Not inside a trusted directory"). `gitEnsureRepo` returns
  an enclosing repo when there is one, so a folder inside the reader's own project is joined rather
  than re-initialized.

## What the SECOND real run taught us

The fixes above got Codex as far as running. What came back was worse than a clean failure: the app
reported "changed 1 file(s)", the assistant believed a project had been produced, went looking for
`main.py` and `test_main.py`, found only a `README.md`, and reported the wrong problem entirely.

- **The one changed file was ours.** `git status --porcelain` reports an untracked DIRECTORY as a
  single `?? dir/` entry rather than listing its contents, so excluding `.vr-codex/config.toml` by
  exact path never matched the `?? .vr-codex/` git actually printed. Fixed with `-uall` (which lists
  the files) plus a directory-aware exclusion, belt and braces — the collapsed form is what git emits
  by default and the expanded form is what we now ask for.
- **A count is not evidence.** The summary said "changed N file(s)" and named nothing, so neither the
  assistant nor the reader could see that the one file was scaffolding. It now always lists the
  paths, and tells the model to check their contents before reporting success — an agent's claim
  about its own work is not evidence that the work exists.
- **The agent's output was dropped exactly when it mattered.** The tail was shown only when NOTHING
  changed; a run that half-worked, failed verify, or errored after touching one file lost the one
  explanation it had produced. It is now included whenever the run did not cleanly succeed.

Still open after that run, and NOT yet explained: Codex reported creating two files that never
appeared on disk. With the leak above fixed, a repeat will say "changed NO files" and carry Codex's
own output, which is the evidence needed to tell a sandbox/working-directory problem from a model
that simply narrated work it never did.

## Caveats (need a real-box pass)

Everything pure is unit-tested, but the runtime path can't be exercised in CI here:

- **Optional dependency:** the user must `pipx install aider-chat` (or `npm i -g @openai/codex`).
  The app detect-and-offers; it never assumes the agent is present.
- **A local chat model must actually be installed.** Codex pinned to Ollama can only run a model
  Ollama has. The generated config names the app's configured chat model, so if that model isn't
  pulled, the run fails at the provider rather than falling back to a cloud model — which is the
  intended behaviour, but the error comes from Codex and not from us.
- **VRAM contention:** Aider hits the same Ollama server as the in-app chat model. With the
  architect/editor split that's potentially two models loaded; coordinate (or use one model)
  on a constrained GPU.
- **Less per-step control:** the external agent runs its own inner loop, so the app's
  evidence-based collar supervises the *task boundary* (did the diff build/test?) rather than
  each inner edit. That's the intended trade-off.
- **Cross-platform shell:** the runner builds a POSIX command by default and a minimal
  `cmd`/PowerShell variant on Windows; verify the Windows path on a real box.

## Future: Option B — Agent Client Protocol (ACP)

Zed's [Agent Client Protocol](https://zed.dev/acp) is the durable way to embed an external
agent *inside* our chat UI: the app becomes an ACP **client** that speaks JSON-RPC over stdio
to the agent subprocess, streams its progress, and answers its callbacks (read-file,
write-file, request-permission) against our workspace + worktree + approval UI. Codex, Gemini,
and Claude Code ship ACP adapters today; an **Aider ACP adapter is in progress**.

Why we did Option A first: ACP is a whole protocol to implement on both halves (a message
loop plus every callback handler), and the agent we want most for local Ollama (Aider) doesn't
speak it yet. Option A answers "is delegation useful?" in a fraction of the surface area; if
the answer is yes, ACP is the natural productization. Migration path: keep `delegate_coding_task`
as the in-app fallback, add an ACP client transport, and route to it when an ACP-capable agent
is configured.
