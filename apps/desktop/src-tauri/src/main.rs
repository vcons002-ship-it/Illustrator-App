#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Visual Reader desktop shell.
//!
//! The renderer is the existing web app (`apps/web`); this Rust shell adds the
//! one thing a browser cannot do — manage a local GPU inference engine so big
//! image models (SD / SDXL / Flux) "just work" with no setup. It exposes three
//! commands to the renderer (see `apps/web/src/runtime.ts`):
//!   - `ensure_engine`  install + launch the engine on first use, return its URL
//!   - `list_models`    the checkpoints currently downloaded
//!   - `download_model` fetch a curated checkpoint on demand (with progress)
//!
//! Implementation notes:
//!   - The app-managed install uses the official **ComfyUI Windows portable**
//!     build (bundled Python, nothing installed system-wide). On macOS/Linux the
//!     command returns a clear message pointing to the manual / connect path.
//!   - All blocking work (network, unzip, process spawn, fs) runs inside
//!     `spawn_blocking`; only the small shared state is touched on the async side
//!     (so we never block the Tauri async runtime or hold a lock across `await`).
//!   - Progress is streamed to the UI via `engine://progress` / `model://progress`.
//!
//! NOTE: this requires the Rust toolchain + (ideally) a GPU to compile and run;
//! it is verified on a real desktop, not in CI.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const COMFY_PORTABLE_URL: &str =
    "https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z";
const ENGINE_PORT: u16 = 8188;

/// Process + endpoint handle for the managed engine. The child is killed on app
/// exit (see `RunEvent::ExitRequested` in `main`), so no stray GPU process lingers.
#[derive(Default)]
struct EngineState {
    base_url: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
    /// Serializes engine setup so concurrent `ensure_engine` calls (e.g. React
    /// StrictMode double-invoking the effect in dev) never spawn two engines.
    setup: tauri::async_runtime::Mutex<()>,
}

#[derive(Serialize, Clone)]
struct EngineProgress {
    phase: String, // downloading | extracting | starting | ready | error
    message: String,
    percent: Option<f64>,
}

#[derive(Serialize, Clone)]
struct ModelProgress {
    id: String,
    #[serde(rename = "receivedBytes")]
    received_bytes: u64,
    #[serde(rename = "totalBytes")]
    total_bytes: u64,
    percent: f64,
}

#[derive(Serialize)]
struct InstalledModel {
    id: String,
    label: String,
}

#[derive(Deserialize)]
struct DownloadableModel {
    id: String,
    filename: String,
    url: String,
    /// ComfyUI models subfolder (split-file models): "checkpoints" (default),
    /// "diffusion_models", "text_encoders" or "vae".
    #[serde(default)]
    folder: Option<String>,
}

// --------------------------------------------------------------------- commands

/// Ensure the local engine is installed and running; return its base URL. `low_vram`
/// launches ComfyUI with `--lowvram` so the big text encoder offloads to CPU after
/// encoding (only honoured the FIRST time the engine starts — a reused instance keeps
/// whatever mode it booted in).
#[tauri::command]
async fn ensure_engine(
    app: AppHandle,
    state: State<'_, EngineState>,
    low_vram: Option<bool>,
) -> Result<String, String> {
    if let Some(existing) = state.base_url.lock().unwrap().clone() {
        return Ok(existing);
    }
    // Only one setup at a time. A second concurrent call waits here, then finds
    // base_url already set below and reuses it — so we never spawn twice.
    let _setup = state.setup.lock().await;
    if let Some(existing) = state.base_url.lock().unwrap().clone() {
        return Ok(existing);
    }
    let app2 = app.clone();
    let low = low_vram.unwrap_or(false);
    let (base, child) = tauri::async_runtime::spawn_blocking(move || ensure_blocking(&app2, low))
        .await
        .map_err(|e| e.to_string())??;
    *state.base_url.lock().unwrap() = Some(base.clone());
    if let Some(child) = child {
        *state.child.lock().unwrap() = Some(child);
    }
    Ok(base)
}

