# Setup & Usage

Get Visual Reader running locally. The fastest path on Windows is the one-click
installer; manual steps for every platform are below.

---

## Windows — one click

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

---

## Run images on your own GPU (AUTOMATIC1111 or ComfyUI)

This is the path to **free, private, real** image generation today: point Visual
Reader at a Stable Diffusion server you run yourself. It works in **both the web
app and the desktop app** — no API keys, nothing leaves your machine.

You'll need one of these already installed, with at least one checkpoint model:

- **AUTOMATIC1111** — Stable Diffusion web UI
  (<https://github.com/AUTOMATIC1111/stable-diffusion-webui>)
- **ComfyUI** (<https://github.com/comfyanonymous/ComfyUI>)

### 1. Start your engine with its API + CORS enabled

The browser will only talk to the engine if it allows this app's web address
(the "origin", e.g. `http://localhost:5173`).

**AUTOMATIC1111:**

```bash
# macOS / Linux
./webui.sh --api --cors-allow-origins=http://localhost:5173

# Windows
webui-user.bat   # after adding to COMMANDLINE_ARGS:  --api --cors-allow-origins=http://localhost:5173
```

Leave it running. By default it serves at `http://127.0.0.1:7860`.

**ComfyUI:**

```bash
python main.py --enable-cors-header http://localhost:5173
```

By default it serves at `http://127.0.0.1:8188`.

### 2. Connect Visual Reader to it

1. Start Visual Reader (`install.bat` / `pnpm dev:web`, or the desktop app).
2. Click **Settings**, set **Images** to **On my computer (free)**.
3. Choose your engine — **AUTOMATIC1111** or **ComfyUI**.
4. Enter the server URL (or leave it blank to use the default shown) and click
   **Connect**. The model dropdown fills with the checkpoints your server has.
5. Pick a model. Re-load the book — pages now render on your own GPU.

> The chosen engine, server URL, and model are remembered, so next time it just
> connects. If Connect fails, the most common cause is the CORS flag above not
> matching the address in your browser's URL bar.

---

## Using the app

1. Click **Load sample** to start reading immediately — it works with **no API
   keys**, using built-in placeholder art so you can see the whole flow
   (Visual Bible → predictive rendering → bloom reveal → spoiler gating).
2. Or click **Open EPUB** and choose an `.epub` file from your computer.
3. As you scroll, the illustration for the current page appears beside the text,
   fading in as you arrive. Spoiler imagery stays blurred until you read past it.

### Turn on real AI image generation (optional)

You have two ways to get real art:

**A) Cloud (bring your own key):**

1. Click **Settings** in the top bar.
2. Pick a **Text** provider (Claude / Gemini / OpenAI) and an **Images** provider
   (Flux / Imagen / OpenAI) — they're independent.
3. Paste the API key for each one you chose.
   - Get a Claude key at <https://console.anthropic.com>; Gemini at
     <https://aistudio.google.com/app/apikey>; OpenAI at
     <https://platform.openai.com/api-keys>.
   - Keys are encrypted and stored **only on your device**.
4. Re-load the book — pages now render with real, character-consistent art.

**B) Your own GPU (free, private):** set **Images** to **On my computer** and
connect a local Stable Diffusion server — see
[Run images on your own GPU](#run-images-on-your-own-gpu-automatic1111-or-comfyui).

---

## Handy commands

| Command | What it does |
|---|---|
| `pnpm dev:web` | Run the reader in development at http://localhost:5173 |
| `pnpm dev:desktop` | Run the native desktop app (needs Rust + Tauri CLI) |
| `pnpm build:desktop` | Build a desktop installer (`.msi` / `.dmg` / AppImage) |
| `pnpm test` | Run the test suite |
| `pnpm -r build` | Build all packages and apps |
| `pnpm -r typecheck` | Type-check everything |

### Build the Chrome extension

```bash
pnpm --filter @visual-reader/extension build
```

Then in Chrome go to `chrome://extensions`, enable **Developer mode**, click
**Load unpacked**, and select the `apps/extension/dist` folder. Click the
toolbar icon on any article to toggle the overlay.

**What it does:** on the page you're reading, it finds the main article text
(the densest `article` / `main` / `body` block), runs it through the same engine
the web app uses, and floats an illustration panel beside it that follows your
scroll.

**Turn on real generation:** open the panel's **Settings** (same panel as the web
app):

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
