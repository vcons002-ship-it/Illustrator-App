# Visual Reader

AI-generated illustrations for what you read on screen. As you read a novel, a
**"Visual Bible"** keeps characters and settings consistent so the generated
scene art doesn't drift from page to page.

This is the v1 implementation: fiction/EPUB **scene illustrations**, with a
shared engine consumed by three surfaces — a web app, a Chrome extension (which
illustrates any article you read), and a desktop app.

> New here? **[FEATURES.md](./FEATURES.md)** is a plain-language tour of what the
> app does, how it works, and what's on the roadmap.

## Quick start

**Windows — no commands, just double-click a file:**

| Version | Double-click | Then |
|---|---|---|
| **Start (already installed)** | **`start.bat`** | Menu to launch web / desktop / extension / ComfyUI. |
| **Update to latest** | **`update.bat`** | Pulls new code, refreshes deps, rebuilds. |
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
  outfits), environments, a world style, and spoilers into a typed JSON object —
  and writes each chapter's scene prompts in the same pass (stored as storyboard
  `keyEvents`). Cached in IndexedDB; at render time the stored prompt's character/
  outfit/location names are expanded into their Bible descriptions per the image
  model's family, so rendering never calls the LLM.
- **JIT predictive buffer** — renders the current page and pre-renders ahead so
  you never wait; speculatively pre-renders further when idle/powered. In the web
  app the whole engine runs in a **Web Worker**, so extraction and rendering never
  block the reading UI; image bytes are transferred to the main thread zero-copy.
- **Gaze-Sync UI** — a "contextual bloom" fade reveals each image as you reach
  it, and a "Fog of War" blur keeps spoiler imagery hidden until you scroll past.
- **Conversational layer** — the landing page is a full-window **chat buddy**
  (`packages/core/src/chat/buddy-*`) that drives the app through a provider-agnostic
  JSON tool protocol: find books (library / Project Gutenberg / web / pasted text),
  open + illustrate them (style & cadence included), generate images (approval-gated),
  retrieve figures, read a web page or GitHub repo into the chat (`read_url`), calculate,
  manage the library, and keep a **long-term memory** of your preferences across books.
  In-book, a reading-companion chat shares the same protocol with spoiler-safe context,
  an on-demand `search_book` tool (recent-window context, whole book reachable lazily),
  provider-aware context budgets (local models sized to their real window), and a
  context-usage breakdown in the UI. Both chats expose a **`/` slash-command menu**
  (`chat/slash-commands.ts`) that runs any tool directly, **clarify-when-ambiguous**
  prompting, and **file creation** (a fenced code block in a reply gets a Save button).
- **Agentic desktop tools (opt-in, approval-gated)** — on the desktop app the chat can
  reach the machine, every step human-gated: **`find_files`** (search your computer for a
  document to open), **`run_command`** (run one shell command in the `VisualReader`
  workspace — install deps, build, run tests, execute a script it wrote — with stdout/
  stderr/exit fed back so it can test code and fix it iteratively), **`screenshot`**
  (capture the whole screen or one window by title and assess it with a vision model —
  cloud *or* a local vision model — to check whether a game/UI it built actually works),
  and **`export_book`** (save an illustrated copy of the open book as a self-contained
  HTML page or an EPUB). `run_command`/`screenshot` are off by default behind a Settings
  flag; filesystem and screen access ask per session.

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
              engine (ComfyUI portable) and curated models, plus a native
              `http_fetch` command (the desktop twin of the extension's proxy)
              giving the chat's web search/fetch CORS-free reach
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
  web app or the desktop app. Free, private, no keys. Family-aware rendering:
  SD 1.5 / SDXL / Flux.1, plus the split-file generation on ComfyUI — **Z-Image
  Turbo** (recommended), **Flux.2 Klein**, **Qwen-Image**. The desktop app
  **auto-manages** the engine: it downloads/launches ComfyUI portable and fetches
  every file a catalog model needs (diffusion model + text encoder + VAE, with
  resume) from the Settings picker (implemented; pending on-device verification).
- **Local text:** WebLLM (on-device WebGPU) or an OpenAI-compatible local server
  (Ollama / LM Studio / llama.cpp); `ollama-setup.bat` installs Ollama and text
  models download from the Settings menu with live progress. Chat context budgets
  are sized to the model's **actual** window (read from Ollama `/api/show`, safely
  capped). The ONNX/WebGPU **image** provider remains a stub for a later phase.
