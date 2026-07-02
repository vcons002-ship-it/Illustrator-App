# Improvement Plan — full-app audit (July 2026)

A four-track audit (UI components · web-app host · core logic · desktop shell + product) produced
this plan. The **easy wins were implemented immediately** (see "Shipped with this audit" at the
bottom); everything else is planned here, ordered by priority within each phase. Each item names
the exact files/lines so it can be picked up cold.

Legend: 🔴 high · 🟡 medium · 🟢 low — severity/impact if left unfixed.

**Status (July 2026): Phases 1–4 are shipped.** Phase 1 + 2 landed in the reliability/parity PR;
Phase 3 (modal shell, keyboard access, tokens, small fixes, library search/sort) and Phase 4
(Creations gallery, toast system, docs truth pass incl. TROUBLESHOOTING.md + CHANGELOG.md) landed in
the follow-up PR. 4.5 was decided as **Windows-first** (documented in README/SETUP); 4.6 is
**deferred** (see the item). Phase 5 remains deferred by design — pick up any item when a feature
forces that seam open.

---

## Phase 1 — Reliability (do first)

### 1.1 🔴 Engine-worker crash recovery
`apps/web/src/useEngineWorker.ts:1255-1264` — `worker.onerror` only sets a status string. The ~25
pending-request maps (lines ~533-614) are never rejected: a crashed worker strands every in-flight
chat/render/plan promise forever and leaves `generating` stuck.
**Plan:** one `failAllPending(reason)` helper that iterates every request map, rejects/resolves-with-error
each entry, clears `generating`/`paused`, then recreates the worker (same init path as mount). Call it
from `onerror` and from a manual "Restart engine" button in Settings. Test by `worker.terminate()` in dev.

### 1.2 🔴 Orphaned GPU processes (Rust)
`apps/desktop/src-tauri/src/main.rs:2415-2421, 2469-2475, 2799-2806` — a spawn that fails its 180s
readiness poll drops the `Child` (process keeps running, holding VRAM, never killed on exit); crash/task-kill
of the app orphans all children; and `child.kill()` doesn't kill the `cmd /c webui-user.bat` process TREE.
**Plan:** (a) store-or-kill the child before returning the timeout error at all three sites; (b) Windows Job
Object with `KILL_ON_JOB_CLOSE` (one small unsafe block, kills children on parent death for free);
(c) `taskkill /T /F` fallback for tree-kill on stop. Verify with Task Manager on a real render box.

### 1.3 🔴 SSRF hardening for `http_fetch`
`main.rs:453-515` — the CORS proxy fetches ANY http(s) URL for the model; a prompt-injected page can
pivot to `http://169.254.169.254/`, `127.0.0.1:*`, or LAN admin panels.
**Plan:** resolve the host before fetching; deny loopback/link-local/RFC-1918 targets unless the URL was
explicitly user-initiated (the engine's own localhost calls don't go through this proxy — verify with a
grep for `http_fetch` call sites, then deny-by-default). Add a Rust unit test for the classifier.

### 1.4 🔴 `read_file` scope (model can read any file)
`main.rs:1442-1467` — the model's file tools can read any absolute path (`~/.ssh`, browser profiles).
**Plan:** maintain an approved-roots list (workspace + folders the user picked via the folder picker or
`search_files` results the user clicked); anything else returns "needs approval" and surfaces the same
approval card the command tool uses. Also validate the `cwd` param of `run_command`/workspace file ops
against approved roots (`main.rs:1103-1113, 1649-1660`).

### 1.5 🟡 Phone↔desktop settings echo race
`App.tsx` (`vrcmd:settings` at ~2725 / `vrsync:settings` apply at ~2699) — per-keystroke full-settings
relay; a late desktop echo clobbers what the phone user typed meanwhile.
**Plan:** debounce the phone's `vrcmd:settings` send (400ms, same as the worker identity sync), and skip
applying an inbound mirror that is deep-equal to current local state. Optionally stamp settings frames
with a monotonic counter and drop stale ones.

