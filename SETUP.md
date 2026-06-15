# Setup & Usage

Get Visual Reader running. On **Windows you never need to type a command** — each
version is a single file you double-click. (macOS / Linux steps are further down.)

## Windows: just double-click

| You want… | Double-click | What it does |
|---|---|---|
| **Already installed — just start something** | **`start.bat`** | A menu: pick web / desktop / extension / ComfyUI and it launches it. |
| **Update to the latest** | **`update.bat`** | Pulls new code, refreshes deps, rebuilds the web app + extension (optional desktop rebuild). |
| **Everything, set up at once** | **`full-install.bat`** | Installs the prerequisites for **all** versions (Node.js, pnpm, deps, Rust, build tools, Tauri CLI) and builds the extension, then lets you pick one to launch. |
| The **web app** (read EPUBs) | **`install.bat`** | Installs everything, then opens the app. Start it later with **`run.bat`**. |
| The **desktop app** (native window, local GPU) | **`desktop.bat`** | Installs everything (incl. Rust/Tauri), then builds and opens the app. Start it later with **`run-desktop.bat`**. |
| The **Chrome extension** (illustrate the web) | **`extension.bat`** | Builds the extension and opens the folder + Chrome to load it. Re-open it later with **`run-extension.bat`**. |
| A **free local image engine** (optional) | **`comfyui-setup.bat`** | Downloads ComfyUI portable + a starter model so you can generate on your own GPU, no API keys. |
| A **free local text engine** (optional) | **`ollama-setup.bat`** | Installs Ollama (story analysis + prompt writing on your machine, no API key). Text models are then downloaded from inside the app — Settings → Text. |
| **GitHub repo access** (optional, desktop) | **`github-setup.bat`** | Installs Git + the GitHub CLI (`gh`) so the desktop assistant can clone, commit, push, open PRs, and manage issues. Then add a token in Settings → "GitHub token". |

Each script checks for and installs anything it needs (Node.js, etc.) on its own.
If a script says it just installed something and asks you to run it again, close
the window and double-click the same file once more. `full-install.bat` does the
most, so it may ask you to re-run it a couple of times as new toolchains land on
your PATH.

> Not sure which to use? **`full-install.bat`** is the simplest — it prepares
> every version and then asks what you'd like to start.

### Updating later

- **App:** double-click **`update.bat`** — it `git pull`s the latest code,
  refreshes only changed dependencies, and rebuilds the web app + extension (and
  optionally the desktop app). Re-running `install.bat`/`desktop.bat`/`extension.bat`
  only rebuilds the code you already have — they don't fetch new code.
- **ComfyUI engine:** run **`comfyui-setup.bat`** again — if it's already
  installed it offers to update **in place** to the latest; **nothing you've added
  is deleted** (models, `custom_nodes`, saved workflows, inputs/outputs, config
  are all kept). Use **`comfyui-setup.bat --upgrade`** to update without asking,
  or **`comfyui-setup.bat --clean`** for a from-scratch engine that still
  preserves your models + custom_nodes (custom-node Python deps may need
  reinstalling).
- After updating, reload the **extension** at `chrome://extensions` (refresh icon).

---

## Windows — web app, in detail

1. **Download the project**
   - On the GitHub page, click the green **Code** button → **Download ZIP**, then
     unzip it somewhere easy (e.g. your Desktop).
   - *Or*, if you have Git: `git clone <repo-url>` and open the folder.
2. **Double-click `install.bat`** in the project folder.

That's it. The script will:
- check for **Node.js** and install it via `winget` if it's missing
  (if `winget` isn't available it tells you where to get Node.js);
- enable **pnpm** (the package manager) automatically;
- install all dependencies;
- start the app and open **http://localhost:5173** in your browser.

> If `install.bat` says Node.js was just installed and asks you to re-run it,
> close the window and double-click `install.bat` again — Windows needs a fresh
> window to see the newly installed Node.js.

**Next time**, just double-click **`run.bat`** to start the app again (no setup).

To stop the app, click the black setup window and press **Ctrl + C**, or just
close it.

---

## macOS / Linux (and manual Windows)

You need **Node.js v20 or newer**. Check with:

```bash
node --version
```

If you don't have it, install from <https://nodejs.org/en/download> (or use a
version manager like `nvm`).

Then, from the project folder:

```bash
# 1. Enable pnpm (bundled with Node.js via Corepack)
corepack enable

# 2. Install dependencies
pnpm install

# 3. Start the app
pnpm dev:web
```