/// Models currently downloaded (the Settings model picker reads this). Lists both
/// all-in-one checkpoints and split-file diffusion models.
#[tauri::command]
async fn list_models(app: AppHandle) -> Result<Vec<InstalledModel>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for dir in [checkpoints_dir(&app), comfy_models_dir(&app).join("diffusion_models")] {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if (name.ends_with(".safetensors") || name.ends_with(".ckpt"))
                        && seen.insert(name.to_lowercase())
                    {
                        out.push(InstalledModel { id: name.clone(), label: name });
                    }
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download a curated model file into the engine's models dir, with progress.
/// `folder` routes split-file components (diffusion model / text encoder / VAE).
#[tauri::command]
async fn download_model(app: AppHandle, model: DownloadableModel) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = match model.folder.as_deref() {
            None | Some("checkpoints") => checkpoints_dir(&app2),
            Some(f @ ("diffusion_models" | "text_encoders" | "vae")) => {
                comfy_models_dir(&app2).join(f)
            }
            Some(other) => return Err(format!("Unknown model folder \"{other}\".")),
        };
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = dir.join(&model.filename);
        download_model_with_progress(&app2, &model, &dest)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// LoRAs currently installed in the engine's loras dir (style auto-download checks).
#[tauri::command]
async fn list_loras(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = loras_dir(&app);
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".safetensors") || name.ends_with(".ckpt") || name.ends_with(".pt") {
                    out.push(name);
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Total VRAM of the primary GPU in MB, or `None` when it can't be determined
/// (no NVIDIA GPU / `nvidia-smi` absent). Used to keep Auto-quality within what the
/// card can render without running out of memory. Best-effort and never an error.
#[tauri::command]
async fn gpu_info() -> Result<Option<u64>, String> {
    Ok(tauri::async_runtime::spawn_blocking(nvidia_vram_mb)
        .await
        .unwrap_or(None))
}

/// Query `nvidia-smi` for the first GPU's total memory in MB. None on any failure.
fn nvidia_vram_mb() -> Option<u64> {
    let out = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next()?.trim().parse::<u64>().ok()
}

/// Per-GPU VRAM usage for the status-bar indicator, as raw `nvidia-smi` CSV lines
/// ("name, total_mb, used_mb"), parsed on the JS side. Unlike ComfyUI's /system_stats — which
/// only sees its OWN torch context — `nvidia-smi`'s `memory.used` is the whole board across ALL
/// processes, so a co-resident local LLM (Ollama / the bundled llama-server) is included. `None`
/// on any failure (no NVIDIA GPU / `nvidia-smi` absent). Best-effort, never an error.
#[tauri::command]
async fn gpu_vram_usage() -> Result<Option<String>, String> {
    Ok(tauri::async_runtime::spawn_blocking(nvidia_vram_usage_csv)
        .await
        .unwrap_or(None))
}

fn nvidia_vram_usage_csv() -> Option<String> {
    let out = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total,memory.used",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Fully relaunch the app (Settings → Restart app). The bundled engine/LLM children are killed on
/// exit (see `RunEvent::ExitRequested`), so nothing is left holding the GPU. Never returns.
#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

/// One installed LoRA's name + the leading JSON header of its safetensors file (training
/// metadata + tensor names), so the UI can detect which base model it was trained for.
#[derive(Serialize)]
struct LoraHeader {
    name: String,
    /// The safetensors JSON header, or "" when unreadable / not a safetensors file.
    header: String,
}

/// Read each LoRA's safetensors header (a few KB at the FRONT of the file — never the
/// multi-GB of weights) so the renderer can classify its base architecture.
#[tauri::command]
async fn lora_headers(app: AppHandle) -> Result<Vec<LoraHeader>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = loras_dir(&app);
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                // Only safetensors carry a readable header; .ckpt/.pt are opaque pickles.
                if !(name.ends_with(".safetensors") || name.ends_with(".sft")) {
                    continue;
                }
                let header = read_safetensors_header(&entry.path()).unwrap_or_default();
                out.push(LoraHeader { name, header });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read only the JSON header of a safetensors file: first 8 bytes are the header length
/// (u64 little-endian), followed by that many bytes of JSON. Bounded so a corrupt length
/// can never allocate wildly. None on any read/parse failure.
fn read_safetensors_header(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut len_buf = [0u8; 8];
    f.read_exact(&mut len_buf).ok()?;
    let len = u64::from_le_bytes(len_buf);
    if len == 0 || len > 32 * 1024 * 1024 {
        return None; // a sane LoRA header is tens of KB, never >32 MB
    }
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

// ------------------------------------------------------------------ http proxy

/// One proxied HTTP request from the renderer (see `desktopHttpFetch` in
/// `apps/web/src/runtime.ts`). Bodies travel base64-encoded because invoke
/// payloads are JSON, not binary — same convention as the extension's proxy.
#[derive(Deserialize)]
struct HttpFetchRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    #[serde(rename = "bodyBase64")]
    body_base64: Option<String>,
}

#[derive(Serialize)]
struct HttpFetchResult {
    ok: bool,
    status: u16,
    #[serde(rename = "statusText")]
    status_text: String,
    headers: std::collections::HashMap<String, String>,
    #[serde(rename = "bodyBase64")]
    body_base64: String,
}

/// Search pages / articles / figures — never model downloads (those have their
/// own resumable path) and never LLM streams (cloud APIs are CORS-open and stay
/// on the webview's native fetch). 32 MB covers any page or figure generously.
const HTTP_FETCH_MAX_BYTES: usize = 32 * 1024 * 1024;

/// True when a URL targets the local machine / LAN — a self-hosted engine (ComfyUI / AUTOMATIC1111),
/// a dev server, etc. Such requests must NOT go through a system/env proxy: the webview's `fetch`
/// bypasses the proxy for localhost, but `reqwest` honors it by default, so a user behind a proxy
/// (corporate, Cloudflare WARP, …) hits the proxy when reaching their own 127.0.0.1 and gets the
/// opaque "error sending request for url". We bypass the proxy for these so a local engine is always
/// reachable; internet requests (web/figure search) keep proxy support.
fn is_local_target(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(raw) = parsed.host_str() else {
        return false;
    };
    let host = raw.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        Ok(std::net::IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => false,
    }
}

/// Flatten an error + its source chain into one message, so a wrapped transport failure surfaces its
/// real cause (e.g. "error sending request for url (…) — error trying to connect — Connection
/// refused") instead of just the opaque top line.
fn err_with_sources(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut src = e.source();
    while let Some(inner) = src {
        s.push_str(" — ");
        s.push_str(&inner.to_string());
        src = inner.source();
    }
    s
}

/// CORS-free fetch for the renderer — the desktop twin of the extension's
/// background-worker proxy (`apps/extension/src/background.ts`). The webview is
/// a browser and enforces CORS like any other; this native command is what lets
/// the chat buddy's keyless web search (DuckDuckGo) and "open this URL" work in
/// the desktop app with no API keys. Plain request/response only: no cookies,
/// no auth ambient to the user's browser — strictly less capable than curl.
#[tauri::command]
async fn http_fetch(request: HttpFetchRequest) -> Result<HttpFetchResult, String> {
    tauri::async_runtime::spawn_blocking(move || http_fetch_blocking(request))
        .await
        .map_err(|e| e.to_string())?
}

fn http_fetch_blocking(req: HttpFetchRequest) -> Result<HttpFetchResult, String> {
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::STANDARD;
    if !(req.url.starts_with("https://") || req.url.starts_with("http://")) {
        return Err("Only http(s) URLs can be fetched.".into());
    }
    // A real User-Agent is REQUIRED by some hosts: Wikimedia (the keyless image/
    // figure search) returns 403 to a client with none, and reqwest built with
    // default-features=false sends no default UA. The browser/extension paths get
    // the webview's UA for free; this proxy must set one or desktop figure search
    // 403s. A request that carries its own User-Agent header still overrides this.
    let mut client_builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("VisualReader/1.0 (https://github.com/vcons002-ship-it/illustrator-app)");
    // A self-hosted engine on this machine/LAN must bypass any system/env proxy (see is_local_target).
    if is_local_target(&req.url) {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder.build().map_err(|e| e.to_string())?;
    let method =
        reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
    let mut builder = client.request(method, &req.url);
    for (name, value) in &req.headers {
        builder = builder.header(name, value);
    }
    if let Some(b64) = &req.body_base64 {
        builder = builder.body(engine.decode(b64).map_err(|e| e.to_string())?);
    }
    let mut resp = builder.send().map_err(|e| err_with_sources(&e))?;
    let status = resp.status();
    let mut headers = std::collections::HashMap::new();
    for (name, value) in resp.headers() {
        if let Ok(text) = value.to_str() {
            headers.insert(name.to_string(), text.to_string());
        }
    }
    let mut body: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1 << 16];
    loop {
        let n = resp.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
        if body.len() > HTTP_FETCH_MAX_BYTES {
            return Err("Response exceeded the 32 MB proxy limit.".into());
        }
    }
    Ok(HttpFetchResult {
        ok: status.is_success(),
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body_base64: engine.encode(&body),
    })
}

/// TradingView Desktop bridge (experimental, opt-in): discover the TradingView page
/// target on the Chrome DevTools port and run one JS expression in it via
/// `Runtime.evaluate`, returning the JSON-stringified result value. Used by the
/// Markets bridge so the assistant can drive the user's TradingView chart (set symbol,
/// add studies, read state). Chart-only — it never trades. See MARKETS-BRIDGE.md.
#[derive(serde::Deserialize)]
struct TvCdpRequest {
    port: Option<u16>,
    expression: String,
}
#[derive(serde::Serialize)]
struct TvCdpResult {
    ok: bool,
    value: Option<String>,
    error: Option<String>,
}
#[tauri::command]
async fn tv_cdp_eval(request: TvCdpRequest) -> Result<TvCdpResult, String> {
    tauri::async_runtime::spawn_blocking(move || tv_cdp_eval_blocking(request))
        .await
        .map_err(|e| e.to_string())?
}

fn tv_cdp_eval_blocking(req: TvCdpRequest) -> Result<TvCdpResult, String> {
    let port = req.port.unwrap_or(9222);
    // Discover the TradingView page target (HTTP), then evaluate over its websocket.
    let list_url = format!("http://127.0.0.1:{port}/json/list");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let targets: serde_json::Value = client
        .get(&list_url)
        .send()
        .map_err(|_| "TradingView Desktop isn't reachable on the debug port. Launch it with --remote-debugging-port=9222 (see MARKETS-BRIDGE.md).".to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let ws_url = targets
        .as_array()
        .and_then(|arr| {
            arr.iter().find(|t| {
                t["type"] == "page"
                    && (t["url"].as_str().unwrap_or("").to_lowercase().contains("tradingview")
                        || t["title"].as_str().unwrap_or("").to_lowercase().contains("tradingview"))
            })
        })
        .and_then(|t| t["webSocketDebuggerUrl"].as_str())
        .ok_or_else(|| "Couldn't find a TradingView page on the debug port (is a chart open?).".to_string())?
        .to_string();
    let (mut socket, _) = tungstenite::connect(&ws_url).map_err(|e| e.to_string())?;
    let msg = serde_json::json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": { "expression": req.expression, "returnByValue": true, "awaitPromise": true }
    });
    socket
        .send(tungstenite::Message::Text(msg.to_string()))
        .map_err(|e| e.to_string())?;
    for _ in 0..100 {
        match socket.read().map_err(|e| e.to_string())? {
            tungstenite::Message::Text(txt) => {
                let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
                if v["id"] == 1 {
                    if !v["result"]["exceptionDetails"].is_null() {
                        let text = v["result"]["exceptionDetails"]["exception"]["description"]
                            .as_str()
                            .unwrap_or("evaluation error")
                            .to_string();
                        return Ok(TvCdpResult { ok: false, value: None, error: Some(text) });
                    }
                    let value = v["result"]["result"]["value"].clone();
                    return Ok(TvCdpResult { ok: true, value: Some(value.to_string()), error: None });
                }
            }
            tungstenite::Message::Close(_) => break,
            _ => {}
        }
    }
    Err("No CDP response from TradingView.".into())
}

// ---------------------------------------------------------------------------
// Remote link (LAN): a small WebSocket relay so a phone on the same Wi-Fi can
// drive the assistant in real time (see REMOTE-LINK.md). The desktop webview and
// the phone both connect as WS clients; this server just relays token-gated frames
// between paired peers — it holds no engine itself. Opt-in, LAN-only.
//
// NEEDS REAL-DEVICE VERIFICATION: there is no listening socket in CI, so this async
// relay is written to the idiomatic tokio-tungstenite + broadcast pattern but is
// verified on a real desktop, not here. (Same posture as the GPU/CDP code above.)

/// Stop-handle + advertised URL for a running relay; cleared by `stop_remote_server`.
#[derive(Default)]
struct RemoteServerState {
    inner: Mutex<Option<RemoteHandle>>,
}
struct RemoteHandle {
    stop: std::sync::Arc<tokio::sync::Notify>,
    url: String,
    token: String,
    port: u16,
}

#[derive(serde::Deserialize)]
struct StartRemoteRequest {
    token: String,
    port: Option<u16>,
}
#[derive(serde::Serialize, Clone)]
struct RemoteServerStatus {
    running: bool,
    url: Option<String>,
    token: Option<String>,
    port: Option<u16>,
    error: Option<String>,
}

/// Best-effort LAN IP of this machine (no DNS): open a UDP socket "towards" a public
/// address and read back which local interface the OS picked. Falls back to localhost.
fn local_ip() -> String {
    use std::net::UdpSocket;
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            Ok(s.local_addr()?.ip().to_string())
        })
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

#[tauri::command]
async fn start_remote_server(
    app: AppHandle,
    request: StartRemoteRequest,
    state: State<'_, RemoteServerState>,
) -> Result<RemoteServerStatus, String> {
    let port = request.port.unwrap_or(8787);
    let token = request.token;
    let host = local_ip();
    let url = format!("http://{host}:{port}/#vrlink={token}");
    let stop = std::sync::Arc::new(tokio::sync::Notify::new());

    // Replace any prior server (signal the old one to stop first).
    if let Ok(mut guard) = state.inner.lock() {
        if let Some(prev) = guard.take() {
            prev.stop.notify_waiters();
        }
        *guard = Some(RemoteHandle {
            stop: stop.clone(),
            url: url.clone(),
            token: token.clone(),
            port,
        });
    }

    let bind = format!("0.0.0.0:{port}");
    let token_for_loop = token.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_remote_server(bind, token_for_loop, stop, app).await {
            eprintln!("remote relay stopped: {e}");
        }
    });

    Ok(RemoteServerStatus {
        running: true,
        url: Some(url),
        token: Some(token),
        port: Some(port),
        error: None,
    })
}

#[tauri::command]
fn stop_remote_server(state: State<'_, RemoteServerState>) {
    if let Ok(mut guard) = state.inner.lock() {
        if let Some(h) = guard.take() {
            h.stop.notify_waiters();
        }
    }
}

#[tauri::command]
fn remote_server_status(state: State<'_, RemoteServerState>) -> RemoteServerStatus {
    if let Ok(guard) = state.inner.lock() {
        if let Some(h) = guard.as_ref() {
            return RemoteServerStatus {
                running: true,
                url: Some(h.url.clone()),
                token: Some(h.token.clone()),
                port: Some(h.port),
                error: None,
            };
        }
    }
    RemoteServerStatus { running: false, url: None, token: None, port: None, error: None }
}

