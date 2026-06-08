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
}

// --------------------------------------------------------------------- commands

/// Ensure the local engine is installed and running; return its base URL.
#[tauri::command]
async fn ensure_engine(app: AppHandle, state: State<'_, EngineState>) -> Result<String, String> {
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

/// Checkpoints currently downloaded (the Settings model picker reads this).
#[tauri::command]
async fn list_models(app: AppHandle) -> Result<Vec<InstalledModel>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = checkpoints_dir(&app);
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".safetensors") || name.ends_with(".ckpt") {
                    out.push(InstalledModel { id: name.clone(), label: name });
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download a curated checkpoint into the engine's models dir, with progress.
#[tauri::command]
async fn download_model(app: AppHandle, model: DownloadableModel) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = checkpoints_dir(&app2);
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
    let child = install_and_spawn(app)?;
    emit_engine(app, "ready", "Engine ready", Some(100.0));
    Ok((base, Some(child)))
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

/// Like `download_to_file` but emits `model://progress` keyed by model id.
fn download_model_with_progress(
    app: &AppHandle,
    model: &DownloadableModel,
    dest: &Path,
) -> Result<(), String> {
    let mut resp = reqwest::blocking::get(&model.url).map_err(|e| e.to_string())?;
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
    Ok(())
}

// ----------------------------------------------------------------------- helpers

fn engine_root(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("engine")
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
            download_lora
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