Open **http://localhost:5173** in your browser. Press **Ctrl + C** in the
terminal to stop.

> If `corepack` isn't found, install pnpm with `npm install -g pnpm` and retry.

---

## Minimum & recommended specs

The app itself is light — it runs in a browser tab or a small native window. What needs
real horsepower is the AI, and you choose where that runs: **cloud** (any computer, just a
key) or **local** (your own CPU/GPU, free and private). You can place the **text** model
and the **image** model independently. With **no keys at all**, the built-in placeholder
art works on anything.

**Text LLM** (reads the book, writes prompts, powers the chat):

| Where | Needs | Models (pick any) |
|---|---|---|
| **Cloud** | Any laptop + a key | **Claude**, **Gemini**, or **OpenAI** |
| **Local — minimum** | A WebGPU browser, or ~8 GB RAM for Ollama | **Llama 3.2 1B/3B**, **Qwen2.5 3B** (in-browser), **Qwen 3 8B** (Ollama) |
| **Local — recommended** | 12–16 GB VRAM or Apple Silicon | **Qwen 3 14B**, **Gemma 3 12B** (better prompts) |
| **Local — vision** | 8 GB+ VRAM | **llama3.2-vision**, **llava**, **qwen2-vl**, or an LM Studio vision model (for the screenshot tool) |

**Image model** (renders the art):

| Where | Needs | Models (pick any) |
|---|---|---|
| **Cloud** | Any laptop + a key | **Flux** (Black Forest Labs), **Gemini** native, **OpenAI** `gpt-image-1` |
| **Local — minimum** | ~4 GB VRAM | **SD 1.5**, **SDXL-Turbo** (run almost anywhere) |
| **Local — recommended** | 8–12 GB VRAM | **SDXL**, **Flux.1**, **Z-Image Turbo** (the recommended default — 8 steps) |
| **Local — high-end** | 16–24 GB VRAM | **Flux.2 Klein 9B**, **Qwen-Image** (sharpest detail + in-image text) |

One **Gemini** or one **OpenAI** key covers both text and images. A common high-continuity
combo is **Claude** (text) + **Flux** (images). Mix cloud and local freely — e.g. a cloud
text key with a local SDXL GPU.

---

## Desktop app (optional)

Prefer a native window over a browser tab? Visual Reader also ships a desktop app
(Tauri) that wraps the same UI and can manage a **local GPU image engine** so big
models run on your own hardware. It needs more than the web app — Rust and the
platform C/C++ build tools in addition to Node.js — but the setup is still one
click on Windows.

- **Windows:** double-click **`desktop.bat`**. It checks/installs Node.js, pnpm,
  Rust, the Visual C++ build tools, and the Tauri CLI, then builds and opens the
  desktop window. The first build compiles the Rust shell and can take several
  minutes; later runs are fast.
  > If it installs Node, Rust, or the build tools, close the window and run
  > `desktop.bat` again so the new PATH/toolchain is picked up.