/// Open a live web page in its OWN Tauri webview window — the in-app browser's "live" mode
/// (the readable-text panel stays in the main window for illustrate/analyse). The external
/// page runs in a separate webview with **no Visual Reader APIs exposed to it**, so a hostile
/// site can't reach the engine, the filesystem, or your keys. http(s) only. Reuses one window
/// ("vr-browser"): if it's already open, just navigate it to the new URL.
#[tauri::command]
async fn open_browser_window(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http(s) pages can be opened.".into());
    }
    if let Some(win) = app.get_webview_window("vr-browser") {
        win.navigate(parsed).map_err(|e| e.to_string())?;
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "vr-browser", tauri::WebviewUrl::External(parsed))
        .title("Visual Reader — Browse")
        .inner_size(1024.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Run a **stdio MCP server** for one exchange: spawn `command args`, write the JSON-RPC request
/// lines to its stdin (newline-delimited), close stdin so the server finishes + exits, and return
/// its stdout lines (bounded by a 30s read timeout). The command is user-authored in Settings —
/// the same trust model as the run-command tool — and a browser can't spawn a process, so this is
/// desktop-only. The JSON-RPC protocol itself lives in the TS core (mcp.ts); this is a dumb pipe.
#[derive(serde::Deserialize)]
struct McpStdioRequest {
    command: String,
    args: Vec<String>,
    input: Vec<String>,
}
#[tauri::command]
async fn mcp_stdio_exchange(request: McpStdioRequest) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || mcp_stdio_blocking(request))
        .await
        .map_err(|e| e.to_string())?
}

fn mcp_stdio_blocking(req: McpStdioRequest) -> Result<Vec<String>, String> {
    use std::io::{BufRead, BufReader, Write};
    let mut child = Command::new(&req.command)
        .args(&req.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("couldn't start MCP server '{}': {e}", req.command))?;
    {
        let mut stdin = child.stdin.take().ok_or("no stdin on the MCP server")?;
        for line in &req.input {
            writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
        }
        // stdin dropped here → the server reads EOF and should respond + exit.
    }
    let stdout = child.stdout.take().ok_or("no stdout on the MCP server")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut lines = Vec::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            lines.push(line);
        }
        let _ = tx.send(lines);
    });
    match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(lines) => {
            let _ = child.wait();
            Ok(lines)
        }
        Err(_) => {
            let _ = child.kill();
            Err("the MCP server timed out (no response in 30s)".into())
        }
    }
}

/// Constant-time byte comparison for the pairing token — equal length AND equal contents, with no
/// early-out, so authorization timing doesn't leak how many leading bytes matched.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The relay loop: accept connections, classify each (peek the request bytes) as either a
/// WebSocket upgrade (authorize by the pairing token, then relay frames between peers) or a
/// plain HTTP GET (serve the bundled web app so the phone can LOAD it from this same port —
/// no dev server, no cloud). `peek` doesn't consume the stream, so the WS handshake still
/// reads cleanly afterwards.
async fn run_remote_server(
    bind: String,
    token: String,
    stop: std::sync::Arc<tokio::sync::Notify>,
    app: AppHandle,
) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    let listener = tokio::net::TcpListener::bind(&bind).await.map_err(|e| e.to_string())?;
    let (tx, _rx) = tokio::sync::broadcast::channel::<(u64, String)>(256);
    let mut next_id: u64 = 0;
    loop {
        let (stream, _addr) = tokio::select! {
            _ = stop.notified() => return Ok(()),
            accepted = listener.accept() => accepted.map_err(|e| e.to_string())?,
        };
        // Peek (non-consuming) to tell a WebSocket upgrade from a plain HTTP request. Use a large
        // buffer: through Cloudflare (Access) the request carries big headers + the CF_Authorization
        // JWT cookie, which can push the `Upgrade: websocket` header well past the first KB.
        let mut head = [0u8; 8192];
        let n = match stream.peek(&mut head).await {
            Ok(n) => n,
            Err(_) => continue,
        };
        let head_str = String::from_utf8_lossy(&head[..n]).to_ascii_lowercase();
        if !head_str.contains("upgrade: websocket") {
            // Serve the bundled SPA so the phone can load the app from this port.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                serve_http_asset(stream, &app).await;
            });
            continue;
        }
        let peer_id = next_id;
        next_id += 1;
        let tx = tx.clone();
        let mut rx = tx.subscribe();
        let token = token.clone();
        tauri::async_runtime::spawn(async move {
            let ws = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws,
                Err(_) => return,
            };
            let (mut write, mut read) = ws.split();
            // Authorize: the first frame must carry the pairing token.
            let mut authorized = false;
            loop {
                tokio::select! {
                    incoming = read.next() => {
                        let Some(Ok(msg)) = incoming else { break };
                        if let tokio_tungstenite::tungstenite::Message::Text(txt) = msg {
                            if !authorized {
                                // Constant-time compare so a network timing side-channel can't probe the
                                // pairing token byte-by-byte (it now also gates an internet-exposed tunnel).
                                let ok = serde_json::from_str::<serde_json::Value>(&txt)
                                    .ok()
                                    .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(|s| ct_eq(s.as_bytes(), token.as_bytes())))
                                    .unwrap_or(false);
                                if !ok { break; }
                                authorized = true;
                            }
                            // Relay this peer's frame to the others.
                            let _ = tx.send((peer_id, txt));
                        }
                    }
                    bcast = rx.recv() => {
                        let Ok((from, txt)) = bcast else { continue };
                        if from == peer_id || !authorized { continue; }
                        if write.send(tokio_tungstenite::tungstenite::Message::Text(txt)).await.is_err() { break; }
                    }
                }
            }
        });
    }
}

/// Serve one bundled web-app asset over a plain HTTP/1.1 response, so a phone can load the
/// SPA from the relay port. Reads the request line for the path, resolves it from Tauri's
/// embedded assets (SPA-fallback to index.html for extension-less routes), and writes the
/// bytes back. The pairing token rides in the URL `#hash`, which the browser keeps client-side
/// (never sent here) — so serving a file leaks nothing; the WS handshake still gates control.
async fn serve_http_asset(mut stream: tokio::net::TcpStream, app: &AppHandle) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // Read the FULL request head (request line + ALL headers), not a fixed slice. Through Cloudflare
    // the request carries large headers — X-Forwarded-*, and especially the CF_Authorization JWT
    // cookie that Access adds — that exceed a single small read. If we reply + close with request
    // bytes still unread in the socket, Windows sends a TCP RST and the edge reports 502 (Bad
    // Gateway). So drain to the end of the headers (\r\n\r\n) first, then respond and close cleanly.
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => break, // peer closed
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                // End of the request head, or a sane cap so a malformed request can't grow forever.
                if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 65536 {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    if buf.is_empty() {
        return;
    }
    let req = String::from_utf8_lossy(&buf);
    let raw_path = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string();
    // Drop the query/fragment, normalise to an asset key.
    let path = raw_path.split(['?', '#']).next().unwrap_or("/");
    let mut key = path.trim_start_matches('/').to_string();
    if key.is_empty() {
        key = "index.html".to_string();
    }
    let resolver = app.asset_resolver();
    let asset = resolver.get(format!("/{key}")).or_else(|| resolver.get(key.clone())).or_else(|| {
        // SPA fallback: an extension-less route (e.g. a deep link) → index.html.
        if key.contains('.') {
            None
        } else {
            resolver.get("/index.html".to_string()).or_else(|| resolver.get("index.html".to_string()))
        }
    });
    let (status, mime, body): (&str, String, Vec<u8>) = match asset {
        Some(a) => ("200 OK", a.mime_type, a.bytes),
        // No embedded asset. In a `tauri dev` build the web UI is served by the Vite dev server
        // (devUrl), not bundled into the binary, so the resolver is empty and every phone request
        // would 404. Proxy the request to the dev server so the phone link still works in
        // development; if there's no reachable dev server, show an actionable guidance page
        // instead of a bare "Not found".
        None => match proxy_dev_asset(app, &raw_path).await {
            Some((m, b)) => ("200 OK", m, b),
            None => (
                "503 Service Unavailable",
                "text/html; charset=utf-8".to_string(),
                phone_link_help_html().into_bytes(),
            ),
        },
    };
    // Cache policy so a desktop rebuild reliably reaches the phone: NEVER cache the HTML shell (it
    // must re-fetch each load to pick up new asset hashes), but let the content-hashed /assets/*
    // files cache long (a new build = new hashes = new URLs, so this is safe and keeps loads fast
    // over the tunnel).
    let cache = if mime.starts_with("text/html") {
        "no-cache, must-revalidate"
    } else if key.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: {cache}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(&body).await;
    let _ = stream.flush().await;
    // Graceful FIN (half-close the write side) so the peer reads the whole response before the
    // socket drops — avoids a truncating RST under Cloudflare.
    let _ = stream.shutdown().await;
}

/// In a `tauri dev` build the web UI is served by the Vite dev server (`devUrl`) rather than
/// embedded in the binary, so `asset_resolver()` is empty and the phone link would 404 on
/// every request. Proxy the request straight through to the dev server (same path) so the
/// phone link works in development too. Returns `(mime, bytes)` on success, or `None` when
/// there's no reachable dev server (a packaged build, or the dev server isn't running) — in
/// which case the caller shows a guidance page. http(s) only; mirrors the existing
/// `reqwest::blocking` usage elsewhere in this file.
async fn proxy_dev_asset(app: &AppHandle, req_path: &str) -> Option<(String, Vec<u8>)> {
    let base = app
        .config()
        .build
        .dev_url
        .as_ref()
        .map(|u| u.to_string())
        .unwrap_or_else(|| "http://localhost:5173/".to_string());
    let base = base.trim_end_matches('/').to_string();
    let path = if req_path.starts_with('/') {
        req_path.to_string()
    } else {
        format!("/{req_path}")
    };
    let target = format!("{base}{path}");
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .ok()?;
        let resp = client.get(&target).send().ok()?;
        if !resp.status().is_success() {
            return None;
        }
        // Read the content-type before consuming the body.
        let mime = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = resp.bytes().ok()?.to_vec();
        Some((mime, bytes))
    })
    .await
    .ok()
    .flatten()
}

