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
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// Suppresses the blocking Windows "System Error" dialog (e.g. "xyz.dll was not found") that the OS
// loader pops up for a broken executable — without this, probing a corrupt/incomplete binary (a
// half-finished PATH install, a shared ffmpeg build missing a DLL) HANGS the probing process
// indefinitely waiting for a human to click OK, instead of just failing with a bad exit code. Declared
// manually (no crate needed) since it's one Win32 call, linked automatically via kernel32 on Windows.
#[cfg(target_os = "windows")]
extern "system" {
    fn SetErrorMode(mode: u32) -> u32;
}
#[cfg(target_os = "windows")]
const SEM_FAILCRITICALERRORS: u32 = 0x0001;
#[cfg(target_os = "windows")]
const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;

// Kill-on-close Job Object: every long-lived child (ComfyUI / A1111 / llama-server) is assigned to
// ONE job created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. The job handle is never closed by us, so
// the OS closes it when THIS process dies — including a crash or a Task Manager kill, where
// `RunEvent::ExitRequested` never fires — and then terminates every process in the job. Without it,
// an app crash orphans multi-GB GPU processes until the user hunts them down. Manual FFI like
// `SetErrorMode` above (a handful of kernel32 calls, no crate). Best-effort: if job creation fails,
// children are simply not adopted and the exit handler still kills them on a normal quit.
#[cfg(target_os = "windows")]
mod job_object {
    use std::process::Child;
    use std::sync::OnceLock;

    type Handle = *mut core::ffi::c_void;
    extern "system" {
        fn CreateJobObjectW(attrs: Handle, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: u32, info: *const core::ffi::c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    /// JobObjectExtendedLimitInformation in the JOBOBJECTINFOCLASS enum.
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;

    // Only the layout matters — SetInformationJobObject reads a raw buffer with these exact
    // sizes/offsets (64-bit: 64 + 48 + 32 bytes). Every field except `limit_flags` stays zero.
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    /// The one process-wide job handle, created on first use. Stored as usize because a raw
    /// pointer isn't Send/Sync; 0 = creation failed (checked before every assignment).
    static JOB: OnceLock<usize> = OnceLock::new();

    fn job_handle() -> Handle {
        *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return 0;
            }
            let mut info = ExtendedLimits::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<ExtendedLimits>() as u32,
            );
            if ok == 0 {
                // A job WITHOUT kill-on-close would silently do nothing — don't hand children to it.
                CloseHandle(job);
                return 0;
            }
            job as usize
        }) as Handle
    }

    /// Tie a freshly spawned long-lived child's lifetime to ours (see the module comment).
    /// Best-effort: a failure (e.g. an outer job on a pre-Win8 nesting-less system) leaves the
    /// child exactly as unmanaged as before this feature existed.
    pub(crate) fn adopt_child(child: &Child) {
        use std::os::windows::io::AsRawHandle;
        let job = job_handle();
        if job.is_null() {
            return;
        }
        unsafe {
            let _ = AssignProcessToJobObject(job, child.as_raw_handle() as Handle);
        }
    }
}
#[cfg(target_os = "windows")]
use job_object::adopt_child;
/// On Unix the managed children are killed by the exit handler; there is no job-object
/// equivalent to wire up here (and the managed engines are Windows-only at runtime anyway).
#[cfg(not(target_os = "windows"))]
fn adopt_child(_child: &Child) {}

const COMFY_PORTABLE_URL: &str =
    "https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z";
/// A self-contained (static, no external DLL) Windows ffmpeg build — gyan.dev's non "-shared" builds
/// link everything into one exe, avoiding the "avfilter-10.dll was not found" class of failure a
/// shared/DLL-based install can hit when its folder gets split up (e.g. by a PATH workaround).
const FFMPEG_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.7z";
const ENGINE_PORT: u16 = 8188;
/// AUTOMATIC1111's default REST API port — it runs alongside ComfyUI (image gen on A1111, video on ComfyUI).
const A1111_PORT: u16 = 7860;

/// Process + endpoint handle for the managed engine. The child is killed on app
/// exit (see `RunEvent::ExitRequested` in `main`), so no stray GPU process lingers.
#[derive(Default)]
struct EngineState {
    base_url: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
    /// A separately-launched AUTOMATIC1111 (image gen on :7860, alongside the managed ComfyUI for video).
    /// Killed on exit like `child` so no stray GPU process lingers.
    a1111_child: Mutex<Option<Child>>,
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
    /// "diffusion_models", "text_encoders", "vae", "loras" or "latent_upscale_models".
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
    show_console: Option<bool>,
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
    let console = show_console.unwrap_or(false);
    let (base, child) = tauri::async_runtime::spawn_blocking(move || ensure_blocking(&app2, low, console))
        .await
        .map_err(|e| e.to_string())??;
    *state.base_url.lock().unwrap() = Some(base.clone());
    if let Some(child) = child {
        *state.child.lock().unwrap() = Some(child);
    }
    Ok(base)
}