### 1.6 🟡 Silent IndexedDB quota loss
`App.tsx` — ~104 bare `catch(() => {})`, including `libraryStore.putBook` (2131, 2168, 4819, 5187).
Quota exhaustion silently stops persisting books/chats.
**Plan:** one `persistOrWarn(promise, label)` helper that catches, detects `QuotaExceededError`, and
surfaces ONE activity-log entry + status-bar warning (not a modal per write). Route store writes through it.
Also fix `indexeddb-store.ts:113` (prefix-range delete can hit sibling ids — bound the range with a
separator) and add `onblocked` handling at :281.

### 1.7 🟡 Worker protocol hygiene
- `useEngineWorker.ts:649-657` — phone `send()` drops frames while the WS reconnects: queue up to N
  frames and flush on reconnect, or surface "not connected".
- `worker-protocol.ts:164` — `codingAgentCancel` exists but is never sent: wire it into `buddyCancel`,
  and add a timeout to `runCodingAgents` (useEngineWorker.ts:1708-1724).
- Both dispatch switches: add `default: satisfies never`-style exhaustiveness so protocol drift fails
  typecheck instead of vanishing at runtime.

### 1.8 🟡 Provider robustness (core)
- `comfyui-backend.ts:1021-1027` — retry `/prompt` submit once on 5xx/network error.
- Missing timeouts: `openai-provider.ts:169-187`, `gemini-provider.ts:164-224`, `sse.ts:22-27` (connect),
  ComfyUI/A1111 discovery calls — adopt the `AbortSignal.timeout(...)` pattern local-server-provider uses.
- `buddy-session.ts:517-519` — the automatic retry re-runs non-idempotent write tools (`create_event`,
  `create_task`, `schedule_task`, `continue_story`): whitelist idempotent tools only.
- `chat-session.ts:213-235` — at the tool-round cap, raw tool-JSON is shown verbatim to the reader:
  mirror buddy-session's `looksLikeToolJson` + strip/nudge path.
- `claude-provider.ts:166` — extraction `max_tokens` pinned at 4,096 (local uses 12,288): long chapters
  silently produce an empty bible. Raise to match.

### 1.9 🟡 Prompt-injection hardening (core)
- `search_web` results (chat-tools.ts:376-379 / buddy-tools.ts:2985-2988): add the "reference DATA,
  not instructions" delimiter that read_url/gmail results already have.
- Sanitize `]` in interpolated page titles (chat-tools.ts:410 / buddy-tools.ts:3063).
- Consider approval-gating `remember` when the note originates in the same turn as a `read_url`
  (persistent-injection vector via 2,000-char memory notes).

---

## Phase 2 — Mobile/phone-link parity & UX correctness

### 2.1 🟡 Remote gating inconsistencies (one sweep)
Several features gate on `isDesktop` where siblings use `isDesktop || remote`:
- Slash commands: `ChatBuddyPanel.tsx:180` uses `buddySlashCommands(props.desktop)`, but `/find` +
  command tools are permitted for remote too (App.tsx:7406-7418). Pass a `desktopOrRemote` flag.
- `StyleLoraRow` (SettingsPanel.tsx:~2430) — `isDesktop` only; ffmpeg/video rows already do
  `isDesktop || remote`.
- `localTextBackend` fallback drift: four variants exist; extract one `resolveTextBackend(settings,
  isDesktop, remote)` helper (SettingsPanel.tsx:1816 vs 1158/1253/2519).
**Plan:** grep every `isDesktop` in packages/ui + the SettingsPanel props, and classify each against the
"desktop owns it / phone relays it" table in REMOTE-LINK.md. Fix the mismatches in one PR.

### 2.2 🟡 Mirror performance
- `App.tsx:3443-3457` — chatLive pushes the cumulative streaming string ~8/s (O(n²) bytes over a long
  answer) and the trailing 120ms timer is never cleaned up. Send deltas (index + suffix) or throttle by
  payload size; add the effect cleanup.
- `vrsync:book` re-serializes book+bible every beat (~2702): mirror the bible as a separate, throttled
  slice keyed by a revision counter.