/// A small, self-contained guidance page shown when the phone link can't be served: either a
/// `tauri dev` build whose Vite dev server isn't running, or some other reason the SPA bytes
/// aren't available. Explains the two requirements (a packaged build + same Wi-Fi) so the
/// reader isn't left staring at a bare "Not found".
fn phone_link_help_html() -> String {
    "<!doctype html><html><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<title>Visual Reader — Phone link</title>\
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#11131a;\
color:#e7e9ee;margin:0;padding:2rem;line-height:1.5}main{max-width:34rem;margin:0 auto}\
h1{font-size:1.25rem}code{background:#1d2130;padding:.1rem .35rem;border-radius:.3rem}\
li{margin:.4rem 0}.muted{color:#9aa0ad;font-size:.9rem}</style></head><body><main>\
<h1>Phone link isn't ready yet</h1>\
<p>The desktop app is reachable on this address, but it can't serve the reader UI to your phone right now.</p>\
<ul>\
<li>Use a <strong>packaged build</strong> of the desktop app (<code>pnpm build:desktop</code>), not <code>tauri dev</code>. \
In dev mode the UI is served by the Vite dev server, which your phone can't reach.</li>\
<li>Keep your phone and computer on the <strong>same Wi-Fi network</strong>.</li>\
<li>Re-open the phone link from the desktop app to get a fresh address and pairing code.</li>\
</ul>\
<p class=\"muted\">If you're a developer running <code>tauri dev</code>, make sure the Vite dev server is running \
and reachable — the desktop app will proxy phone requests to it.</p>\
</main></body></html>"
        .to_string()
}

/// Save a generated artifact (illustrated HTML/EPUB export, or a single image) to
/// disk. Writes into `~/VisualReader/exports` (created on demand) and returns the
/// full path — the renderer shows it to the reader. Deliberately uses a fixed,
/// app-owned folder via plain `std::fs` rather than a file-picker plugin: no new
/// capability surface, and the same home-dir root the engine already uses.
#[tauri::command]
async fn save_file(app: AppHandle, filename: String, body_base64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(body_base64.as_bytes())
            .map_err(|e| e.to_string())?;
        let dir = exports_dir(&app);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = unique_path(&dir, &sanitize_filename(&filename));
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open an existing file or folder in the OS default handler (the "Open on PC" file-card action).
/// Reuses the same platform launchers as `open_browser` so a path opens in the user's default app
/// (or the file manager for a directory). The path must already exist — refuses otherwise so a
/// stray string can't be handed to the shell.
#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("No such file: {path}"));
    }
    open_browser(&path); // file paths open in the default app; directories in the file manager
    Ok(())
}

/// Write a file the assistant authored INTO the workspace (or the session's chosen folder) so it can
/// then be run via `run_command` — the autonomous write→run→fix loop. `rel_path` is workspace-relative
/// and sanitized component-by-component (`..`, `.`, absolute parts and illegal chars are dropped) so it
/// can NEVER escape the base directory. Only reached when Autonomous workspace is on (the write_file
/// tool). Returns the absolute path written. Mirrors `run_command`'s base-dir resolution.
#[tauri::command]
async fn write_workspace_file(
    app: AppHandle,
    rel_path: String,
    content_base64: String,
    cwd: Option<String>,
    append: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content_base64.as_bytes())
            .map_err(|e| e.to_string())?;
        // Base: the session's working folder when it's a real directory, else the sandbox workspace.
        let base = match cwd
            .filter(|c| !c.is_empty())
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_dir())
        {
            Some(p) => p,
            None => {
                let d = workspace_dir(&app);
                std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
                d
            }
        };
        // Sanitize each component so the result stays INSIDE base (no traversal / absolute paths).
        let mut dest = base.clone();
        let mut any = false;
        for part in rel_path.split(['/', '\\']) {
            let p = part.trim();
            if p.is_empty() || p == "." || p == ".." {
                continue;
            }
            dest.push(sanitize_filename(p));
            any = true;
        }
        if !any {
            return Err("invalid file path".to_string());
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Append mode lets the model build a file too large for one reply in chunks (the first
        // write_file overwrites, each subsequent append:true grows the SAME file on disk).
        if append.unwrap_or(false) {
            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&dest)
                .map_err(|e| e.to_string())?;
            f.write_all(&bytes).map_err(|e| e.to_string())?;
        } else {
            std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        }
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The result of reading a workspace-relative file: whether it exists and (if so) its bytes.
#[derive(serde::Serialize)]
struct WorkspaceReadResult {
    exists: bool,
    /// Resolved absolute path (for display / logging).
    path: String,
    /// Base64 of the file bytes; empty when the file doesn't exist.
    #[serde(rename = "bodyBase64")]
    body_base64: String,
}

/// Read a workspace-RELATIVE file (the counterpart to `write_workspace_file`). Resolves + sanitizes
/// the path the SAME way (never escapes the workspace), and returns `exists:false` instead of erroring
/// when the file is absent — so callers can check existence (`edit_file`, AGENTS.md, deliverable
/// verification) without exception handling. Capped at `MAX_READ_BYTES`.
#[tauri::command]
async fn read_workspace_file(
    app: AppHandle,
    rel_path: String,
    cwd: Option<String>,
) -> Result<WorkspaceReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let base = match cwd
            .filter(|c| !c.is_empty())
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_dir())
        {
            Some(p) => p,
            None => workspace_dir(&app),
        };
        let mut dest = base.clone();
        let mut any = false;
        for part in rel_path.split(['/', '\\']) {
            let p = part.trim();
            if p.is_empty() || p == "." || p == ".." {
                continue;
            }
            dest.push(sanitize_filename(p));
            any = true;
        }
        if !any {
            return Err("invalid file path".to_string());
        }
        let path = dest.to_string_lossy().to_string();
        match std::fs::metadata(&dest) {
            Ok(meta) if meta.is_file() => {
                if meta.len() > MAX_READ_BYTES {
                    return Err("File too large.".to_string());
                }
                let bytes = std::fs::read(&dest).map_err(|e| e.to_string())?;
                Ok(WorkspaceReadResult {
                    exists: true,
                    path,
                    body_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                })
            }
            _ => Ok(WorkspaceReadResult { exists: false, path, body_base64: String::new() }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Strip any path separators / parent refs so a renderer-supplied name can only
/// ever land a file INSIDE the exports dir (never traverse out of it).
fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() { "export".to_string() } else { trimmed.to_string() }
}

/// First non-colliding path: `name.ext`, then `name (2).ext`, `name (3).ext`… so a
/// repeat export never silently overwrites the previous keep.
fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let first = dir.join(filename);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match filename.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (filename.to_string(), String::new()),
    };
    for n in 2..1000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

// ------------------------------------------------------------- local file search

#[derive(Serialize)]
struct FoundFile {
    path: String,
    name: String,
    ext: String,
    size: u64,
}

/// File types the importer can read (mirrors the web importer's accept list).
const SEARCHABLE_EXTS: &[&str] = &[
    // Documents (a resume is often .doc/.odt/.pages, not just .docx — those were missing).
    "epub", "pdf", "txt", "md", "markdown", "html", "htm", "rtf", "tex",
    "doc", "docx", "odt", "pages", "wpd", "wps",
    // Slides + sheets.
    "ppt", "pptx", "key", "odp", "xls", "xlsx", "ods", "numbers", "csv", "tsv",
    // Data + code-ish text the reader may want to find.
    "json", "xml", "yaml", "yml", "ini", "log", "ics",
    // Images.
    "png", "jpg", "jpeg", "webp", "gif",
];
/// Filler words people say when phrasing a search ("find my notes file", "any md files") that aren't
/// part of a filename — dropped before matching so a token like "files" isn't required in the name
/// (which would make "find my md files" return nothing). Mirrors FIND_STOP_WORDS in local-files.ts.
fn is_find_stop_word(t: &str) -> bool {
    matches!(
        t,
        "find" | "search" | "look" | "locate" | "get" | "open" | "show" | "give" | "fetch" | "grab"
            | "me" | "my" | "the" | "a" | "an" | "any" | "some" | "all" | "please" | "and" | "that" | "this"
            | "for" | "of" | "on" | "in" | "about" | "with" | "named" | "called" | "titled"
            | "file" | "files" | "doc" | "docs" | "document" | "documents"
    )
}

/// Type words → the extensions they mean, so "md files" filters to .md, "a photo of …" to images, etc.
/// A token matches a file when its NAME contains the token OR it's a type word matching the file's
/// EXTENSION. Mirrors FILE_TYPE_EXTS in local-files.ts.
fn type_word_exts(t: &str) -> &'static [&'static str] {
    match t {
        "md" | "markdown" => &["md", "markdown"],
        "pdf" | "pdfs" => &["pdf"],
        "txt" | "text" => &["txt"],
        "docx" => &["docx"],
        "word" => &["doc", "docx"],
        "rtf" => &["rtf"],
        "epub" | "ebook" | "ebooks" => &["epub"],
        "csv" => &["csv"],
        "tsv" => &["tsv"],
        "json" => &["json"],
        "xlsx" | "xls" | "excel" => &["xlsx", "xls"],
        "spreadsheet" | "spreadsheets" => &["xlsx", "xls", "csv", "ods"],
        "sheet" => &["xlsx", "xls", "csv"],
        "html" | "htm" | "webpage" => &["html", "htm"],
        "png" => &["png"],
        "jpg" | "jpeg" => &["jpg", "jpeg"],
        "webp" => &["webp"],
        "gif" => &["gif"],
        "image" | "images" | "photo" | "photos" | "picture" | "pictures" | "pic" => {
            &["png", "jpg", "jpeg", "webp", "gif"]
        }
        _ => &[],
    }
}

/// Bounds so a broad walk stays fast and can't wander into heavy caches forever.
const MAX_RESULTS: usize = 100;
const MAX_VISITS: usize = 400_000;
const MAX_DEPTH: usize = 8;
/// Cap a single pulled-in file (a huge PDF would blow the base64 invoke payload).
const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;

/// Heavy / system directories that never hold the user's books — skipped so the
/// walk spends its budget on real document folders.
fn is_skipped_dir(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "node_modules"
            | "library"
            | "appdata"
            | "$recycle.bin"
            | "windows"
            | "program files"
            | "program files (x86)"
            | "programdata"
            | ".git"
            | "target"
            | "venv"
            | ".venv"
            | "__pycache__"
            | "site-packages"
            | "cache"
            | "caches"
            | ".cache"
            | "dist"
            | "build"
            | ".cargo"
            | ".rustup"
            | ".npm"
    )
}