/// Ensure AUTOMATIC1111 is running for image generation (it runs ALONGSIDE the managed ComfyUI, which
/// handles video). Returns its base URL (`http://127.0.0.1:7860`). Reuses an A1111 already answering on
/// :7860 (the user's own, or ours from earlier); otherwise launches it from `path` (the install folder)
/// with `--api`. `path` empty / not found / non-Windows → an explanatory error, and the caller falls
/// back to connect-only.
#[tauri::command]
async fn ensure_a1111(
    state: State<'_, EngineState>,
    path: String,
    show_console: Option<bool>,
) -> Result<String, String> {
    let base = format!("http://127.0.0.1:{A1111_PORT}");
    // Already up (the user started it, or we did earlier this session) → reuse it.
    if a1111_health_ok(&base) {
        return Ok(base);
    }
    if path.trim().is_empty() {
        return Err("Set your AUTOMATIC1111 install folder in Settings to auto-start it (or start it yourself with --api).".into());
    }
    if !cfg!(target_os = "windows") {
        return Err("Auto-starting AUTOMATIC1111 is Windows-only — start it yourself with --api and connect.".into());
    }
    let console = show_console.unwrap_or(false);
    let dir = std::path::PathBuf::from(path);
    let child = tauri::async_runtime::spawn_blocking(move || spawn_a1111(&dir, console))
        .await
        .map_err(|e| e.to_string())??;
    *state.a1111_child.lock().unwrap() = Some(child);
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
            Some("loras") => loras_dir(&app2),
            Some(f @ ("diffusion_models" | "text_encoders" | "vae" | "latent_upscale_models")) => {
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

/// Build a `Command` that never flashes a console window on Windows. This is a GUI app
/// (`windows_subsystem = "windows"`), so spawning a console child — nvidia-smi, git, python, the
/// bundled llama-server, an MCP server, a run_command shell — pops a black console window for a split
/// second unless the process is created with `CREATE_NO_WINDOW`. The recurring `nvidia-smi` VRAM poll
/// made this especially jarring (a flash every few seconds). No-op on macOS/Linux. Use this in place
/// of `Command::new` for every subprocess the shell spawns.
fn quiet_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// A `Command` for an ENGINE process whose console the user may want to watch (ComfyUI / A1111
/// generation logs). When `show_console` is true, spawn with a VISIBLE console window (plain
/// `Command::new`, no `CREATE_NO_WINDOW`); otherwise stay headless like `quiet_command`. The
/// "Show engine console windows" setting drives this. No visible difference on macOS/Linux.
fn command_for<S: AsRef<std::ffi::OsStr>>(program: S, show_console: bool) -> Command {
    if show_console {
        Command::new(program)
    } else {
        quiet_command(program)
    }
}

/// Stop a long-lived engine child AND its descendants. A1111 is spawned as `cmd /c webui-user.bat`,
/// so a plain `child.kill()` only kills cmd.exe and leaves the python tree holding the GPU;
/// `taskkill /T` walks the whole tree. The direct `kill()` afterwards covers a taskkill failure
/// (worst case: the old single-process kill), and `wait()` reaps the handle so nothing zombies.
fn kill_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    let _ = quiet_command("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

/// Query `nvidia-smi` for the first GPU's total memory in MB. None on any failure.
fn nvidia_vram_mb() -> Option<u64> {
    let out = quiet_command("nvidia-smi")
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
    let out = quiet_command("nvidia-smi")
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

/// Is this the PACKAGED build (the web UI compiled into the binary), rather than `cargo tauri dev`?
///
/// It decides whether an update is finished by `pnpm -r build` + a reload, or needs the Rust binary
/// rebuilt as well. In dev the page comes from the vite dev server, so rebuilding the web app is
/// enough; packaged, `frontendDist` was embedded at COMPILE time, so the built bundle changes
/// nothing until the binary itself is rebuilt — which is the round trip the reader has been making
/// by hand.
fn is_packaged_build() -> bool {
    !tauri::is_dev()
}

/// Does an update here need the binary rebuilt (packaged) or just a reload (dev)? Asked by the
/// updater before it decides what "finished" means.
#[tauri::command]
fn is_packaged() -> bool {
    is_packaged_build()
}

/// Where the running executable lives, and where a rebuild would put its replacement.
fn running_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("couldn't locate the running app: {e}"))
}

/// Delete `*.superseded-*.exe` left beside the executable by a previous self-rebuild.
///
/// The old binary can't be deleted while it's the running image, so a rebuild renames it aside and
/// the NEXT start clears it. Best-effort throughout: a leftover file is untidy, never harmful.
fn sweep_superseded_binaries() {
    let Ok(exe) = running_exe() else { return };
    let Some(dir) = exe.parent() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains(".superseded-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Start the freshly-built app as an INDEPENDENT process, so it survives this one exiting.
///
/// A plain spawn makes the new app a child that inherits this process's console and standard
/// handles — and this process is about to die. On Windows that is how a relaunch turns into "the
/// app closed and never came back": the child is tied to a console that goes away, or to a job
/// object the parent belonged to (anything launched from a terminal, a script, or a build tool can
/// carry one), and it is killed with the parent instead of replacing it.
///
/// `DETACHED_PROCESS` gives it no console at all, `CREATE_NEW_PROCESS_GROUP` takes it out of this
/// one's group, and null stdio leaves it holding no handle of ours. The working directory is the
/// REPO ROOT, not `target/release`, because that's where `desktop-prod.bat` starts it from — the
/// relaunch should reproduce the launch that's known to work, not a subtly different one.
fn launch_detached(exe: &Path, root: &Path) -> std::io::Result<std::process::Child> {
    let mut cmd = Command::new(exe);
    cmd.current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn()
}

/// Rebuild the PACKAGED desktop app from the current checkout and relaunch into it. Never returns
/// on success — the process is replaced by the freshly built one.
///
/// This is the half of "update" that could only be done by hand before: `pnpm -r build` refreshes the
/// web bundle, but a packaged build embedded that bundle when it was compiled, so nothing the reader
/// sees changes until `cargo tauri build` runs again. They were remoting in to run desktop-prod.bat
/// for exactly this.
///
/// THE RUNNING BINARY IS THE OBSTACLE: Windows locks an executable's image file, so the linker cannot
/// write over the app that's asking for the rebuild. It can, however, be RENAMED while running — the
/// open image handle follows the file, not the path. So: move ourselves aside, let the build write a
/// fresh binary at the original path, and launch that. On any failure the rename is undone, so a
/// failed update leaves exactly what was there before.
#[tauri::command]
async fn rebuild_desktop_app(app: AppHandle) -> Result<String, String> {
    if !is_packaged_build() {
        return Err(
            "This window is running the development build, where the page comes from the dev server              — rebuilding the binary wouldn't change it. Close and reopen desktop.bat to finish."
                .to_string(),
        );
    }
    let root = app_repo_root_cached()
        .ok_or_else(|| "Couldn't find the Visual Reader project folder to build from.".to_string())?;
    let tauri_dir = root.join("apps").join("desktop").join("src-tauri");
    if !tauri_dir.is_dir() {
        return Err(format!("The desktop project folder is missing at {}.", tauri_dir.display()));
    }
    let exe = running_exe()?;
    // A distinct name each time, so a previous failed sweep can't collide with this one.
    let aside = exe.with_file_name(format!(
        "{}.superseded-{}.exe",
        exe.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "visual-reader".into()),
        std::process::id()
    ));
    std::fs::rename(&exe, &aside)
        .map_err(|e| format!("Couldn't move the running app aside to rebuild over it: {e}"))?;

    let build = tauri::async_runtime::spawn_blocking({
        let dir = tauri_dir.clone();
        move || cargo_tauri_build(&dir)
    })
    .await
    .map_err(|e| e.to_string())?;

    match build {
        Ok(tail) if exe.is_file() => {
            // The new binary is in place. Start it and stand down; the sweep on ITS startup deletes
            // the copy we renamed aside (we can't, we're still running out of it).
            let child = launch_detached(&exe, &root).map_err(|e| {
                let _ = std::fs::rename(&aside, &exe);
                format!("Rebuilt, but couldn't start the new app: {e}")
            })?;
            // DON'T exit into nothing. Spawning only proves the process was CREATED; a new binary
            // that dies on startup used to take the old one with it — the app vanished and never
            // came back, with no message anywhere, because we had already called app.exit(0). Wait
            // for it to get past its own startup, off the async runtime so the UI stays responsive.
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                let mut child = child;
                std::thread::sleep(std::time::Duration::from_secs(3));
                // Ok(None) = still running. An error means we can't tell, which is not evidence of
                // failure — treat "unknown" as alive rather than tearing down a good update.
                match child.try_wait() {
                    Ok(Some(status)) => Some(status.to_string()),
                    _ => None,
                }
            })
            .await
            .unwrap_or(None);
            match outcome {
                Some(status) => {
                    // It started and stopped. Put the working binary back and stay up to say so —
                    // an app still running to deliver the bad news beats one that's simply gone.
                    let _ = std::fs::remove_file(&exe);
                    let _ = std::fs::rename(&aside, &exe);
                    Err(format!(
                        "Rebuilt, but the new app closed immediately ({status}). The previous version has been \
                         put back and is still running. Run desktop-prod.bat to see what it printed."
                    ))
                }
                None => {
                    app.exit(0);
                    Ok(tail)
                }
            }
        }
        Ok(_) => {
            let _ = std::fs::rename(&aside, &exe);
            Err("The build reported success but produced no new app. Run desktop-prod.bat to check.".to_string())
        }
        Err(e) => {
            // Put ourselves back: a failed update must leave the install exactly as it was.
            let _ = std::fs::rename(&aside, &exe);
            Err(e)
        }
    }
}

/// `cargo tauri build --no-bundle` in the desktop project — the same command desktop-prod.bat runs.
/// `--no-bundle` because the reader launches the executable directly; building installers as well
/// would add minutes for something nobody here uses.
fn cargo_tauri_build(dir: &Path) -> Result<String, String> {
    let mut cmd = quiet_command("cargo");
    cmd.current_dir(dir).arg("tauri").arg("build").arg("--no-bundle");
    // rustup installs to ~/.cargo/bin, which a GUI process doesn't always inherit on PATH — the
    // .bat files prepend it for the same reason.
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let cargo_bin = PathBuf::from(home).join(".cargo").join("bin");
        if let Some(path) = std::env::var_os("PATH") {
            let mut dirs = vec![cargo_bin];
            dirs.extend(std::env::split_paths(&path));
            if let Ok(joined) = std::env::join_paths(dirs) {
                cmd.env("PATH", joined);
            }
        }
    }
    let out = cmd
        .output()
        .map_err(|e| format!("Couldn't run cargo: {e}. Is the Rust toolchain installed (full-install.bat)?"))?;
    if out.status.success() {
        return Ok(tail_of(&String::from_utf8_lossy(&out.stdout)));
    }
    Err(format!("Rebuilding the app failed: {}", tail_of(&String::from_utf8_lossy(&out.stderr))))
}

