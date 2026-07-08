# Project hand-off — Visual Reader / Illustrator App

A pointer for whoever picks this up next (human or a fresh agent session). Read this first, then
`README.md` for the product and `docs/IMPROVEMENT-PLAN.md` for the current engineering roadmap.

> **Paste-in for a fresh agent session:**
> Continue on branch `claude/app-simplification-consolidation-6ou0tp`. The repo's DEFAULT branch is
> `claude/visual-content-generator-BLJks` — develop on the work branch, then PR + squash-merge into
> the default branch (installers and `git pull` track it; `main` was deleted). After each merge,
> reset the work branch onto the updated default and force-with-lease push. Read `HANDOFF.md`,
> `docs/IMPROVEMENT-PLAN.md`, and `CHANGELOG.md` first.

---

## 1. What this is

A cross-platform **AI reading + creation app**. It illustrates books as you read (a "Visual Bible"
keeps characters/world consistent), and its landing page is a full-window **chat assistant** ("the
buddy") that drives everything: find/open/illustrate books, generate images and video, research the
web, run desktop tools, plan and track multi-step tasks, and more. It runs against **cloud
providers** (Claude / Gemini / OpenAI) or **fully local** (Ollama / LM Studio / llama.cpp for text;
ComfyUI / AUTOMATIC1111 for images + video; a bundled llama-server on desktop).

Platforms: web app (Vite), desktop app (Tauri/Rust shell), Chrome extension. **Managed engines
(auto-launched ComfyUI/A1111), the bundled LLM, and managed ffmpeg are Windows-only**; macOS/Linux
connect their own servers by URL. A desktop can mirror to a phone over the LAN (the phone is a thin
client; the desktop owns the engine + filesystem).

---

## 2. Monorepo map (pnpm workspaces)

| Path | What lives there |
|---|---|
| `packages/core` | Engine, pipeline, providers (LLM + image + video), Visual Bible, storage, chat/tool protocols, task planning, workflow engine, types. **Fully unit-tested** (`vitest`, `**/*.test.ts`). No DOM/host deps — pure logic. |
| `packages/epub` | EPUB parsing + `bookFromText`/`bookFromCode` (txt/md/paste/code → `BookSource`) + illustrated HTML/EPUB/PDF/DOCX/XLSX export. |
| `packages/ui` | React components (inline styles), the model-menu builder, design tokens, `buildProviders` (settings → providers). Shared by web + extension. |
| `apps/web` | The reader app. The engine runs in a **Web Worker** (`engine.worker.ts`); `App.tsx` is the host (~10k lines — see §5). |
| `apps/desktop/src-tauri` | Rust shell: managed ComfyUI/A1111 lifecycle, model/LoRA/ffmpeg downloads, GPU/VRAM info, `http_fetch` (CORS-exempt), file tools, screenshot, the LAN relay server, process/VRAM management. `main.rs` ~3k lines. |
| `apps/extension` | Chrome extension reader (shares `packages/ui`/`core`). |

---

## 3. Build / run / verify

Package manager is **pnpm** (never npm). Root scripts:

```
pnpm dev:web                       # Vite dev server (engine in a worker)
pnpm dev:desktop                   # cargo tauri dev  (needs Rust + Tauri)
pnpm -r typecheck                  # tsc across all packages
pnpm test           (== vitest run)
pnpm lint                          # eslint .
pnpm --filter @visual-reader/web build
```

**Full verification suite (run before every commit of non-trivial work):**

```
pnpm -r typecheck
npx vitest run                     # ~1,647 tests today, all green
pnpm lint
pnpm --filter @visual-reader/web build
cargo check --target x86_64-pc-windows-gnu   # ONLY when apps/desktop/src-tauri changed
```

- The Rust shell targets Windows; this container has the `x86_64-pc-windows-gnu` toolchain + mingw-w64
  installed, so `cargo check` works here. Rust runtime behavior (spawning engines, capture, sockets)
  still needs an **on-device** pass — CI has no GPU/engine/listening socket.
- `exactOptionalPropertyTypes` is **on**: never pass `undefined` for an optional field — spread it,
  `...(x ? { x } : {})`.

---

## 4. Git / PR workflow (important)

- **Default branch:** `claude/visual-content-generator-BLJks`. `main` was deleted; the user's
  installers and `git pull` track the default branch. (There's a stale `Dev` branch ~125 PRs behind —
  ignore it.)
- **Work branch:** `claude/app-simplification-consolidation-6ou0tp`. Develop here.
- **Cycle:** commit to the work branch → open a PR into the default branch → **squash-merge** → then
  reset the work branch onto the updated default and force-with-lease push:
  ```
  git fetch origin claude/visual-content-generator-BLJks -q
  git checkout -B claude/app-simplification-consolidation-6ou0tp origin/claude/visual-content-generator-BLJks -q
  git push --force-with-lease -u origin claude/app-simplification-consolidation-6ou0tp -q
  ```
- **GitHub MCP scope:** `vcons002-ship-it/illustrator-app` only.
- Commit messages end with the two `Co-Authored-By:` / `Claude-Session:` trailers; PR bodies end with
  the "🤖 Generated with Claude Code" line. Never put a model identifier in committed artifacts.
- One quirk: a squash-merge inherits the branch's single-commit title. If the branch had a "WIP" first
  commit, the merge commit may read "WIP …" even though the PR body is accurate — cosmetic only.

---

## 5. Architecture notes that save time

**The chat/tool protocol.** Two provider-agnostic JSON tool unions:
- `packages/core/src/chat/buddy-tools.ts` — the landing-page assistant (find/open books, images,
  video, web, desktop tools, tasks, markets, etc.). `BuddyToolCall` union + `parseBuddyToolCall` +
  `formatBuddyToolResult` + `buildBuddySystemPrompt`.
- `packages/core/src/chat/chat-tools.ts` — the in-book reading companion (smaller surface).
- Shared parsing primitives live in `tool-protocol.ts` (extracted so the two files can't drift).
  `tool-inventory.ts` is a feature-parity ledger — every tool ever shipped, with its disposition;
  `feature-parity.test.ts` fails CI if a capability is dropped without a replacement.

**Where a tool call executes.** The worker runs a turn (`buddy-session.ts` `runBuddyTurn`). Auto-run
tools execute in the worker; **host tools** (image/video/file/command/screenshot/plan/stitch/…) are
handed up to `App.tsx` as a `pendingTool`. The **approval policy** is a pure, tested table:
`packages/core/src/chat/tool-approval.ts` `routePendingTool(tool, flags)` → a route
(`host`/`image`/`video`/`stitch`/`ask`/…); `App.tsx`'s turn-completion handler switches on the route.
Full-autonomy / session grants decide auto-run vs. show-the-approval-card.

**App-managed workflows** (`packages/core/src/chat/workflow.ts`) — the reliable multi-step engine.
The model compiles a plan once (`set_plan`), then the **app** owns the checklist and ticks steps
only from *observed evidence* (a render happened, a file landed, a command exited 0) — never the
model's self-report ("the collar", `evaluateStep`). `complete_step` is withdrawn in this mode. The
executor is `advanceWorkflowAfterTurn` in `App.tsx`. Recent fix: turns where the model *didn't
attempt* the step's work (narrated, or tried to check the box) re-nudge toward the tool without
burning an attempt, so image checklists don't prematurely park (`attemptedStepWork` /
`checklistMetaOnly`).

**Task plans** (`packages/core/src/chat/tasks.ts`) are a *separate* feature from workflows: durable
multi-step to-dos (optionally synced to Google Tasks). The buddy can create/refine them
(`plan_task`, `add_task_steps`), check them off (`mark_step_done` for a step, `complete_task` for the
whole plan), and — new — **persist conversation context onto the active task** every turn
(`save_task_context` + deterministic link/attachment harvest in the worker, so closing a task chat
never loses what you handed it).

**Phone mirror** (`apps/web/src/useRemoteMirror.ts`) — the whole desktop↔phone relay: hello
snapshot, the `vrsync:`(desktop→phone) / `vrcmd:`(phone→desktop) handler switch, per-slice push
effects, debounced settings relay. Chat/planner/host-tool machinery declared later in `App.tsx` binds
in via refs the hook returns.

**Local engine lifecycle** (`apps/web/src/useLocalEngine.ts`) — managed ComfyUI/A1111 start + probe +
fallback resolution, low-VRAM deferred start, bundled/local-server LLM bring-up, every Settings
download + Connect handler. The resolver chain (probe your URL → self-provision managed → fall back)
is hook-private.

**Image/video rendering** (`packages/core/src/providers/image/local-engine/comfyui-backend.ts`) —
pure ComfyUI graph builders (`buildWorkflow` for images incl. Flux.1/Flux.2/SD/HiDream/Z-Image/Qwen;
`buildWanI2VWorkflow` / `buildLtx2I2VWorkflow` for video). Graphs are the ComfyUI **API/prompt
format** (flat `node-id → {class_type, inputs}`). Filenames resolve at render time against what's
installed (`diffusionComponents`, catalog-first then family heuristic). Video: Wan supports
first+last-frame conditioning (`WanFirstLastFrameToVideo`); long-form chains clips by last-frame with
a persistent-subject anchor (`video-continuity.ts`); separate clips stitch via managed ffmpeg
(`video-stitch.ts` + `stitch_videos`).

**Host state.** `apps/web/src/App.tsx` is still the ~10k-line host. Two of its biggest subsystems were
extracted to the hooks above; the tool-approval policy and tool-protocol primitives moved to core.
The remaining large seams are documented in `docs/IMPROVEMENT-PLAN.md` §"Phase 5" (chat-runner
unification and per-tool parse/format consolidation are the last two, deliberately deferred).

---

## 6. Current state (this session)

Everything below is **merged into the default branch and verified** (typecheck + ~1,647 vitest +
lint + web build green; Rust unchanged this session). See `CHANGELOG.md` for the user-facing list and
`docs/IMPROVEMENT-PLAN.md` for the audit + phase status.

- **Full-app audit → 5-phase plan** (`docs/IMPROVEMENT-PLAN.md`). Phases **1–4 shipped**:
  - P1 reliability (engine crash recovery, Rust process/VRAM lifecycle, SSRF guard, file-scope
    approval, settings echo race, IndexedDB quota surfacing, provider timeouts/retries).
  - P2 mobile/phone-link parity + settings correctness.
  - P3 UI consistency: `ModalShell` (shared dialog: role/aria/Escape/focus/backdrop) across 7 modals,
    keyboard access, `tokens.ts` design tokens, small a11y/cleanup fixes, library search+sort.
  - P4 features: **Creations gallery** (`CreationsPanel` + `creations.ts` — every generated
    image/video across all chats, view/download/delete, multi-select stitch), **toast system**
    (`Toast.tsx`), docs truth-pass (README/FEATURES/SETUP + new `docs/TROUBLESHOOTING.md`,
    `CHANGELOG.md`). 4.5 decided Windows-first; 4.6 spoiler-reveal deferred.
  - **P5 architecture** — extractions done: `useRemoteMirror`, `useLocalEngine`, `tool-approval`
    policy, `tool-protocol` primitives merge; risk-module test coverage added (comfyui-backend,
    local-server-provider, indexeddb-store, note-store, via `fake-indexeddb`). **Deferred:**
    chat-runner unification + per-tool parse/format branch consolidation (rationale in the plan).
- **Models menu redesign** — the chat's ⚙ switcher is now tabbed (Chat/Image/Video) with provider
  sections, per-tab active pick, and a filter (`model-menu.ts` + `ChatBuddyPanel.tsx`).
- **Task check-off** — `complete_task`, fixed `mark_step_done` to complete the *named* step
  (any order); **task chats persist context** every turn.
- **Video** — long-form subject anchoring, `stitch_videos` (chat + gallery), Wan first+last-frame
  (address each frame by filename/position), plus the app-managed image-checklist park fix.

---

## 7. Conventions

- **pnpm**, `exactOptionalPropertyTypes` on (see §3).
- New logic ships with **tests** (vitest). Pure logic lives in `packages/core` and is unit-tested;
  host glue lives in `apps/web` and stays thin over core helpers.
- Comments explain **why**, matching the existing dense style. Match the surrounding code's idiom.
- Don't commit secrets. Don't put the model identifier in any committed artifact.
- The stop-hook requires the working tree be committed + pushed before a turn ends.

---

## 8. Operational notes & gotchas (durable reference)

- **Provider keys** (encrypted per-origin in `keys.*`): Gemini (AI Studio) also powers Custom
  Search + in-call grounding on the same key; Custom Search needs an engine id (`cx`) +
  API key too. Settings → "Scientific sources" holds them.
- **Managed model catalog** (`packages/core/src/providers/catalog.ts`) — download URLs drift.
  Live-check any time with `VALIDATE_DOWNLOAD_URLS=1 pnpm test live-validation` (no keys). Known:
  Flux.2 Klein 9B's diffusion fp8 is on a **gated** `black-forest-labs` repo (anonymous 401) — the
  downloader fetches the ungated encoder+VAE first and fails last on the gated file with a
  browser-download hint; ungated HF mirrors were rejected as untrusted. HiDream-I1 uses the native
  ComfyUI repack (QuadrupleCLIPLoader + ModelSamplingSD3), not the custom-node packaging.
- **Live provider validation** — `packages/core/src/providers/live-validation.test.ts` is an
  env-gated suite (skips without keys, keeping CI green). Run with the real keys to confirm Custom
  Search + Gemini grounding/native-image field shapes when they drift.
- **CORS** — keyless web search + page fetch only work through CORS-exempt transports (desktop
  `http_fetch` / the extension proxy); inert in the plain web app by design. `http_fetch` has an
  SSRF classifier that blocks private hosts *except* the known local-inference ports (8188/7860/
  11434/…), because that's the app's own path to local engines.
- **Remaining on-device verification** — anything touching the Rust runtime (engine spawn/kill, VRAM
  freeing, screen capture, the LAN relay, first/last-frame + stitch ffmpeg paths) is compile-checked
  but wants a real-box pass.

---

## 9. Where to look

| Concern | File(s) |
|---|---|
| Buddy tools / prompt | `packages/core/src/chat/buddy-tools.ts`, `buddy-session.ts` |
| Tool approval policy | `packages/core/src/chat/tool-approval.ts` |
| App-managed workflow engine | `packages/core/src/chat/workflow.ts` |
| Task plans | `packages/core/src/chat/tasks.ts` |
| Image/video ComfyUI graphs | `packages/core/src/providers/image/local-engine/comfyui-backend.ts` |
| Video continuity / stitch | `packages/core/src/providers/image/video-continuity.ts`, `video-stitch.ts` |
| Model quick-menu | `packages/ui/src/model-menu.ts`, `packages/ui/src/ChatBuddyPanel.tsx` |
| Phone mirror | `apps/web/src/useRemoteMirror.ts` |
| Local engine lifecycle | `apps/web/src/useLocalEngine.ts` |
| Host (state, turn handler, executors) | `apps/web/src/App.tsx` |
| Worker protocol / handlers | `apps/web/src/worker-protocol.ts`, `apps/web/src/engine.worker.ts` |
| Rust shell | `apps/desktop/src-tauri/src/main.rs` |
| Roadmap / deferred work | `docs/IMPROVEMENT-PLAN.md` |
| User-facing change log | `CHANGELOG.md` |