/// Search the user's files for importable books whose NAME contains every query
/// token (case-insensitive AND). Walks from `root` (default: the home dir), with
/// the bounds above; hidden entries and the skiplist dirs are pruned. Filename
/// matching only — never opens or reads file contents. The renderer ranks the
/// returned candidates (see `rankLocalFiles`).
#[tauri::command]
async fn search_files(
    app: AppHandle,
    query: String,
    root: Option<String>,
) -> Result<Vec<FoundFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Split on non-alphanumeric (so "resume.pdf" → "resume","pdf") and drop filler words, matching
        // the renderer's queryTokens(). What's left is what actually has to match a filename.
        let tokens: Vec<String> = query
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty() && !is_find_stop_word(s))
            .map(|s| s.to_string())
            .collect();
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        let start = match root {
            Some(r) if !r.trim().is_empty() => PathBuf::from(r),
            _ => app.path().home_dir().unwrap_or_else(|_| PathBuf::from(".")),
        };
        let mut out: Vec<FoundFile> = Vec::new();
        let mut visits = 0usize;
        let mut stack: Vec<(PathBuf, usize)> = vec![(start, 0)];
        while let Some((dir, depth)) = stack.pop() {
            if out.len() >= MAX_RESULTS || visits >= MAX_VISITS {
                break;
            }
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue, // unreadable dir (permissions) — skip, don't fail
            };
            for entry in entries.flatten() {
                visits += 1;
                if out.len() >= MAX_RESULTS || visits >= MAX_VISITS {
                    break;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue; // hidden files/dirs
                }
                let file_type = match entry.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if file_type.is_dir() {
                    if depth < MAX_DEPTH && !is_skipped_dir(&name) {
                        stack.push((entry.path(), depth + 1));
                    }
                    continue;
                }
                let lower = name.to_lowercase();
                let ext = lower.rsplit('.').next().unwrap_or("");
                if !SEARCHABLE_EXTS.contains(&ext) {
                    continue;
                }
                // Every token must be satisfied: present in the name, OR a type word ("md", "pdf",
                // "photo") matching this file's extension — so "md files" finds every .md.
                if tokens.iter().all(|t| lower.contains(t.as_str()) || type_word_exts(t).contains(&ext)) {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    out.push(FoundFile {
                        path: entry.path().to_string_lossy().to_string(),
                        name,
                        ext: ext.to_string(),
                        size,
                    });
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct ReadFileResult {
    name: String,
    ext: String,
    #[serde(rename = "bodyBase64")]
    body_base64: String,
}

/// Read ONE chosen file's bytes (base64) so the renderer can import it through
/// the same parsers as an uploaded file. Bounded; only invoked from the explicit
/// `/open <path>` command or a click on a `/find` result.
#[tauri::command]
async fn read_file(path: String) -> Result<ReadFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let p = PathBuf::from(&path);
        let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("That path isn't a file.".into());
        }
        if meta.len() > MAX_READ_BYTES {
            return Err("That file is larger than the 100 MB import limit.".into());
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        Ok(ReadFileResult {
            name,
            ext,
            body_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct CommandResult {
    stdout: String,
    stderr: String,
    code: i32,
    #[serde(rename = "timedOut")]
    timed_out: bool,
    /// The directory the command actually ran in (so the assistant + reader see WHERE it ran and
    /// can correct a relative-path mistake).
    cwd: String,
}

/// Hard ceilings so an approved command can't hang the UI or flood it with output.
const COMMAND_TIMEOUT_SECS: u64 = 240;
const COMMAND_OUTPUT_CAP: usize = 32 * 1024;

/// Result of the Google OAuth loopback: the consent code + the exact redirect_uri it
/// was issued for (the token exchange must echo the same redirect_uri).
#[derive(serde::Serialize)]
struct OauthResult {
    code: String,
    #[serde(rename = "redirectUri")]
    redirect_uri: String,
}

/// Pull one query param out of a request path like `/?code=abc&state=xyz`.
fn query_param(path: &str, key: &str) -> Option<String> {
    let q = path.split_once('?')?.1;
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(
                    percent_encoding::percent_decode_str(v)
                        .decode_utf8_lossy()
                        .into_owned(),
                );
            }
        }
    }
    None
}

fn open_browser(url: &str) {
    // NOT `cmd /C start`: cmd treats `&` as a command separator (so it drops every query
    // parameter after the first — e.g. an OAuth URL loses response_type/redirect_uri/scope and
    // Google rejects it) and also expands `%xx` sequences, corrupting percent-encoded URLs.
    // rundll32 receives the URL as a direct argument (no shell parsing), so it stays intact.
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

/// Run the Google OAuth consent + loopback redirect: bind a localhost port, open the
/// system browser to the consent screen, and capture the `code` from the redirect. The
/// renderer supplies the OAuth params (client id, scope, PKCE challenge, state); this
/// builds the URL because the redirect_uri (port) is only known after binding. Times out
/// so a never-completed consent doesn't leak the listener thread.
#[tauri::command]
async fn oauth_loopback(
    client_id: String,
    scope: String,
    code_challenge: String,
    state: String,
) -> Result<OauthResult, String> {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}");
        let enc = |s: &str| {
            percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
        };
        let auth_url = format!(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code\
             &scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
            enc(&client_id), enc(&redirect_uri), enc(&scope), enc(&code_challenge), enc(&state),
        );
        open_browser(&auth_url);

        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    // The listener is non-blocking (so accept() can time out), but the accepted
                    // socket inherits that flag on Windows — a non-blocking read would return
                    // WouldBlock before the browser's request bytes arrive and fail the connect.
                    // Force the stream back to blocking so the read waits for the redirect.
                    let _ = stream.set_nonblocking(false);
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("");
                    let got_state = query_param(path, "state");
                    let code = query_param(path, "code");
                    let html = "<html><body style='font-family:system-ui;padding:3rem;text-align:center'>\
                        <h2>Visual Reader is connected to Google.</h2><p>You can close this tab.</p></body></html>";
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        html.len(),
                        html
                    );
                    if got_state.as_deref() != Some(state.as_str()) {
                        return Err("OAuth state mismatch — please try connecting again.".into());
                    }
                    return match code {
                        Some(code) if !code.is_empty() => Ok(OauthResult { code, redirect_uri }),
                        _ => Err(query_param(path, "error").unwrap_or_else(|| "No authorization code returned.".into())),
                    };
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err("Timed out waiting for Google sign-in.".into());
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Native "choose a folder" dialog for the assistant's working-folder control.
/// Returns the chosen absolute path, or None if the reader cancelled. AsyncFileDialog
/// drives the dialog on the platform's UI thread without blocking the command runtime.
#[tauri::command]
async fn pick_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose a working folder for the assistant")
        .pick_folder()
        .await
        .map(|h| h.path().to_string_lossy().into_owned())
}

/// Append a shell command to `cmd` VERBATIM on Windows, so `cmd /C` / PowerShell get the command
/// exactly as written and do their OWN quote parsing. Rust's normal arg escaping wraps the command
/// and turns an inner `"path"` into `\"path\"` — which cmd.exe does NOT understand, so the quotes
/// reach the program literally (python then opened `"C:\…\f.py"` as a RELATIVE path, doubling the
/// workspace dir → Errno 22). `raw_arg` skips that escaping. No-op shim off Windows (this code path
/// is Windows-only at runtime, but must still compile elsewhere).
#[cfg(target_os = "windows")]
fn append_raw_command(c: &mut Command, command: &str) {
    use std::os::windows::process::CommandExt;
    c.raw_arg(command);
}
#[cfg(not(target_os = "windows"))]
fn append_raw_command(c: &mut Command, command: &str) {
    c.arg(command);
}