/// The last few hundred characters of build output — the part that names the failure. A full cargo
/// log is thousands of lines and the error is always at the END.
fn tail_of(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= 400 {
        return t.to_string();
    }
    let start = t.char_indices().nth(t.chars().count() - 400).map(|(i, _)| i).unwrap_or(0);
    format!("…{}", &t[start..])
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

/// True when `host` names this machine or a private/link-local network — the targets a
/// prompt-injected page would pivot the CORS proxy to (cloud metadata at 169.254.169.254, the
/// router's admin panel, local daemons). Pure classifier; the proxy's policy (which of these are
/// still reachable) lives at the call site in `http_fetch_blocking`.
fn is_private_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
    {
        return true;
    }
    fn v4_private(v4: std::net::Ipv4Addr) -> bool {
        v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
    }
    match h.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4_private(v4),
        Ok(std::net::IpAddr::V6(v6)) => {
            let seg0 = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                // fe80::/10 (link-local) and fc00::/7 (ULA) — no stable is_* helpers yet.
                || (seg0 & 0xffc0) == 0xfe80
                || (seg0 & 0xfe00) == 0xfc00
                // An IPv4 address smuggled as ::ffff:a.b.c.d must classify like the IPv4.
                || v6.to_ipv4_mapped().is_some_and(v4_private)
        }
        Err(_) => false,
    }
}

/// The local-inference ports the proxy may still reach on a private host: the managed
/// ComfyUI / AUTOMATIC1111 / bundled llama-server, plus the Ollama / LM Studio defaults
/// the Text settings offer. Everything else private is refused (see `http_fetch_blocking`).
const LOCAL_ENGINE_PORTS: &[u16] = &[ENGINE_PORT, A1111_PORT, LLM_PORT, 11434, 1234];

/// True ONLY for this machine's own loopback (127.0.0.0/8, ::1, an IPv4-mapped loopback, and the
/// `localhost` family) — NOT the rest of the private range. The `LOCAL_ENGINE_PORTS` exemption keys
/// off this, so a private-but-routable LAN host (a co-worker's Ollama / LM Studio) gets NO exemption
/// even on an engine port. The app's own engines all run on 127.0.0.1, so loopback keeps them reachable.
fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    match h.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_loopback(),
        Ok(std::net::IpAddr::V6(v6)) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        Err(_) => false,
    }
}

