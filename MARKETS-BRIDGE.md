# TradingView Desktop bridge — setup, update & troubleshooting

This is the **experimental, opt-in** feature that lets the assistant work **directly in your
TradingView Desktop chart** — set the symbol, add studies (VWAP, RSI…), and read back what the
chart is showing (its state, its studies, and the bars themselves) — the same approach the
community "TradingView MCP" tools use. It is **chart-only and never places trades.**

It works by talking to TradingView Desktop over **Chrome DevTools Protocol (CDP)**: TradingView
Desktop is an Electron/Chromium app, and when it's launched with remote debugging it exposes a
local debug port. The desktop shell (Rust) finds the TradingView page and runs one JS expression
in it. Because it drives TradingView's *internal* chart API, it is **version-sensitive** and may
conflict with **TradingView's Terms of Use** — use at your own discretion.

> Desktop app only. The web/extension builds can't reach a local debug port.

---

## One-time setup

1. **Build/update the desktop app** so the `tv_cdp_eval` command + the `tungstenite` dependency
   are present (this repo adds both). From `apps/desktop/src-tauri`: `cargo tauri build` (or
   `cargo tauri dev`). If the bridge button reports *"backend unavailable — rebuild the desktop
   app,"* you're on an older build.
2. **Enable it:** Settings → 🛠 Assistant abilities → **"Let the assistant control my TradingView
   Desktop chart."** Off by default.
3. **Press "Launch TradingView"** in 📈 Markets → Bridge. It finds your install, starts it with the
   debug flag, and waits for the port to answer before reporting success — so a green status means
   the bridge actually works, not that something was spawned. If TradingView is already open
   *without* the flag, quit it first: a second launch just hands off to the running copy and the flag
   is ignored (the button says so when that happens).

   The app only ever **starts** TradingView. It will not download or run an installer for you — if
   it isn't installed, the button offers **Get TradingView Desktop ↗**, which opens the download page
   in your browser.

   To do it by hand instead:
   - **Windows:** `"%LOCALAPPDATA%\Programs\TradingView\TradingView.exe" --remote-debugging-port=9222`
   - **macOS:** `/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222`
   - **Linux:** `tradingview --remote-debugging-port=9222`
   (Make a shortcut with that flag so you don't retype it.)
4. **Test bridge** confirms the connection. **Probe** reports what your build actually exposes —
   the first line answers *can the assistant read my chart's bars?* Then ask the assistant things
   like *"put VWAP on my chart"*, *"switch my chart to AAPL 5-min"*, or *"read the last 20 bars"*.

### What it can read

| Action | Returns |
|---|---|
| `read_state` | the chart's symbol + interval |
| `read_studies` | the studies on the chart, with their ids |
| `read_series` | the OHLCV bars the chart is displaying (`bars`: 1–500, default 100) |
| `probe` | what this TradingView build actually exposes — run this first when something stops working |

**On "live" data.** `read_series` returns exactly what TradingView is showing *you*. It is
real-time only where your own TradingView plan carries a real-time feed; on a free plan most
exchanges are delayed. The bridge cannot make a delayed feed live, and the assistant is told to say
so rather than call a delayed price current. For entitled real-time quotes, connect Schwab instead
(`schwab_quote`).

**`read_series` depends on `exportData`**, a charting-library call that the desktop build is not
guaranteed to expose. If it isn't there the action says so and points you here — run `probe` and
read `canReadSeries`.

### Removed: Pine injection and chart alerts

Earlier versions advertised `inject_pine` and `create_alert`. Neither worked. `inject_pine` called a
`window.__vrPineInject` helper that was never added to the codebase, so it threw every time;
`create_alert` checked that an alert API existed and then returned a success string **without
creating an alert**. Both are gone rather than left as stubs. Use `trading_script` to generate Pine
you paste in yourself, and set alerts in TradingView directly. If you want either done properly,
`probe` is how to find out what your build supports first.

---

The default debug port is **9222**. If you use a different one, the Rust command accepts a `port`
(it defaults to 9222); change the call site or the launch flag to match.

---

## Auto check on startup

When the bridge is enabled, the app probes it on startup and when you open the Markets panel, and
shows the status (connected / not detected). If TradingView isn't running with debugging, just
relaunch it with the flag and hit **Test bridge** — nothing else to reconfigure.

---

## Updating it when TradingView changes

The fragile part is the **JS that drives TradingView's internal chart API**. It lives in **one
place**: `packages/core/src/providers/tv-bridge.ts` → `tvActionScript()`. If an action stops
working after a TradingView update:

1. Open TradingView Desktop's own DevTools (the debug port also serves `http://127.0.0.1:9222`),
   find the chart widget global (commonly `window.tvWidget`), and confirm the call that changed
   (e.g. `activeChart().createStudy(...)`, `setSymbol(...)`, `setResolution(...)`).
2. Update the matching `case` in `tvActionScript()` — that's the only edit needed; the tools,
   worker, and Rust transport don't change.
3. Re-run the unit tests (`pnpm test -- tv-bridge`) — they check the *shape* of the emitted JS, so
   keep the action names stable.

The CDP transport (target discovery + `Runtime.evaluate`) is in `apps/desktop/src-tauri/src/main.rs`
(`tv_cdp_eval`) and rarely needs changes.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"backend unavailable — rebuild the desktop app"* | Rebuild the desktop app so `tv_cdp_eval` exists. |
| *"TradingView Desktop isn't reachable on the debug port"* | Launch TradingView with `--remote-debugging-port=9222`. |
| *"Couldn't find a TradingView page"* | Open a chart window in TradingView, then retry. |
| *"TradingView widget not found / internal API changed"* | Update `tvActionScript()` per the steps above. |

**Safety:** this controls the chart only. It cannot place, modify, or cancel trades — that's the
Schwab review-and-place flow (a separate, explicit, you-confirm path), or your own action in
TradingView/thinkorswim.