- **Vision (describe images):** the screenshot tool and any "discuss this image"
  request need a vision-capable model. Cloud **Claude, Gemini, and OpenAI** all see
  images; **locally** a vision model works too — Ollama `llama3.2-vision` / `llava` /
  `qwen2-vl`, or an LM Studio vision model — so on-device screen assessment needs no
  cloud key. Text-only local models can't see images (the UI says so).
- **Import formats:** EPUB, plain text/Markdown, HTML, PDF, **Word (`.docx`)**,
  **Excel (`.xlsx`)**, **CSV/TSV**, **RTF**, and **JSON** all open as books (data
  files default to technical mode); dropping an **image** (`.png/.jpg/.webp/.gif`)
  opens the **photo-transform** (img2img) panel instead — restyle a photo through your
  image model (cloud Gemini/OpenAI native, or local ComfyUI), without forcing the
  global art style onto it.
- **Keyless search & discovery:** with no Google Custom Search credentials, search
  resolves to a layered keyless stack — Wikipedia (grounding) + Wikimedia Commons
  (figures) always; **DuckDuckGo full-web** where a CORS-exempt transport exists
  (extension background worker, the desktop shell's `http_fetch` command), with
  automatic per-session fallback to Wikipedia; **Project Gutenberg** (Gutendex) for
  whole-book discovery in the chat buddy.
- **Mature mode (opt-in, adults only):** a Settings toggle that relaxes the
  adjustable provider safety knobs (Gemini `safetySettings`, Flux `safety_tolerance`)
  and threads faithful-depiction instructions through extraction, prompt-writing,
  and chat — for intentionally adult source material. Claude/OpenAI expose no such
  knob and keep their own policies.

## Minimum & recommended specs

Visual Reader runs **two** AI workloads you can place independently: a **text LLM**
(reads the book, writes prompts, powers the chat) and an **image model** (renders the
art). Either can be **cloud** (no special hardware — any laptop works) or **local** (your
own CPU/GPU, free and private). The tables below show a variety of models at each level.

**Cloud (zero local hardware):** any modern computer + internet. Text: **Claude**
(`claude-*`), **Gemini** (`gemini-2.5-*`), or **OpenAI** (`gpt-*`). Images: a **Flux**-style
API (Black Forest Labs), **Gemini** native (Nano Banana), or **OpenAI** `gpt-image-1`. One
Gemini *or* one OpenAI key covers both text and images. Vision (screenshots/discuss-image):
Claude, Gemini, and OpenAI all qualify.

**Local text LLM (run the reader's brain on your machine):**

| Level | Hardware | Models (a variety) |
|---|---|---|
| **Minimum** | Any WebGPU browser, or 8 GB RAM for Ollama | **Llama 3.2 1B/3B**, **Qwen2.5 3B** (on-device WebGPU); **Qwen 3 8B** via Ollama |
| **Recommended** | 12–16 GB VRAM (or Apple Silicon) | **Qwen 3 14B**, **Gemma 3 12B** — noticeably better prompts |
| **Vision-capable** | 8 GB+ VRAM | **llama3.2-vision**, **llava**, **qwen2-vl** (Ollama) or an LM Studio vision model — for the screenshot tool offline |

**Local image model (run rendering on your GPU, via ComfyUI / AUTOMATIC1111):**

| Level | VRAM | Models (a variety) |
|---|---|---|
| **Minimum** | ~4 GB | **SD 1.5**, **SDXL-Turbo** — run almost anywhere |
| **Recommended** | 8–12 GB | **SDXL**, **Flux.1**, **Z-Image Turbo** (the recommended default — current-gen quality in 8 steps) |
| **High-end** | 16–24 GB | **Flux.2 Klein 9B**, **Qwen-Image** (best fine detail + in-image text; ~30 GB download) |

> Mix and match freely — e.g. a cloud Claude key for text while images render locally on
> SDXL, or a fully local Qwen 3 + Z-Image setup with no keys at all. The placeholder
> renderer needs **nothing**: open the app and click *Load sample*.

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

v1 covers the fiction scene-illustration path end to end, plus the technical
(Visual Atlas) mode, the conversational layer (home-screen chat buddy + in-book
companion with tools, slash commands, long-term memory, and clarify-when-ambiguous
prompting), the agentic desktop tools (file find/create, `run_command` with
test-and-fix iteration, vision screenshots), illustrated HTML/EPUB export, expanded
import formats + photo transform, keyless web/book search, and opt-in mature mode.
Deliberately deferred (seams in place): info-graphics output, sanitized-HTML
article rendering, a hosted backend/billing, and the full local-WebGPU image tier.