/// Run ONE shell command (the chat's run_command tool, after the reader approved it)
/// in the app's workspace folder, capturing stdout/stderr/exit. The renderer only
/// reaches this after an explicit per-command approval click — there is no silent
/// path to it. stdout/stderr are drained on their own threads (so a chatty command
/// can't deadlock on a full pipe), and a watchdog kills a command that overruns the
/// timeout. Cross-platform via `cmd /C` on Windows, `sh -c` elsewhere.
#[tauri::command]
async fn run_command(
    app: AppHandle,
    command: String,
    github_token: Option<String>,
    cwd: Option<String>,
    shell: Option<String>,
) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // The session's chosen working folder when it's a real directory; otherwise the
        // default sandbox workspace (created on demand).
        let dir = match cwd
            .filter(|c| !c.is_empty())
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_dir())
        {
            Some(p) => p,
            None => {
                let d = workspace_dir(&app);
                std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
                d
            }
        };
        // Windows defaults to `cmd /C`; the reader can opt into PowerShell (per the
        // commandShell setting, threaded through as `shell`). Unix always uses `sh -c`.
        let use_powershell = cfg!(target_os = "windows") && shell.as_deref() == Some("powershell");
        let mut cmd = if use_powershell {
            // raw_arg: pass the command VERBATIM so PowerShell parses its own quotes (see
            // append_raw_command) instead of getting Rust-escaped `\"` it mishandles.
            let mut c = Command::new("powershell");
            c.arg("-NoProfile").arg("-NonInteractive").arg("-Command");
            append_raw_command(&mut c, &command);
            c
        } else if cfg!(target_os = "windows") {
            // raw_arg: `cmd /C` must see the command verbatim, or a quoted "C:\…\f.py" arrives at the
            // program with literal quotes (Errno 22). See append_raw_command.
            let mut c = Command::new("cmd");
            c.arg("/C");
            append_raw_command(&mut c, &command);
            c
        } else {
            // Unix: args are a vector (no command-line string), so `sh -c <command>` needs no special
            // handling — sh parses the one command string itself.
            let mut c = Command::new("sh");
            c.arg("-c").arg(&command);
            c
        };
        cmd.current_dir(&dir).stdout(Stdio::piped()).stderr(Stdio::piped());
        // GitHub token (when configured) is injected into the child's ENVIRONMENT —
        // never the command string — so `gh` is authenticated and `git push` works,
        // while the token stays out of the chat transcript and shell history.
        if let Some(token) = github_token.filter(|t| !t.is_empty()) {
            cmd.env("GH_TOKEN", &token);
            cmd.env("GITHUB_TOKEN", &token);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the command: {e}"))?;

        // Drain both pipes concurrently so a large output never blocks the child.
        let mut out_pipe = child.stdout.take();
        let mut err_pipe = child.stderr.take();
        let out_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(p) = out_pipe.as_mut() {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        });
        let err_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(p) = err_pipe.as_mut() {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        });

        let deadline = Instant::now() + Duration::from_secs(COMMAND_TIMEOUT_SECS);
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        timed_out = true;
                        break child.wait().map_err(|e| e.to_string())?;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(e.to_string()),
            }
        };
        let cap = |bytes: Vec<u8>| {
            let s = String::from_utf8_lossy(&bytes);
            s.chars().take(COMMAND_OUTPUT_CAP).collect::<String>()
        };
        Ok(CommandResult {
            stdout: cap(out_handle.join().unwrap_or_default()),
            stderr: cap(err_handle.join().unwrap_or_default()),
            code: status.code().unwrap_or(-1),
            timed_out,
            cwd: dir.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Wrap an interpreter token in quotes when it contains a space (an absolute path), so it can be
/// safely prepended to a shell command; bare names / launcher forms (`py -3`) pass through.
fn quote_interp(s: &str) -> String {
    if s.contains(' ') && !s.contains("-3") {
        format!("\"{s}\"")
    } else {
        s.to_string()
    }
}

/// Resolve a WORKING interpreter for the chat's ▶ Run button: probe the common names for `kind`
/// (python: `python3` → `python` → `py -3`, then the bundled ComfyUI python as a last resort; node;
/// sh) with a quick `--version`, and return a shell-ready token to prepend. None when nothing works —
/// the UI then shows a clear "install X" message instead of a cryptic "file not found". No shell is
/// spawned; each candidate is probed directly.
#[tauri::command]
async fn which_interpreter(app: AppHandle, kind: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fn probe(prog: &str, args: &[&str]) -> bool {
            Command::new(prog)
                .args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .stdin(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }
        let found = match kind.as_str() {
            "python" => {
                // System pythons first (a predictable env, so a `pip install` the assistant runs and
                // the script that imports it share the same interpreter).
                if probe("python3", &["--version"]) {
                    Some("python3".to_string())
                } else if probe("python", &["--version"]) {
                    Some("python".to_string())
                } else if probe("py", &["-3", "--version"]) {
                    Some("py -3".to_string())
                } else {
                    // Last resort: the bundled ComfyUI embedded python (present once the managed
                    // engine is installed), so a stdlib script still runs with zero setup.
                    let exe = engine_root(&app)
                        .join("ComfyUI_windows_portable")
                        .join("python_embeded")
                        .join(if cfg!(windows) { "python.exe" } else { "python" });
                    let p = exe.to_string_lossy().to_string();
                    if exe.is_file() && probe(&p, &["--version"]) {
                        Some(quote_interp(&p))
                    } else {
                        None
                    }
                }
            }
            "node" => {
                if probe("node", &["--version"]) {
                    Some("node".to_string())
                } else {
                    None
                }
            }
            "sh" => {
                if !cfg!(windows) && probe("sh", &["-c", "exit 0"]) {
                    Some("sh".to_string())
                } else if probe("bash", &["-c", "exit 0"]) {
                    Some("bash".to_string())
                } else {
                    None
                }
            }
            _ => None,
        };
        Ok(found)
    })
    .await
    .map_err(|e| e.to_string())?
}
//
// App-managed git worktrees for parallel WRITE-capable coding agents: each agent works in
// its own worktree+branch so concurrent edits can't collide, and the app (not the model)
// creates, diffs, merges, and tears them down. All commands shell out to `git` with FIXED
// args (no shell), reusing the COMMAND_OUTPUT_CAP cap. A baked-in author/committer identity
// is set via env so commits/merges work even on a machine with no global git config.

#[derive(Serialize)]
struct WorktreeInfo {
    path: String,
    branch: String,
    /// The base commit the worktree branched from — the diff/merge reference.
    base: String,
}

/// Run `git` with fixed args in `dir`; returns the captured result (never spawns a shell).
fn git(dir: &str, args: &[&str]) -> Result<CommandResult, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Visual Reader")
        .env("GIT_AUTHOR_EMAIL", "agent@visual-reader.local")
        .env("GIT_COMMITTER_NAME", "Visual Reader")
        .env("GIT_COMMITTER_EMAIL", "agent@visual-reader.local")
        .output()
        .map_err(|e| format!("git isn't available: {e}"))?;
    let cap = |b: &[u8]| String::from_utf8_lossy(b).chars().take(COMMAND_OUTPUT_CAP).collect::<String>();
    Ok(CommandResult {
        stdout: cap(&out.stdout),
        stderr: cap(&out.stderr),
        code: out.status.code().unwrap_or(-1),
        timed_out: false,
        cwd: dir.to_string(),
    })
}

