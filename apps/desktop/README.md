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
- **Commands (Rust → renderer):** `ensure_engine`, `list_models`, `download_model`
  (see `src-tauri/src/main.rs`). The renderer calls these from `runtime.ts`.
- **Generation:** the engine's HTTP API is driven by the engine-agnostic
  `ComfyUIBackend` in `packages/core` (transport-injected, unit-tested), so the
  same code path runs in tests and in production.

## Status

The command surface, window, and renderer wiring are in place. The heavy lifting
inside `ensure_engine` / `download_model` (GPU-build detection, portable-ComfyUI
download with progress, process spawn/health-check/teardown) is marked with TODOs
and is the remaining Phase 3 work.

## Build / run

Requires the Rust toolchain and the Tauri CLI (this is intentionally **outside**
the pnpm workspace so it never affects the JS build/test gate):

```bash
# one-time
cargo install tauri-cli --version "^2"

# dev (builds + serves apps/web, opens the desktop window)
cd apps/desktop/src-tauri
cargo tauri dev

# production installers (.dmg / .msi / AppImage)
cargo tauri build
```
