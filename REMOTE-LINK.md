# Remote link — drive the assistant from your phone (LAN)

**Experimental, opt-in, desktop-only.** Lets a phone on the **same Wi-Fi** drive the desktop
assistant in real time, with **no cloud and no account** — the desktop runs a small WebSocket
relay on your local network and the phone becomes a thin client of the desktop's engine. Nothing
leaves your network.

> This is the real-time sibling of the **[remote bus](./SETUP.md)** ("Run commands from my phone
> via Google Tasks"), which works from anywhere but isn't live. Use the bus when you're away; use
> this when you're on the same Wi-Fi and want a live session.

## How it works

```
phone (browser, thin client)  ⟷  ws://<desktop-ip>:8787  ⟷  desktop webview  ⟷  engine worker
                                   (Rust relay, token-gated)
```

- The desktop shell (Rust) opens a **WebSocket relay** bound to your LAN IP on port **8787**.
- Every frame carries a **one-time pairing token**; a device that can't present it is ignored.
- The desktop webview and the phone both connect as WS clients; the relay just forwards
  token-matched frames between them. The relay holds no engine and no data of its own.
- The shared frame format + token live in `packages/core/src/chat/remote-link.ts` (pure, tested);
  the relay is `start_remote_server` / `stop_remote_server` in `apps/desktop/src-tauri/src/main.rs`.

## Use it

1. **Build/update the desktop app** so the `start_remote_server` command is present (this repo
   adds it). If the button reports *"backend unavailable — rebuild the desktop app,"* you're on an
   older build.
2. On the desktop home screen click **🔗 Link phone**. It starts the relay and shows the URL to
   open (it carries the pairing code in the `#vrlink=` hash), e.g. `http://192.168.1.20:8787/#vrlink=…`.
3. On a phone **on the same Wi-Fi**, open that URL. Click **🔗 Phone linked** on the desktop to stop.

## Status & what needs on-device verification

- ✅ **Compiles + built** — `cargo check` builds the relay; the pure foundations (pairing token,
  frame envelope, message (de)serialization incl. ArrayBuffer↔base64, link/host parsing) are
  unit-tested (`remote-link.test.ts`); the TypeScript thin-client typechecks + builds.
- ✅ **Thin-client implemented (guarded).** `useEngineWorker` now has two extra, opt-in paths that
  leave the normal local-worker path byte-for-byte unchanged:
  - **Phone mode** — when the tab is opened via a `#vrlink=…` link it creates **no local worker**;
    it frames every `MainToWorker` message over the relay and feeds `WorkerToMain` replies from the
    relay into the same handler. No engine, no keys on the phone.
  - **Host bridge** — clicking 🔗 Link phone also bridges the desktop's real engine worker to the
    relay: phone requests are `postMessage`d to the worker; the worker's output is mirrored back to
    the phone. CORS-exempt fetches stay **local to the desktop** (`isLocalOnlyMessage` filter).
- ⏳ **Serving the app to the phone.** The phone needs to LOAD the web app from the LAN. For now
  the relay is a WebSocket channel only; to verify, serve the web app on your LAN (e.g.
  `pnpm dev:web --host`, then open `http://<lan-ip>:5173/#vrlink=<token>` on the phone, where the
  hash carries the token and the page host is where the relay listens). **Serving the bundled SPA
  directly from the relay port is the remaining follow-up** so it works from the packaged desktop
  app with no dev server.
- ⏳ **Runtime relay + two-device flow** — the live LAN socket, the phone connecting, and the
  end-to-end round-trip can't be exercised in CI (no socket/device); verify on a real desktop +
  phone. Assumes a **single user** (the same person on both devices) — the relay broadcasts between
  paired peers, so don't share the link.

## Security

- **LAN-only.** The relay binds your local network; there is **no cloud relay** (that's a separate,
  deferred, opt-in idea — it would need a server and end-to-end encryption).
- **Token-gated.** A fresh pairing token is generated each time you start the link; frames without
  it are dropped. Stop the link (🔗 Phone linked → Stop) when you're done.
- **No new data path off your machine.** The engine, keys, and books stay on the desktop; the phone
  only sends/receives the same messages the desktop UI already exchanges with its worker.
