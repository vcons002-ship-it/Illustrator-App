# Troubleshooting

Practical fixes for the problems people actually hit. Install/build problems (Node, Rust,
ports) are covered in the table at the bottom of **[SETUP.md](../SETUP.md)**.

---

## Local engine won't start / stuck on "Setting up the local engine…"

The desktop app downloads and launches ComfyUI itself; a stall is almost always one of these:

- **First run is a big download** (several GB) — leave it; progress bars in Settings show
  whether it's still moving. Downloads resume if interrupted, so closing and reopening is safe.
- **Something else owns port 8188** — a ComfyUI you started yourself, or a stuck one. Start
  yours *first* and the app will reuse it, or run `stop-comfyui.bat` to clear whatever's stuck.
- **See what the engine is doing** — turn on **Settings → Show engine console** and relaunch;
  the engine's own window usually names the real error (out of VRAM, missing model file, …).
- **Still wedged?** Quit the app fully (check Task Manager for leftover `python` processes),
  then relaunch. The managed install lives in `%USERPROFILE%\VisualReader\` if you want to
  inspect it.
- Managed engines are **Windows-only** — on macOS/Linux the app never starts an engine; connect
  your own ComfyUI/AUTOMATIC1111 by URL instead.

## "avfilter-10.dll was not found" (ffmpeg)

A broken **shared** ffmpeg build on your PATH (a half-finished install missing its DLLs) is
being picked up. Fix:

1. Delete or un-PATH the broken ffmpeg install.
2. In the app, use **Settings → 🎬 Image-to-video → Download ffmpeg (~80 MB)**. It fetches a
   **static** build (everything linked into one exe — no DLLs to lose) into
   `%USERPROFILE%\VisualReader\ffmpeg`, and the app prefers it from then on.

## A video card appears on the phone, but there's no player

Videos are stripped from the mirrored chat to keep the phone link light; the phone
**auto-fetches the video over the link** from the desktop when you view it. If the card shows
no player:

- Make sure the **desktop app is still open and reachable** on the same Wi-Fi — the phone pulls
  the file from it.
- Wait a moment on a slow network (long-form videos can be tens of MB), or re-open the chat to
  retry the fetch.

## The phone link won't reconnect

- The **desktop app must be running** — the phone is a thin client with no engine of its own.
- Both devices must be on the **same Wi-Fi** (the link is LAN-only; no cloud relay).
- Wi-Fi blips recover on their own (the phone retries and queued messages flush). If it stays
  dead, click **🔗 Link phone** on the desktop again and open the fresh URL — a paired phone
  reuses its saved token, so you won't lose anything.
- First time only: allow the desktop's **firewall prompt for port 8787** (private networks).
- If the desktop app was updated, the phone may need a **page reload** to pick up the new UI.

## Google connect fails (OAuth window opens but never finishes)

Connecting Google uses a **loopback redirect**: the app listens on a `127.0.0.1` port and the
browser hands the consent code back to it.

- Create the credential as an **OAuth client ID → Desktop app** (not "Web application") and add
  your account as a **Test user** on the consent screen — then click through the
  *"unverified app"* warning.
- If the browser shows a connection error after you approve, a firewall or another program is
  blocking the local port — allow the app through the firewall and try **Connect Google** again.
- **"OAuth state mismatch — please try connecting again."** — a stale consent tab was used;
  close old tabs and redo the connect in the tab it just opened.

## "The app's storage is locked by another open tab"

Two open copies of the app are fighting over the same IndexedDB. Close the other Visual Reader
tab(s) — check other windows and minimized browsers — then reload. (The desktop app and a
browser tab each have their own storage, so they don't conflict with each other.)

## "Storage is full — new books, chats, and images are NOT being saved"

Your browser's storage quota is exhausted, and the app is telling you instead of failing
silently. Free space by removing large library items (illustrated books, exports, generated
media you no longer need), then reload. Until you do, new work is **not persisted** — export
anything you care about first.

## AUTOMATIC1111 doesn't auto-start with the app

The desktop app can launch your A1111 install at boot, but only if the path is right:

- **Settings → AUTOMATIC1111 folder** (`a1111Path`) must point at the folder that contains
  **`webui-user.bat`** — the webui root itself, not a parent folder or the `webui` script.
- Make sure `webui-user.bat` includes `--api` in its `COMMANDLINE_ARGS` (see SETUP.md) so the
  app can talk to it once it's up.
- Auto-start is **Windows-only**; elsewhere start A1111 yourself and connect by URL.
