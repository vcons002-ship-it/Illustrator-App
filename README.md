# Visual Reader

AI-generated illustrations for what you read on screen. As you read a novel, a
**"Visual Bible"** keeps characters and settings consistent so the generated
scene art doesn't drift from page to page.

This is the v1 implementation: fiction/EPUB **scene illustrations**, with a
shared engine consumed by two front-ends (a web app and a Chrome extension).

## Quick start

- **Windows:** double-click **`install.bat`** — it checks prerequisites,
  installs everything, and opens the app. (Use **`run.bat`** to launch later.)
- **macOS / Linux:** `corepack enable && pnpm install && pnpm dev:web`, then open
  http://localhost:5173.
- **Native desktop app (optional):** double-click **`desktop.bat`** on Windows
  (or `pnpm dev:desktop` on macOS/Linux) to run the Tauri desktop build, which can
  manage a local GPU image engine. See [SETUP.md](./SETUP.md#desktop-app-optional).

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
  extension/  Chrome MV3 extension overlay reusing core + ui
  desktop/    Tauri shell wrapping the web UI — manages a local GPU engine
              (command surface + wiring in place; engine lifecycle is Phase 3)
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
  + a Flux-style diffusion API. Bring-your-own keys, encrypted on-device
  (`storage/secure-keys.ts`).
- **Mocks:** network-free LLM + image providers so the whole flow runs with no
  keys — used by tests and the keyless demo.
- **Local (opt-in, stubbed):** WebLLM + ONNX/WebGPU providers implement the same
  interfaces; full implementation is the next phase.

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
