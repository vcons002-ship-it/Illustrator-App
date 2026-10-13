# Coding call receipts

Codex and Aider calls now display host-measured changes before the agent's own explanation:

```text
Codex: Finished (exit 0)
Workspace: C:/Projects/Example
Model: local-model
Files: 3 — 1 created, 1 modified, 1 deleted
Lines: +15 added / -6 removed

Created:
- src/new.ts — +12 / -0
Modified:
- src/old.ts — +3 / -2
Deleted:
- obsolete.ts — +0 / -4

Verification: No separate build/test command requested.
Agent report (self-reported):
...
```

The file paths are relative to the workspace shown, even when that folder is inside a larger
repository. Line counts mean additions and removals, not unique lines touched. A replacement can
count as both an addition and a removal. Binary changes have no line count. Renames are shown as
a deleted path and a created path.

## Measurement and safety

The desktop captures the real working tree immediately before and after the agent. Each capture
uses a private copy of Git's index to include untracked files and changes to already-dirty files.
This avoids attributing earlier uncommitted work to the latest call and works whether the agent
commits or leaves its work uncommitted. The real staging area, branches, and commits are unchanged
by receipt collection. Git tree/blob objects are written for comparison and are unreferenced;
normal Git garbage collection can prune them. Temporary index files are cleaned up.

Scope is Git-tracked and non-ignored workspace files. Internal `.vr-codex` caches/configuration
and `.vr-coding-task.md` are excluded. Changes made by another actor *during* the call can appear
in the receipt: this is a before/after comparison, not forensic proof of who edited a file.

If the native capture/comparison fails, filenames fall back to the existing best-effort detector.
Classification and line counts then say **unavailable**, never guessed or falsely zero. Output
limits and unsupported filename encodings fail explicitly rather than silently truncating counts.
Individual Git capture commands are bounded to 60 seconds, so a slow filter cannot indefinitely
hold up delegation or reporting.

Process failure, timeout, and separate verification failure remain visible even if files changed.
An exit code of zero means the agent finished; it does not prove the requested behavior works.
Agent-reported tests are labeled self-reported. Only a separately supplied verification command
gets a host-confirmed passed/failed status. Verification-generated artifacts are outside the
agent's before/after measurement.

Receipts are rendered into the chat's existing persisted tool messages and mirror to linked
clients. Deleted files appear in the receipt but are not added to the written-file ledger.
