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
  `quotePosixCommand`, `ollamaApiBase`) — unit-tested without a shell.
- The desktop runner is `delegateCodingTask` in `apps/web/src/runtime.ts`: it detects Aider,
  writes the task to a file (so the prompt never hits the shell), records the pre-run commit,
  runs Aider headless against the **same local Ollama model** the chat uses, diffs to summarize
  what changed, and runs the optional verify command.
- Host wiring is `runDelegateCodingTask` in `apps/web/src/App.tsx` (mirrors `runEditFile`):
  it surfaces changed files into the file ledger and folds the run into the app-managed
  workflow as a command-style step (a clean run + verify pass satisfies the collar).
- **Architect/editor split for free:** when a sub-agent model (`subAgentModel`) is configured,
  Aider runs in `--architect` mode with the main model planning and the cheaper model applying
  edits — Aider's most reliable local-model mode (this is the "G9" idea, realized by Aider
  rather than re-implemented in-app).

## Caveats (need a real-box pass)

Everything pure is unit-tested, but the runtime path can't be exercised in CI here:

- **Optional dependency:** the user must `pipx install aider-chat`. The app detect-and-offers;
  it never assumes Aider is present.
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