/// SSRF guard for ONE fetch target — the initial URL AND every redirect hop (see the manual redirect
/// loop in `http_fetch_blocking`). A model-driven fetch must not pivot to local/private addresses
/// (cloud metadata at 169.254.169.254, a router panel, local daemons). The sole exception is the
/// app's own local-inference engines on the known `LOCAL_ENGINE_PORTS` — and ONLY on loopback, so the
/// exemption can't be aimed at a LAN peer's engine on the same port.
fn guard_fetch_target(url: &reqwest::Url) -> Result<(), String> {
    let Some(host) = url.host_str() else {
        return Ok(());
    };
    if !is_private_host(host) {
        return Ok(());
    }
    let engine_port =
        url.port_or_known_default().is_some_and(|p| LOCAL_ENGINE_PORTS.contains(&p));
    if engine_port && is_loopback_host(host) {
        return Ok(());
    }
    Err("blocked: this proxy can't reach local/private addresses".into())
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
    // SSRF guard: a model-driven fetch (keyless web search, "open this URL") must not pivot to
    // local/private addresses. The app's OWN engine traffic goes through this same proxy —
    // verified against the apps/web/src call sites: `desktopFetch` (App.tsx) reaches self-hosted
    // ComfyUI/A1111 and the worker's `corsFetch` reaches local LLM servers, which is exactly why
    // the `is_local_target` no_proxy branch below exists — so private targets stay reachable on
    // the known local-inference ports only; every other private target is refused.
    let parsed = reqwest::Url::parse(&req.url).map_err(|e| e.to_string())?;
    guard_fetch_target(&parsed)?;
    // A real User-Agent is REQUIRED by some hosts: Wikimedia (the keyless image/
    // figure search) returns 403 to a client with none, and reqwest built with
    // default-features=false sends no default UA. The browser/extension paths get
    // the webview's UA for free; this proxy must set one or desktop figure search
    // 403s. A request that carries its own User-Agent header still overrides this.
    let mut client_builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        // Follow redirects MANUALLY (loop below) instead of letting reqwest chase them: its own
        // follower re-runs no SSRF guard, so a public page could 302 → 127.0.0.1:PORT / 169.254.169.254
        // and defeat the up-front check. `Policy::none()` returns the 3xx so we re-guard each hop.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("VisualReader/1.0 (https://github.com/vcons002-ship-it/illustrator-app)");
    // A self-hosted engine on this machine/LAN must bypass any system/env proxy (see is_local_target).
    if is_local_target(&req.url) {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder.build().map_err(|e| e.to_string())?;
    let method =
        reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
    // Decode the request body once (re-sent verbatim on each redirect hop).
    let body = match &req.body_base64 {
        Some(b64) => Some(engine.decode(b64).map_err(|e| e.to_string())?),
        None => None,
    };
    // Bounded manual redirect loop (max 5 hops). Some legitimate hosts DO redirect (Wikimedia upload,
    // Hugging Face), so we follow — but each `Location` is re-parsed (relative ones joined against the
    // CURRENT url) and re-run through the SAME private-host guard before it's followed, so a redirect
    // can never reach a target the guard would have refused up front.
    let mut current = parsed;
    let mut redirects = 0u8;
    let mut resp = loop {
        let mut builder = client.request(method.clone(), current.clone());
        for (name, value) in &req.headers {
            builder = builder.header(name, value);
        }
        if let Some(bytes) = &body {
            builder = builder.body(bytes.clone());
        }
        let resp = builder.send().map_err(|e| err_with_sources(&e))?;
        if resp.status().is_redirection() {
            if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
                if redirects >= 5 {
                    return Err("Too many redirects (max 5).".into());
                }
                redirects += 1;
                let loc = loc.to_str().map_err(|e| e.to_string())?.to_string();
                let next = current.join(&loc).map_err(|e| e.to_string())?;
                if !matches!(next.scheme(), "http" | "https") {
                    return Err("blocked: redirect to a non-http(s) URL".into());
                }
                guard_fetch_target(&next)?;
                current = next;
                continue;
            }
        }
        break resp;
    };
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
    let mut child = quiet_command(&req.command)
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
            // Reap the whole process tree — an MCP server may itself have spawned children.
            kill_tree(&mut child);
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

/// Cap concurrent WebSocket peers on the internet-exposable relay: an unauthenticated flood must not
/// exhaust memory/handles before the token check runs. Phone pairing needs only a couple of peers.
const MAX_RELAY_WS_CONNS: usize = 32;
/// Per-message size limit for relay frames — well above any legitimate control-JSON/payload frame,
/// far below tokio-tungstenite's 64 MB default, so a pre-auth peer can't buffer a giant frame.
const RELAY_MAX_WS_MSG_BYTES: usize = 4 * 1024 * 1024;

/// RAII counter for live relay WS connections — decrements on drop so a dropped/aborted task frees
/// its slot (see `MAX_RELAY_WS_CONNS`).
struct RelayConnGuard(std::sync::Arc<std::sync::atomic::AtomicUsize>);
impl Drop for RelayConnGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
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
    // Live WS-peer count (see MAX_RELAY_WS_CONNS) — HTTP asset requests aren't counted (they're short).
    let conns = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
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
        // Enforce the concurrent-peer cap BEFORE upgrading, so a flood is dropped cheaply.
        use std::sync::atomic::Ordering;
        if conns.fetch_add(1, Ordering::SeqCst) >= MAX_RELAY_WS_CONNS {
            conns.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let conn_guard = RelayConnGuard(conns.clone());
        let peer_id = next_id;
        next_id += 1;
        let tx = tx.clone();
        let mut rx = tx.subscribe();
        let token = token.clone();
        tauri::async_runtime::spawn(async move {
            // Held for the connection's lifetime; frees the slot on drop (normal exit or abort).
            let _conn_guard = conn_guard;
            // Bound each frame's size so a pre-auth peer can't buffer a huge message (tungstenite's
            // default is 64 MB).
            let mut ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
            ws_config.max_message_size = Some(RELAY_MAX_WS_MSG_BYTES);
            ws_config.max_frame_size = Some(RELAY_MAX_WS_MSG_BYTES);
            let ws = match tokio_tungstenite::accept_async_with_config(stream, Some(ws_config)).await {
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
                                if !ok {
                                    // Small fixed delay before dropping a bad-token peer, to blunt online
                                    // brute-forcing over the tunnel (the ct_eq compare above stays constant-time).
                                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                    break;
                                }
                                authorized = true;
                                // FALL THROUGH — do NOT swallow this frame. There is no separate
                                // handshake: EVERY frame is `{token, payload}` (see encodeFrame), so a
                                // peer's first frame is already a real message. For a phone that is
                                // `vrcmd:hello`, the request that asks the desktop for its state
                                // snapshot — dropping it left a freshly-linked phone showing an empty
                                // chat until the reader happened to send something (which, as the
                                // SECOND frame, relayed normally and made everything appear at once).
                                // Relaying the token along with it is by design, not a leak: a peer can
                                // only decode a frame whose token matches the one it already holds, and
                                // only authorized peers ever receive a broadcast (see the recv arm).
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
    // No `Access-Control-Allow-Origin: *`: the SPA loads from THIS origin (the relay port), so its
    // asset/API fetches are same-origin and need no CORS grant — and a wildcard would needlessly let
    // any other web page read responses from this internet-exposable server.
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: {cache}\r\nConnection: close\r\n\r\n",
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
        // Base: the session's working folder when it's a real, APPROVED directory (see
        // resolve_approved_cwd), else the sandbox workspace.
        let base = match resolve_approved_cwd(&app, cwd)? {
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
        let base = match resolve_approved_cwd(&app, cwd)? {
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

/// Folders the model's file tools may touch. `read_file` used to accept ANY absolute path — a
/// prompt-injected page could pull `~/.ssh` or a browser profile through the import pipeline.
/// Roots are: the app's own folders (workspace + engine root, seeded lazily), every folder the
/// reader picked this session (`pick_folder`), and the folder of every `search_files` hit (the
/// reader initiated that search, and clicking a hit is the intended way into `read_file`).
static APPROVED_ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();

/// The reader-facing refusal, shared by every approved-roots check so the fix is always named.
const OUTSIDE_APPROVED_ROOTS: &str = "outside the folders this app is allowed to touch.";
/// The same refusal for reading a FILE, where the model can resolve it ITSELF.
///
/// This used to say "pick the folder first (📁) or search for the file, then retry" — advice aimed
/// at the reader but delivered to the MODEL, which cannot see the screen. It relayed the instruction
/// and filled the gaps with a permissions dialog that does not exist: click the folder icon, a window
/// pops up asking which folders it may access, approve it. The reader had to say it was invented
/// before the model tried the other half of the sentence — searching — which worked first time,
/// because a search approves each hit’s folder.
///
/// So: name the tool, say what it achieves, and rule the fabrication out explicitly.
const OUTSIDE_APPROVED_ROOTS_FILE: &str = concat!(
    "outside the folders this app is allowed to touch. Resolve it yourself: call find_files with the ",
    "file’s name, then read the path it returns — finding a file approves its folder. Do NOT ask the ",
    "reader to grant access or to click anything; there is no permissions dialog. (If the search finds ",
    "nothing, say so — they can point the assistant at a folder with Browse… beside the chat box.)"
);

fn approved_roots(app: &AppHandle) -> &'static Mutex<Vec<PathBuf>> {
    APPROVED_ROOTS.get_or_init(|| Mutex::new(vec![workspace_dir(app), engine_root(app)]))
}

fn approve_root(app: &AppHandle, dir: &Path) {
    let mut roots = approved_roots(app).lock().unwrap();
    if !roots.iter().any(|r| r == dir) {
        roots.push(dir.to_path_buf());
    }
}

/// Is `path` inside an approved root? Both sides are canonicalized so `..` segments, symlinks and
/// 8.3 aliases can't dodge the prefix check; a path that can't be canonicalized (doesn't exist /
/// unreadable) is denied — nothing legitimate reads a nonexistent file.
fn is_approved_path(app: &AppHandle, path: &Path) -> bool {
    let Ok(real) = std::fs::canonicalize(path) else {
        return false;
    };
    let roots = approved_roots(app).lock().unwrap();
    roots.iter().any(|root| {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        real.starts_with(&root)
    })
}

/// The app's OWN git checkout, discovered once and cached. `None` when the app isn't running from a
/// git working copy (a packaged build) — then there's nothing to self-update.
static APP_REPO_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Locate the app's own repository root (the folder holding this checkout), from the executable's
/// directory or the process cwd. Cached — this shells out to git.
fn app_repo_root_cached() -> Option<PathBuf> {
    APP_REPO_ROOT
        .get_or_init(|| {
            let mut dirs: Vec<PathBuf> = Vec::new();
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
                            return Some(PathBuf::from(root));
                        }
                    }
                }
            }
            None
        })
        .clone()
}

/// Is this the app's own checkout? Compared canonicalized, so `..`/symlink/8.3 spellings still match.
fn is_app_repo_root(path: &Path) -> bool {
    let Some(root) = app_repo_root_cached() else {
        return false;
    };
    let (Ok(a), Ok(b)) = (std::fs::canonicalize(path), std::fs::canonicalize(&root)) else {
        return false;
    };
    a == b
}

/// Resolve the optional `cwd` parameter of run_command / the workspace file ops: an existing
/// directory must be inside the approved roots (the picked session folder always is); a missing /
/// not-a-directory value keeps the old silent fallback to the sandbox workspace (`None`).
///
/// The app's OWN checkout counts as approved. The in-app updater runs `git pull` / `pnpm install` /
/// `pnpm -r build` THERE, and that folder is not (and should not become) a reader-picked root — so
/// without this the Update button failed at the first step with "outside the approved folders". This
/// widens nothing the model can reach: `cwd` is always supplied by the host (the session or agent
/// working folder), never taken from a tool call, so the only caller that can name this path is the
/// app's own updater.
fn resolve_approved_cwd(app: &AppHandle, cwd: Option<String>) -> Result<Option<PathBuf>, String> {
    match cwd.filter(|c| !c.is_empty()).map(PathBuf::from).filter(|p| p.is_dir()) {
        Some(p) if is_approved_path(app, &p) || is_app_repo_root(&p) => Ok(Some(p)),
        Some(_) => Err(OUTSIDE_APPROVED_ROOTS.to_string()),
        None => Ok(None),
    }
}

/// Validate an ffmpeg path operand (an `-i <input>` or the final output) against the approved roots.
/// Relative operands resolve against `cwd` (itself already approved via `resolve_approved_cwd`). An
/// input clip already exists → validated directly by `is_approved_path`. The output usually does NOT
/// exist yet, so we canonicalize its PARENT (resolving `..`/symlinks / 8.3 aliases) and confirm the
/// resolved location sits under a root — mirroring `is_approved_path`, which requires the file to exist.
fn is_approved_ffmpeg_operand(app: &AppHandle, cwd: &Path, operand: &str) -> bool {
    let raw = Path::new(operand);
    let full = if raw.is_absolute() { raw.to_path_buf() } else { cwd.join(raw) };
    if full.exists() {
        return is_approved_path(app, &full);
    }
    let (Some(parent), Some(name)) = (full.parent(), full.file_name()) else {
        return false;
    };
    let Ok(real_parent) = std::fs::canonicalize(parent) else {
        return false;
    };
    let candidate = real_parent.join(name);
    let roots = approved_roots(app).lock().unwrap();
    roots.iter().any(|root| {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        candidate.starts_with(&root)
    })
}

/// The path operands an ffmpeg argv touches: the token after every `-i` (inputs) and the final arg
/// (the output — how `buildConcatArgs`/`buildLastFrameArgs` in packages/core always shape it). Flags,
/// filter strings and numeric options are left alone; only these operands are roots-checked.
fn ffmpeg_path_operands(args: &[String]) -> Vec<&str> {
    let mut ops = Vec::new();
    let mut it = args.iter().enumerate().peekable();
    while let Some((i, a)) = it.next() {
        if a == "-i" {
            if let Some((_, next)) = it.peek() {
                ops.push(next.as_str());
            }
        } else if i == args.len() - 1 && !a.starts_with('-') {
            // The final operand is the output path (never a flag in the app-built argv).
            ops.push(a.as_str());
        }
    }
    ops
}

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
            // An explicit search root is subject to the same approved-roots check as a cwd
            // (it arrives from the picked working folder, which is always approved).
            Some(r) if !r.trim().is_empty() => {
                let p = PathBuf::from(r);
                if !is_approved_path(&app, &p) {
                    return Err(OUTSIDE_APPROVED_ROOTS.to_string());
                }
                p
            }
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
        // The reader initiated this search, and clicking a hit calls `read_file` on it — approve
        // each hit's folder (deduped in approve_root) so that follow-up read is in scope. NOT the
        // whole search root: the default root is the home dir, and approving that would undo the
        // scoping for everything under it.
        for f in &out {
            if let Some(parent) = Path::new(&f.path).parent() {
                approve_root(&app, parent);
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
/// `/open <path>` command or a click on a `/find` result — and scoped to the
/// approved roots, so a fabricated path can't exfiltrate `~/.ssh` or a browser profile.
#[tauri::command]
async fn read_file(app: AppHandle, path: String) -> Result<ReadFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let p = PathBuf::from(&path);
        if !is_approved_path(&app, &p) {
            return Err(OUTSIDE_APPROVED_ROOTS_FILE.to_string());
        }
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
    let _ = quiet_command("rundll32.exe")
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
async fn pick_folder(app: AppHandle) -> Option<String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Choose a working folder for the assistant")
        .pick_folder()
        .await?;
    // An explicit pick is the user's consent: the folder joins the approved roots, so the file
    // tools (read_file, run_command's cwd, …) can work there for the rest of the session.
    approve_root(&app, picked.path());
    Some(picked.path().to_string_lossy().into_owned())
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
        // The session's chosen working folder when it's a real, APPROVED directory (see
        // resolve_approved_cwd); otherwise the default sandbox workspace (created on demand).
        let dir = match resolve_approved_cwd(&app, cwd)? {
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
            let mut c = quiet_command("powershell");
            c.arg("-NoProfile").arg("-NonInteractive").arg("-Command");
            append_raw_command(&mut c, &command);
            c
        } else if cfg!(target_os = "windows") {
            // raw_arg: `cmd /C` must see the command verbatim, or a quoted "C:\…\f.py" arrives at the
            // program with literal quotes (Errno 22). See append_raw_command.
            let mut c = quiet_command("cmd");
            c.arg("/C");
            append_raw_command(&mut c, &command);
            c
        } else {
            // Unix: args are a vector (no command-line string), so `sh -c <command>` needs no special
            // handling — sh parses the one command string itself.
            let mut c = quiet_command("sh");
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
                        // Reap the whole tree, not just the shell/ffmpeg parent, so a spawned child
                        // (a GPU-holding process) can't orphan on timeout. kill_tree also wait()s;
                        // the cached status is returned by the wait() below.
                        kill_tree(&mut child);
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
            quiet_command(prog)
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

/// ffmpeg re-encodes can run longer than a shell command (stitching many clips), so give it its own,
/// more generous ceiling.
const FFMPEG_TIMEOUT_SECS: u64 = 900;

/// Resolve an ffmpeg binary for the long-form video pipeline (stitching clips + extracting last frames).
/// Prefers our OWN managed, known-good static build (see `download_ffmpeg`) — checked FIRST so a stray
/// broken PATH entry (a half-finished install, a shared build missing a DLL — the exact "avfilter-10.dll
/// was not found" failure mode) never shadows a copy we know works. Falls back to `ffmpeg` on PATH, then
/// to the ffmpeg that imageio-ffmpeg bundles inside the managed ComfyUI's embedded Python (rarely
/// present — vanilla ComfyUI doesn't depend on it — but a free check). `None` when nothing works.
fn resolve_ffmpeg(app: &AppHandle) -> Option<std::path::PathBuf> {
    let ok = |p: &std::path::Path| {
        quiet_command(p)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    // 1. Our own managed copy.
    let managed = ffmpeg_dir(app).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    if managed.exists() && ok(&managed) {
        return Some(managed);
    }
    // 2. On PATH (a user-installed ffmpeg).
    if ok(std::path::Path::new("ffmpeg")) {
        return Some(std::path::PathBuf::from("ffmpeg"));
    }
    // 3. Bundled with the managed ComfyUI (imageio-ffmpeg's binary under site-packages/imageio_ffmpeg).
    let bin_dir = engine_root(app)
        .join("ComfyUI_windows_portable")
        .join("python_embeded")
        .join("Lib")
        .join("site-packages")
        .join("imageio_ffmpeg")
        .join("binaries");
    if let Ok(entries) = std::fs::read_dir(&bin_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if name.starts_with("ffmpeg") && (name.ends_with(".exe") || !name.contains('.')) {
                let p = e.path();
                if ok(&p) {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Download a self-contained (static, no external DLL) ffmpeg build into the app's own managed folder,
/// so the long-form video pipeline never depends on PATH or a third-party installer — the exact class
/// of problem that produces a "some.dll was not found" crash when a shared/DLL-based ffmpeg install
/// gets split up (e.g. only the exe copied somewhere on PATH, without its neighboring DLLs). Idempotent:
/// returns immediately if we already have a working copy. Windows-only — ffmpeg is trivially available
/// via brew/apt elsewhere.
#[tauri::command]
async fn download_ffmpeg(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !cfg!(target_os = "windows") {
            return Err(
                "A managed ffmpeg download is only needed on Windows — install ffmpeg with your \
                 package manager (brew install ffmpeg / apt install ffmpeg) and it'll be found on PATH."
                    .to_string(),
            );
        }
        let dir = ffmpeg_dir(&app);
        let dest = dir.join("ffmpeg.exe");
        if dest.exists() {
            emit_ffmpeg_progress(&app, "ffmpeg", 0, 0, 100.0);
            return Ok(dest.to_string_lossy().to_string());
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let archive = dir.join("ffmpeg.7z");
        download_ffmpeg_archive(&app, &archive)?;
        let staging = dir.join("_extract");
        let _ = std::fs::remove_dir_all(&staging);
        sevenz_rust::decompress_file(&archive, &staging).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&archive);
        // The archive's top-level folder name is version-stamped (e.g. "ffmpeg-7.1-essentials_build"),
        // so walk the extracted tree for the exe rather than hard-coding that path.
        let found = find_file_named(&staging, "ffmpeg.exe")
            .ok_or_else(|| "The downloaded ffmpeg archive didn't contain ffmpeg.exe.".to_string())?;
        std::fs::copy(&found, &dest).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&staging);
        emit_ffmpeg_progress(&app, "ffmpeg", 0, 0, 100.0);
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stream `FFMPEG_URL` to `dest`, reporting progress the SAME way a catalog model download does
/// (`model://progress`, keyed by id `"ffmpeg"`) — reuses the existing progress UI in Settings with no
/// new plumbing needed on the frontend.
fn download_ffmpeg_archive(app: &AppHandle, dest: &Path) -> Result<(), String> {
    let mut resp = reqwest::blocking::get(FFMPEG_URL).map_err(|e| e.to_string())?;
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
                emit_ffmpeg_progress(app, "ffmpeg", received, total, pct as f64);
            }
        }
    }
    Ok(())
}

fn emit_ffmpeg_progress(app: &AppHandle, id: &str, received_bytes: u64, total_bytes: u64, percent: f64) {
    let _ = app.emit("model://progress", ModelProgress { id: id.to_string(), received_bytes, total_bytes, percent });
}

/// Depth-first search for a file named `name` (case-insensitive) under `root`. Used to find
/// `ffmpeg.exe` inside a downloaded archive whose top-level folder name is version-stamped.
fn find_file_named(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, name) {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|f| f.to_str())
            .map(|f| f.eq_ignore_ascii_case(name))
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

/// Run ffmpeg with the given argument vector (built by the app, NOT the model — so this needs no
/// `allowCommands` opt-in) in `cwd` (default the workspace). Used by the long-form video pipeline to
/// extract each clip's last frame and concatenate the clips into one mp4. Reuses `run_command`'s
/// concurrent pipe-drain + timeout + output-cap. Errors with an install hint when ffmpeg isn't found.
#[tauri::command]
async fn run_ffmpeg(app: AppHandle, args: Vec<String>, cwd: Option<String>) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = resolve_ffmpeg(&app).ok_or_else(|| {
            "ffmpeg not found — install ffmpeg and add it to your PATH (it's needed to stitch the clips into one video).".to_string()
        })?;
        // Gate the cwd through the approved roots, exactly like run_command (default: the sandbox
        // workspace when none/not-a-dir is given).
        let dir = match resolve_approved_cwd(&app, cwd)? {
            Some(p) => p,
            None => {
                let d = workspace_dir(&app);
                std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
                d
            }
        };
        // These args come from the app (not the model), but validate the file operands anyway so a
        // compromised caller can't make ffmpeg read/write outside the roots (or reach a URL via an
        // ffmpeg protocol handler): every `-i <input>` and the output path must be approved.
        for operand in ffmpeg_path_operands(&args) {
            if !is_approved_ffmpeg_operand(&app, &dir, operand) {
                return Err(format!("{OUTSIDE_APPROVED_ROOTS} (ffmpeg path: {operand})"));
            }
        }
        let mut cmd = quiet_command(&bin);
        cmd.args(&args).current_dir(&dir).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start ffmpeg: {e}"))?;

        // Drain both pipes concurrently so a large log never blocks the child (same as run_command).
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

        let deadline = Instant::now() + Duration::from_secs(FFMPEG_TIMEOUT_SECS);
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        // Reap the whole tree, not just the shell/ffmpeg parent, so a spawned child
                        // (a GPU-holding process) can't orphan on timeout. kill_tree also wait()s;
                        // the cached status is returned by the wait() below.
                        kill_tree(&mut child);
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
    let out = quiet_command("git")
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

/// The app-managed agent-worktree base (temp_dir/vr-agents) — app-created, so paths under it are
/// trusted for the worktree git_* commands even though they sit OUTSIDE the approved roots.
fn agent_worktree_base() -> PathBuf {
    std::env::temp_dir().join("vr-agents")
}

/// May a git_* command run against `dir`? Allowed when `dir` is inside an approved root (the picked
/// session folder / workspace) OR inside the app's own agent-worktree base — but NOT an arbitrary
/// caller-supplied repo (e.g. the user's real project), which a prompt-injected flow could otherwise
/// commit into, read via `git show`, or have branches deleted from. Canonicalized both sides so
/// `..`/symlinks can't dodge the check.
fn is_git_dir_allowed(app: &AppHandle, dir: &str) -> bool {
    let p = Path::new(dir);
    if is_approved_path(app, p) {
        return true;
    }
    match (std::fs::canonicalize(p), std::fs::canonicalize(agent_worktree_base())) {
        (Ok(real), Ok(base)) => real.starts_with(&base),
        _ => false,
    }
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
    // Shares the cache with `resolve_approved_cwd`'s self-update exemption, so the folder the updater
    // is handed is exactly the one that's allowed to run commands.
    tauri::async_runtime::spawn_blocking(move || Ok(app_repo_root_cached().map(|p| p.to_string_lossy().to_string())))
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
async fn git_commit_all(app: AppHandle, dir: String, message: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_dir_allowed(&app, &dir) {
            return Err(OUTSIDE_APPROVED_ROOTS.to_string());
        }
        git(&dir, &["add", "-A"])?;
        git(&dir, &["commit", "--allow-empty", "-m", &message])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A worktree branch's diff against `base` (name-stat summary + full patch).
#[tauri::command]
async fn git_worktree_diff(app: AppHandle, path: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_dir_allowed(&app, &path) {
            return Err(OUTSIDE_APPROVED_ROOTS.to_string());
        }
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
async fn git_merge_branch(app: AppHandle, repo_dir: String, branch: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_dir_allowed(&app, &repo_dir) {
            return Err(OUTSIDE_APPROVED_ROOTS.to_string());
        }
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
async fn git_conflict_versions(app: AppHandle, repo_dir: String, file: String) -> Result<ConflictVersions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_dir_allowed(&app, &repo_dir) {
            return Err(OUTSIDE_APPROVED_ROOTS.to_string());
        }
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
async fn git_complete_merge(app: AppHandle, repo_dir: String, message: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_dir_allowed(&app, &repo_dir) {
            return Err(OUTSIDE_APPROVED_ROOTS.to_string());
        }
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
async fn git_worktree_remove(app: AppHandle, repo_dir: String, path: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_git_dir_allowed(&app, &repo_dir) {
            return Err(OUTSIDE_APPROVED_ROOTS.to_string());
        }
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

fn ensure_blocking(app: &AppHandle, low_vram: bool, show_console: bool) -> Result<(String, Option<Child>), String> {
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
    let child = install_and_spawn(app, low_vram, show_console)?;
    emit_engine(app, "ready", "Engine ready", Some(100.0));
    Ok((base, Some(child)))
}

/// Is something already listening on `127.0.0.1:port`?
fn port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn install_and_spawn(app: &AppHandle, low_vram: bool, show_console: bool) -> Result<Child, String> {
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
    let mut child = spawn_comfy(&portable, low_vram, show_console)?;

    let base = format!("http://127.0.0.1:{ENGINE_PORT}");
    for _ in 0..180 {
        if health_ok(&base) {
            return Ok(child);
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    // The child is spawned and consuming VRAM even though it never answered — returning without
    // killing it would drop the handle and orphan a running GPU process.
    kill_tree(&mut child);
    Err("The engine did not become ready in time.".into())
}

fn spawn_comfy(portable: &Path, low_vram: bool, show_console: bool) -> Result<Child, String> {
    let python = portable.join("python_embeded").join("python.exe");
    let main_py = portable.join("ComfyUI").join("main.py");
    let mut cmd = command_for(python, show_console);
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
    let child = cmd.spawn().map_err(|e| format!("Failed to start the engine: {e}"))?;
    adopt_child(&child); // dies with the app even on crash/task-kill (see job_object)
    Ok(child)
}

/// Spawn AUTOMATIC1111 from its install `dir` (the folder with webui-user.bat) with `--api` on
/// :7860, then wait for the REST API to answer. We pass `--api --port 7860` via `COMMANDLINE_ARGS`
/// (webui-user.bat forwards that env into launch.py) so the API is on even if the user never edited
/// the bat. Best-effort launcher: if a setup hard-codes its own COMMANDLINE_ARGS, the user keeps the
/// API flag there. Visible/hidden console follows `show_console`. (Reached only on Windows at runtime —
/// `ensure_a1111` guards with `cfg!(windows)` — but the body is plain cross-platform `Command` code, so
/// it isn't `#[cfg]`-gated and compiles on every target.)
fn spawn_a1111(dir: &Path, show_console: bool) -> Result<Child, String> {
    let bat = dir.join("webui-user.bat");
    if !bat.exists() {
        return Err(format!(
            "webui-user.bat not found in {} — point the setting at your AUTOMATIC1111 folder.",
            dir.display()
        ));
    }
    let mut cmd = command_for("cmd", show_console);
    cmd.arg("/c")
        .arg(&bat)
        .env("COMMANDLINE_ARGS", format!("--api --port {A1111_PORT}"))
        .current_dir(dir);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start AUTOMATIC1111: {e}"))?;
    adopt_child(&child); // dies with the app even on crash/task-kill (see job_object)
    let base = format!("http://127.0.0.1:{A1111_PORT}");
    for _ in 0..180 {
        if a1111_health_ok(&base) {
            return Ok(child);
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    // Never answered, but the python tree under `cmd /c` is running and holding VRAM — kill the
    // whole tree before erroring, or the handle drops and the process is orphaned.
    kill_tree(&mut child);
    Err("AUTOMATIC1111 did not become ready in time.".into())
}

/// Is an AUTOMATIC1111 REST API answering at `base`? `/sdapi/v1/sd-models` is 200 only when launched
/// with `--api`, so it doubles as an "API actually enabled" check (unlike ComfyUI's `/system_stats`).
fn a1111_health_ok(base: &str) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .and_then(|c| c.get(format!("{base}/sdapi/v1/sd-models")).send())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
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

/// Where the app's own managed ffmpeg copy lives: `~/VisualReader/ffmpeg`. Kept separate from PATH
/// and any user install so it's never affected by a broken/incomplete third-party ffmpeg elsewhere.
fn ffmpeg_dir(app: &AppHandle) -> PathBuf {
    engine_root(app).join("ffmpeg")
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
    quiet_command("nvidia-smi")
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
        kill_tree(&mut child);
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
    let mut child = spawn_llama(&bin, &gguf)?;
    for _ in 0..120 {
        if llm_health_ok(&root) {
            emit_llm(app, "ready", "Built-in model ready", Some(100.0));
            return Ok((api, Some(child)));
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    // Never answered, but the server is running and may hold VRAM — kill it before erroring,
    // or the dropped handle orphans it.
    kill_tree(&mut child);
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
    let mut cmd = quiet_command(bin);
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
    let child = cmd.spawn().map_err(|e| format!("Failed to start the built-in model: {e}"))?;
    adopt_child(&child); // dies with the app even on crash/task-kill (see job_object)
    Ok(child)
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
    // Process-wide: a broken/incomplete exe (bad PATH entry, half-installed ffmpeg) fails fast with an
    // error code instead of popping a blocking Windows dialog that hangs any probe/spawn until a human
    // clicks OK. Set once, before spawning anything — child processes inherit it.
    #[cfg(target_os = "windows")]
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    }
    // A self-rebuild renames the outgoing binary aside (it can't delete the image it's running from);
    // the next start is the first moment that copy is free. Best-effort, and before anything else so
    // a stale one never sits next to the app for a whole session.
    sweep_superseded_binaries();
    tauri::Builder::default()
        .manage(EngineState::default())
        .manage(LlmState::default())
        .manage(RemoteServerState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_engine,
            ensure_a1111,
            ensure_llm,
            stop_llm,
            restart_app,
            rebuild_desktop_app,
            is_packaged,
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
            run_ffmpeg,
            download_ffmpeg,
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
                // Kill both managed children (image engine + built-in model) so no stray process
                // lingers after the window closes — kill_tree, because A1111's `cmd /c` wrapper
                // (and any engine that forks workers) would survive a single-process kill.
                if let Some(state) = app.try_state::<EngineState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            kill_tree(&mut child);
                        }
                    }
                    // Also kill a separately-launched AUTOMATIC1111, if we started it.
                    if let Ok(mut guard) = state.a1111_child.lock() {
                        if let Some(mut child) = guard.take() {
                            kill_tree(&mut child);
                        }
                    }
                }
                if let Some(state) = app.try_state::<LlmState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            kill_tree(&mut child);
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        ffmpeg_path_operands, guard_fetch_target, is_loopback_host, is_private_host,
    };

    fn guard(url: &str) -> Result<(), String> {
        guard_fetch_target(&reqwest::Url::parse(url).unwrap())
    }

    #[test]
    fn loopback_is_only_loopback() {
        // Loopback: v4 (whole 127/8), v6, IPv4-mapped loopback, localhost family.
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.9.9.9"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(is_loopback_host("::ffff:127.0.0.1"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("app.localhost"));
        // Private but NOT loopback — these must be rejected by the port exemption (S4).
        assert!(!is_loopback_host("192.168.1.50"));
        assert!(!is_loopback_host("10.0.0.7"));
        assert!(!is_loopback_host("169.254.169.254"));
        assert!(!is_loopback_host("printer.local"));
        assert!(!is_loopback_host("8.8.8.8"));
    }

    #[test]
    fn fetch_guard_allows_public_and_loopback_engines() {
        // Public targets always pass.
        assert!(guard("https://en.wikipedia.org/wiki/Rust").is_ok());
        assert!(guard("http://93.184.216.34/").is_ok());
        // The app's own engines on loopback engine ports stay reachable.
        assert!(guard("http://127.0.0.1:8188/prompt").is_ok()); // ComfyUI
        assert!(guard("http://127.0.0.1:7860/sdapi").is_ok()); // A1111
        assert!(guard("http://localhost:11434/api").is_ok()); // Ollama on loopback
    }

    #[test]
    fn fetch_guard_blocks_private_and_lan_engines() {
        // Cloud metadata / router / arbitrary private targets.
        assert!(guard("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(guard("http://192.168.1.1/").is_err());
        // S4: an engine PORT on a private-but-routable LAN host is NOT exempt.
        assert!(guard("http://192.168.1.50:11434/api").is_err());
        assert!(guard("http://10.0.0.7:8188/prompt").is_err());
        // Loopback but a non-engine port is still refused.
        assert!(guard("http://127.0.0.1:22/").is_err());
    }

    #[test]
    fn ffmpeg_operands_are_inputs_and_output() {
        // buildLastFrameArgs shape.
        let last = vec![
            "-y".to_string(), "-sseof".into(), "-0.2".into(), "-i".into(),
            "clips/clip_0.webp".into(), "-frames:v".into(), "1".into(), "clips/frame_0.png".into(),
        ];
        assert_eq!(ffmpeg_path_operands(&last), vec!["clips/clip_0.webp", "clips/frame_0.png"]);
        // buildConcatArgs shape: two inputs + a filter string (must NOT be treated as a path) + output.
        let concat = vec![
            "-y".to_string(), "-i".into(), "a.webp".into(), "-i".into(), "b.mp4".into(),
            "-filter_complex".into(), "[0:v]scale=768:512[v0];[v0]concat=n=1[out]".into(),
            "-map".into(), "[out]".into(), "-pix_fmt".into(), "yuv420p".into(), "final.mp4".into(),
        ];
        assert_eq!(ffmpeg_path_operands(&concat), vec!["a.webp", "b.mp4", "final.mp4"]);
    }


    #[test]
    fn private_hosts_are_classified() {
        // Loopback v4/v6 (bare and URL-bracketed, as reqwest::Url::host_str returns it).
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("127.8.9.10"));
        assert!(is_private_host("::1"));
        assert!(is_private_host("[::1]"));
        // Link-local — the cloud metadata service lives here.
        assert!(is_private_host("169.254.169.254"));
        assert!(is_private_host("fe80::1"));
        // RFC-1918 / ULA / unspecified.
        assert!(is_private_host("10.0.0.7"));
        assert!(is_private_host("172.16.0.1"));
        assert!(is_private_host("192.168.1.1"));
        assert!(is_private_host("fd00::2"));
        assert!(is_private_host("0.0.0.0"));
        // An IPv4 target smuggled as an IPv4-mapped IPv6 literal.
        assert!(is_private_host("::ffff:192.168.0.1"));
        // Local-only hostnames.
        assert!(is_private_host("localhost"));
        assert!(is_private_host("LOCALHOST"));
        assert!(is_private_host("printer.local"));
        assert!(is_private_host("db.corp.internal"));
    }

    #[test]
    fn public_hosts_are_not() {
        assert!(!is_private_host("8.8.8.8"));
        assert!(!is_private_host("93.184.216.34"));
        assert!(!is_private_host("2606:4700::1111"));
        assert!(!is_private_host("example.com"));
        assert!(!is_private_host("en.wikipedia.org"));
        // 172.32.x is just OUTSIDE the 172.16/12 block.
        assert!(!is_private_host("172.32.0.1"));
    }
}