- **macOS / Linux:** install the Tauri CLI once with
  `cargo install tauri-cli --version "^2" --locked`, then run `pnpm dev:desktop`.
  (You'll also need Rust — see <https://rustup.rs> — and your platform's WebKit
  build dependencies, listed at <https://tauri.app/start/prerequisites/>.)

To produce an installable build (`.msi` / `.dmg` / AppImage) instead of running
in dev mode, use `pnpm build:desktop`.

**Local images, fully automatic (Windows):** in the desktop app, open **Settings**,
set **Images → On my computer**, and just **pick a model** under "Download a model".
The app downloads the ComfyUI engine (bundled Python — nothing installed
system-wide) and your chosen checkpoint, shows progress bars, launches it, and
connects — no separate `comfyui-setup.bat` needed. (macOS/Linux still connect to
an engine you run yourself; see below.)

### Hands-on assistant tools (desktop only — approval-gated)

The desktop app lets the chat assistant reach your machine to *do* things, with a
human approval at every step. Some are on by default, the riskier ones are opt-in:

- **Find files on your computer** — ask "open the PDF in my downloads" and it searches
  and lists matches as clickable items. The first search asks you to **allow filesystem
  access for the session**.
- **Run commands & test code** *(opt-in)* — turn on **Settings → "Let the assistant run
  commands"** and it can run **one shell command at a time** in a dedicated
  `VisualReader` workspace folder (install dependencies, run a build or tests, execute a
  script it wrote). **You approve every command** before it runs; its output comes back so
  the assistant can check whether code works, fix it, and re-run. The same flag enables the
  **screenshot** tool.
- **Screenshots for a vision model** *(opt-in, same flag)* — it can capture your whole
  screen, or just one window by name (great for a running game), and look at it with a
  **vision model** to verify what it built. Vision can be cloud (Claude/Gemini/OpenAI) **or
  a local vision model** (Ollama `llama3.2-vision` / `llava`, or LM Studio) so the image
  never leaves your machine. You approve the first capture and can allow the rest for the
  session.
- **Work with your GitHub repos** *(opt-in — needs the run-commands flag + a token)* — paste a
  GitHub token into **Settings → "GitHub token"** and the assistant can **clone, branch,
  commit, push, open pull requests, and manage issues** using `git` and the `gh` CLI in its
  workspace. Setup:
  1. Install `git` and the **GitHub CLI** (`gh`) — on **Windows just double-click
     `github-setup.bat`** (installs both and can sign you in); on macOS `brew install git gh`,
     on Linux your package manager.
  2. Create a token at **[github.com/settings/tokens](https://github.com/settings/tokens)**
     (a fine-grained token scoped to the repos you want, with Contents + Pull requests +
     Issues access, is ideal). Paste it into Settings.
  3. Turn on **"Let the assistant run commands"** (GitHub work runs through that same
     approval-gated runner — you click to approve every command).

  The token is handed to commands through their **environment** (`GH_TOKEN`) — it's never
  written into a command, shown to the model, or printed — so `gh` is authenticated and
  `git push` works without `gh auth login`. **There's no fixed "current repo":** you tell the
  assistant which repo to clone/work on in plain language, and it works inside the
  `VisualReader` workspace. For changes it creates a branch and opens a PR — `gh` targets the
  repo's **default branch** automatically. It won't force-push, delete history, or change repo
  settings unless you explicitly ask.

These tools only exist in the desktop app (a browser tab can't touch the filesystem, run a
process, or capture the screen). They never act on their own — and the assistant will not
run a command or open a file just because some web page or book text told it to.

---

## Run images on your own GPU (AUTOMATIC1111 or ComfyUI)

This is the path to **free, private, real** image generation today — no API keys,
nothing leaves your machine.

### How it works (web vs desktop) — read this first

There is **one shared ComfyUI install** at `%USERPROFILE%\VisualReader\` —
whether it's set up by `comfyui-setup.bat` *or* by the desktop app, they use the
same folder and the same models/loras. How it runs depends on which app you use:

| | Who installs ComfyUI | Who **starts/stops** it | Do you touch `run-comfyui.bat`? |
|---|---|---|---|
| **Desktop app** | the app (first use) or the bat | the **desktop app**, automatically | **No** — just pick a model in Settings |
| **Web app** (browser) | `comfyui-setup.bat` (or BYO) | **`run.bat`** starts it for you, if installed | **No** — `run.bat` launches it; or run it yourself |

Key points:
- **Desktop app:** fully automatic. Choose **Images → On my computer**, pick a
  model, and the app downloads/launches/stops ComfyUI itself.
- **Web app:** a browser can't start a GPU process, so **`run.bat` now starts the
  local ComfyUI for you** (in its own window) whenever it's installed — then the
  web app connects to it. ComfyUI must be running while you generate; `run.bat`
  handles that each session, or you can launch `run-comfyui.bat` yourself.
- The web app and desktop app are **separate programs** — the browser doesn't run
  "through" the desktop app. They can, however, share the *same* running engine on
  `http://127.0.0.1:8188` (whoever starts it first; the other reuses it).
- **First time only:** open **Settings → Images → On my computer → ComfyUI**,
  **Connect**, and pick a model. After that it reconnects automatically.

### Easiest: one-click ComfyUI (Windows)

Don't have an engine yet? **Double-click `comfyui-setup.bat`.** It downloads the
official **ComfyUI portable** build (bundles its own Python — nothing installed
system-wide), grabs a starter model, and creates **`run-comfyui.bat`** in the
shared `%USERPROFILE%\VisualReader` folder. Uses your NVIDIA GPU if present, CPU
otherwise.

After that, **`run.bat` auto-starts it** for the web app — or the desktop app
starts it on its own. You only need `run-comfyui.bat` directly if you want to run
the engine without the reader open.

> It's a large download (several GB) and resumes if interrupted. AUTOMATIC1111
> and non-NVIDIA GPUs are set up manually — see below.

### Manual: bring your own engine

If you already run one (or want AUTOMATIC1111), install it from source and start
it with its API + CORS enabled, so the browser is allowed to talk to it (the
"origin" is this app's web address, e.g. `http://localhost:5173`):

- **AUTOMATIC1111** (<https://github.com/AUTOMATIC1111/stable-diffusion-webui>)
  ```bash
  # macOS / Linux
  ./webui.sh --api --cors-allow-origins=http://localhost:5173
  # Windows: add to COMMANDLINE_ARGS in webui-user.bat, then run it:
  #   --api --cors-allow-origins=http://localhost:5173
  ```
  Serves at `http://127.0.0.1:7860`.
- **ComfyUI** (<https://github.com/comfyanonymous/ComfyUI>)
  ```bash
  python main.py --enable-cors-header http://localhost:5173
  ```
  Serves at `http://127.0.0.1:8188`.

> **Already have your own ComfyUI?** Use it instead of the app-managed one — just
> add **`--enable-cors-header`** to how you launch it (e.g.
> `.\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --enable-cors-header`).
> **Only one ComfyUI can use port 8188** — start *yours* before `run.bat` and the
> app's auto-start will yield to it. If you hit *"Port 8188 already in use"* or a
> database-lock error, run **`stop-comfyui.bat`** to clear whatever's stuck, then
> start one. To stop the app from launching its own at all, delete
> `%USERPROFILE%\VisualReader\run-comfyui.bat`.

### Connect Visual Reader to it

1. Start Visual Reader (`install.bat` / `run.bat`, or the desktop app).
2. Click **Settings**, set **Images** to **On my computer (free)**.
3. Choose your engine — **AUTOMATIC1111** or **ComfyUI**.
4. Enter the server URL (or leave it blank to use the default shown) and click
   **Connect**. The model dropdown fills with the checkpoints your server has.
5. Pick a model. Re-load the book — pages now render on your own GPU.

> The chosen engine, server URL, and model are remembered, so next time it just
> connects. If Connect fails, the most common cause is the CORS flag above not
> matching the address in your browser's URL bar.

### Picking a model — what works best

Every model in the desktop picker is one click: the app downloads **all** the files a
model needs (the newest models ship as **split files** — diffusion model + text encoder
+ VAE — which land in the right ComfyUI folders automatically) and selects it when done.
Downloads **resume** if interrupted; retrying skips files that finished.

- **Z-Image Turbo — the recommended default for reading.** Current-generation quality
  at **8 steps** (a few seconds per image on a decent GPU), prompts in natural
  language, ~20 GB download.
- **Flux.2 Klein 9B (fp8)** — the official open Flux.2; excellent quality, ~20 GB,
  slower than Z-Image (real CFG, 20 steps). Needs a strong GPU.
- **Qwen-Image (fp8)** — best fine detail and in-image text; the biggest download
  (~30 GB) and VRAM-heaviest.
- **SD 1.5 / SDXL / SDXL-Turbo / Flux.1** — the classic single-file checkpoints;
  smaller and fine on modest GPUs (SD 1.5 runs almost anywhere).

> **Why a "small" model can fill a big card.** A split-file model's checkpoint size
> is only part of what loads: Flux.2 / Z-Image / Qwen-Image each pair the diffusion
> weights with a **large separate text encoder** (a Qwen-3-8B / T5-XXL, ~9 GB) plus a
> VAE, and ComfyUI keeps a copy in **system RAM** as well as VRAM — so the resident
> footprint is easily ~20 GB, mirrored. If you're tight on memory, turn on
> **Settings → Low-VRAM mode**: it loads the diffusion model in fp8 and (managed
> engine) launches ComfyUI with `--lowvram`, so the encoder offloads to RAM after it
> encodes instead of squatting VRAM — roughly halving the resident footprint for a
> small speed/quality cost. (Running **your own** ComfyUI? Add `--lowvram` to how you
> launch it.)

Notes for **manually installed** files (everything above is automatic):

- **All-in-one checkpoints just work** (SD 1.5 / SDXL / Flux.1 fp8) — the app probes
  ComfyUI to see how a file must be loaded.
- **`clip input is invalid: None`?** You selected a **diffusion-only** file whose
  text encoder + VAE aren't installed. For catalog models the error tells you the
  exact missing filenames (the Download button fetches them); for other files set
  **Settings → Images → Model family** and install the encoder/VAE it names.
- The split-file families (**Flux.2 / Z-Image / Qwen-Image**) are **ComfyUI only**
  (not AUTOMATIC1111).

### Local text model (prompt quality)

Illustration **prompts** are written by your text LLM, and the prompt is the ceiling on
image quality. Under **Settings → Text → On my computer → Local server** you can now
**download text models into Ollama from the menu** (live progress bar, no terminal):
**Qwen 3 8B** is the recommended default; **Qwen 3 14B** or **Gemma 3 12B** write even
better prompts if your VRAM allows; **Llama 3.2 3B** is the lightweight fallback.

### One-API native mode (Gemini / OpenAI)

When you use the **same cloud provider for both text and images** (e.g. Gemini for both,
one key), a **Native “one API” mode** toggle appears under the image settings. Turn it on
and renders go through that vendor’s **multimodal** image model (Gemini 2.5 Flash Image, or
OpenAI `gpt-image-1`), which accepts your **uploaded character reference photos** inline —
so cloud renders get the character-consistency conditioning that otherwise needs a local
ComfyUI + IP-Adapter setup. It’s opt-in because it uses a different image model than the
default text-to-image path.

There’s also an experimental **one-shot** sub-toggle: instead of rendering the pre-written
scene prompt, the model reads each passage and draws it directly (fewer steps, less control
over the exact moment). The Visual Bible still supplies character context and reference
photos either way.

### Art styles on a local engine (LoRAs)

When you pick an **Art style** on a local engine, the app also applies a **LoRA
named after the style**, used **only if it's installed** (otherwise it falls back
to the text style prompt — nothing breaks).

There are **three ways** to provide a style's LoRA (and the same applies to
**models/checkpoints** in the desktop model picker):

1. **Built-in download** *(desktop managed engine)* — for styles with a known
   source, Settings shows a **“Download style pack”** button (size + progress);
   it fetches the LoRA into the engine's `models/loras` and uses it.
2. **Paste a URL** *(desktop managed engine)* — paste any `.safetensors` LoRA URL
   for the selected style (or any checkpoint URL under the model picker) and the
   app downloads it into the right folder. Great for styles without a built-in
   source.
3. **Manual** *(any engine)* — drop a LoRA named after the style —
   `anime.safetensors`, `manga.safetensors`, etc. — into `models/loras` (ComfyUI)
   or `models/Lora` (AUTOMATIC1111); drop checkpoints into `models/checkpoints`.
   The app detects and uses them automatically.

Style ids: `photorealistic`, `anime`, `manga`, `animation-3d`, `watercolor`,
`comic`, `oil-painting`, `storybook`.

> Built-in download URLs are best-effort community LoRAs; to change or add one,
> edit the style's `local.lora.url` in
> `packages/core/src/providers/catalog.ts` — or just paste a URL in the UI.

---

## Using the app

The home screen is a **chat assistant** — you can simply tell it what you want:
*"open Frankenstein and illustrate it in oil painting style"*, *"find me an
article on the citric acid cycle"*, *"generate a picture of an apple"*, *"export
this as an epub"*, or just chat. It can open books from your library, fetch
public-domain classics from Project Gutenberg, open web articles, read a web page
or GitHub repo, change the art style, and start illustrating — all from the
conversation. Type **`/`** for a menu of commands (`/web`, `/books`, `/draw`,
`/style`, `/remember`, …), ask it to **make a file** (a worksheet, a CSV, a web
page — it adds a Save button), and it **remembers your preferences** across
sessions. If a request is ambiguous it asks a quick clarifying question rather than
guessing. Or drive everything by hand:

1. Click **Load sample** to start reading immediately — it works with **no API
   keys**, using built-in placeholder art so you can see the whole flow
   (Visual Bible → predictive rendering → bloom reveal → spoiler gating).
2. Or click **Open book…** and choose a file — **EPUB, PDF, Word (`.docx`),
   Excel (`.xlsx`), CSV/TSV, RTF, JSON, plain text, Markdown, or HTML** (data files
   open in technical mode). Dropping an **image** (`.png/.jpg/.webp/.gif`) instead
   opens the **photo-transform** panel to restyle that picture through your image
   model. Every book you open is remembered in a **Library** dropdown in the top bar —
   pick a title to switch back to it instantly (its illustrations + Visual Bible
   are cached, so there's nothing to regenerate). **← Exit book** returns to the
   home screen anytime. You can **export** any open book as an illustrated HTML page
   or EPUB from the toolbar (or just ask the chat).
3. As you scroll, the illustration for the current page appears beside the text,
   fading in as you arrive. Spoiler imagery stays blurred until you read past it.
4. Optional: click **Pre-render whole book** in the top bar to generate every
   page's illustration up front (instead of as you reach them) — the button shows
   `Rendering N/total…` and the current page still takes priority so you can keep
   reading. (The Visual Bible is always built for the whole book on open.)

### Turn on real AI image generation (optional)

You have two ways to get real art:

**A) Cloud (bring your own key):**

1. Click **Settings** in the top bar (in the extension, open the panel's Settings).
2. Pick a **Text** provider (Claude / Gemini / OpenAI) and an **Images** provider
   (Flux / Gemini / OpenAI) — they're independent. Each shows a **Get a key ↗**
   link and a one-line reminder of where to find it.
3. Paste the API key for each one you chose. You'll see **✓ saved** once it's in.
4. Optional: pick an **Art style** (Photorealistic, Anime, Manga, Realistic
   animation, Watercolor, Comic, Oil painting, Storybook, or *Auto*). It applies
   to every illustration, on any provider — cloud or your own GPU. On a **local
   engine** it also uses a matching **LoRA/checkpoint when installed** (see below).
5. Re-load the book — pages now render with real, character-consistent art.

> 🔒 **Your keys are encrypted on your device.** They're sealed with a key that
> lives in your browser and can never be exported, so they're never written to
> disk in plain text — and they're only ever sent to the provider you picked.

#### Where to get each API key

| Provider | Used for | Get your key | Where in the dashboard |
|---|---|---|---|
| **Claude** (Anthropic) | Text | <https://console.anthropic.com/settings/keys> | Settings → API Keys → **Create Key** |
| **Gemini** (Google) | Text **and** images (one key) | <https://aistudio.google.com/app/apikey> | **Get API key** → Create API key |
| **OpenAI** | Text and images (one key) | <https://platform.openai.com/api-keys> | **API keys** → Create new secret key |
| **Flux** (Black Forest Labs) | Images | <https://api.bfl.ai/auth/profile/keys> | Sign in → **Keys** → Add key |

> A common, cheap combo: one **Gemini** key (or one **OpenAI** key) covers both
> text and images. Claude has no image model, so pair it with Flux/Gemini/OpenAI
> for images. (Gemini images use its multimodal model, which works on a standard
> key — no separate Imagen/paid tier needed.)

**B) Your own GPU (free, private):** set **Images** to **On my computer** and
connect a local Stable Diffusion server — see
[Run images on your own GPU](#run-images-on-your-own-gpu-automatic1111-or-comfyui).

### Mature mode (adults only — optional)

Reading intentionally adult fiction? Settings has a **"Mature mode (adults
only)"** checkbox (off by default). It turns off the app's content filtering so
explicit or violent source material is illustrated and discussed faithfully:
it relaxes the adjustable safety filters on **Gemini** (text + image) and
**Flux**, and instructs the models not to sanitise. **Claude and OpenAI** have
no such control and apply their own policies regardless — for the most
permissive results use Gemini, Flux, or a fully local model + local image
engine (which have no external filter at all). Toggling it rebuilds the
providers; if a book's analysis was already done with filtering, use
**↻ Redo → Story analysis** to re-extract.

### Scientific sources (technical books — optional)

For a book imported as **technical**, the app can pull in **real figures** and **sourced
facts** instead of (or before) generating. Both are optional and live under **Settings →
Scientific sources**. They use Google's Programmable Search Engine, which needs **two**
credentials (separate from your Gemini key):

1. **Search engine ID (`cx`)** — create a free engine at
   <https://programmablesearchengine.google.com> → enable **Image search** and **Search the
   entire web** → copy its **Search engine ID**.
2. **Custom Search API key** — in the Google Cloud console
   (<https://console.cloud.google.com>): pick/create a project → **APIs & Services → Library**
   → enable **Custom Search API** → **Credentials → Create credentials → API key**.

Free tier: ~100 searches/day. Then:

- **Real figures** — each technical illustration first searches for an existing diagram of
  the concept; if found it's shown (with source attribution) and cached, otherwise the app
  generates one.
- **Ground analysis in real sources** *(checkbox)* — definitions/quantities are grounded in
  a web search and the sources are cited in the book's glossary. With the **Gemini** text
  provider this uses its built-in Google Search (your Gemini key); with **any other** reader
  — including a **local LLM** — it uses the search engine above. So a fully local read can
  still produce sourced facts.

**C) On-device text (no key):** set **Text** to **On my computer**. Pick how to run
the story-understanding LLM locally under **How to run it**:

- **Built-in model (desktop app only — the default, zero setup):** the desktop app
  **ships a small text model** (Llama 3.2 3B) and a llama.cpp server, and launches them
  for you on first use — no install, no download, no API key. It runs on the **CPU**, so
  it never competes with a local GPU image engine for VRAM (handy when you also generate
  images on the same machine). It's the lightest-touch local option; for faster local text
  use Ollama or keep Text on a cloud key. *(Building the desktop app from source? Run
  `llm-setup.bat` once so the model is bundled into the build — see the desktop README.)*

- **On-device (WebGPU, no install):** runs the model right in the browser/desktop
  via **WebGPU**. Pick a model (default **Llama 3.2 3B**; **Qwen2.5 3B** is best at
  structured extraction; **Llama 3.2 1B** is fastest). The model downloads once on
  first use, then runs offline. Needs a WebGPU-capable browser/desktop; without one
  it falls back to the demo text.

- **Local server (Ollama / LM Studio / llama.cpp):** the most reliable local option
  — runs the model as a normal app on your machine and the reader talks to it over
  an OpenAI-compatible API. Use this if WebGPU won't load. Steps:
  1. Install + start a server. **Ollama (recommended): double-click
     `ollama-setup.bat`** — it installs Ollama, allows browser access, and starts it
     (API at `http://localhost:11434/v1`). Alternatives:
     - **LM Studio** — load a model and start its **Local Server** (`http://localhost:1234/v1`).
     - **llama.cpp** — run its server (e.g. `llama-server -m model.gguf --port 8000`,
       API at `http://localhost:8000/v1`).
  2. In **Settings → Text → On my computer → Local server**, choose the server,
     confirm the URL, click **Connect**.
  3. **Ollama: download a model from the menu** — pick one (Qwen 3 8B is the
     recommended default) and click **Download**; a progress bar runs and the model
     is selected when done. No `ollama pull`, no terminal. For LM Studio /
     llama.cpp, pick from the models the server reports.
  - **CORS (web app only):** a browser page calling Ollama needs `OLLAMA_ORIGINS`
    set (`ollama-setup.bat` does this; manually: `OLLAMA_ORIGINS=*` or your app's
    origin); LM Studio and llama.cpp allow cross-origin requests by default. The
    **Chrome extension** needs no CORS flags — its requests are proxied through the
    extension's background worker. The server must expose OpenAI-compatible
    `/v1/chat/completions` and `/v1/models`.

For the strongest character continuity, you can still keep **Text** on a cloud key
while running **Images** on your own GPU.

---

## Handy commands (optional / advanced)

You don't need these for normal use — the double-click files above cover
everything. They're here for developers and macOS / Linux users.

| Command | What it does |
|---|---|
| `pnpm dev:web` | Run the reader in development at http://localhost:5173 |
| `pnpm dev:desktop` | Run the native desktop app (needs Rust + Tauri CLI) |
| `pnpm build:desktop` | Build a desktop installer (`.msi` / `.dmg` / AppImage) |
| `pnpm test` | Run the test suite |
| `pnpm -r build` | Build all packages and apps |
| `pnpm -r typecheck` | Type-check everything |

## Chrome extension

The extension illustrates anything you read **on the web** (web serials,
fan-fiction, long articles) right on the page.

### Install it (Windows — no typing)

1. **Double-click `extension.bat`.** It builds the extension, then opens the
   build folder and Chrome's Extensions page for you.
2. In Chrome, turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked** and select the folder that opened
   (`apps/extension/dist`).
4. Open any article, click the **Visual Reader** toolbar icon (it's under the
   puzzle-piece menu — you can pin it), and the panel appears.

> After you change the code, run `extension.bat` again and click the circular
> **refresh** icon on the Visual Reader card at `chrome://extensions`.

*(macOS / Linux, or if you prefer the terminal: `pnpm --filter
@visual-reader/extension build`, then load `apps/extension/dist` as above.)*

### Use it

- **What it does:** finds the main article text on the page, runs it through the
  same engine as the web app, and floats an illustration panel beside it that
  follows your scroll.
- **Turn on real generation:** open the panel's **Settings** (same panel as the
  web app):
  - **Cloud:** pick a Text + Images provider and paste your key(s).
  - **Your own GPU:** set Images to **On my computer**, choose AUTOMATIC1111 or
    ComfyUI, enter the server URL, and **Connect**.

Settings are saved in the browser. With nothing configured it uses built-in
**placeholder art**, so page text stays local. When you add keys or a server,
all API calls are routed through the extension's background worker (so they
aren't blocked by the page's CORS) — your keys go only to the provider you chose.

> Because requests go through the extension's background worker, a **local**
> AUTOMATIC1111 / ComfyUI server only needs its API enabled — no CORS flags
> required (unlike the web app).

---

## Example use cases

Not sure which app or which image source fits you? Pick by what you're trying to
do.

### Which version of the app?

| Version | Best when you want to… | Example |
|---|---|---|
| **Web app** | Read EPUBs you own, on any computer, with the least setup | You bought a novel as an `.epub` and want illustrated reading on your laptop in 2 minutes: run `install.bat` (or `pnpm dev:web`), **Open EPUB**, paste one Gemini key, start reading. |
| **Desktop app** | A native, offline-friendly window that can run image models on your own GPU with no browser tab | You have a gaming PC and want free, private art for a long weekend re-read of a trilogy: launch `desktop.bat`, choose **Run on my computer**, let it use your GPU. |
| **Chrome extension** | Illustrate things you read **on the web** — web serials, fan-fiction, long articles — right where they are | You're reading a story on Royal Road / AO3: click the toolbar icon and an illustration panel appears beside the page, updating as you scroll. |

### Which image-generation method?

| Method | Best when… | Example |
|---|---|---|
| **Demo / placeholder** (no keys) | You just want to see the flow, record a screenshot, or develop | Trying Visual Reader for the first time: **Load sample** → watch the Visual Bible, predictive rendering, bloom reveal, and spoiler gating with built-in art, zero config. |
| **Gemini** (one key → text + images) | You want the cheapest, simplest *real* cloud setup with a single key | A casual reader illustrating a YA novel: paste one **Gemini** key, set both Text and Images to Gemini, done. |
| **OpenAI** (one key → text + images) | You already have an OpenAI key and want one-stop setup | You use ChatGPT already: reuse your **OpenAI** key for both story understanding and `gpt-image-1` art. |
| **Claude + Flux** | You care most about character/setting **continuity** and image quality | Illustrating a sprawling fantasy series where faces and outfits must stay consistent: **Claude** builds the Visual Bible, **Flux** renders cinematic scenes. |
| **AUTOMATIC1111** (local GPU) | You already run A1111 and want your own checkpoints/LoRAs, free and offline | You have a tuned anime checkpoint in A1111: start it with `--api`, **Connect** Visual Reader to it, and every page renders in your style — no per-image cost, nothing leaves your PC. |
| **ComfyUI** (local GPU) | You run ComfyUI and want full SDXL/Flux checkpoints on your GPU | You keep SDXL models in ComfyUI: launch it, **Connect**, pick the checkpoint, and read with high-fidelity local art. |

### Worked examples (app + method)

- **Free & private, start to finish — desktop + local GPU.** Install with
  `desktop.bat`, pick **Run on my computer** in the first-run wizard, choose a
  model, and read an EPUB entirely offline on your own hardware.
- **One key, illustrate the web — extension + Gemini.** Build and load the
  extension, open its **Settings**, paste a Gemini key, then open any web serial;
  art appears beside the text as you scroll.
- **Highest continuity for a long series — web + Claude + Flux.** In the web app,
  set Text to **Claude** and Images to **Flux**, paste both keys, and open the
  series' EPUBs one after another — the Visual Bible keeps characters consistent
  across books.
- **Bring your own Stable Diffusion — web + AUTOMATIC1111.** Start A1111 with
  `--api --cors-allow-origins=http://localhost:5173`, then in the web app set
  **Images → On my computer → AUTOMATIC1111**, **Connect**, and pick your
  checkpoint.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `install.bat` closes instantly | Right-click → **Run as administrator**, or open it from a Command Prompt so you can read any error. |
| "Node.js was just installed… run again" | Close the window and double-click `install.bat` again. |
| `corepack: command not found` | Your Node.js is too old. Install v20+ from nodejs.org. |
| Browser opens before the app is ready | Wait a few seconds and refresh — the dev server is still starting. |
| Port 5173 already in use | Stop the other process, or run `pnpm dev:web -- --port 5174`. |
| `desktop.bat`: "Rust/build tools just installed… run again" | Close the window and double-click `desktop.bat` again so the new toolchain is on PATH. |
| Desktop build fails with a linker error | Install the Visual C++ build tools ("Desktop development with C++"): <https://visualstudio.microsoft.com/visual-cpp-build-tools/>. |
| `cargo: command not found` (macOS/Linux) | Install Rust from <https://rustup.rs>, then `cargo install tauri-cli --version "^2" --locked`. |