/// The repo root for `dir`, or None when it isn't inside a git repo.
#[tauri::command]
async fn git_repo_root(dir: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !std::path::Path::new(&dir).is_dir() {
            return Ok(None);
        }
        let r = git(&dir, &["rev-parse", "--show-toplevel"])?;
        Ok(if r.code == 0 { Some(r.stdout.trim().to_string()) } else { None })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The Visual Reader SOURCE repo root, located from the running executable (the .bat distribution
/// runs the app from inside the clone — `cargo tauri dev` from target/debug, a built exe from the
/// repo tree). Used by the in-app "Software update" button to git-pull + rebuild the web bundle in
/// place. None when the app isn't inside a git checkout (e.g. a packaged binary moved elsewhere).
#[tauri::command]
async fn app_repo_root() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dirs: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(p) = exe.parent() {
                dirs.push(p.to_path_buf());
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            dirs.push(cwd);
        }
        for dir in dirs {
            let d = dir.to_string_lossy().to_string();
            if let Ok(r) = git(&d, &["rev-parse", "--show-toplevel"]) {
                if r.code == 0 {
                    let root = r.stdout.trim().to_string();
                    if !root.is_empty() {
                        return Ok(Some(root));
                    }
                }
            }
        }
        Ok(None)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ensure `dir` is a git repo (init + an initial empty commit if not), returning its root —
/// so a plain workspace folder can still host agent worktrees.
#[tauri::command]
async fn git_ensure_repo(dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let existing = git(&dir, &["rev-parse", "--show-toplevel"])?;
        if existing.code == 0 {
            return Ok(existing.stdout.trim().to_string());
        }
        git(&dir, &["init"])?;
        git(&dir, &["add", "-A"])?;
        // --allow-empty so a brand-new folder still gets a base commit for worktrees to branch from.
        git(&dir, &["commit", "--allow-empty", "-m", "Visual Reader workspace"])?;
        let root = git(&dir, &["rev-parse", "--show-toplevel"])?;
        if root.code != 0 {
            return Err(format!("couldn't initialize a git repo: {}", root.stderr));
        }
        Ok(root.stdout.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Add a worktree + branch for one agent, OUTSIDE the repo (in a temp dir) so it never
/// pollutes the working tree. Branch names are caller-controlled (e.g. "vr-agent-1").
#[tauri::command]
async fn git_worktree_create(repo_dir: String, branch: String) -> Result<WorktreeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = std::env::temp_dir().join("vr-agents");
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let path = base.join(&branch);
        let path_str = path.to_string_lossy().to_string();
        // Clean up a stale worktree at this path from a previous run (best-effort).
        let _ = git(&repo_dir, &["worktree", "remove", "--force", &path_str]);
        let _ = git(&repo_dir, &["branch", "-D", &branch]);
        let base = git(&repo_dir, &["rev-parse", "HEAD"])?;
        let r = git(&repo_dir, &["worktree", "add", &path_str, "-b", &branch])?;
        if r.code != 0 {
            return Err(format!("git worktree add failed: {}", r.stderr));
        }
        Ok(WorktreeInfo { path: path_str, branch, base: base.stdout.trim().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stage + commit everything in `dir` (an agent's worktree, or the base after a conflict
/// resolution). `--allow-empty` so it never errors when there's nothing to commit.
#[tauri::command]
async fn git_commit_all(dir: String, message: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git(&dir, &["add", "-A"])?;
        git(&dir, &["commit", "--allow-empty", "-m", &message])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A worktree branch's diff against `base` (name-stat summary + full patch).
#[tauri::command]
async fn git_worktree_diff(path: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let range = format!("{base}...HEAD");
        let stat = git(&path, &["diff", &range, "--stat"])?;
        let full = git(&path, &["diff", &range])?;
        Ok(format!("{}\n{}", stat.stdout.trim(), full.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merge an agent branch into the current base (no-ff). Returns the raw git output; the
/// caller parses "CONFLICT (…): Merge conflict in <file>" lines to detect conflicts.
#[tauri::command]
async fn git_merge_branch(repo_dir: String, branch: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git(&repo_dir, &["merge", "--no-ff", "--no-edit", &branch])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Abort an in-progress (conflicted) merge, returning the base to a clean state.
#[tauri::command]
async fn git_merge_abort(repo_dir: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || git(&repo_dir, &["merge", "--abort"]))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct ConflictVersions {
    base: String,
    ours: String,
    theirs: String,
}

/// The three merge stages of a conflicted file (:1: base, :2: ours, :3: theirs) — fed to the
/// manager model to auto-resolve. A missing stage (add/delete conflict) yields an empty string.
#[tauri::command]
async fn git_conflict_versions(repo_dir: String, file: String) -> Result<ConflictVersions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stage = |n: u8| git(&repo_dir, &["show", &format!(":{n}:{file}")]).map(|r| r.stdout).unwrap_or_default();
        Ok(ConflictVersions { base: stage(1), ours: stage(2), theirs: stage(3) })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Complete a conflicted merge AFTER the host wrote resolved files: stage everything, then REFUSE
/// (non-zero code) if any path is still unmerged or any staged content still carries conflict
/// markers (`git diff --cached --check`) — only then commit. So a bad auto-resolution can never be
/// committed; the caller aborts the merge on a non-zero code.
#[tauri::command]
async fn git_complete_merge(repo_dir: String, message: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git(&repo_dir, &["add", "-A"])?;
        let unmerged = git(&repo_dir, &["ls-files", "-u"])?;
        if !unmerged.stdout.trim().is_empty() {
            return Ok(CommandResult { stdout: String::new(), stderr: "files are still unmerged".into(), code: 2, timed_out: false, cwd: repo_dir.clone() });
        }
        let check = git(&repo_dir, &["diff", "--cached", "--check"])?;
        if check.code != 0 {
            return Ok(CommandResult { stdout: check.stdout, stderr: "conflict markers remain in the staged content".into(), code: 3, timed_out: false, cwd: repo_dir.clone() });
        }
        git(&repo_dir, &["commit", "--no-edit", "-m", &message])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove an agent worktree + delete its branch (best-effort cleanup after merge).
#[tauri::command]
async fn git_worktree_remove(repo_dir: String, path: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = git(&repo_dir, &["worktree", "remove", "--force", &path]);
        let _ = git(&repo_dir, &["branch", "-D", &branch]);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct Screenshot {
    #[serde(rename = "bytesBase64")]
    bytes_base64: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
}

/// Capture either a specific WINDOW (by title substring) or, when no window is
/// given, the primary monitor — to a PNG (the chat's screenshot tool, after the
/// reader approved it). Window capture lets the model see e.g. a game window even
/// when the app is focused for the approval click. Reached only after an explicit
/// approval — no silent capture. A bad window name returns the list of open titles.
#[tauri::command]
async fn capture_screen(window: Option<String>) -> Result<Screenshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        use image::ImageEncoder as _;
        let needle = window.as_deref().map(str::trim).filter(|w| !w.is_empty());
        let frame = match needle {
            Some(needle) => {
                let windows = xcap::Window::all().map_err(|e| format!("Couldn't list windows: {e}"))?;
                let lower = needle.to_lowercase();
                match windows.iter().find(|w| w.title().to_lowercase().contains(&lower)) {
                    Some(w) => w.capture_image().map_err(|e| format!("Window capture failed: {e}"))?,
                    None => {
                        let titles: Vec<String> = windows
                            .iter()
                            .map(|w| w.title().to_string())
                            .filter(|t| !t.is_empty())
                            .collect();
                        return Err(format!(
                            "No open window matches \"{needle}\". Open windows: {}",
                            if titles.is_empty() { "(none)".into() } else { titles.join(" | ") }
                        ));
                    }
                }
            }
            None => {
                let monitor = xcap::Monitor::all()
                    .map_err(|e| format!("Couldn't list monitors: {e}"))?
                    .into_iter()
                    .next()
                    .ok_or_else(|| "No monitor to capture.".to_string())?;
                monitor.capture_image().map_err(|e| format!("Screen capture failed: {e}"))?
            }
        };
        let mut png: Vec<u8> = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                frame.as_raw(),
                frame.width(),
                frame.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("PNG encode failed: {e}"))?;
        Ok(Screenshot {
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(&png),
            mime_type: "image/png".to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download a style LoRA into the engine's loras dir, with progress.
#[tauri::command]
async fn download_lora(app: AppHandle, model: DownloadableModel) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = loras_dir(&app2);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = dir.join(&model.filename);
        download_model_with_progress(&app2, &model, &dest)
    })
    .await
    .map_err(|e| e.to_string())?
}

// --------------------------------------------------------------------- blocking

fn ensure_blocking(app: &AppHandle, low_vram: bool) -> Result<(String, Option<Child>), String> {
    let base = format!("http://127.0.0.1:{ENGINE_PORT}");
    // Reuse an engine that's already up (e.g. the user's own ComfyUI, or a
    // previous run of ours).
    if health_ok(&base) {
        emit_engine(app, "ready", "Engine ready", Some(100.0));
        return Ok((base, None));
    }
    if !cfg!(target_os = "windows") {
        return Err("The app-managed engine currently supports Windows. On macOS/Linux, run \
                    ComfyUI or AUTOMATIC1111 yourself and connect to it in Settings."
            .into());
    }
    // If something already holds the port (a ComfyUI still booting, our own from a
    // prior run, or another app), do NOT spawn a second — wait for it to answer,
    // then reuse it; only error if it never does. This avoids two engines fighting
    // over the port / database.
    if port_in_use(ENGINE_PORT) {
        emit_engine(app, "starting", "Waiting for an engine already on the port…", None);
        for _ in 0..180 {
            if health_ok(&base) {
                emit_engine(app, "ready", "Engine ready", Some(100.0));
                return Ok((base, None));
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        return Err(format!(
            "Port {ENGINE_PORT} is in use but isn't responding as ComfyUI. Close that program \
             (or run stop-comfyui.bat), then try again."
        ));
    }
    let child = install_and_spawn(app, low_vram)?;
    emit_engine(app, "ready", "Engine ready", Some(100.0));
    Ok((base, Some(child)))
}

/// Is something already listening on `127.0.0.1:port`?
fn port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn install_and_spawn(app: &AppHandle, low_vram: bool) -> Result<Child, String> {
    let root = engine_root(app);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let portable = root.join("ComfyUI_windows_portable");
    let python = portable.join("python_embeded").join("python.exe");

    if !python.exists() {
        let archive = root.join("comfyui_portable.7z");
        download_to_file(app, COMFY_PORTABLE_URL, &archive, "downloading", "Downloading the engine")?;
        emit_engine(app, "extracting", "Unpacking the engine…", None);
        sevenz_rust::decompress_file(&archive, &root).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&archive);
    }

    emit_engine(app, "starting", "Starting the engine…", None);
    let child = spawn_comfy(&portable, low_vram)?;

    let base = format!("http://127.0.0.1:{ENGINE_PORT}");
    for _ in 0..180 {
        if health_ok(&base) {
            return Ok(child);
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    Err("The engine did not become ready in time.".into())
}

fn spawn_comfy(portable: &Path, low_vram: bool) -> Result<Child, String> {
    let python = portable.join("python_embeded").join("python.exe");
    let main_py = portable.join("ComfyUI").join("main.py");
    let mut cmd = Command::new(python);
    cmd.arg("-s")
        .arg(main_py)
        .arg("--port")
        .arg(ENGINE_PORT.to_string())
        // Allow the desktop webview origin to call the engine.
        .arg("--enable-cors-header")
        .current_dir(portable);
    if !has_nvidia() {
        cmd.arg("--cpu");
    } else if low_vram {
        // Keep the big text encoder / weights on CPU and stream into VRAM on demand,
        // instead of ComfyUI's default "grab all free VRAM" mode. Only on a GPU box.
        cmd.arg("--lowvram");
    }
    cmd.spawn().map_err(|e| format!("Failed to start the engine: {e}"))
}

/// Download `url` to `dest`, emitting `engine://progress` with a percentage.
fn download_to_file(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    phase: &str,
    label: &str,
) -> Result<(), String> {
    let mut resp = reqwest::blocking::get(url).map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Download failed ({}).", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 1 << 16];
    let mut received: u64 = 0;
    let mut last_pct: i64 = -1;
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        if total > 0 {
            let pct = (received as f64 / total as f64 * 100.0).floor() as i64;
            if pct != last_pct {
                last_pct = pct;
                emit_engine(app, phase, label, Some(pct as f64));
            }
        }
    }
    Ok(())
}

/// Like `download_to_file` but emits `model://progress` keyed by model id, and is
/// built for the 9–20 GB split-file era:
///  - **idempotent** — an already-complete file returns immediately (so a multi-file
///    retry skips what's done);
///  - **resumable** — streams into `<name>.part` and continues it with an HTTP Range
///    request after an interruption, renaming to the real name only when complete;
///  - **untimed** — no overall request timeout (a multi-hour download must not be cut).
fn download_model_with_progress(
    app: &AppHandle,
    model: &DownloadableModel,
    dest: &Path,
) -> Result<(), String> {
    if dest.exists() {
        let _ = app.emit(
            "model://progress",
            ModelProgress { id: model.id.clone(), received_bytes: 0, total_bytes: 0, percent: 100.0 },
        );
        return Ok(());
    }
    let part = dest.with_file_name(format!("{}.part", model.filename));
    let mut offset = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);

    let client = reqwest::blocking::Client::builder()
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&model.url);
    if offset > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let mut resp = req.send().map_err(|e| e.to_string())?;
    // 416 → our .part is at/beyond the file's full size (a stale partial from an
    // earlier run, or clobbered by manual file moves in the models folder). It can
    // never resume — discard it and restart this download from zero, instead of
    // failing every retry forever.
    if offset > 0 && resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = std::fs::remove_file(&part);
        offset = 0;
        resp = client.get(&model.url).send().map_err(|e| e.to_string())?;
    }
    if !resp.status().is_success() {
        // Gated repos (e.g. some Hugging Face hosts) answer 401/403 without a logged-in
        // license acceptance — something this keyless downloader can never satisfy. Say
        // so, instead of leaving the user retrying a download that can't succeed.
        let hint = match resp.status().as_u16() {
            401 | 403 => " The host requires a login/license for this file — download it in \
                          your browser and place it in the engine's models folder, or paste \
                          an alternative URL in Settings.",
            _ => "",
        };
        return Err(format!("Download of {} failed ({}).{hint}", model.filename, resp.status()));
    }
    // 206 → the server honours the Range and we append; anything else (200, or we
    // asked from 0) → start the .part over from scratch.
    let resume = offset > 0 && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resume {
        offset = 0;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(resume)
        .write(true)
        .truncate(!resume)
        .open(&part)
        .map_err(|e| e.to_string())?;
    let total = offset + resp.content_length().unwrap_or(0);
    let mut buf = [0u8; 1 << 16];
    let mut received: u64 = offset;
    let mut last_pct: i64 = -1;
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        let percent = if total > 0 { received as f64 / total as f64 * 100.0 } else { 0.0 };
        let pct = percent.floor() as i64;
        if pct != last_pct {
            last_pct = pct;
            let _ = app.emit(
                "model://progress",
                ModelProgress {
                    id: model.id.clone(),
                    received_bytes: received,
                    total_bytes: total,
                    percent,
                },
            );
        }
    }
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(())
}

// ----------------------------------------------------------------------- helpers

fn engine_root(app: &AppHandle) -> PathBuf {
    // Shared with comfyui-setup.bat (%USERPROFILE%\VisualReader) so the desktop
    // app and the .bat use ONE ComfyUI install + models/loras folder.
    let base = app
        .path()
        .home_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("VisualReader")
}

fn comfy_models_dir(app: &AppHandle) -> PathBuf {
    engine_root(app)
        .join("ComfyUI_windows_portable")
        .join("ComfyUI")
        .join("models")
}

/// Where saved exports (illustrated HTML/EPUB, images) land: `~/VisualReader/exports`.
fn exports_dir(app: &AppHandle) -> PathBuf {
    engine_root(app).join("exports")
}

/// Working directory for the run_command tool: `~/VisualReader/workspace`. A known,
/// app-owned folder where the assistant's files + commands live (not the user's cwd).
fn workspace_dir(app: &AppHandle) -> PathBuf {
    engine_root(app).join("workspace")
}

fn checkpoints_dir(app: &AppHandle) -> PathBuf {
    comfy_models_dir(app).join("checkpoints")
}

fn loras_dir(app: &AppHandle) -> PathBuf {
    comfy_models_dir(app).join("loras")
}

fn health_ok(base: &str) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .and_then(|c| c.get(format!("{base}/system_stats")).send())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn has_nvidia() -> bool {
    Command::new("nvidia-smi")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn emit_engine(app: &AppHandle, phase: &str, message: &str, percent: Option<f64>) {
    let _ = app.emit(
        "engine://progress",
        EngineProgress {
            phase: phase.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

// ------------------------------------------------------------ bundled local LLM
//
// The desktop app ships a small GGUF + a `llama-server` (llama.cpp) binary and
// runs them on first use, so a brand-new install has a working local text model
// with zero setup. The renderer then talks to it through the ordinary
// OpenAI-compatible `LocalServerProvider` (see `ensureLocalLlm` in runtime.ts and
// `BUNDLED_LLM` in packages/core). The model id below MUST match `BUNDLED_LLM.model`.

/// A dedicated port so the built-in model never collides with a user's own Ollama
/// (11434) or LM Studio (1234).
const LLM_PORT: u16 = 11435;
/// Must equal `BUNDLED_LLM.model` in packages/core (what /v1/models reports).
const BUNDLED_LLM_MODEL: &str = "Llama-3.2-3B-Instruct";
/// The GGUF + server binary placed by `llm-setup.bat` (bundled as Tauri resources
/// under `llm/`, or dropped into `~/VisualReader/llm`).
const BUNDLED_GGUF_FILE: &str = "Llama-3.2-3B-Instruct-Q4_K_M.gguf";
const LLAMA_SERVER_BIN: &str = "llama-server.exe";

/// Process + endpoint handle for the bundled text model, mirroring `EngineState`.
/// The child is killed on app exit alongside the image engine.
#[derive(Default)]
struct LlmState {
    base_url: Mutex<Option<String>>,
    model: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
    setup: tauri::async_runtime::Mutex<()>,
}

#[derive(Serialize, Clone)]
struct LlmInfo {
    #[serde(rename = "baseUrl")]
    base_url: String,
    model: String,
}

/// Ensure the bundled text model is running; return its OpenAI-compatible base URL
/// and model id. One setup at a time (like `ensure_engine`); a second concurrent
/// call reuses the first's result.
#[tauri::command]
async fn ensure_llm(app: AppHandle, state: State<'_, LlmState>) -> Result<LlmInfo, String> {
    if let (Some(base_url), Some(model)) = (
        state.base_url.lock().unwrap().clone(),
        state.model.lock().unwrap().clone(),
    ) {
        return Ok(LlmInfo { base_url, model });
    }
    let _setup = state.setup.lock().await;
    if let (Some(base_url), Some(model)) = (
        state.base_url.lock().unwrap().clone(),
        state.model.lock().unwrap().clone(),
    ) {
        return Ok(LlmInfo { base_url, model });
    }
    let app2 = app.clone();
    let (base_url, child) = tauri::async_runtime::spawn_blocking(move || ensure_llm_blocking(&app2))
        .await
        .map_err(|e| e.to_string())??;
    *state.base_url.lock().unwrap() = Some(base_url.clone());
    *state.model.lock().unwrap() = Some(BUNDLED_LLM_MODEL.to_string());
    if let Some(child) = child {
        *state.child.lock().unwrap() = Some(child);
    }
    Ok(LlmInfo { base_url, model: BUNDLED_LLM_MODEL.to_string() })
}

/// Stop the bundled text model to free its VRAM (e.g. for a burst of local image renders on the
/// same GPU). Kills the managed child and clears the cached URL, so the next `ensure_llm`
/// relaunches it cold. A no-op when nothing is running. Safe to call repeatedly.
#[tauri::command]
async fn stop_llm(state: State<'_, LlmState>) -> Result<(), String> {
    let child = state.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    *state.base_url.lock().unwrap() = None;
    *state.model.lock().unwrap() = None;
    Ok(())
}

fn ensure_llm_blocking(app: &AppHandle) -> Result<(String, Option<Child>), String> {
    let root = format!("http://127.0.0.1:{LLM_PORT}");
    let api = format!("{root}/v1");
    // Reuse an instance already answering (a prior run of ours).
    if llm_health_ok(&root) {
        emit_llm(app, "ready", "Built-in model ready", Some(100.0));
        return Ok((api, None));
    }
    if !cfg!(target_os = "windows") {
        return Err("The built-in model currently ships on Windows. On macOS/Linux, run a local \
                    server (Ollama / LM Studio) and pick \"Local server\" under Text in Settings."
            .into());
    }
    // Something already on the port (our prior run still booting): wait, then reuse.
    if port_in_use(LLM_PORT) {
        emit_llm(app, "starting", "Waiting for the built-in model…", None);
        for _ in 0..120 {
            if llm_health_ok(&root) {
                emit_llm(app, "ready", "Built-in model ready", Some(100.0));
                return Ok((api, None));
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        return Err(format!("Port {LLM_PORT} is busy but not answering as the built-in model."));
    }
    let (bin, gguf) = resolve_llm_files(app)?;
    emit_llm(app, "starting", "Starting the built-in model…", None);
    let child = spawn_llama(&bin, &gguf)?;
    for _ in 0..120 {
        if llm_health_ok(&root) {
            emit_llm(app, "ready", "Built-in model ready", Some(100.0));
            return Ok((api, Some(child)));
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    Err("The built-in model did not become ready in time.".into())
}

/// Locate the bundled `llama-server` + GGUF: first the Tauri resource dir (shipped in
/// the installer under `llm/`), then `~/VisualReader/llm` (where `llm-setup.bat` can
/// place them). A clear error — pointing at the setup script — beats a cryptic spawn
/// failure when neither is present (e.g. a dev build that didn't bundle the model).
fn resolve_llm_files(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("llm"));
    }
    dirs.push(engine_root(app).join("llm"));
    for dir in &dirs {
        let bin = dir.join(LLAMA_SERVER_BIN);
        let gguf = dir.join(BUNDLED_GGUF_FILE);
        if bin.exists() && gguf.exists() {
            return Ok((bin, gguf));
        }
    }
    Err(format!(
        "The built-in model isn't installed. Run llm-setup.bat to fetch {LLAMA_SERVER_BIN} + \
         {BUNDLED_GGUF_FILE} (into the app's llm folder), or pick \"Local server\" / a cloud key \
         under Text in Settings."
    ))
}

fn spawn_llama(bin: &Path, gguf: &Path) -> Result<Child, String> {
    let mut cmd = Command::new(bin);
    cmd.arg("-m")
        .arg(gguf)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(LLM_PORT.to_string())
        // 8k context matches BUNDLED_LLM.contextTokens in packages/core.
        .arg("-c")
        .arg("8192")
        // Report a stable model id on /v1/models (what the provider sends).
        .arg("--alias")
        .arg(BUNDLED_LLM_MODEL);
    // Offload to the GPU when one is present; CPU-only builds ignore it.
    if has_nvidia() {
        cmd.arg("-ngl").arg("99");
    }
    if let Some(dir) = bin.parent() {
        cmd.current_dir(dir); // find the ggml/llama DLLs shipped beside the exe
    }
    cmd.spawn().map_err(|e| format!("Failed to start the built-in model: {e}"))
}

fn llm_health_ok(root: &str) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .and_then(|c| c.get(format!("{root}/health")).send())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn emit_llm(app: &AppHandle, phase: &str, message: &str, percent: Option<f64>) {
    let _ = app.emit(
        "llm://progress",
        EngineProgress {
            phase: phase.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

fn main() {
    tauri::Builder::default()
        .manage(EngineState::default())
        .manage(LlmState::default())
        .manage(RemoteServerState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_engine,
            ensure_llm,
            stop_llm,
            restart_app,
            list_models,
            download_model,
            list_loras,
            lora_headers,
            download_lora,
            gpu_info,
            gpu_vram_usage,
            http_fetch,
            save_file,
            open_path,
            write_workspace_file,
            read_workspace_file,
            search_files,
            read_file,
            run_command,
            which_interpreter,
            git_repo_root,
            app_repo_root,
            git_ensure_repo,
            git_worktree_create,
            git_commit_all,
            git_worktree_diff,
            git_merge_branch,
            git_merge_abort,
            git_conflict_versions,
            git_complete_merge,
            git_worktree_remove,
            capture_screen,
            pick_folder,
            oauth_loopback,
            tv_cdp_eval,
            start_remote_server,
            stop_remote_server,
            remote_server_status,
            open_browser_window,
            mcp_stdio_exchange
        ])
        .build(tauri::generate_context!())
        .expect("error while building Visual Reader")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Kill both managed children (image engine + built-in model) so no
                // stray process lingers after the window closes.
                if let Some(state) = app.try_state::<EngineState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
                if let Some(state) = app.try_state::<LlmState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