### 2.3 🟢 Settings panel on phones
`SettingsPanel.tsx:3652` — fixed 340px column; grids never reflow. Adopt `useNarrow` (already in
packages/ui) for full-width fields + stacked rows under 480px.

---

## Phase 3 — UI consistency & accessibility

### 3.1 🟡 Shared modal wrapper
LibraryPanel/MemoriesPanel/SoulPanel/StorySetupModal/FirstRunWizard/OrderReviewModal all hand-roll
overlays with no `role="dialog"`, no Escape, no focus trap (only RenameExportModal handles Escape).
**Plan:** one `<ModalShell title onClose>` in packages/ui (role/aria-modal/Escape/focus-return/backdrop
click; `disableBackdropClose` for OrderReviewModal while `placing`). Migrate the six call sites. The
Settings overlay (SettingsPanel.tsx:703) gets Escape + focus handling in the same pass.

### 3.2 🟡 Keyboard access for popovers
Model-menu + slash-menu items are `onMouseDown`-only (ChatBuddyPanel.tsx:734-768, ChatPanel.tsx:496):
add `onClick`/key handling so Enter/Space select. Image lightbox (ChatPanel.tsx:1011-1049): real button
semantics + Escape.

### 3.3 🟢 Design tokens
Extract a `packages/ui/src/tokens.ts` with the success green (3 drifted values), accent blue (3 values),
border/overlay rgba constants, and the shared button/input/popover styles (MemoriesPanel ≡ SoulPanel
styles are verbatim copies; ChatBuddyPanel copies ChatPanel's). Pure refactor, no visual change intended.

### 3.4 🟢 Small fixes batch
- Auto-scroll only when already near the bottom (ChatBuddyPanel.tsx:182-185, ChatPanel scroll effect).
- Message keys: stable ids instead of array index (ChatPanel.tsx:395) — per-bubble state currently
  re-associates after a deletion.
- Effect cleanups: model "Loading…" 4s timer, SpeechRecognition, TTS cancel (ChatBuddyPanel.tsx:320,
  200-232); objectURL revoke timers (ChatPanel.tsx:1244, 1400).
- aria-labels on icon-only buttons (list in audit; ~15 sites).
- Truncation tooltips (`title={...}`) on LibraryPanel titles + ChatPanel filenames.
- Dead exports: remove or wire `SpoilerGate`, `TechnicalSupport`, `DataSection` (packages/ui/src/index.ts).

---

## Phase 4 — Functionality gaps toward the "ideal app"

### 4.1 Generated-media gallery (biggest gap)
Images/videos exist only as chat bubbles + file cards; there is no way to browse, re-download, or delete
generated media, and a 50s long-form video is unfindable a week later.
**Plan:** a "Creations" panel (same overlay pattern as Library) listing the chat blob store's media
(id, kind, prompt, date, size) with view/download/delete; desktop adds "open folder" for
`~/VisualReader/workspace/longvideo/*`. The store already externalizes blobs with stable ids — the panel
is mostly a reader over `libraryStore.getImageBlob` plus an index memo maintained on externalize.
**Shipped** as `packages/ui/src/CreationsPanel.tsx` + `packages/core/src/chat/creations.ts`: instead
of a separate index memo (a second source of truth to keep in sync), the gallery derives its items by
walking the persisted chat histories (`collectCreations`) and hydrates bytes lazily from the blob
store; delete strips the media from its message (`removeCreationFromMessages`) and drops the blob
(`deleteImageBlob`). Desktop "open folder" for longvideo outputs remains a follow-up.

### 4.2 Library at scale
`LibraryPanel` has type-filter chips only. Add: text search over title/author, sort (recent/title/type),
and a compact grid at >20 books. All local — no schema change needed beyond an optional `lastOpenedAt`.

### 4.3 Error-recovery UX
`localError` strings + status bar are the only surface; add a small toast/queue component (3-4 states:
info/success/warn/error, auto-dismiss, click-through to Settings section when actionable). Route
`setLocalError` + engine failures + quota warnings (1.6) through it.

### 4.4 Docs truth pass
- README "Status" contradicts FEATURES on infographics; video generation (Wan/LTX/long-form/ffmpeg) is
  barely documented; `delegate_coding_task`, `spawn_agents`, VLLM-SETUP capabilities are absent from
  FEATURES. One pass to make README/FEATURES/SETUP agree with the code, plus a short TROUBLESHOOTING.md
  (engine won't start / ffmpeg / phone link / OAuth).
- Add a CHANGELOG.md going forward (the squash-merge PR titles are already good material).

### 4.5 macOS/Linux managed engines (scope decision)
All four `ensure_*` commands are Windows-only (clear errors, but zero bundled AI elsewhere). Either ship a
pip/venv ComfyUI + llama.cpp path for macOS/Linux, or state "Windows-first; mac/Linux = connect your own
servers" in README. Decision needed before investing.
**Decided: Windows-first.** README/SETUP now carry an honest "Platform support" section (managed
engines/ffmpeg/bundled LLM are Windows-only; macOS/Linux connect their own ComfyUI/A1111/Ollama
servers). A pip/venv path can be revisited if demand shows up.

### 4.6 Spoiler-reveal feature is dead code
`spoiler.ts:23` — `revealParagraphId` is always `""` from extraction (`extraction.ts:991`), so per-paragraph
spoiler reveal never fires (images just stay blurred). Either wire the extractor to emit real paragraph ids
or remove the plumbing and keep the simpler position-based gating.
**Deferred.** Position-based gating already covers the user-visible behavior (images un-blur as you
reach them); wiring real paragraph ids through extraction would grow the extraction prompt/schema for
a marginal win, and removing the plumbing is churn in tested code with no behavior change. Revisit if
per-paragraph reveal becomes a requested feature.

---

## Phase 5 — Architecture (deferred until a feature forces it)

Documented so the seams are known; each is a contained extraction with the line ranges verified:

1. **`useRemoteMirror`** — App.tsx ~2320-2831 (snapshot builder, sync-handler switch, per-slice push
   effects). Biggest single win; the switch is self-contained already.
2. **`useLocalEngine`** — App.tsx ~1396-2300 (managed engine, downloads, connects, bundled LLM).
3. **Tool-approval dispatcher** — App.tsx ~5268-5680 + 6466 (approve/deny/allow-always for every tool).
4. **`tool-protocol.ts` merge** — buddy-tools vs chat-tools share ~250-300 duplicated lines (strArg,
   stripTrailingCommas, stripFences, parse branches, format blocks). Merge the primitives first (zero
   behavior change), then the per-tool branches tool-by-tool.
5. **Chat runner unification** — the reading chat and buddy chat duplicate pendingTool triage, send
   paths, silence watchdogs, and debounced persistence. Unify AFTER 1-4; riskiest, largest.

Also: top untested-risky modules for when adding tests — comfyui-backend generate/poll state machine,
local-server-provider streaming merge, `nativeToolCallsToText`, indexeddb-store, note-store (direct).

---

## Shipped with this audit (already merged into this branch)

- **core:** chat-tools `MAX_PROMPT_CHARS` 600→2,000 (parity with buddy; prompts no longer silently
  truncated); `stripFences` accepts any fence language (```tool_code etc.); note-store `loadNotes` keeps
  the NEWEST notes when a stored list exceeds the cap (was dropping the newest). Tests added.
- **web host:** `saveSettings` debounced 400ms + pagehide flush (was per-keystroke AES + stringify);
  `vrcmd:hostTool` relay always replies on failure (was a 600s phone stall); price-alert runner gated
  off on linked phones (was double-firing); `getCharacterReference` gained the standard timeout.
- **UI:** destructive actions confirm (chat Clear, session delete, library remove, Google disconnect);
  ChatPanel now forwards quick-reply actions + found-file opens to MessageBubble (were dead buttons);
  Google connect + code-card Save surface thrown errors; SoulPanel photo errors land in the panel's
  error line; FirstRunWizard clamps the provider when switching paths (blank-dropdown bug).
