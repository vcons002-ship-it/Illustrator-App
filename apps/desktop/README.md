# Visual Reader — Desktop shell (Tauri)

The downloadable, "just works" form of Visual Reader. The renderer is the
existing web app (`apps/web`); this Tauri shell adds the one capability a browser
cannot provide: **an app-managed local GPU inference engine** so big image models
(SD / SDXL / Flux, 8GB+) run on the user's own hardware with zero setup.

## Why a desktop app

The browser sandbox caps WebGPU at ~1–4 GB VRAM and a 128 MiB storage-buffer
binding, so Flux/SDXL-class models cannot run in a web page, and a page cannot
install or manage a GPU process. The desktop shell installs, launches, and shuts
down the engine invisibly — the user only ever picks a model.

## How it fits together

- **Renderer:** `apps/web` build is loaded directly (`tauri.conf.json` →
  `frontendDist: ../../web/dist`). `withGlobalTauri: true` exposes `window.__TAURI__`,
  which `apps/web/src/runtime.ts` detects (`isDesktop`) to enable the local path.
- **Commands (Rust → renderer):** `ensure_engine`, `list_models`, `download_model`,
  `download_lora`, `lora_headers`, `gpu_info`, `http_fetch`, and the agentic-tool
  commands `save_file`, `search_files`, `read_file`, `run_command`, and `capture_screen`
  (see `src-tauri/src/main.rs`). The renderer calls these from `runtime.ts`.
- **Agentic tools — the desktop-only reach the chat assistant gets:** a browser tab
  can't touch the filesystem, spawn a process, or capture the screen, so these live in
  the Rust shell, each one human-approved in the UI before it fires:
  - `save_file` — writes a chat-authored file (a fenced code block's *Save* button) into
    the `VisualReader` workspace.
  - `search_files` / `read_file` — back the buddy's `find_files` tool: locate a document
    on the user's machine and read it in to open as a book.
  - `run_command` — runs **one** shell command in the workspace folder and returns
    stdout/stderr/exit code so the assistant can build, test, and fix code iteratively. It
    drains the pipes on a thread and enforces a watchdog timeout so a hung child can't wedge
    the app. Gated behind the opt-in `allowCommands` setting.
  - `capture_screen` — screenshots the whole screen or a single window by title (via the
    `xcap` crate, PNG-encoded) so a vision model can assess what the assistant built. Same
    opt-in gate; the renderer hands the image to a cloud **or local** vision model.
- **`http_fetch` — CORS-free web access:** the desktop twin of the extension's
  background-worker proxy. The webview is a browser and enforces CORS like one;
  this native command (reqwest, 60s timeout, 32 MB cap, http(s)-only, base64
  bodies, no cookies/ambient auth) is what lets the chat buddy's keyless
  DuckDuckGo search and "open this URL" reach sites that block cross-origin
  requests. The engine worker can't reach the Tauri bridge directly, so requests
  relay through the main thread (`corsFetch`/`corsFetchResult` in
  `apps/web/src/worker-protocol.ts`).
- **Generation:** the engine's HTTP API is driven by the engine-agnostic
  `ComfyUIBackend` in `packages/core` (transport-injected, unit-tested), so the
  same code path runs in tests and in production.

## Status

The managed-engine lifecycle is **implemented** in `src-tauri/src/main.rs`:

- `ensure_engine` — reuses an engine already on the port; otherwise (Windows)
  downloads the official **ComfyUI portable** build (bundled Python), unpacks it,
  spawns it with `--enable-cors-header` and NVIDIA/CPU auto-detection, and
  health-checks `/system_stats`. macOS/Linux return a clear "connect your own"
  message (managed install there is future work).
- `download_model` — streams a curated checkpoint (from the core catalog) into
  `models/checkpoints`, emitting `model://progress`.
- `list_models` — lists the downloaded checkpoints.
- The spawned child is killed on app exit (`RunEvent::ExitRequested`).

Install/download progress streams to the UI via `engine://progress` /
`model://progress` (see `apps/web/src/runtime.ts`), and the Settings model picker
shows per-model progress bars.

> **Compiles (`cargo check` passes); runtime needs on-device verification.**
> Two things to confirm on a real Windows machine with a GPU:
> (1) the webview→engine fetch — a Tauri webview may use an `https`/custom origin,
> so reaching `http://127.0.0.1:8188` could be blocked as mixed content; if so,
> enable the http scheme for the webview or proxy engine calls through a Tauri
> command (same pattern the extension uses for its background worker);
> (2) the exact ComfyUI portable asset name / model URLs (download is resilient
> and falls back to a clear error).
> The bundled `icons/icon.png` is a placeholder — run `tauri icon <png>` to
> generate real multi-format icons before distributing.

## Build / run

The desktop app is intentionally **outside** the pnpm workspace so it never
affects the JS build/test gate. It needs Node.js + pnpm (the renderer is the web
app), the Rust toolchain, the platform C/C++ build tools, and the Tauri CLI.

> **Toolchain note:** `Cargo.toml` ceiling-pins `time < 0.3.48` — 0.3.48's new
> impls collide with `tauri-utils 2.9.2` under recent rustc coherence rules
> (E0119) and break fresh clones on up-to-date toolchains. Drop the pin once
> tauri-utils ships a fix.

### Windows — one click

Double-click **`desktop.bat`** in the repo root. It checks every prerequisite
(Node.js, pnpm, Rust, Visual C++ build tools, the Tauri CLI), installs anything
missing via `winget`, then builds and opens the desktop window. The first run
compiles the Rust shell and can take several minutes; later runs are fast.

> If the script installs Node, Rust, or the build tools, it asks you to close the
> window and run `desktop.bat` again so the updated PATH/toolchain is picked up.

### macOS / Linux (and manual Windows)

```bash
# one-time
cargo install tauri-cli --version "^2" --locked

# dev (builds + serves apps/web, opens the desktop window)
pnpm dev:desktop          # == cd apps/desktop/src-tauri && cargo tauri dev

# production installers (.dmg / .msi / AppImage)
pnpm build:desktop        # == cd apps/desktop/src-tauri && cargo tauri build
```

`pnpm dev:desktop` / `pnpm build:desktop` are convenience wrappers in the root
`package.json`; they shell out to `cargo tauri` and do **not** make the desktop a
workspace package.
