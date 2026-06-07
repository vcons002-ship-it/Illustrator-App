# Visual Reader

AI-generated illustrations for what you read on screen. As you read a novel, a
**"Visual Bible"** keeps characters and settings consistent so the generated
scene art doesn't drift from page to page.

This is the v1 implementation: fiction/EPUB **scene illustrations**, with a
shared engine consumed by three surfaces — a web app, a Chrome extension (which
illustrates any article you read), and a desktop app.

## Quick start

**Windows — no commands, just double-click a file:**

| Version | Double-click | Then |
|---|---|---|
| **Start (already installed)** | **`start.bat`** | Menu to launch web / desktop / extension / ComfyUI. |
| **Everything at once** | **`full-install.bat`** | Sets up all three, then asks which to start. |
| Web app | **`install.bat`** | Opens in your browser. Start later with **`run.bat`**. |
| Desktop app | **`desktop.bat`** | Builds + opens the native window. Start later with **`run-desktop.bat`**. |
| Chrome extension | **`extension.bat`** | Opens the folder + Chrome to load it. Re-open with **`run-extension.bat`**. |

Each file installs anything it needs on its own (Node.js, Rust, etc.).
**`full-install.bat`** is the simplest if you just want everything ready;
**`start.bat`** is the simplest once things are installed.

**macOS / Linux:** `corepack enable && pnpm install && pnpm dev:web`, then open
http://localhost:5173. (Desktop: `pnpm dev:desktop`; extension: `pnpm --filter
@visual-reader/extension build`, then load `apps/extension/dist` unpacked.)

Full, beginner-friendly instructions (and how to add API keys) are in
**[SETUP.md](./SETUP.md)**. The app works with **no API keys** via built-in
placeholder art so you can see the whole flow.

## How it works

```
EPUB ──▶ segment ──▶ Visual Bible (LLM pre-pass) ──▶ pipeline ──▶ image
                         │ characters, traits,            │ prompt + identity
                         │ clothing, environments,        │ anchor → diffusion
                         ▼ spoilers (cached)              ▼
                    IndexedDB                       JIT render buffer
                                                    (3-page window + idle
                                                     pre-render), Gaze-Sync UI
                                                    (bloom + spoiler gating)
```

- **Visual Bible** — an LLM extracts recurring characters (persistent traits,
  clothing), environments, and spoilers into a typed JSON object, cached in
  IndexedDB and injected into every image prompt for continuity.
- **JIT predictive buffer** — renders the current page and pre-renders ahead so
  you never wait; speculatively pre-renders further when idle/powered. In the web
  app the whole engine runs in a **Web Worker**, so extraction and rendering never
  block the reading UI; image bytes are transferred to the main thread zero-copy.
- **Gaze-Sync UI** — a "contextual bloom" fade reveals each image as you reach
  it, and a "Fog of War" blur keeps spoiler imagery hidden until you scroll past.

## Architecture

A pnpm + TypeScript monorepo. All generation logic lives in `packages/*`; the
`apps/*` are thin platform glue.

```
packages/
  core/   engine — types, Visual Bible, pipeline, JIT buffer, providers, storage
  epub/   EPUB parsing + chapter→page→paragraph segmentation
  ui/     shared React components (ImagePanel, BloomTransition, SpoilerGate, …)
apps/
  web/        standalone reader (Vite + React) — primary dev/demo surface
  extension/  Chrome MV3 overlay — illustrates any article; same engine + settings
              (API calls proxy through the background worker to bypass page CORS)
  desktop/    Tauri shell wrapping the web UI — downloads/launches a local GPU
              engine (ComfyUI portable) and curated models; pending on-device verify
```

### Designed-in seams (so v1 doesn't need rework later)

| Seam | Where | Enables |
|---|---|---|
| `VisualRequest.kind` discriminator | `core/src/types/content.ts` | Info-graphics (diagrams/flowcharts/summaries) without touching the pipeline |
| `ComputeTier` + provider factory | `core/src/types/tier.ts`, `providers/factory.ts` | Cloud default now; opt-in local WebGPU tier later |
| `Transport` | `core/src/providers/transport` | "Client now, server-ready" — swap direct fetch for a hosted proxy |
| Provider interfaces | `core/src/providers/{llm,image}` | Claude/Flux default; Gemini/OpenAI/Midjourney/on-device are drop-ins |

### Providers

- **Cloud (default):** Claude (`@anthropic-ai/sdk`, structured-output extraction)
  + a Flux-style diffusion API. Bring-your-own keys, encrypted at rest with a
    non-extractable WebCrypto key kept in IndexedDB (`storage/key-vault.ts`); in
    the extension, encryption runs in the background worker so the key lives in
    the extension's own isolated storage.
- **Mocks:** network-free LLM + image providers so the whole flow runs with no
  keys — used by tests and the keyless demo.
- **Local engine (your own GPU):** connect to a Stable Diffusion server you run —
  **AUTOMATIC1111** (`/sdapi/v1/*`) or **ComfyUI** (graph API) — from either the
  web app or the desktop app. Free, private, no keys. The desktop app can also
  **auto-manage** the engine: download/launch ComfyUI portable and curated models
  from the Settings picker (implemented; pending on-device verification).
- **On-device (stubbed):** WebLLM + ONNX/WebGPU providers implement the same
  interfaces for fully in-browser generation; full implementation is a later phase.

## Develop

```bash
pnpm install
pnpm dev:web        # run the web reader at http://localhost:5173
pnpm test           # unit + integration tests (Vitest)
pnpm -r typecheck   # typecheck every package
pnpm lint
pnpm -r build       # build all packages + apps
```

Open the web app and click **Load sample** (works with no API keys via the
placeholder renderer), or **Open EPUB** to load your own. Enter Claude + image
keys under **Settings** to switch to real generation.

### Build the extension

```bash
pnpm --filter @visual-reader/extension build
# then load apps/extension/dist as an unpacked extension in Chrome
```

## Status

v1 covers the fiction scene-illustration path end to end. Deliberately deferred
(seams in place): info-graphics output, a hosted backend/billing, and the full
local-WebGPU tier.
