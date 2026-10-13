# Coding-agent context handoff

Both direct `/code` and ordinary `delegate_coding_task` hand off actual context text in
`.vr-coding-task.md`, before starting Codex/Aider. The current task remains first and authoritative.
The app resolves/creates the selected chat/project workspace before staging the task; it rejects a
chat switch during preparation rather than accidentally mixing another chat with the workspace.

The handoff includes:

- Active chat/project labels and up to 20 recent nonempty visible messages, oldest to newest.
  Chat text has a 10,000-character serialized budget; individual messages are shortened.
- The active checklist goal, steps, completion notes, deliverables and verification commands.
- Workspace-relative paths from the chat's file ledger and explicitly supplied `files`.
  These are hints, not a guarantee the file exists or additional permission to modify it.
- Existing `AGENTS.override.md`, `AGENTS.md`, `CONVENTIONS.md`, `README.md`,
  `notes/project-context.md`, `notes/decisions.md`, `notes/current-task.md`, in that order.
  Documents have a shared 10,000-character budget and an individual 3,200-character excerpt cap.
  A nonempty `AGENTS.override.md` supersedes `AGENTS.md` at the same directory level.

Native context reads are read-only, allowlisted, limited to 12,000 bytes per file, and reject
symlinks/junctions resolving outside the selected workspace. Missing optional notes are normal.
Unsupported older desktop hosts report them unavailable, not silently missing or loaded elsewhere.
The receipt displays sources included, omitted/shortened message counts, note availability,
context size and best-effort secret redactions. It reports the handoff, not proof the model used it.

Only the active conversation is included. The app does **not** merge other project chats, hidden
reasoning, system prompts, image bytes, Soul profiles, preference memory, or application settings.
Visible text can still contain personal information. Recognizable API/GitHub tokens, passwords,
Bearer tokens and private-key blocks are redacted from automatic context on a best-effort basis;
this is not a comprehensive secret detector. The explicit coding task is not rewritten/redacted.

Project notes are durable files you or the agent can maintain when requested; the app reads them
again on each call, including from a different chat in the same project. It does **not** automatically
create/overwrite these notes or claim that bounded chat excerpts are a complete project memory.
Keep long-lived requirements and decisions in these files when they must survive chat switches.
The staged prompt is a replaceable app artifact, excluded from change receipts, not a durable log.

Quoted chat/tool/document content is labeled as background rather than new permissions. Applicable
AGENTS instructions and relevant source files still need to be read by the agent. The handoff is
not a security sandbox and cannot guarantee protection against malicious workspace instructions.
Codex's own instruction loading remains independent of the app's excerpt budget:
[official AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

A phone request targeting a different workspace gets notes from that workspace, but not the
desktop's unrelated active chat. Parallel worktree agents retain their existing explicit task
handoffs; this change does not inject unrelated chat history into independent worktrees.
