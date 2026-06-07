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

## Using the app

1. Click **Load sample** to start reading immediately — it works with **no API
   keys**, using built-in placeholder art so you can see the whole flow
   (Visual Bible → predictive rendering → bloom reveal → spoiler gating).
2. Or click **Open EPUB** and choose an `.epub` file from your computer.
3. As you scroll, the illustration for the current page appears beside the text,
   fading in as you arrive. Spoiler imagery stays blurred until you read past it.

### Turn on real AI image generation (optional)

1. Click **Settings** in the top bar.
2. Keep the tier on **Cloud (Claude + Flux)**.
3. Paste your **Claude API key** and an **image (Flux) API key**.
   - Get a Claude key at <https://console.anthropic.com>.
   - Keys are encrypted and stored **only on your device**.
4. Re-load the book — pages now render with real, character-consistent art.

---

## Handy commands

| Command | What it does |
|---|---|
| `pnpm dev:web` | Run the reader in development at http://localhost:5173 |
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

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `install.bat` closes instantly | Right-click → **Run as administrator**, or open it from a Command Prompt so you can read any error. |
| "Node.js was just installed… run again" | Close the window and double-click `install.bat` again. |
| `corepack: command not found` | Your Node.js is too old. Install v20+ from nodejs.org. |
| Browser opens before the app is ready | Wait a few seconds and refresh — the dev server is still starting. |
| Port 5173 already in use | Stop the other process, or run `pnpm dev:web -- --port 5174`. |
