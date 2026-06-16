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

- ✅ **Compiles** — `cargo check` builds the relay; the pure foundations are unit-tested
  (`remote-link.test.ts`); the TypeScript wiring (runtime bridge, the desktop UI) typechecks/builds.
- ⏳ **Runtime relay** — the live LAN socket + a second peer connecting can't be exercised in CI
  (no listening socket / no device), so the relay behavior is verified on a real desktop.
- ⏳ **Phone thin-client** — the phone-side transport (sending the worker-protocol frames over the
  socket instead of to a local Web Worker) and serving the app to the phone are the **remaining
  step**; until then the relay + pairing are in place but a phone won't yet drive the engine
  end-to-end. This is the documented next increment.

## Security

- **LAN-only.** The relay binds your local network; there is **no cloud relay** (that's a separate,
  deferred, opt-in idea — it would need a server and end-to-end encryption).
- **Token-gated.** A fresh pairing token is generated each time you start the link; frames without
  it are dropped. Stop the link (🔗 Phone linked → Stop) when you're done.
- **No new data path off your machine.** The engine, keys, and books stay on the desktop; the phone
  only sends/receives the same messages the desktop UI already exchanges with its worker.
