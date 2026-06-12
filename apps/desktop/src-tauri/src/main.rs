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
use std::process::{Child, Command};
use std::sync::Mutex;

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

/// Ensure the local engine is installed and running; return its base URL.
#[tauri::command]
async fn ensure_engine(app: AppHandle, state: State<'_, EngineState>) -> Result<String, String> {
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
    let (base, child) = tauri::async_runtime::spawn_blocking(move || ensure_blocking(&app2))
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
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("VisualReader/1.0 (https://github.com/vcons002-ship-it/illustrator-app)")
        .build()
        .map_err(|e| e.to_string())?;
    let method =
        reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
    let mut builder = client.request(method, &req.url);
    for (name, value) in &req.headers {
        builder = builder.header(name, value);
    }
    if let Some(b64) = &req.body_base64 {
        builder = builder.body(engine.decode(b64).map_err(|e| e.to_string())?);
    }
    let mut resp = builder.send().map_err(|e| e.to_string())?;
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

fn ensure_blocking(app: &AppHandle) -> Result<(String, Option<Child>), String> {
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
    let child = install_and_spawn(app)?;
    emit_engine(app, "ready", "Engine ready", Some(100.0));
    Ok((base, Some(child)))
}

/// Is something already listening on `127.0.0.1:port`?
fn port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn install_and_spawn(app: &AppHandle) -> Result<Child, String> {
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
    let child = spawn_comfy(&portable)?;

    let base = format!("http://127.0.0.1:{ENGINE_PORT}");
    for _ in 0..180 {
        if health_ok(&base) {
            return Ok(child);
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    Err("The engine did not become ready in time.".into())
}

fn spawn_comfy(portable: &Path) -> Result<Child, String> {
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

fn main() {
    tauri::Builder::default()
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_engine,
            list_models,
            download_model,
            list_loras,
            lora_headers,
            download_lora,
            gpu_info,
            http_fetch
        ])
        .build(tauri::generate_context!())
        .expect("error while building Visual Reader")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<EngineState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
