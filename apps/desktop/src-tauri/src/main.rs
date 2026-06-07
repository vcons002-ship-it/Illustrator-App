#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Visual Reader desktop shell.
//!
//! The renderer is the existing web app (`apps/web`); this Rust shell adds the
//! one thing a browser cannot do — manage a local GPU inference engine so big
//! image models (SD / SDXL / Flux, 8GB+) "just work" with no setup. It exposes
//! three commands to the renderer (see `apps/web/src/runtime.ts`):
//!   - `ensure_engine`  install + launch the engine on first use, return its URL
//!   - `list_models`    the models currently downloaded
//!   - `download_model` fetch a curated model on demand
//!
//! The heavy lifting (download/spawn/lifecycle) is marked with TODOs below; the
//! command surface and state plumbing are in place so the renderer integration
//! is already wired.

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

/// Process + endpoint handle for the managed engine. The child is killed when the
/// app exits (drop), so the user never has a stray GPU process.
#[derive(Default)]
struct EngineState {
    base_url: Mutex<Option<String>>,
    // TODO: hold the spawned `std::process::Child` here so it is terminated on exit.
}

#[derive(Serialize)]
struct InstalledModel {
    id: String,
    label: String,
}

/// Ensure the local inference engine is installed and running; return its base URL.
///
/// TODO (managed-engine flow):
///  1. Detect the GPU and pick the right build (CUDA / Metal-MPS / DirectML / ROCm,
///     CPU fallback).
///  2. On first use, download a portable ComfyUI to the app data dir, emitting
///     `engine://progress` events for the UI progress bar; idempotent thereafter.
///  3. Spawn it on a free localhost port with permissive CORS for the app origin,
///     health-check `/system_stats`, store the child + URL in `EngineState`.
#[tauri::command]
fn ensure_engine(state: State<'_, EngineState>) -> Result<String, String> {
    let mut url = state.base_url.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = url.clone() {
        return Ok(existing);
    }
    // Scaffold: assume a ComfyUI instance on its default port. Replace with the
    // download + spawn flow above.
    let base = "http://127.0.0.1:8188".to_string();
    *url = Some(base.clone());
    Ok(base)
}

/// Models the engine currently has downloaded (for the Settings model picker).
///
/// TODO: query the running engine (`GET /object_info/CheckpointLoaderSimple`) or
/// scan the app data models dir. Empty until wired.
#[tauri::command]
fn list_models() -> Result<Vec<InstalledModel>, String> {
    Ok(vec![])
}

/// Download a curated model on demand.
///
/// TODO: resolve `id` against the curated catalog, stream the weights to the
/// models dir with progress events, then refresh the engine.
#[tauri::command]
fn download_model(id: String) -> Result<(), String> {
    let _ = id;
    Err("Model download is not implemented in the scaffold yet".into())
}

fn main() {
    tauri::Builder::default()
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![ensure_engine, list_models, download_model])
        .run(tauri::generate_context!())
        .expect("error while running Visual Reader");
}
