import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNarrow } from "./useMediaQuery.js";
import { ACCENT_BLUE, DANGER_RED, SUCCESS_GREEN } from "./tokens.js";
import {
  IMAGE_PROVIDERS,
  IMAGE_STYLES,
  catalogEntryForModel,
  resolveModelFamily,
  samplerFor,
  BUNDLED_LLM,
  LOCAL_TEXT_MODELS,
  LOCAL_TEXT_SERVER_DEFAULT_URL,
  LOCAL_TEXT_SERVER_LABEL,
  DEFAULT_LOCAL_TEXT_SERVER,
  TEXT_PROVIDERS,
  LOCAL_IMAGE_MODELS,
  imageModelVramCostGb,
  VIDEO_MODELS,
  videoModelById,
  VIDEO_RENDER_DEFAULTS,
  serverModelVramCostGb,
  defaultLoadedWindow,
  recommendImageModePairings,
  OLLAMA_TEXT_MODELS,
  getImageStyle,
  getProvider,
  ollamaModelMatches,
  qualityProfile,
  resolveAssetName,
  resolveQuality,
  styleLoraDownload,
  comboVramGb,
  combFitsCard,
  RECOMMENDED_WORKER_COMBOS,
  suggestComponents,
  MCP_PRESETS,
  type LocalTextServerId,
  type ProviderInfo,
  type VideoLora,
} from "@visual-reader/core";

/**
 * Settings: pick a text provider and an image provider independently, each with
 * its own remembered key, plus the local-model picker when "On my computer" is
 * chosen. Keys are handed to the host to encrypt + persist. Provider lists come
 * from the core catalog so the UI and the engine wiring never drift.
 */

export type TextProviderId = "claude" | "gemini" | "openai" | "local";
export type ImageProviderId = "flux" | "gemini" | "openai" | "local";
/** Which local engine HTTP API to speak when the image provider is "local". Both ComfyUI and
 * AUTOMATIC1111 can be either the app's own auto-launched process or a server the user runs
 * themselves — that distinction is an implementation detail (see `startActiveLocalEngine`), not a
 * separate setting. */
export type LocalBackendId = "comfyui" | "a1111";

/** Default localhost URL for each local engine, used as the field placeholder. */
export const LOCAL_ENGINE_DEFAULT_URL: Record<LocalBackendId, string> = {
  comfyui: "http://127.0.0.1:8188",
  a1111: "http://127.0.0.1:7860",
};

export const LOCAL_BACKEND_LABEL: Record<LocalBackendId, string> = {
  a1111: "AUTOMATIC1111",
  comfyui: "ComfyUI",
};

/** ComfyUI sampler / scheduler choices offered in Advanced (blank = per-model default). */
const SAMPLER_OPTIONS = [
  "euler",
  "euler_ancestral",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "res_multistep",
  "uni_pc",
] as const;
const SCHEDULER_OPTIONS = ["simple", "normal", "karras", "sgm_uniform", "beta"] as const;

/** One video model family's render-param overrides (size / length / sampler). Structurally a
 * VideoRenderParams; stored per `kind` under ReaderSettings.videoParams. `shift` is Wan-only; `highRes`
 * and `audio` are LTX-2-only — the UI shows only the relevant fields for the selected model. */
export interface VideoRenderSettings {
  frames?: number;
  fps?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  shift?: number;
  highRes?: boolean;
  audio?: boolean;
}

export interface ReaderSettings {
  textProvider: TextProviderId;
  imageProvider: ImageProviderId;
  /** Per-provider API keys, keyed by provider id (e.g. keys.claude, keys.flux). */
  keys: Record<string, string>;
  /** Chosen local image checkpoint. */
  localModel?: string;
  /** On-device text model id (WebLLM) when textProvider is "local". */
  localTextModel?: string;
  /** Under textProvider "local": on-device (WebGPU), a local server you run, or the
   * "bundled" model the desktop app ships and auto-launches (see BUNDLED_LLM). */
  localTextBackend?: "webgpu" | "server" | "bundled";
  /** Which local LLM server kind (sets the default URL/label), for the server path. */
  localTextServer?: LocalTextServerId;
  /** Base URL of the local LLM server you run yourself (persisted). */
  localServerTextUrl?: string;
  /** Chosen model id reported by the local LLM server. */
  localServerTextModel?: string;
  /** Art style id applied to every illustration (see catalog IMAGE_STYLES). */
  imageStyle?: string;
  /**
   * Manual style-LoRA choice for the local engine, overriding the style's automatic
   * mapping: "" / undefined = automatic, "none" = prompt-only (no LoRA), or an installed
   * LoRA filename to force that one. Lets you use any LoRA in the engine's folder.
   */
  styleLoraOverride?: string;
  /**
   * Force the local image model family for prompt formatting when auto-detection
   * from the checkpoint name is wrong. "auto" (default) detects it. SD families get
   * quality tags + a negative prompt; Flux gets plain natural language.
   */
  imageModelFamily?: "auto" | "sd15" | "sdxl" | "flux" | "flux2" | "zimage" | "qwenimage" | "hidream";
  /**
   * How many pages share one illustration: any positive number, or a whole
   * "chapter". A group never crosses a chapter boundary, so a number larger than
   * a chapter's page count just yields one image for that chapter. Fewer pages →
   * frequent, draftier images; more → rarer, higher-quality. Default 3.
   */
  pagesPerImage?: number | "chapter";
  /**
   * Image quality: "auto" scales with pagesPerImage; or pick a level explicitly.
   * Higher levels use more steps + resolution (slower). Default "auto".
   */
  imageQuality?: "auto" | "draft" | "standard" | "high" | "ultra";
  /**
   * Canvas orientation: "square" (1:1, default), "portrait" (2:3), or "landscape" (3:2).
   * Portrait/landscape keep the same pixel area as the square at that quality level.
   */
  aspectRatio?: "square" | "portrait" | "landscape";
  /**
   * Reader-only multi-panel comic view: compose this many consecutive unit images into
   * one comic-page grid (chapter-aware). 1 (default) = today's single image; 4/6/9 grids.
   */
  panelsPerView?: 1 | 4 | 6 | 9;
  /**
   * Prompt the model to draw a SINGLE image laid out as a multi-panel comic page (comic/
   * manga styles only). Independent of `panelsPerView`. Off by default.
   */
  drawAsComicPage?: boolean;
  /**
   * When to start illustrating: "book" reads the whole book first so prompts have
   * full context (best images, slower start); "chapter" starts as each chapter is
   * analysed (faster first image). Default "book".
   */
  illustrateAfter?: "book" | "chapter";
  /** Manual override of a split-file model's text-encoder / VAE file (Flux.2 etc.) when
   * auto-detection picks the wrong one. Exact filename as the engine lists it; "" = auto. */
  localTextEncoder?: string;
  localVae?: string;
  /** Per-model memory of the text-encoder + VAE combo last used WITH each image model (keyed by the
   * model's filename). When a model is selected, its remembered combo is restored into
   * localTextEncoder/localVae (or "" = auto if none) — so switching between e.g. Flux.2 Klein and
   * Z-Image doesn't leave the wrong encoder/VAE selected from the previous model. */
  localComponentsByModel?: Record<string, { textEncoder?: string; vae?: string }>;
  /** Advanced manual sampler overrides for local ComfyUI: step count and CFG/guidance
   * scale. Unset/undefined = the family/catalog default. */
  localSteps?: number | undefined;
  localCfg?: number | undefined;
  /** Low-VRAM mode (local ComfyUI): fp8 UNET loading + (managed engine) --lowvram so the
   * heavy text encoder offloads to CPU. Shrinks VRAM/RAM for Flux.2/Z-Image/Qwen-Image. */
  lowVram?: boolean;
  /** Hi-Res two-pass (local ComfyUI): render at the family's native-safe size, then upscale
   * the latent ~2× and refine for a larger, more detailed image without subject duplication. */
  hires?: boolean;
  /** Advanced manual sampler / scheduler choice for local ComfyUI; "" = per-model default. */
  localSampler?: string;
  localScheduler?: string;
  /**
   * Detected primary-GPU VRAM in MB (desktop only; transient — set at runtime, not
   * persisted). Caps Auto image-quality to a canvas the card can render.
   */
  gpuVramMb?: number;
  /**
   * Scientific sources (technical books). `searchEngineId` is the Programmable Search
   * Engine id ("cx") paired with a Custom Search API key stored as `keys.search`;
   * together they enable retrieving REAL figures/diagrams before generating one.
   * `groundFacts` grounds Gemini's technical analysis in Google Search (same Gemini key).
   */
  searchEngineId?: string;
  groundFacts?: boolean;
  /**
   * Reading-companion chat overrides — the chat can run on a DIFFERENT provider than
   * the book analysis. Default "local" (free, private); "default" follows the book's
   * text/image provider. When a chat override isn't usable (local server not
   * connected, no key), the chat falls back to the book's provider rather than mock.
   */
  chatTextProvider?: "default" | TextProviderId;
  /** Chat-only local model (Ollama id or WebLLM id, per the active local backend). */
  chatLocalModel?: string;
  chatImageProvider?: "default" | ImageProviderId;
  /**
   * The context window (tokens) the LOCAL text server actually loads — overrides
   * auto-detection. Needed when raised via OLLAMA_CONTEXT_LENGTH (invisible to any
   * API) or for LM Studio/WebLLM (no query API). Unset = auto: the model's
   * Modelfile num_ctx when Ollama reports one, else a conservative 4096.
   */
  localContextTokens?: number;
  /**
   * Per-OLLAMA-model context window to LOAD with (keyed by model id). Unlike `localContextTokens`
   * (which only sizes OUR prompt), this is SENT to Ollama via its native `/api/chat` as
   * `options.num_ctx`, so the model loads at this window and its KV cache fits the GPU — the in-app
   * lever for the "256k default spills a dense model to the CPU" problem. Ollama-only; mirrors the
   * `localComponentsByModel` per-model map.
   */
  localContextByModel?: Record<string, number>;
  /** Thinking level for local REASONING models (Qwen3, DeepSeek-R1, …) — sent as the OpenAI
   * `reasoning_effort` on each chat: "off" turns the hidden reasoning pass off (faster), low/medium/
   * high scale it. "auto"/unset leaves the model's default. Models/servers that don't support it
   * ignore the field. */
  localThinkingEffort?: "auto" | "off" | "low" | "medium" | "high";
  /** Which local engine API images render on: ComfyUI or AUTOMATIC1111. Whether that engine is the
   * app's own auto-launched process or a server you run yourself is decided automatically (see
   * `startActiveLocalEngine` in App.tsx), not a separate setting. */
  localBackend?: LocalBackendId;
  /** Base URL of a local engine you run yourself (persisted). Mirrors the last-used URL for the
   * currently-selected `localBackend`; the full per-backend memory lives in `localServerUrlByBackend`. */
  localServerUrl?: string;
  /** Last-used server URL for EACH backend, so switching the ComfyUI/A1111 dropdown restores the URL
   * you last entered for it (you don't retype it). Keyed by backend id. */
  localServerUrlByBackend?: Partial<Record<LocalBackendId, string>>;
  /** Desktop only: the AUTOMATIC1111 install folder (the one containing webui-user.bat). When set and
   * A1111 is the chosen image backend, the app starts A1111 with --api on :7860 if it isn't already up —
   * so it can run alongside the managed ComfyUI (images on A1111, video on ComfyUI). Empty = connect-only. */
  a1111Path?: string;
  /** Desktop only: spawn the ComfyUI/A1111 engines with a VISIBLE console window so you can watch
   * generation logs outside the app. Default off (headless). Takes effect at the next engine start. */
  showEngineConsole?: boolean;
  /** Transient: the API the CURRENTLY-ACTIVE engine speaks (set by engine resolution alongside
   * engineBaseUrl; "comfyui" for the managed engine). Not persisted. The provider reads this so a
   * fallback to the managed ComfyUI talks ComfyUI even when localBackend is "a1111". */
  engineBackend?: LocalBackendId;
  /**
   * "One API" native mode (opt-in): when the same vendor (Gemini/OpenAI) drives both
   * text and images, render through that vendor's MULTIMODAL endpoint so character
   * reference photos condition cloud renders. Only takes effect when the slots match.
   */
  nativeIllustration?: boolean;
  /** Experimental: under native mode, let the model read the passage and draw it in one
   * step (passage text → image) instead of rendering the pre-written scene prompt. */
  nativeOneShot?: boolean;
  /** Advanced: pin a specific cloud image model id (e.g. a newer Gemini image model).
   * Empty/unset = auto-select the best model the key can access. */
  imageModel?: string;
  /** True once the first-run wizard has been completed. */
  configured?: boolean;
  /**
   * Mature mode (adults only): turn off the app's content filtering so books with
   * explicit sexual content, graphic violence or other adult themes are illustrated
   * and discussed faithfully. Relaxes the adjustable provider safety knobs (Gemini /
   * Flux) and tells the models not to sanitise. Off by default. Providers without an
   * adjustable knob (Claude / OpenAI) still apply their own policies.
   */
  allowMature?: boolean;
  /**
   * Desktop only, OFF by default: let the chat assistant propose shell commands to
   * run in its workspace (install deps, run tests, execute code it wrote). Even
   * when on, EVERY command is shown and must be approved before it runs. Enables
   * the test-as-you-go coding loop.
   */
  allowCommands?: boolean;
  /** Desktop + requires allowCommands. When on, the assistant writes files (write_file) and runs
   * commands WITHOUT a per-action approval click — the hands-free write→run-tests→fix loop, scoped
   * to the workspace folder. Off by default; lowers the per-command approval guard, so it only
   * applies to the workspace and the model is told never to act on instructions from fetched text. */
  autonomousWorkspace?: boolean;
  /** Windows shell for run_command: "cmd" (default) or "powershell". Ignored on macOS/Linux
   * (always sh). Lets PowerShell-centric workflows run pwsh cmdlets without the `powershell -Command` wrapper. */
  commandShell?: "cmd" | "powershell";
  /** Desktop + requires allowCommands. Advertise the delegate_coding_task tool: hand a hard, multi-file
   * coding job to an EXTERNAL coding agent running headless against the same local model. Off by
   * default; the model only sees the tool when this is on, and the runtime checks the agent is installed. */
  delegateCoding?: boolean;
  /** Which external coding agent delegate_coding_task drives: "aider" (default) or "codex" (backup). */
  codingAgentBackend?: "aider" | "codex";
  /** Selected image-to-video model id (see VIDEO_MODELS); undefined → the default (Wan 2.2). */
  videoModel?: string;
  /** Per-file overrides for the image-to-video model — swap a component (a specific checkpoint / text
   * encoder / VAE / LoRA) or point at a renamed file to fix a broken download. Blank → the catalog default.
   * A superset of every family's filenames; only the selected model's fields are shown/used. */
  videoFiles?: { highNoise?: string; lowNoise?: string; textEncoder?: string; vae?: string; checkpoint?: string; distilledLora?: string; upscaler?: string; loraHigh?: string; loraLow?: string; ltxLoras?: VideoLora[] };
  /** Image-to-video render-param overrides (the graph's size / length / sampler choices), kept PER MODEL
   * family — Wan and LTX-2 want different lengths/fps (Wan ~16fps/4n+1, LTX ~24fps/8n+1), so each `kind`
   * stores its own set and switching models doesn't clobber the other's frames/fps. Blank → catalog defaults. */
  videoParams?: { "wan-i2v"?: VideoRenderSettings; "ltx2-i2v"?: VideoRenderSettings };
  /** Parallel coding agents: let the manager model auto-resolve a merge conflict between agent
   * branches (validated, then committed — or aborted if it can't). Default on. */
  autoResolveConflicts?: boolean;
  /** Enable GitHub repo work using your OWN local `gh` login (gh auth login) instead
   * of a stored token — so the assistant's GitHub mode turns on without `keys.github`. */
  githubLocalAuth?: boolean;
  /** Let the Task Assistant schedule + prep automatically (create/update Google Tasks
   * & Calendar reminders, run inbox scans, research, draft docs) without asking each
   * time. Never submits forms, pays, or sends. Default off. */
  allowTaskAutomation?: boolean;
  /** Let the assistant follow its own curiosity while you're idle: every so often it researches
   * something on the web and writes it up, in a chat of its own (✨ Creative). Read-and-write-a-document
   * only — it can NEVER run commands, touch files, or send anything, whatever the other permissions
   * say. Default off. */
  allowCreativeIdle?: boolean;
  /** ON by default (when Google is connected): while the desktop app is open and you're idle,
   * periodically scan recent email + the calendar for tasks worth planning, and pre-plan them
   * into the 📋 Tasks panel (research only — no external writes). Set false to stop background scans. */
  autoTaskScan?: boolean;
  /** FOCUS items for the email scan — senders/subjects/keywords (one per line) the scan always
   * watches and favours, beyond the default recent/travel queries. Each line: an email address,
   * a Gmail operator (from:/subject:/label:…), or a bare keyword (matched in subject or sender). */
  scanFocus?: string;
  /** How many UNPLANNED tasks each idle background sweep plans (deep research, sequential). 0 =
   * never auto-plan in the background (surface only; plan via the per-task button). Default 2.
   * Sweeps never overlap and yield when you return, so this is a throughput knob, not a timeout. */
  backgroundPlanRate?: number;
  /** How many read-only sub-agents the assistant's `spawn_agents` fan-out runs at once. Sized for a
   * single local GPU (default 2 — they share it); raise it for cloud providers or a batched local
   * server where concurrent requests genuinely parallelize. 1 = effectively sequential. */
  agentConcurrency?: number;
  /** Advanced: an OpenAI-compatible endpoint (e.g. a vLLM server) + model id for the assistant's
   * parallel SUB-AGENTS only. When set, sub-agents run on this smaller/faster "worker" model while
   * the main model handles the hard reasoning — the tier split that lets one GPU do real parallel
   * sub-agent work behind a batching server. Falls back to the main model when unset/unreachable. */
  subAgentServerUrl?: string;
  subAgentModel?: string;
  /** OFF by default: advertise the parallel sub-agent fan-out tools (delegate / spawn_agents) in
   * chat. Off keeps a one-on-one chat lean (these are orchestration primitives most chats don't
   * need); a configured sub-agent backend (subAgentServerUrl/subAgentModel) auto-enables them too. */
  allowSubAgents?: boolean;
  /** App-managed steps (reliable multi-step). When ON, a multi-step chat task runs through the app's
   * workflow executor: the model compiles the plan, then the APP hands it one step at a time and ticks
   * each off from OBSERVED evidence (a render, a saved file, a reply) — the model never calls
   * complete_step. Far more reliable across models (especially weak local ones). Auto-enabled for a
   * weak/local chat model; OFF otherwise (the model drives its own checklist). */
  appManagedSteps?: boolean;
  /** OFF by default: advertise the keyless markets tools (stock_quote, market_analysis, price alerts,
   * trading_script) in chat. Off so a non-trading chat isn't carrying the finance suite; connecting
   * Schwab or the TradingView bridge auto-enables them regardless. */
  allowMarkets?: boolean;
  /** Desktop only, OFF by default: let the assistant drive your TradingView Desktop chart
   * (set symbol, add studies, read state, inject Pine) via its DevTools bridge. Chart-only
   * — it never trades. Requires TradingView Desktop launched with remote debugging. */
  allowTradingViewBridge?: boolean;
  /** OFF by default: after a multi-step task the buddy distills a reusable "skill" (playbook)
   * and saves it so it does that kind of task better next time. Reviewable in the Skills panel. */
  autoLearnSkills?: boolean;
  /** ON by default: let the assistant PULL FILES IN on its own — read an email attachment, or read
   * a local file it found — as prep, without asking each time (reading is safe "gather" work). */
  autoPullFiles?: boolean;
  /** OFF by default (desktop): let the assistant SEARCH your computer for relevant files on its own
   * while planning, without the per-session approval prompt. Reading is still bounded; it never runs
   * commands. Turn on so the agent can fully plan from documents you already have. */
  autonomousFileSearch?: boolean;
  /** OFF by default: FULL AUTONOMY — the assistant runs its medium-risk actions (generate an image,
   * take a screenshot, search your files) without asking. The hard danger floor still always asks:
   * it NEVER runs a command/executable or places a trade on its own (see ALWAYS_GATED_TOOLS). */
  fullAutonomy?: boolean;
  /** OFF by default: drive the desktop assistant from your phone via Google Tasks — add a to-do
   * starting "VR:" and the app (while open) runs it and writes the answer back. Needs Google. */
  remoteBus?: boolean;
  /** Privacy / incognito for the phone link. The engine still runs on the desktop, but the remote
   * session is NOT persisted (no chat history or memory saved) and the desktop's own screen is
   * curtained so a bystander at the desktop can't see what's being done remotely. Toggle from either
   * side; OFF by default. */
  incognitoRemote?: boolean;
  /** Internet hostname for the phone link via a tunnel (e.g. a Cloudflare named tunnel
   * `vr.example.app`). When set, the Link-a-phone panel also shows an `https://<host>/#vrlink=…`
   * address that works from anywhere (off Wi-Fi), gated by Cloudflare Access in front of the tunnel.
   * Empty = LAN-only. */
  remoteLinkHost?: string;
  /** Optional MCP servers the buddy can call — one per line: `name https://host/mcp`. */
  mcpServers?: string;
  /** Transient: base URL of the ACTIVE local engine (the app-managed one, or the user's server, or
   * the fallback that won — set by engine resolution; not persisted). */
  engineBaseUrl?: string;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  textProvider: "claude",
  imageProvider: "flux",
  keys: {},
};

/**
 * Select a local image model AND restore the text-encoder + VAE combo last used with it (from
 * localComponentsByModel), or "" = auto when none is remembered. Shared by the Settings model
 * picker and the app's auto-select paths (download/connect) so switching models never leaves the
 * previous model's encoder/VAE selected. Pure — returns the next settings.
 */
/** Backup / Restore: export the reader's data (library, chats, tasks, memories, skills + settings)
 * to a file, and import it back — for moving everything between environments (dev ↔ packaged use
 * separate storage) or just keeping a backup. Restore reloads so the app picks up the data. */
function BackupRow({
  onExport,
  onImport,
}: {
  onExport: () => Promise<void>;
  onImport: (file: File) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const doExport = async (): Promise<void> => {
    setBusy(true);
    setMsg("");
    try {
      await onExport();
      setMsg("Backup saved.");
    } catch (e) {
      setMsg(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const doImport = async (file: File): Promise<void> => {
    setBusy(true);
    setMsg("Restoring…");
    const r = await onImport(file);
    if (r.ok) {
      setMsg("Restored — reloading…");
      setTimeout(() => location.reload(), 800);
    } else {
      setMsg(`Restore failed: ${r.error ?? "unknown error"}`);
      setBusy(false);
    }
  };
  return (
    <div style={{ ...rowStyle, marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
      <span>💾 Backup &amp; restore</span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button style={buttonStyle} disabled={busy} onClick={() => void doExport()}>
          Export backup
        </button>
        <button style={buttonStyle} disabled={busy} onClick={() => fileRef.current?.click()}>
          Restore from file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImport(f);
            e.target.value = "";
          }}
        />
        {msg && <span style={{ fontSize: 12, opacity: 0.75 }}>{msg}</span>}
      </div>
      <span style={{ opacity: 0.55, fontSize: 11 }}>
        Moves your library, chats, tasks, memories &amp; skills (and settings) between installs — e.g. from the
        dev build to the packaged app. API keys aren&apos;t included (re-enter them after restoring).
      </span>
    </div>
  );
}

/** In-app "Software update": one button that pulls + rebuilds + reloads, with a live status line. */
function SoftwareUpdateRow({
  onUpdate,
  onRestart,
}: {
  onUpdate: (
    onProgress: (msg: string) => void,
  ) => Promise<{ status: "uptodate" | "updated" | "needs-restart" | "error"; message: string }>;
  /** Relaunch the app — surfaced as a "Restart now" button once an update needs a restart. */
  onRestart?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const [result, setResult] = useState<{ status: string; message: string } | null>(null);
  const run = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    setLine("Starting…");
    try {
      setResult(await onUpdate(setLine));
    } catch (e) {
      setResult({ status: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setLine("");
    }
  };
  const color =
    result?.status === "error" ? "#e0716f" : result?.status === "needs-restart" ? "#e0b050" : SUCCESS_GREEN;
  return (
    <div style={{ ...rowStyle, borderBottom: "1px solid rgba(255,255,255,0.1)", paddingBottom: 10, marginBottom: 2 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span>⬆ Software update</span>
        <button style={buttonStyle} disabled={busy} onClick={() => void run()}>
          {busy ? "Updating…" : "Check & install"}
        </button>
      </div>
      {busy && line ? (
        <span style={{ opacity: 0.75, fontSize: 12 }}>{line}</span>
      ) : result ? (
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color }}>{result.message}</span>
          {onRestart && (result.status === "needs-restart" || result.status === "updated") && (
            <button style={buttonStyle} onClick={() => onRestart()} title="Relaunch Visual Reader to finish the update">
              ↻ Restart now
            </button>
          )}
        </span>
      ) : (
        <span style={{ opacity: 0.55, fontSize: 11 }}>
          Pulls the latest version, rebuilds, and reloads. A core update will ask you to fully restart.
        </span>
      )}
    </div>
  );
}

export function applyLocalModelComponents(s: ReaderSettings, model: string): ReaderSettings {
  const remembered = s.localComponentsByModel?.[model];
  return {
    ...s,
    localModel: model,
    localTextEncoder: remembered?.textEncoder ?? "",
    localVae: remembered?.vae ?? "",
  };
}

/** A downloaded local model reported by the running engine. */
export interface InstalledModel {
  id: string;
  label: string;
}

export interface SettingsPanelProps {
  value: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
  /** The running bundle's git sha + build time, shown at the top of the panel. The app self-updates,
   * so a stale build and an unfixed bug look identical from outside; this is what tells them apart. */
  buildStamp?: string;
  /** What the CHECKOUT is at (desktop). Shown only when it differs from the running bundle — that
   * gap is the difference between "the update didn't download" and "it downloaded but this page is
   * still the old one", which are otherwise indistinguishable and have different fixes. */
  checkoutSha?: string;
  /** Start an idle-creative run immediately, ignoring the idle/gap waits. Without a way to trigger it
   * on demand the only test is to leave the app alone for ten minutes and hope — so "it never ran",
   * "it ran and produced nothing" and "the setting isn't on" are indistinguishable. */
  onExploreNow?: () => void;
  /** When the last creative run started ("" if it hasn't since launch) — the other half of that. */
  lastCreativeRun?: string;
  /** True when running inside the desktop app (enables the local GPU engine). */
  isDesktop?: boolean;
  /** True when this is a phone LINKED to a desktop: it has no engine of its own, but its edits and
   * model picks are relayed to the desktop, so it gets the desktop's pickers (downloads stay
   * desktop-side). The desktop's inventory is mirrored in via installedModels/etc. */
  remote?: boolean;
  /** Models the running engine has downloaded. */
  installedModels?: InstalledModel[];
  /** Text-encoder files the local engine exposes (for the split-file dropdown). */
  installedTextEncoders?: string[];
  /** VAE files the local engine exposes (for the split-file dropdown). */
  installedVaes?: string[];
  /** Wan diffusion models (UNETLoader enum), for the video file dropdowns. */
  installedDiffusionModels?: string[];
  /** LTX 2× upscalers (LatentUpscaleModelLoader enum). */
  installedUpscalers?: string[];
  /** LTX Gemma text encoders (LTXAVTextEncoderLoader enum). */
  installedLtxTextEncoders?: string[];
  /** Start downloading a curated model; desktop only. */
  onDownloadModel?: (id: string) => void;
  /** Download a checkpoint from a pasted URL into the managed engine. */
  onDownloadModelUrl?: (url: string) => void;
  /** Download the selected image-to-video model's files into ComfyUI's subfolders (desktop). */
  onDownloadVideoModel?: (id: string) => void;
  /** Download a self-contained ffmpeg build (Windows) into the app's own managed folder — needed for
   * long-form video stitching, without depending on PATH/winget (desktop). Progress rides
   * `downloadProgress.ffmpeg`, same as a catalog model. */
  onDownloadFfmpeg?: () => void;
  /** Download progress 0..100 per catalog model/LoRA id (desktop). */
  downloadProgress?: Record<string, number>;
  /** Which component file of a split-file model is downloading (per catalog id). */
  downloadStage?: Record<string, string>;
  /** Status line for the app-managed engine setup (desktop), e.g. "Starting…". */
  engineStatus?: string;
  /** LoRA filenames installed in the managed engine (style auto-download). */
  installedLoras?: string[];
  /** Detected base-model family per installed LoRA filename (desktop), for mismatch flags. */
  loraFamilies?: Record<string, string>;
  /** Download the matching LoRA for a style; optional URL overrides the catalog. */
  onDownloadStyleLora?: (styleId: string, url?: string) => void;
  /** Whether Google (Gmail/Calendar/Tasks) is connected, and as which account. */
  googleConnected?: boolean;
  googleEmail?: string;
  /** Run the Google OAuth consent flow (desktop); returns the outcome. */
  onConnectGoogle?: () => Promise<{ ok: boolean; email?: string; error?: string }>;
  /** Forget the stored Google tokens. */
  onDisconnectGoogle?: () => void;
  /** Connect to a self-hosted engine and load its model list (browser path). */
  onConnectLocalServer?: (backend: LocalBackendId, url: string) => void;
  /** True while a connection attempt is in flight. */
  connectingLocal?: boolean;
  /** Models reported by the local LLM text server (separate from image models). */
  textModels?: InstalledModel[];
  /** The selected Ollama model's real context window (Modelfile num_ctx + arch max) so the per-model
   * field shows the actual default/ceiling instead of a blank "uses Ollama default". */
  textModelContext?: { loaded?: number; max?: number };
  /** Connect to a local LLM server and load its model list. */
  onConnectLocalTextServer?: (server: LocalTextServerId, url: string) => void;
  /** True while a local-text-server connection attempt is in flight. */
  connectingLocalText?: boolean;
  /** Download a text model INTO Ollama (`/api/pull`) — no terminal needed. */
  onPullTextModel?: (model: string) => void;
  /** Live pull progress per Ollama model id. */
  pullProgress?: Record<string, { status: string; percent?: number }>;
  /** Ping the sub-agent "worker" endpoint and report whether it's reachable + which models it serves. */
  onTestSubAgentEndpoint?: (url: string) => Promise<{ ok: boolean; models?: string[]; error?: string }>;
  /** In-app software update (desktop): pull + rebuild + reload. Reports progress; resolves with the
   * outcome. Absent on the web / older builds (the section is hidden). */
  onSoftwareUpdate?: (
    onProgress: (msg: string) => void,
  ) => Promise<{ status: "uptodate" | "updated" | "needs-restart" | "error"; message: string }>;
  /** Fully relaunch the desktop app (Settings → Restart app). Absent on the web (button hidden). */
  onRestartApp?: () => void;
  /** Export all reader data (library, chats, tasks, memories, skills + settings) to a backup file. */
  onExportData?: () => Promise<void>;
  /** Restore a backup file produced by onExportData (merges it in); resolves with ok/error. */
  onImportData?: (file: File) => Promise<{ ok: boolean; error?: string }>;
}

export function SettingsPanel({
  value,
  onChange,
  buildStamp,
  checkoutSha,
  onExploreNow,
  lastCreativeRun,
  isDesktop = false,
  remote = false,
  installedModels = [],
  installedTextEncoders = [],
  installedVaes = [],
  installedDiffusionModels = [],
  installedUpscalers = [],
  installedLtxTextEncoders = [],
  onDownloadModel,
  onDownloadModelUrl,
  onDownloadVideoModel,
  onDownloadFfmpeg,
  downloadProgress = {},
  downloadStage = {},
  engineStatus = "",
  installedLoras = [],
  loraFamilies = {},
  onDownloadStyleLora,
  onConnectLocalServer,
  connectingLocal = false,
  textModels = [],
  textModelContext,
  onConnectLocalTextServer,
  connectingLocalText = false,
  onPullTextModel,
  pullProgress = {},
  onTestSubAgentEndpoint,
  googleConnected,
  googleEmail,
  onConnectGoogle,
  onDisconnectGoogle,
  onSoftwareUpdate,
  onRestartApp,
  onExportData,
  onImportData,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  // Escape closes the floating panel like the ✕ button — it isn't a centered modal
  // (no ModalShell), so it needs its own keyboard dismissal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  // Phone-width: the floating panel goes edge-to-edge instead of a 340px strip.
  const narrow = useNarrow(520);
  // Settings filter: typing hides non-matching groups and force-opens matches.
  const [query, setQuery] = useState("");
  // Worker-endpoint connection test: status for the "Test" button under the sub-agent settings.
  const [subTest, setSubTest] = useState<{ state: "idle" | "testing" | "ok" | "err"; msg?: string }>({ state: "idle" });
  const set = (patch: Partial<ReaderSettings>) => onChange({ ...value, ...patch });
  const setKey = (id: string, key: string) => set({ keys: { ...value.keys, [id]: key } });

  // Per-model text-encoder/VAE memory. `selectLocalModel` switches the model AND restores the combo
  // last used with it (or "" = auto). `setComponent` updates the current pick AND remembers it for
  // the active model, so returning to that model later restores the same encoder/VAE.
  const selectLocalModel = (id: string): void => onChange(applyLocalModelComponents(value, id));
  const setComponent = (patch: { textEncoder?: string; vae?: string }): void => {
    const model = value.localModel;
    const fieldPatch: Partial<ReaderSettings> = {
      ...(patch.textEncoder !== undefined ? { localTextEncoder: patch.textEncoder } : {}),
      ...(patch.vae !== undefined ? { localVae: patch.vae } : {}),
    };
    if (model) {
      const prev = value.localComponentsByModel ?? {};
      fieldPatch.localComponentsByModel = { ...prev, [model]: { ...(prev[model] ?? {}), ...patch } };
    }
    set(fieldPatch);
  };

  const textInfo = getProvider("text", value.textProvider);
  const imageInfo = getProvider("image", value.imageProvider);

  // ONE canonical local-text-backend fallback — the desktop AND a linked phone (which mirrors the
  // desktop's engine) default to the bundled model, plain web to on-device WebGPU. Several hand-rolled
  // copies of this expression had drifted (one omitted `remote`, one defaulted to webgpu everywhere),
  // so the panel could list the wrong model set for the actually-active backend.
  const textBackend = value.localTextBackend ?? (isDesktop || remote ? "bundled" : "webgpu");

  // Resolved per-model sampler defaults, surfaced in the Advanced "auto = …" placeholders
  // so the user can see what blank actually does (mirrors the backend's resolution order:
  // catalog entry's own sampler → family default).
  const localFamily = resolveModelFamily(
    value.imageModelFamily && value.imageModelFamily !== "auto" ? value.imageModelFamily : undefined,
    value.localModel ?? "",
  );
  const localBaseSampler = catalogEntryForModel(value.localModel ?? "")?.sampler ?? samplerFor(localFamily);
  const defaultCfg = localBaseSampler.guidance ?? localBaseSampler.cfg;
  // Which text encoder + VAE the chosen image model wants, matched against the files the engine
  // actually has — drives the split-file dropdowns + the "use this one" hint.
  const componentHint = suggestComponents(value.localModel ?? "", localFamily, {
    textEncoders: installedTextEncoders,
    vaes: installedVaes,
  });

  return (
    <div style={{ fontSize: 13, position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} style={buttonStyle}>
        {open ? "Hide settings" : "Settings"}
      </button>
      {open && portalled(
        <div style={narrow ? { ...panelStyle, left: 8, width: "auto" } : panelStyle}>
          {/* The panel floats at the viewport's top-right, over the Settings button —
              so it needs its OWN always-visible close control. On a narrow screen it spans
              edge-to-edge instead of a cramped 340px strip. */}
          <div style={closeRowStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong>Settings</strong>
              <button onClick={() => setOpen(false)} style={closeButtonStyle} aria-label="Close settings">
                ✕ Close
              </button>
            </div>
            {/* Which bundle is actually running. It sits ABOVE the search box and outside the
                filterable sections on purpose: it's needed exactly when something seems missing,
                which is when you'd never think to search for it. Selectable so it can be quoted. */}
            {buildStamp ? (
              <div
                style={{
                  fontSize: 11,
                  opacity: 0.55,
                  marginTop: 2,
                  userSelect: "text",
                  wordBreak: "break-word",
                }}
                title="The build this app is running. Quote it when reporting a problem — it tells a stale build from a real bug."
              >
                Build {buildStamp}
              </div>
            ) : null}
            {/* The running bundle is NOT what the checkout is at. Almost always: the code was pulled
                and built, but this page is still the one loaded before that. Said here because the
                two numbers otherwise only differ somewhere the reader can't see, and the fix depends
                on which way they differ. */}
            {buildStamp && checkoutSha && !buildStamp.startsWith(checkoutSha) ? (
              <div style={{ fontSize: 11, color: "#ffcf8b", marginTop: 3, userSelect: "text" }}>
                Your files are at {checkoutSha}, but this window is still running the build above.
                Reload the app to catch up — if it still doesn't match after that, fully close and
                reopen it (desktop.bat).
              </div>
            ) : null}
            <input
              type="search"
              placeholder="Find a setting… (style, key, context, chat, quality)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={searchStyle}
              aria-label="Filter settings"
            />
          </div>
          {onSoftwareUpdate && (
            <SoftwareUpdateRow onUpdate={onSoftwareUpdate} {...(onRestartApp ? { onRestart: onRestartApp } : {})} />
          )}
          {onExportData && onImportData && <BackupRow onExport={onExportData} onImport={onImportData} />}
          {onRestartApp && (
            <div
              style={{
                ...rowStyle,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                borderBottom: "1px solid rgba(255,255,255,0.1)",
                paddingBottom: 10,
                marginBottom: 2,
              }}
            >
              <span>↻ Restart app</span>
              <button
                style={buttonStyle}
                title="Fully relaunch the app — recovers a stuck engine or finishes a core update"
                onClick={() => {
                  if (window.confirm("Restart Visual Reader now?")) onRestartApp();
                }}
              >
                Restart
              </button>
            </div>
          )}
          {/* Five top-level SECTIONS. Each group below carries a CSS `order` (11/21/31/41/51) that
              places it under the matching header — so the panel reads as five categories without
              physically reordering the JSX. Headers hide during a search (groups then show flat). */}
          <SectionHeader q={query} title="🧠 LLM" order={10} />
          <SectionHeader q={query} title="🎨 Image generation" order={20} />
          <SectionHeader q={query} title="🎬 Video generation" order={25} />
          <SectionHeader q={query} title="🔐 Authorizations" order={30} />
          <SectionHeader q={query} title="🔗 Links & APIs" order={40} />
          <SectionHeader q={query} title="⚙️ Other app settings" order={50} />

          <Group
            q={query}
            order={26}
            title="🎬 Image-to-video"
            hint="Animate an image into a short clip via ComfyUI (image-to-video)."
            keywords="video wan ltx ltx-2 comfyui image to video i2v animate motion lora high noise low noise frames fps width height steps cfg shift checkpoint text encoder gemma umt5 vae download manual safetensors ffmpeg stitch long form"
          >
            {(isDesktop || remote) && (
              <div style={rowStyle}>
                <span>ffmpeg (stitches long-form video into one file)</span>
                {(() => {
                  const progress = downloadProgress.ffmpeg;
                  const downloading = progress !== undefined && progress < 100;
                  const installed = progress === 100;
                  return installed ? (
                    <span style={{ color: SUCCESS_GREEN }}>✓ Installed</span>
                  ) : downloading ? (
                    <span style={{ opacity: 0.7 }}>{Math.round(progress)}%</span>
                  ) : onDownloadFfmpeg ? (
                    <button type="button" style={buttonStyle} onClick={onDownloadFfmpeg}>
                      Download ffmpeg (~80 MB)
                    </button>
                  ) : null;
                })()}
                <span style={{ opacity: 0.55, fontSize: 11 }}>
                  Only needed for "long-form video" (a series of clips stitched into one). Places a
                  self-contained copy in the app's own folder — no PATH or system install needed.
                  {remote && !isDesktop ? " Runs on your linked desktop." : ""} On macOS/Linux, install
                  ffmpeg with brew/apt instead; it's already found on PATH.
                </span>
              </div>
            )}
            {value.imageProvider === "local" && (value.localBackend ?? "a1111") !== "a1111" ? (
              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Image-to-video model</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                  <select value={value.videoModel ?? VIDEO_MODELS[0]?.id ?? ""} onChange={(e) => set({ videoModel: e.target.value })}>
                    {VIDEO_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {onDownloadVideoModel ? (
                    <button type="button" onClick={() => onDownloadVideoModel(value.videoModel ?? VIDEO_MODELS[0]!.id)}>
                      Download (~{videoModelById(value.videoModel)?.sizeGB ?? VIDEO_MODELS[0]?.sizeGB ?? 0} GB)
                    </button>
                  ) : null}
                </div>
                <span style={{ display: "block", opacity: 0.55, fontSize: 11, marginTop: 4 }}>
                  Lets the assistant animate an image into a short video via ComfyUI (the <code>generate_video</code> tool) —
                  just say “animate this / make it move” in chat. Download places the files into ComfyUI’s model folders.
                  Large download; runs on ComfyUI only.
                </span>
                {(() => {
                  // The exact files this model needs, so they can be searched for + downloaded by hand (place
                  // each into ComfyUI/models/<folder>/) if the auto-download is blocked or a file is broken.
                  const entry = videoModelById(value.videoModel) ?? VIDEO_MODELS[0]!;
                  return (
                    <div style={{ marginTop: 8, fontSize: 11 }}>
                      <span style={{ opacity: 0.75, fontWeight: 600 }}>Required files (for manual download):</span>
                      <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                        {entry.downloads.map((d) => (
                          <li key={d.filename} style={{ marginTop: 3, lineHeight: 1.5 }}>
                            <code style={{ userSelect: "all", fontSize: 11 }}>{d.filename}</code>
                            <span style={{ opacity: 0.6 }}>
                              {" → "}ComfyUI/models/{d.folder}/{" "}
                            </span>
                            <a href={d.url} target="_blank" rel="noreferrer" style={{ opacity: 0.85 }}>
                              source ↗
                            </a>
                          </li>
                        ))}
                      </ul>
                      <span style={{ display: "block", opacity: 0.5, marginTop: 3 }}>
                        Copy a filename to search for it, or use the Download button above to fetch them all automatically.
                      </span>
                    </div>
                  );
                })()}
                {(() => {
                  const entry = videoModelById(value.videoModel) ?? VIDEO_MODELS[0]!;
                  const kind = entry.files.kind;
                  const dflt = VIDEO_RENDER_DEFAULTS[kind];
                  // Placeholder filenames keyed by field (the union's per-family string filenames only —
                  // the LTX LoRA stack is an array and is edited separately below).
                  const defFiles: Record<string, string | undefined> = {};
                  for (const [k, v] of Object.entries(entry.files)) if (typeof v === "string") defFiles[k] = v;
                  const vf = value.videoFiles ?? {};
                  // Params are stored per model family, so the selected model's frames/fps/etc are independent
                  // of the other family's (switching Wan↔LTX no longer clobbers length/fps).
                  const vp = value.videoParams?.[kind] ?? {};
                  // String file-override keys only (the LoRA stack `ltxLoras` has its own editor).
                  type StringFileKey = Exclude<keyof NonNullable<typeof value.videoFiles>, "ltxLoras">;
                  const setFile = (k: StringFileKey, v: string) => {
                    // Typed copy + delete (not a computed-key spread, which trips exactOptionalPropertyTypes).
                    const next: NonNullable<typeof value.videoFiles> = { ...vf };
                    if (v) next[k] = v;
                    else delete next[k];
                    set({ videoFiles: next });
                  };
                  // Write back into THIS family's slot only, leaving the other family's params untouched.
                  const setVp = (patch: Partial<VideoRenderSettings>) =>
                    set({ videoParams: { ...value.videoParams, [kind]: { ...vp, ...patch } } });
                  const setParam = (k: Exclude<keyof VideoRenderSettings, "highRes" | "audio">, v: string) =>
                    setVp({ [k]: v === "" ? undefined : Number(v) });
                  // High-res (2× upscale) + audio toggles — LTX only; both default on.
                  const highRes = vp.highRes ?? true;
                  const setHighRes = (on: boolean) => setVp({ highRes: on });
                  const audioOn = vp.audio ?? true;
                  const setAudio = (on: boolean) => setVp({ audio: on });
                  // LTX LoRA stack editor state.
                  const ltxLoras = vf.ltxLoras ?? [];
                  const setLtxLoras = (nextLoras: VideoLora[]) => {
                    const next: NonNullable<typeof value.videoFiles> = { ...vf };
                    if (nextLoras.length) next.ltxLoras = nextLoras;
                    else delete next.ltxLoras;
                    set({ videoFiles: next });
                  };
                  const diffNames = installedModels.map((m) => m.id);
                  const isLora = (k: string) => k === "loraHigh" || k === "loraLow";
                  // A real dropdown read from the engine's actual folder listing (`list`) so the value always
                  // matches an installed file. Falls back to a free-text input when no listing is available
                  // (engine not connected, or the node isn't present). The ✕ clears to the catalog default.
                  const fileRow = (label: string, k: StringFileKey, list: string[]) => {
                    const cur = vf[k] ?? "";
                    const optional = isLora(k);
                    return (
                      <label key={k} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, minWidth: 0 }}>
                        <span style={{ opacity: 0.7 }}>{label}</span>
                        <span style={{ display: "flex", gap: 4, alignItems: "center", minWidth: 0 }}>
                          {list.length ? (
                            <select value={cur} onChange={(e) => setFile(k, e.target.value)} style={{ fontSize: 11, flex: 1, minWidth: 0, maxWidth: "100%" }}>
                              <option value="">{optional ? "(none)" : defFiles[k] ? `Default — ${defFiles[k]}` : "Default"}</option>
                              {list.map((n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                              {cur !== "" && !list.includes(cur) ? <option value={cur}>{cur} — not in folder</option> : null}
                            </select>
                          ) : (
                            <input
                              value={cur}
                              placeholder={optional ? "(none)" : defFiles[k] ?? ""}
                              onChange={(e) => setFile(k, e.target.value)}
                              style={{ fontSize: 11, flex: 1, minWidth: 0 }}
                            />
                          )}
                          {cur !== "" ? (
                            <button
                              type="button"
                              title={optional ? "Remove this LoRA" : "Reset to default"}
                              aria-label={optional ? "Remove this LoRA" : "Reset to default"}
                              onClick={() => setFile(k, "")}
                              style={{ fontSize: 11, lineHeight: 1, padding: "2px 6px", cursor: "pointer" }}
                            >
                              ✕
                            </button>
                          ) : null}
                        </span>
                      </label>
                    );
                  };
                  const numRow = (label: string, k: "frames" | "fps" | "width" | "height" | "steps" | "cfg" | "shift", ph: number) => (
                    <label key={k} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11 }}>
                      <span style={{ opacity: 0.7 }}>{label}</span>
                      <input type="number" value={vp[k] ?? ""} placeholder={String(ph)} onChange={(e) => setParam(k, e.target.value)} style={{ fontSize: 11, width: 80 }} />
                    </label>
                  );
                  const effFrames = vp.frames ?? dflt.frames;
                  const effFps = vp.fps ?? dflt.fps;
                  const durationS = effFps > 0 ? effFrames / effFps : 0;
                  // Each family samples in fixed-size chunks, so a clean length is a multiple +1: Wan = 4n+1, LTX = 8n+1.
                  const SUGGESTED = kind === "ltx2-i2v" ? [97, 121, 161, 201] : [49, 81, 121, 161];
                  const stepLabel = kind === "ltx2-i2v" ? "8n+1" : "4n+1";
                  return (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: "pointer", fontSize: 12 }}>Advanced — model files &amp; render settings</summary>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, minWidth: 0 }}>
                        {kind === "ltx2-i2v" ? (
                          <>
                            {fileRow("Checkpoint", "checkpoint", diffNames)}
                            {fileRow("Text encoder (Gemma)", "textEncoder", installedLtxTextEncoders.length ? installedLtxTextEncoders : installedTextEncoders)}
                            {fileRow("Distilled LoRA (required)", "distilledLora", installedLoras)}
                            {fileRow("Upscaler (required)", "upscaler", installedUpscalers)}
                          </>
                        ) : (
                          <>
                            {fileRow("High-noise model", "highNoise", installedDiffusionModels)}
                            {fileRow("Low-noise model", "lowNoise", installedDiffusionModels)}
                            {fileRow("Text encoder", "textEncoder", installedTextEncoders)}
                            {fileRow("VAE", "vae", installedVaes)}
                            {fileRow("LoRA — high noise (optional)", "loraHigh", installedLoras)}
                            {fileRow("LoRA — low noise (optional)", "loraLow", installedLoras)}
                          </>
                        )}
                      </div>
                      {kind === "ltx2-i2v" ? (
                        <div style={{ marginTop: 8 }}>
                          <span style={{ fontSize: 11, opacity: 0.7 }}>LoRAs (stacked in order, applied to the model)</span>
                          {ltxLoras.map((l, i) => (
                            <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4, minWidth: 0 }}>
                              {installedLoras.length ? (
                                <select
                                  value={l.name}
                                  onChange={(e) => setLtxLoras(ltxLoras.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                                  style={{ fontSize: 11, flex: 1, minWidth: 0 }}
                                >
                                  <option value="">(pick a LoRA)</option>
                                  {installedLoras.map((n) => (
                                    <option key={n} value={n}>
                                      {n}
                                    </option>
                                  ))}
                                  {l.name !== "" && !installedLoras.includes(l.name) ? <option value={l.name}>{l.name} — not in folder</option> : null}
                                </select>
                              ) : (
                                <input
                                  value={l.name}
                                  placeholder="lora filename"
                                  onChange={(e) => setLtxLoras(ltxLoras.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                                  style={{ fontSize: 11, flex: 1, minWidth: 0 }}
                                />
                              )}
                              <input
                                type="number"
                                step="0.05"
                                value={l.strength ?? 1}
                                title="strength"
                                onChange={(e) =>
                                  setLtxLoras(ltxLoras.map((x, j) => (j === i ? { ...x, strength: e.target.value === "" ? 1 : Number(e.target.value) } : x)))
                                }
                                style={{ fontSize: 11, width: 60 }}
                              />
                              <button
                                type="button"
                                title="Remove this LoRA"
                                aria-label="Remove this LoRA"
                                onClick={() => setLtxLoras(ltxLoras.filter((_, j) => j !== i))}
                                style={{ fontSize: 11, lineHeight: 1, padding: "2px 6px", cursor: "pointer" }}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => setLtxLoras([...ltxLoras, { name: "", strength: 1 }])}
                            style={{ marginTop: 4, fontSize: 11, padding: "2px 8px", cursor: "pointer" }}
                          >
                            + Add LoRA
                          </button>
                        </div>
                      ) : null}
                      {kind === "ltx2-i2v" ? (
                        <>
                          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, marginTop: 8 }}>
                            <input type="checkbox" checked={highRes} onChange={(e) => setHighRes(e.target.checked)} />
                            <span>
                              High resolution (2× upscale) —{" "}
                              <span style={{ opacity: 0.6 }}>two-stage render; off is a single faster pass at the target size.</span>
                            </span>
                          </label>
                          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, marginTop: 4 }}>
                            <input type="checkbox" checked={audioOn} onChange={(e) => setAudio(e.target.checked)} />
                            <span>
                              Generate audio —{" "}
                              <span style={{ opacity: 0.6 }}>LTX-2 makes a synced soundtrack (saved as mp4); off is silent video.</span>
                            </span>
                          </label>
                        </>
                      ) : null}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                        {numRow("Frames", "frames", dflt.frames)}
                        {numRow("FPS", "fps", dflt.fps)}
                        {numRow("Width", "width", dflt.width)}
                        {numRow("Height", "height", dflt.height)}
                        {numRow("Steps", "steps", dflt.steps)}
                        {numRow("CFG", "cfg", dflt.cfg)}
                        {kind === "wan-i2v" ? numRow("Shift", "shift", dflt.shift) : null}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 11 }}>
                        <span style={{ fontWeight: 600 }}>≈ {durationS.toFixed(1)}s</span>
                        <span style={{ opacity: 0.7 }}> at {effFrames} frames ÷ {effFps} fps. </span>
                        <span style={{ opacity: 0.7 }}>Length (= frames ÷ fps). Clean {stepLabel} frame counts: </span>
                        {SUGGESTED.map((f, i) => (
                          <span key={f}>
                            {i > 0 ? ", " : ""}
                            <button
                              type="button"
                              onClick={() => setParam("frames", String(f))}
                              style={{ fontSize: 11, padding: "0 4px", cursor: "pointer", background: "none", border: "1px solid currentColor", borderRadius: 4, opacity: 0.8 }}
                            >
                              {f} (~{(f / effFps).toFixed(1)}s)
                            </button>
                          </span>
                        ))}
                        <span style={{ opacity: 0.7 }}>. More frames = more VRAM &amp; time.</span>
                      </div>
                      <span style={{ display: "block", opacity: 0.55, fontSize: 11, marginTop: 6 }}>
                        Override any file (pick an installed one or type a filename) to swap a component or fix a failed
                        download; blank uses the default. Render settings are the graph’s defaults when blank.
                      </span>
                    </details>
                  );
                })()}
              </div>
            ) : (
              <span style={{ opacity: 0.6, fontSize: 12 }}>
                Image-to-video runs on ComfyUI. Set the image engine to “Run on my computer” and choose ComfyUI (under{" "}
                🎨 Image generation) to enable it.
              </span>
            )}
          </Group>
          <Group
            q={query}
            order={11}
            title="📖 Read & analyse — text model"
            hint="Reads the book, learns characters/places, writes the illustration prompts. Changes apply via ↻ Redo → Story analysis (or → Prompts)."
            keywords="text provider llm claude gemini openai api key local ollama lm studio llama webgpu on-device server model download pull context window tokens built-in bundled"
            defaultOpen
          >
          <label style={rowStyle}>
            <span>Text (story understanding)</span>
            <select
              value={value.textProvider}
              onChange={(e) => set({ textProvider: e.target.value as TextProviderId })}
            >
              {TEXT_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {textInfo?.needsKey && <KeyField info={textInfo} value={value.keys[textInfo.id] ?? ""} onChange={(k) => setKey(textInfo.id, k)} />}
          {value.textProvider === "local" && (
            <div style={rowStyle}>
              <span>How to run it</span>
              <select
                value={textBackend}
                onChange={(e) =>
                  set({ localTextBackend: e.target.value as "webgpu" | "server" | "bundled" })
                }
              >
                {(isDesktop || remote) && (
                  <option value="bundled">Built-in model (shipped with the app, no setup)</option>
                )}
                <option value="webgpu">On-device (WebGPU, no install)</option>
                <option value="server">Local server (Ollama / LM Studio / llama.cpp)</option>
              </select>
              {textBackend === "bundled" ? (
                <span style={{ opacity: 0.6, fontSize: 12 }}>
                  {BUNDLED_LLM.label} runs automatically inside the app — nothing to install or
                  connect. Best for reading and chat out of the box; switch to a Local server for a
                  bigger model, or keep Text on a cloud key for the strongest story understanding.
                </span>
              ) : textBackend === "webgpu" ? (
                <label style={rowStyle}>
                  <span>On-device text model</span>
                  <select
                    value={value.localTextModel ?? LOCAL_TEXT_MODELS[0]!.id}
                    onChange={(e) => set({ localTextModel: e.target.value })}
                  >
                    {LOCAL_TEXT_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.downloadGB} GB{m.note ? ` · ${m.note}` : ""}
                      </option>
                    ))}
                  </select>
                  <span style={{ opacity: 0.6, fontSize: 12 }}>
                    Runs on your GPU (WebGPU); the model downloads once on first use. No
                    WebGPU → falls back to demo text. Tip: keep Text on a cloud key for
                    the best story understanding while images run locally.
                  </span>
                </label>
              ) : (
                <LocalTextServer
                  server={value.localTextServer ?? DEFAULT_LOCAL_TEXT_SERVER}
                  url={value.localServerTextUrl ?? ""}
                  selected={value.localServerTextModel}
                  textModels={textModels}
                  connecting={connectingLocalText}
                  onSet={set}
                  onSelect={(id) => set({ localServerTextModel: id })}
                  onConnect={onConnectLocalTextServer}
                  onPull={onPullTextModel}
                  pullProgress={pullProgress}
                />
              )}
              {(() => {
                // PER-MODEL num_ctx — the in-app lever. Ollama-only (its native /api/chat honours
                // options.num_ctx; the OpenAI /v1 path can't). When set, the app loads THIS model at
                // THIS window, so its KV cache (and VRAM) shrink to fit the GPU — the fix for slow
                // CPU-offloaded generation. Stored per model id (mirrors localComponentsByModel).
                const backend = textBackend;
                const server = value.localTextServer ?? "ollama";
                const model = value.localServerTextModel;
                if (backend !== "server" || server !== "ollama" || !model) return null;
                const cur = value.localContextByModel?.[model];
                const setForModel = (n: number | undefined) => {
                  const map = { ...(value.localContextByModel ?? {}) };
                  if (n && n > 0) {
                    map[model] = n;
                    set({ localContextByModel: map });
                  } else {
                    delete map[model];
                    if (Object.keys(map).length) {
                      set({ localContextByModel: map });
                    } else {
                      const { localContextByModel: _drop, ...rest } = value;
                      onChange(rest);
                    }
                  }
                };
                return (
                  <label style={rowStyle}>
                    <span>
                      Load <b>{model}</b> at (num_ctx) — <b>sets VRAM</b>
                    </span>
                    <input
                      type="number"
                      min={1024}
                      step={1024}
                      placeholder={`auto ${defaultLoadedWindow(model, value.gpuVramMb)}${textModelContext?.loaded ? ` · Modelfile ${textModelContext.loaded}` : ""}`}
                      value={cur ?? ""}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setForModel(Number.isFinite(n) ? n : undefined);
                      }}
                    />
                    <span style={{ opacity: 0.55, fontSize: 11 }}>
                      The app tells Ollama (native <code>/api/chat</code>) to LOAD this model at this window,
                      so its KV cache — and its VRAM — shrink to fit the GPU. <b>This</b> is the lever that
                      fixes slow CPU-offloaded generation: a ~19 GB model fits roughly a 48–64k window on a
                      32 GB card.{" "}
                      {textModelContext?.loaded || textModelContext?.max ? (
                        <>
                          This model currently loads at{" "}
                          <b>{textModelContext.loaded ? textModelContext.loaded.toLocaleString() : "Ollama's default"}</b>
                          {textModelContext.max ? <> · architecture max <b>{textModelContext.max.toLocaleString()}</b></> : null}.
                          Blank = leave it at that.
                        </>
                      ) : (
                        <>Per-model; leave blank to use Ollama's own default (often very large).</>
                      )}
                    </span>
                  </label>
                );
              })()}
              <label style={rowStyle}>
                <span>Context window (tokens) — how much we SEND</span>
                <input
                  type="number"
                  min={1024}
                  step={1024}
                  placeholder="auto"
                  value={value.localContextTokens ?? ""}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n > 0) {
                      set({ localContextTokens: n });
                    } else {
                      // Cleared → drop the key (exactOptionalPropertyTypes: no undefined).
                      const { localContextTokens: _drop, ...rest } = value;
                      onChange(rest);
                    }
                  }}
                />
                <span style={{ opacity: 0.55, fontSize: 11 }}>
                  Only sizes how much book/history WE put in each prompt — it does <b>not</b> change
                  your server's VRAM. The KV cache is pre-allocated by your server for its FULL loaded
                  window (Ollama = <code>OLLAMA_CONTEXT_LENGTH</code> or a Modelfile <code>num_ctx</code>),
                  regardless of how short the chat is — so a 256k window reserves a 256k cache even for
                  "hi". To cut VRAM / fix CPU-offload slowness, LOWER that on the server (16k–32k);
                  set this field to match so we don't over-stuff the prompt. Auto reads Ollama's
                  Modelfile num_ctx, else assumes ~4k.
                </span>
              </label>
              {(() => {
                // VRAM FIT for a local-server chat model. A DENSE model whose WEIGHTS + context (KV)
                // cache don't ALL fit the GPU gets split onto the CPU by Ollama, and a dense model
                // runs every weight per token — so token streaming crawls. The weights usually fit on
                // a modern card; the KV cache is the variable that blows the budget, and it scales
                // with the context window Ollama LOADS — which new models often default to a very
                // large value (e.g. 128k+). We can't read that window from here, so: when the reader
                // has told us the window (localContextTokens) we give a confident verdict; otherwise
                // we DON'T claim it fits — we flag the large-default-context trap, which is the usual
                // cause of slow dense generation. (An MoE model activates few params/token, so it
                // stays fast even when offloaded.)
                const backend = textBackend;
                if (backend !== "server") return null;
                const model = value.localServerTextModel ?? "";
                const chatGb = serverModelVramCostGb(model);
                const gpuGb = value.gpuVramMb ? Math.round((value.gpuVramMb / 1024) * 10) / 10 : undefined;
                if (!chatGb || gpuGb === undefined) return null; // unknown size or non-NVIDIA → no guess
                // KV cache grows with BOTH the window and the model size; ~2 GB per 8k tokens for a
                // ~30B model, scaled by the model's size. Rough, clearly approximate.
                const kvPer8k = Math.max(1, Math.round((chatGb / 20) * 2));
                const kvGb = (tokens: number) => Math.max(1, Math.round((tokens / 8192) * kvPer8k));
                const known = !!(value.localContextTokens && value.localContextTokens > 0);
                return (
                  <div style={{ ...rowStyle, fontSize: 11, opacity: 0.85 }}>
                    <span>🧮 Fits your GPU?</span>
                    {known ? (
                      (() => {
                        const ctx = value.localContextTokens!;
                        const kv = kvGb(ctx);
                        const needed = chatGb + kv;
                        const tight = needed + 1 > gpuGb;
                        return (
                          <span>
                            <b>{model}</b> ≈ {chatGb} GB weights + ~{kv} GB for your {Math.round(ctx / 1024)}k context ≈{" "}
                            <b>{needed} GB</b> vs your <b>{gpuGb} GB</b> GPU.
                            {tight
                              ? " ⚠ Over budget — Ollama runs part of it on the CPU, and a DENSE model streams tokens slowly when split. Lower the context window above (and OLLAMA_CONTEXT_LENGTH / a Modelfile num_ctx so Ollama actually loads it smaller), or use an MoE model (e.g. Qwen3-30B-A3B) which stays fast even when offloaded."
                              : " ✓ Should fit on the GPU."}
                          </span>
                        );
                      })()
                    ) : (
                      <span>
                        <b>{model}</b> ≈ {chatGb} GB of weights — those fit your <b>{gpuGb} GB</b> GPU. But its
                        context (KV) cache is added on top and scales with the window Ollama LOADS: ~{kvGb(8192)} GB at 8k,
                        ~{kvGb(40960)} GB at 40k, ~{kvGb(131072)} GB at 128k. New models often DEFAULT to a huge window,
                        which spills a dense model onto the CPU and makes token streaming slow. If it's slow, cap it: set the
                        context window above, and set <code>OLLAMA_CONTEXT_LENGTH</code> (or a Modelfile <code>num_ctx</code>)
                        so weights + cache stay under {gpuGb} GB. Check with <code>ollama ps</code> — it should read 100% GPU.
                      </span>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
          </Group>

          <Group
            q={query}
            order={21}
            title="⏱ Illustration cadence"
            keywords="illustrate after chapter book when timing cadence generate"
          >
          <label style={rowStyle}>
            <span>Illustrate after</span>
            <select
              value={value.illustrateAfter ?? "book"}
              onChange={(e) =>
                set({ illustrateAfter: e.target.value as "book" | "chapter" })
              }
              title="Whole book: read everything first for the most relevant images. Each chapter: faster first image."
            >
              <option value="book">Reading whole book (best context)</option>
              <option value="chapter">Each chapter done (faster)</option>
            </select>
          </label>
          </Group>

          <Group
            q={query}
            order={21}
            title="🎨 Paint — image provider"
            hint="New paintings always use these settings. Apply them to already-painted pictures with ↻ Redo → All images (or → This image)."
            keywords="image provider flux gemini openai dall-e api key local gpu comfyui automatic1111"
            defaultOpen
          >
          <label style={rowStyle}>
            <span>Images</span>
            <select
              value={value.imageProvider}
              onChange={(e) => set({ imageProvider: e.target.value as ImageProviderId })}
            >
              {IMAGE_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {imageInfo?.needsKey && <KeyField info={imageInfo} value={value.keys[imageInfo.id] ?? ""} onChange={(k) => setKey(imageInfo.id, k)} />}
          </Group>

          <Group
            q={query}
            order={21}
            title="🖌 Look & layout"
            keywords="art style anime manga watercolor oil painting comic photorealistic pages per image quality draft ultra aspect ratio portrait landscape panels per view grid comic page local model checkpoint"
          >
          <label style={rowStyle}>
            <span>Art style</span>
            <select value={value.imageStyle ?? "auto"} onChange={(e) => set({ imageStyle: e.target.value })}>
              {IMAGE_STYLES.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>
                  {s.label}
                </option>
              ))}
            </select>
            <span style={{ opacity: 0.55, fontSize: 11 }}>
              {getImageStyle(value.imageStyle).description}
            </span>
          </label>

          {value.imageProvider === "local" && (
            <label style={rowStyle}>
              <span>Model family (local)</span>
              <select
                value={value.imageModelFamily ?? "auto"}
                onChange={(e) =>
                  set({
                    imageModelFamily: e.target.value as
                      | "auto"
                      | "sd15"
                      | "sdxl"
                      | "flux"
                      | "flux2"
                      | "zimage"
                      | "qwenimage"
                      | "hidream",
                  })
                }
                title="How prompts are formatted and the model is loaded. Auto detects from the checkpoint name. SD1.5/SDXL get quality tags + a negative prompt; the newer families get plain natural language. Flux.2 / Z-Image / Qwen-Image / HiDream load via their separate text encoder(s) + VAE (ComfyUI only). Override if auto-detection is wrong."
              >
                <option value="auto">Auto-detect</option>
                <option value="sd15">Stable Diffusion 1.5</option>
                <option value="sdxl">SDXL</option>
                <option value="flux">Flux.1</option>
                <option value="flux2">Flux.2</option>
                <option value="zimage">Z-Image</option>
                <option value="qwenimage">Qwen-Image</option>
                <option value="hidream">HiDream</option>
              </select>
            </label>
          )}

          <div style={rowStyle}>
            <span>Pages per image</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                min={1}
                step={1}
                style={{ width: 80 }}
                value={value.pagesPerImage === "chapter" ? "" : String(value.pagesPerImage ?? 3)}
                disabled={value.pagesPerImage === "chapter"}
                onChange={(e) => {
                  const n = Math.max(1, Math.floor(Number(e.target.value) || 1));
                  set({ pagesPerImage: n });
                }}
                title="How many pages share one illustration. Fewer = frequent/draftier; more = rarer/higher quality. Never crosses a chapter (a bigger number than the chapter just makes one image for it)."
              />
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={value.pagesPerImage === "chapter"}
                  onChange={(e) => set({ pagesPerImage: e.target.checked ? "chapter" : 3 })}
                />
                <span>Whole chapter (one image per chapter)</span>
              </label>
            </div>
          </div>

          <label style={rowStyle}>
            <span>Image quality</span>
            <select
              value={value.imageQuality ?? "auto"}
              onChange={(e) =>
                set({
                  imageQuality: e.target.value as "auto" | "draft" | "standard" | "high" | "ultra",
                })
              }
              title="Auto scales with pages-per-image. Higher levels use more steps + a larger canvas (slower, more VRAM). Override to save time or fit your GPU."
            >
              <option value="auto">
                Auto → {autoQualityLabel(value.pagesPerImage ?? 3)} (scales with pages-per-image)
              </option>
              <option value="draft">Draft · {qualityProfile("draft").width}px · fastest</option>
              <option value="standard">Standard · {qualityProfile("standard").width}px</option>
              <option value="high">High · {qualityProfile("high").width}px</option>
              <option value="ultra">Ultra · {qualityProfile("ultra").width}px · slowest</option>
            </select>
            <span style={{ opacity: 0.55, fontSize: 11 }}>
              Auto by pages-per-image: 1 → Draft, 2–4 → Standard, 5–7 → High, 8+ or whole chapter →
              Ultra. Pick a fixed level to render faster or if a big canvas is too much for your GPU.
              Local models cap the canvas to what they handle well (Flux/Flux.2/Qwen ≤ 1536, Z-Image
              ≤ 1280, SDXL ≤ 1024, SD1.5 ≤ 768).
            </span>
          </label>

          <label style={rowStyle}>
            <span>Aspect ratio</span>
            <select
              value={value.aspectRatio ?? "square"}
              onChange={(e) =>
                set({ aspectRatio: e.target.value as "square" | "portrait" | "landscape" })
              }
              title="Canvas shape. Portrait/landscape keep the same pixel area (and render time) as the square at the same quality level."
            >
              <option value="square">Square · 1:1</option>
              <option value="portrait">Portrait · 2:3 (tall)</option>
              <option value="landscape">Landscape · 3:2 (wide)</option>
            </select>
          </label>

          <label style={rowStyle}>
            <span>Comic panels per view</span>
            <select
              value={String(value.panelsPerView ?? 1)}
              onChange={(e) =>
                set({ panelsPerView: Number(e.target.value) as 1 | 4 | 6 | 9 })
              }
              title="Show several consecutive illustrations together as one comic page (a 2×2 / 2×3 / 3×3 grid). Each panel is still its own image — grids never cross a chapter, and the current panel highlights as you read. Manga style reads right-to-left."
            >
              <option value="1">Single image (off)</option>
              <option value="4">4 panels · 2×2</option>
              <option value="6">6 panels · 2×3</option>
              <option value="9">9 panels · 3×3</option>
            </select>
            <span style={{ opacity: 0.55, fontSize: 11 }}>
              A reading view only — composes images you already render into a comic page.
              Works with every model and keeps characters consistent panel-to-panel.
            </span>
          </label>

          {(value.imageStyle === "comic" || value.imageStyle === "manga") && (
            <label style={{ ...rowStyle, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={value.drawAsComicPage ?? false}
                onChange={(e) => set({ drawAsComicPage: e.target.checked })}
              />
              <span>
                Draw each image as a multi-panel comic page
                <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                  Asks the model to lay out one image as several panels with gutters. Best on
                  natural-language / cloud models; results vary on SD checkpoints.
                </span>
              </span>
            </label>
          )}
          </Group>

          <Group
            q={query}
            order={51}
            title="🔞 Mature content"
            keywords="mature adult explicit nsfw content filter safety moderation uncensored"
          >
          <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <input
              type="checkbox"
              checked={value.allowMature ?? false}
              onChange={(e) => set({ allowMature: e.target.checked })}
            />
            <span>
              Mature mode (adults only)
              <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                Turns off content filtering so books with explicit sexual content, graphic
                violence or other adult themes are illustrated and discussed faithfully. Relaxes
                the adjustable safety filters on Gemini and Flux and tells the models not to
                sanitise; Claude and OpenAI still apply their own policies regardless.
              </span>
            </span>
          </label>
          </Group>

          <Group
            q={query}
            order={31}
            title="🤝 Assistant autonomy"
            keywords="autonomy autonomous learn skills pull files search full medium-risk approve permission"
          >
          <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <input
              type="checkbox"
              checked={value.autoLearnSkills ?? false}
              onChange={(e) => set({ autoLearnSkills: e.target.checked })}
            />
            <span>
              Let the assistant learn skills from experience
              <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                When you do a similar multi-step task <b>more than once</b>, the assistant distils a
                reusable “skill” (a saved playbook) and <b>offers it for you to Keep or Dismiss</b> —
                nothing is saved without your say-so, and near-duplicates are skipped. Skills you keep
                show in the 🧠 Skills panel, and the ones you actually reuse stay put as the list fills.
                Off by default; it adds a short reflection step at the end of those turns.
              </span>
            </span>
          </label>
          <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
            <input
              type="checkbox"
              checked={value.autoPullFiles ?? true}
              onChange={(e) => set({ autoPullFiles: e.target.checked })}
            />
            <span>
              Let the assistant pull files in on its own
              <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                When planning a task, the assistant can <b>read an email attachment</b> (an itinerary, a form,
                a statement) or <b>read a local file it found</b> and use it as prep — without asking each time.
                Reading is safe “gather” work; it never sends, pays, submits, or runs commands. <b>On by default.</b>
              </span>
            </span>
          </label>
          <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
            <input
              type="checkbox"
              checked={value.autonomousFileSearch ?? false}
              onChange={(e) => set({ autonomousFileSearch: e.target.checked })}
            />
            <span>
              Let the assistant search my computer while planning (desktop)
              <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                Lets the assistant <b>search your files on its own</b> while planning a task — to find a document
                you already have — instead of stopping to ask each time. It only searches and reads; it never runs
                commands. <b>Off by default;</b> turn it on so the agent can fully plan from your own documents.
              </span>
            </span>
          </label>
          <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
            <input
              type="checkbox"
              checked={value.fullAutonomy ?? false}
              onChange={(e) => set({ fullAutonomy: e.target.checked })}
            />
            <span>
              Full autonomy — act without asking (advanced)
              <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                The assistant runs its <b>medium-risk</b> actions on its own — generate an image, take a screenshot,
                search your files — without an approval click. A <b>hard danger floor remains</b>: it will{" "}
                <b>always</b> ask before <b>running a command/executable</b> (so an <code>.exe</code> from an email is
                never run on its own) or <b>placing a trade</b>. <b>Off by default.</b>
              </span>
            </span>
          </label>
          </Group>

          <Group
            q={query}
            order={41}
            title="📱 Phone command bus"
            keywords="remote bus google tasks phone run commands VR"
          >
          <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <input
              type="checkbox"
              checked={value.remoteBus ?? false}
              onChange={(e) => set({ remoteBus: e.target.checked })}
            />
            <span>
              Run commands from my phone (via Google Tasks)
              <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                Add a to-do in Google Tasks whose title starts with <b>VR:</b> (e.g. “VR: summarise
                my unread email”) from your phone; while this app is open it picks it up, runs it,
                writes the answer back into the task, and marks it done — so you read the result on
                your phone. No server, no cloud — it uses your own Google account. Needs Google
                connected; off by default.
              </span>
            </span>
          </label>
          </Group>

          <Group
            q={query}
            order={51}
            title="🔒 Privacy / incognito (phone link)"
            keywords="privacy incognito phone link hidden curtain not saved"
          >
          <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <input
              type="checkbox"
              checked={value.incognitoRemote ?? false}
              onChange={(e) => set({ incognitoRemote: e.target.checked })}
            />
            <span>
              🔒 Privacy / incognito (phone link)
              <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                For driving the desktop privately from your phone. The engine still runs on the desktop,
                but the remote session is <b>not saved</b> (no chat history or memories) and the desktop's
                own screen is <b>curtained</b> so a bystander there can't see what you're doing. Toggle it
                from either side; off by default.
              </span>
            </span>
          </label>
          </Group>

          <Group
            q={query}
            order={41}
            title="🧩 MCP servers"
            keywords="mcp model context protocol servers tools http stdio integrations"
          >
          <label style={{ ...rowStyle, marginTop: 8 }}>
            <span>MCP servers (optional)</span>
            <textarea
              value={value.mcpServers ?? ""}
              onChange={(e) => set({ mcpServers: e.target.value })}
              placeholder={"one per line — an HTTP URL or a local command:\nweather https://my-mcp.example/mcp\nfiles npx -y @modelcontextprotocol/server-filesystem /home/me"}
              rows={3}
              style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical", width: "100%" }}
            />
            <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
              Let the assistant call your own <b>Model Context Protocol</b> servers. Two kinds, one per line:
              an <b>HTTP</b> server (<code>name https://host/mcp</code>) or a <b>stdio</b> server — a local command
              the desktop app runs (<code>name npx -y @scope/server …</code>), like the official filesystem/git
              servers. It lists a server’s tools and calls them as part of a task. Desktop only (it needs CORS-free
              access for HTTP, and to spawn a process for stdio — which runs with your permissions, so only add
              servers you trust).
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center" }}>
              <span style={{ opacity: 0.55, fontSize: 11 }}>Add an example:</span>
              {MCP_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  title={`${p.hint}${p.desktopOnly ? " (desktop only)" : ""}\n${p.line}`}
                  onClick={() => {
                    const cur = value.mcpServers ?? "";
                    // Don't duplicate a server that's already listed by name.
                    const name = p.line.split(/\s+/)[0];
                    if (name && new RegExp(`^\\s*${name}\\s`, "m").test(cur)) return;
                    set({ mcpServers: cur ? `${cur.replace(/\s*$/, "")}\n${p.line}` : p.line });
                  }}
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.05)",
                    cursor: "pointer",
                  }}
                >
                  + {p.label}
                </button>
              ))}
            </div>
          </label>
          </Group>

          <Group
            q={query}
            order={41}
            title="🔬 Scientific sources (technical books)"
            keywords="google custom search programmable engine cx key grounding figures wikimedia wikipedia citations sources real diagrams"
          >
            <p style={{ opacity: 0.6, fontSize: 11, margin: "4px 0 8px" }}>
              For books imported as <em>technical</em>: retrieve REAL figures/diagrams (correct
              labels and data) before generating one, and ground the analysis in Google Search.
              Image retrieval needs a <b>Custom Search API key</b> (Google Cloud console →
              enable “Custom Search API” → credentials) and a <b>Programmable Search Engine
              id</b> (programmablesearchengine.google.com → create an engine → enable “Image
              search” + “Search the entire web” → copy its ID). Free tier: 100 searches/day.
              Already using a Gemini key? It can double as the search key — enable “Custom
              Search API” on that key’s Google Cloud project and leave the key field blank.
              The engine ID (cx) is still required either way.
            </p>
            <p style={{ opacity: 0.75, fontSize: 11, margin: "0 0 8px" }}>
              {(value.keys.search || value.keys.gemini) && value.searchEngineId
                ? "Active backend: Google Custom Search (whole-web figures + grounding)."
                : "Active backend: free Wikipedia/Wikimedia search — keyless and automatic. Add a Custom Search key + engine ID for whole-web results."}
            </p>
            <label style={rowStyle}>
              <span>Custom Search API key</span>
              <input
                type="password"
                value={value.keys.search ?? ""}
                placeholder="AIza… (blank = reuse the Gemini key, if Custom Search API is enabled on it)"
                onChange={(e) => setKey("search", e.target.value.trim())}
              />
            </label>
            <label style={rowStyle}>
              <span>Search engine ID (cx)</span>
              <input
                value={value.searchEngineId ?? ""}
                placeholder="e.g. a1b2c3d4e5f6g7h8i"
                onChange={(e) => set({ searchEngineId: e.target.value.trim() })}
              />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={value.groundFacts ?? false}
                onChange={(e) => set({ groundFacts: e.target.checked })}
              />
              <span>
                Ground analysis in real sources (cited in the book’s glossary). With the
                Gemini text provider this uses its built-in Google Search; with any other
                reader — including a local LLM — it uses the Search engine above, so the
                facts are sourced regardless of which model reads the book.
              </span>
            </label>
            <label style={rowStyle}>
              <span>Wolfram|Alpha AppID (optional)</span>
              <input
                type="password"
                value={value.keys.wolfram ?? ""}
                placeholder="blank = use the built-in calculator (mathjs) for math"
                onChange={(e) => setKey("wolfram", e.target.value.trim())}
              />
              <span style={{ opacity: 0.6, fontSize: 11 }}>
                Lets the chat ground answers in Wolfram|Alpha for <b>real-world data &amp; computation</b>
                {" "}(facts/figures, equation solving, step-by-step). Free AppID at{" "}
                <a href="https://developer.wolframalpha.com/access" target="_blank" rel="noreferrer" style={{ color: ACCENT_BLUE }}>
                  developer.wolframalpha.com ↗
                </a>
                . Without it, math still works via the built-in calculator (units, matrices, calculus,
                stats — keyless). Needs the desktop app or extension to dodge browser CORS.
              </span>
            </label>
          </Group>

          <Group
            q={query}
            order={11}
            title="💬 Chat — model & reasoning"
            keywords="chat buddy companion local model ollama webllm chat provider private vision describe image screenshot thinking reasoning effort qwen deepseek"
          >
            <p style={{ opacity: 0.6, fontSize: 11, margin: "4px 0 8px" }}>
              The chat panel can run on a different model than the book analysis. Defaults to
              local (free &amp; private); when the local option isn’t connected it falls back to
              the book’s provider. You can also ask for render settings IN the chat (“draw a
              truck, 20 steps, flux 2”) — named models must already be downloaded.
            </p>
            <label style={rowStyle}>
              <span>Chat model</span>
              <select
                value={value.chatTextProvider ?? "local"}
                onChange={(e) =>
                  set({ chatTextProvider: e.target.value as "default" | TextProviderId })
                }
              >
                <option value="local">Local (on-device / local server)</option>
                <option value="default">Same as book analysis</option>
                {TEXT_PROVIDERS.filter((p) => p.id !== "local").map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <p style={{ opacity: 0.6, fontSize: 11, margin: "2px 0 6px" }}>
              👁 <b>Vision</b> (needed for the screen-capture tool, and to discuss images):{" "}
              <b>Gemini</b>, <b>OpenAI</b> and <b>Claude</b> can see images. Local works too with a{" "}
              <b>vision model</b> — Ollama <code>llama3.2-vision</code> / <code>llava</code>, or LM
              Studio. Other local (text-only) models can’t see images.
            </p>
            {(value.chatTextProvider ?? "local") === "local" && (
              <label style={rowStyle}>
                <span>Chat local model</span>
                <select
                  value={value.chatLocalModel ?? ""}
                  onChange={(e) => set({ chatLocalModel: e.target.value })}
                >
                  <option value="">Same as the book’s local model</option>
                  {(textBackend === "server"
                    ? textModels.map((m) => ({ id: m.id, label: m.label }))
                    : LOCAL_TEXT_MODELS.map((m) => ({ id: m.id, label: m.label }))
                  ).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <span style={{ opacity: 0.6, fontSize: 12 }}>
                  Downloaded models from your local setup (connect the server in section 1 to
                  list more).
                </span>
              </label>
            )}
            {(value.chatTextProvider ?? "local") === "local" && (
              <label style={rowStyle}>
                <span>Thinking (reasoning models)</span>
                <select
                  value={value.localThinkingEffort ?? "auto"}
                  onChange={(e) =>
                    set({ localThinkingEffort: e.target.value as "auto" | "off" | "low" | "medium" | "high" })
                  }
                  title="For local REASONING models (Qwen3, DeepSeek-R1, GPT-OSS…), sent as the OpenAI reasoning_effort on each chat. Off skips the hidden reasoning pass (fastest); Low/Medium/High scale how much it thinks before answering. Auto leaves the model's default. Models/servers that don't support thinking ignore this."
                >
                  <option value="auto">Auto (model default)</option>
                  <option value="off">Off — answer directly (fastest)</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High — think hardest (slowest)</option>
                </select>
                <span style={{ opacity: 0.6, fontSize: 12 }}>
                  Only affects local models that support reasoning (Qwen3, DeepSeek-R1…); others ignore it.
                </span>
              </label>
            )}
          </Group>

          <Group
            q={query}
            order={21}
            title="🖼 Chat image generation"
            keywords="chat image generation local provider draw"
          >
            <label style={rowStyle}>
              <span>Chat image generation</span>
              <select
                value={value.chatImageProvider ?? "local"}
                onChange={(e) =>
                  set({ chatImageProvider: e.target.value as "default" | ImageProviderId })
                }
              >
                <option value="local">Local engine (free)</option>
                <option value="default">Same as book illustrations</option>
                {IMAGE_PROVIDERS.filter((p) => p.id !== "local").map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </Group>

          {(isDesktop || remote) && (
            <Group
              q={query}
              order={31}
              title="🛠 Assistant — commands & screen"
              keywords="run commands shell screen capture workspace autonomous test code execute conflicts"
            >
              <>
                <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 12 }}>
                  <input
                    type="checkbox"
                    checked={value.appManagedSteps ?? false}
                    onChange={(e) => set({ appManagedSteps: e.target.checked })}
                  />
                  <span>
                    App-managed steps (reliable multi-step)
                    <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                      For a task with several steps, the assistant lays out the plan and then the app runs it — handing
                      the model one step at a time and ticking each off only when it sees the step actually happen (an
                      image rendered, a file saved, an answer given). Far more reliable than letting the model track its
                      own checklist, especially with smaller local models. Off by default (the model drives its own list).
                    </span>
                  </span>
                </label>
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: "1px solid rgba(255,255,255,0.1)",
                    fontSize: 12,
                    opacity: 0.85,
                  }}
                >
                  🛠 <b>Assistant abilities</b>
                  {remote && !isDesktop ? <span style={{ opacity: 0.6 }}> — these run on your desktop</span> : " (desktop)"}
                </div>
                <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={value.allowCommands ?? false}
                    onChange={(e) => set({ allowCommands: e.target.checked })}
                  />
                  <span>
                    Let the assistant run commands &amp; see the screen (advanced)
                    <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                      Allows the chat to PROPOSE shell commands (install dependencies, run tests,
                      execute code it wrote) in a <code>VisualReader/workspace</code> folder, and to
                      capture your screen so it can check whether something it built is working — the
                      test-as-you-go loop. You approve <b>every</b> command and <b>every</b> screen
                      capture before it happens; nothing runs on its own. Off by default. Only enable
                      if you understand that approved commands run on your computer with your
                      permissions. (Opening files from your computer is always available and asks per
                      session.)
                    </span>
                  </span>
                </label>
                {(value.allowCommands ?? false) && (
                  <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={value.autonomousWorkspace ?? false}
                      onChange={(e) => set({ autonomousWorkspace: e.target.checked })}
                    />
                    <span>
                      Autonomous workspace — write &amp; run without approving each step
                      <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                        Lets the assistant <b>save files</b> and <b>run commands</b> in the
                        <code> VisualReader/workspace</code> folder <b>without a per-action click</b>, so it can
                        write code → run tests → read the output → fix it → re-run on its own. Scoped to the
                        workspace; it's told never to act on instructions from fetched email/web text. This{" "}
                        <b>removes the per-command approval</b> for that folder — only turn it on if you're
                        comfortable with that. Off by default; desktop only.
                      </span>
                    </span>
                  </label>
                )}
                {(value.allowCommands ?? false) && (
                  <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={value.delegateCoding ?? false}
                      onChange={(e) => set({ delegateCoding: e.target.checked })}
                    />
                    <span>
                      Delegate hard coding jobs to an external agent
                      <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                        Adds a <code>delegate_coding_task</code> tool: the assistant can hand a tough,
                        multi-file coding job to an external coding agent running on your <b>same local
                        model</b>, which edits the workspace itself; the app captures the diff. Needs the
                        chosen agent installed; if it isn't, the assistant just does the change the normal
                        way. Off by default; desktop only.
                      </span>
                    </span>
                  </label>
                )}
                {(value.allowCommands ?? false) && (value.delegateCoding ?? false) && (
                  <label style={{ ...rowStyle, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <span style={{ fontSize: 13 }}>Coding agent</span>
                    <select
                      value={value.codingAgentBackend ?? "aider"}
                      onChange={(e) => set({ codingAgentBackend: e.target.value === "codex" ? "codex" : "aider" })}
                    >
                      <option value="aider">Aider (pipx install aider-chat)</option>
                      <option value="codex">Codex CLI (npm i -g @openai/codex)</option>
                    </select>
                    <span style={{ opacity: 0.55, fontSize: 11 }}>
                      Which agent runs the delegated job. Aider has an architect/editor split; Codex is the
                      backup. Both run on your local Ollama model.
                    </span>
                  </label>
                )}
                {(value.allowCommands ?? false) && (
                  <label style={{ ...rowStyle, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <span style={{ fontSize: 13 }}>Windows shell</span>
                    <select
                      value={value.commandShell ?? "cmd"}
                      onChange={(e) => set({ commandShell: e.target.value === "powershell" ? "powershell" : "cmd" })}
                    >
                      <option value="cmd">Command Prompt (cmd)</option>
                      <option value="powershell">PowerShell</option>
                    </select>
                    <span style={{ opacity: 0.55, fontSize: 11 }}>
                      Which shell runs approved commands on Windows. PowerShell lets the assistant use
                      cmdlets directly. Ignored on macOS/Linux (always <code>sh</code>).
                    </span>
                  </label>
                )}
                {(value.allowCommands ?? false) && (
                  <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={value.autoResolveConflicts ?? true}
                      onChange={(e) => set({ autoResolveConflicts: e.target.checked })}
                    />
                    <span>
                      Auto-resolve coding-agent merge conflicts
                      <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                        When parallel <b>coding agents</b> edit overlapping code, let the main model
                        merge the conflicting versions automatically. It only commits a resolution that
                        leaves <b>no conflict markers</b>; if it's unsure it backs out and leaves that
                        agent's branch for you. On by default.
                      </span>
                    </span>
                  </label>
                )}
              </>
            </Group>
          )}

          {(isDesktop || remote) && (
            <Group
              q={query}
              order={41}
              title="📈 Integrations & API keys"
              keywords="github git gh token google gmail calendar tasks oauth schwab markets options tradingview chart scan inbox focus"
            >
              <>
                <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={value.allowMarkets ?? false}
                    onChange={(e) => set({ allowMarkets: e.target.checked })}
                  />
                  <span>
                    Offer markets tools in chat (quotes, technicals, alerts)
                    <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                      Advertises the keyless <b>stock quote / technical-analysis / price-alert</b> tools to the
                      assistant. Off by default so a non-trading chat stays lean; connecting Schwab or the TradingView
                      bridge below turns it on automatically.
                    </span>
                  </span>
                </label>
                <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={value.allowTradingViewBridge ?? false}
                    onChange={(e) => set({ allowTradingViewBridge: e.target.checked })}
                  />
                  <span>
                    Let the assistant control my TradingView Desktop chart (experimental)
                    <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                      Connects to <b>TradingView Desktop</b> via its developer/debug port so the assistant can set the
                      symbol, add studies (VWAP, RSI…), read the chart state, and inject Pine — <b>chart-only, it never
                      trades</b>. Requires launching TradingView Desktop with remote debugging on; it’s version-sensitive
                      and may conflict with TradingView’s Terms. Off by default. Setup + update steps in
                      <b> MARKETS-BRIDGE.md</b>.
                    </span>
                  </span>
                </label>
                <label style={{ ...rowStyle, marginTop: 8 }}>
                  <span>GitHub token (optional)</span>
                  <input
                    type="password"
                    value={value.keys.github ?? ""}
                    placeholder="ghp_… — lets the assistant work with your repos"
                    onChange={(e) => setKey("github", e.target.value.trim())}
                  />
                  <span style={{ opacity: 0.55, fontSize: 11 }}>
                    With “run commands” on, lets the assistant <b>clone, commit, push, open pull requests and manage
                    issues</b> on your repos using <code>git</code> and the <code>gh</code> CLI in its workspace. The
                    token is injected into the command’s environment — never shown to the model, printed, or committed.
                    Create a fine-scoped token at{" "}
                    <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" style={{ color: ACCENT_BLUE }}>
                      github.com/settings/tokens ↗
                    </a>
                    {" "}(<code>git</code>/<code>gh</code> must be installed).
                  </span>
                </label>
                <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={value.githubLocalAuth ?? false}
                    onChange={(e) => set({ githubLocalAuth: e.target.checked })}
                  />
                  <span>
                    No token? Use my own <code>gh</code> login instead
                    <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                      If you’ve run <code>gh auth login</code> yourself (so <code>git</code>/<code>gh</code> already
                      work in a terminal), turn this on to enable the assistant’s GitHub features without storing a
                      token here — it uses your existing login.
                    </span>
                  </span>
                </label>
                {onConnectGoogle && (
                  <GoogleConnectBlock
                    value={value}
                    setKey={setKey}
                    connected={googleConnected ?? false}
                    {...(googleEmail ? { email: googleEmail } : {})}
                    onConnect={onConnectGoogle}
                    {...(onDisconnectGoogle ? { onDisconnect: onDisconnectGoogle } : {})}
                  />
                )}
                {onConnectGoogle && (
                  <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={value.autoTaskScan ?? true}
                      onChange={(e) => set({ autoTaskScan: e.target.checked })}
                    />
                    <span>
                      Scan my inbox &amp; calendar for tasks while idle
                      <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                        While the desktop app is open and you&apos;re away, periodically check recent email + your
                        calendar for things that need planning (renewals, trips, deadlines) and surface them into the
                        📋 Tasks panel. Read &amp; research only — it makes <b>no</b> changes to your email/calendar.
                        <b> On by default</b> when Google is connected.
                      </span>
                    </span>
                  </label>
                )}
                {onConnectGoogle && (value.autoTaskScan ?? true) && (
                  <label style={{ ...rowStyle, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <span>Plan per background sweep</span>
                    <select
                      value={value.backgroundPlanRate ?? 2}
                      onChange={(e) => set({ backgroundPlanRate: Number(e.target.value) })}
                      style={{
                        background: "rgba(255,255,255,0.06)",
                        color: "inherit",
                        border: "1px solid rgba(255,255,255,0.15)",
                        borderRadius: 6,
                        padding: "4px 6px",
                        fontSize: 12,
                      }}
                    >
                      <option value={0}>Off — surface only</option>
                      <option value={1}>1 task</option>
                      <option value={2}>2 tasks (default)</option>
                      <option value={3}>3 tasks</option>
                      <option value={5}>5 tasks</option>
                      <option value={10}>10 tasks</option>
                    </select>
                    <span style={{ opacity: 0.55, fontSize: 11 }}>
                      how many unplanned tasks each idle sweep researches + plans (sequentially; it yields when you
                      return). Higher = the backlog clears faster but uses more model time.
                    </span>
                  </label>
                )}
                {onConnectGoogle && (
                  <label style={{ ...rowStyle, marginTop: 8 }}>
                    <span>Focus senders &amp; subjects (one per line)</span>
                    <span style={{ display: "block", opacity: 0.55, fontSize: 11, marginBottom: 4 }}>
                      People or topics the scan should always watch — even when an item looks borderline. One per line:
                      an <b>email address</b> (e.g. <code>landlord@acme.com</code>), a <b>Gmail operator</b> (e.g.
                      <code> from:irs.gov</code>, <code>subject:invoice</code>, <code>label:bills</code>), or a plain{" "}
                      <b>keyword</b> (matched in the subject or sender). The scan searches these too and flags anything
                      actionable from them.
                    </span>
                    <textarea
                      value={value.scanFocus ?? ""}
                      placeholder={"boss@company.com\nsubject:invoice\nlandlord\nfrom:school.edu"}
                      onChange={(e) => set({ scanFocus: e.target.value })}
                      rows={3}
                      style={{
                        background: "rgba(255,255,255,0.06)",
                        color: "inherit",
                        border: "1px solid rgba(255,255,255,0.15)",
                        borderRadius: 6,
                        padding: "6px 8px",
                        fontSize: 12,
                        fontFamily: "ui-monospace, Menlo, monospace",
                        resize: "vertical",
                      }}
                    />
                  </label>
                )}
              </>
            </Group>
          )}

          {(isDesktop || remote) && (
            <Group
              q={query}
              order={11}
              title="🧠 Parallel sub-agents (advanced)"
              keywords="parallel sub-agents concurrency worker model vllm endpoint qwen fast delegate spawn"
            >
              <>
                <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={value.allowSubAgents ?? false}
                    onChange={(e) => set({ allowSubAgents: e.target.checked })}
                  />
                  <span>
                    Offer sub-agent fan-out in chat (<code>delegate</code> / <code>spawn_agents</code>)
                    <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                      Lets the assistant hand off or parallelise read-only research across several sub-agents. Off by
                      default to keep ordinary chats lean; configuring a worker endpoint below turns it on automatically.
                    </span>
                  </span>
                </label>
                <label style={{ ...rowStyle, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <span>Parallel sub-agents</span>
                  <select
                    value={value.agentConcurrency ?? 2}
                    onChange={(e) => set({ agentConcurrency: Number(e.target.value) })}
                    style={{
                      background: "rgba(255,255,255,0.06)",
                      color: "inherit",
                      border: "1px solid rgba(255,255,255,0.15)",
                      borderRadius: 6,
                      padding: "4px 6px",
                      fontSize: 12,
                    }}
                  >
                    <option value={1}>1 — sequential</option>
                    <option value={2}>2 (default)</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                    <option value={6}>6</option>
                    <option value={8}>8</option>
                  </select>
                  <span style={{ opacity: 0.55, fontSize: 11 }}>
                    how many read-only sub-agents the assistant runs at once when it fans a job out (its <code>spawn_agents</code>
                    {" "}tool). Keep low (1–2) for a single local GPU; raise it for cloud or a batched local server where
                    concurrent requests truly parallelize.
                  </span>
                </label>
                <label style={{ ...rowStyle, marginTop: 8 }}>
                  <span>Sub-agent "worker" model (advanced)</span>
                  <span style={{ display: "block", opacity: 0.55, fontSize: 11, marginBottom: 4 }}>
                    Optional. An OpenAI-compatible endpoint + model id (e.g. a <b>vLLM</b> server running a small fast model
                    like Qwen3-4B) that the parallel sub-agents use INSTEAD of your main model — so a single GPU can run them
                    concurrently while the main model does the hard reasoning. Leave blank to use the main model. Falls
                    back to the main model if unreachable. New to this? See VLLM-SETUP.md, or just ask the chat{" "}
                    <b>"walk me through vLLM setup"</b> and it'll guide you step by step.
                  </span>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <input
                      style={{ flex: "2 1 220px", minWidth: 180 }}
                      placeholder="http://localhost:8000/v1"
                      value={value.subAgentServerUrl ?? ""}
                      onChange={(e) => set({ subAgentServerUrl: e.target.value })}
                    />
                    <input
                      style={{ flex: "1 1 140px", minWidth: 120 }}
                      placeholder="model id (e.g. Qwen/Qwen3-4B)"
                      value={value.subAgentModel ?? ""}
                      onChange={(e) => set({ subAgentModel: e.target.value })}
                    />
                  </div>
                  {onTestSubAgentEndpoint && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        disabled={subTest.state === "testing"}
                        onClick={async () => {
                          const url = (value.subAgentServerUrl ?? "").trim();
                          if (!url) {
                            setSubTest({ state: "err", msg: "Enter the endpoint URL first." });
                            return;
                          }
                          setSubTest({ state: "testing" });
                          try {
                            const r = await onTestSubAgentEndpoint(url);
                            if (!r.ok) {
                              setSubTest({ state: "err", msg: r.error || "Couldn't reach the endpoint." });
                              return;
                            }
                            const models = r.models ?? [];
                            const want = (value.subAgentModel ?? "").trim();
                            if (want && !models.includes(want)) {
                              setSubTest({
                                state: "err",
                                msg: `Reachable, but “${want}” isn't loaded. Server has: ${models.slice(0, 6).join(", ") || "(none)"}`,
                              });
                            } else {
                              setSubTest({
                                state: "ok",
                                msg: want
                                  ? `Reachable — “${want}” is loaded ✓`
                                  : `Reachable — serving ${models.length} model(s): ${models.slice(0, 4).join(", ")}`,
                              });
                            }
                          } catch (e) {
                            setSubTest({ state: "err", msg: e instanceof Error ? e.message : String(e) });
                          }
                        }}
                        style={{ padding: "3px 10px", fontSize: 12, cursor: subTest.state === "testing" ? "default" : "pointer" }}
                      >
                        {subTest.state === "testing" ? "Testing…" : "Test connection"}
                      </button>
                      {subTest.state !== "idle" && subTest.state !== "testing" && (
                        <span style={{ fontSize: 11, color: subTest.state === "ok" ? SUCCESS_GREEN : "#f0a868" }}>{subTest.msg}</span>
                      )}
                    </div>
                  )}
                  {(() => {
                    // Honest, rough VRAM read for the chosen worker + (local) main model, so you can
                    // tell at a glance whether the combo fits your card before launching a server.
                    const cardGb = value.gpuVramMb ? Math.round(value.gpuVramMb / 1024) : 32; // default = a 5090
                    const mainId = (value.chatLocalModel ?? value.localTextModel ?? "").trim();
                    const workerId = (value.subAgentModel ?? "").trim();
                    const v = comboVramGb(mainId, workerId);
                    if (v.workerGb === undefined && v.mainGb === undefined) return null;
                    const fit = combFitsCard(v.totalGb, cardGb);
                    return (
                      <div style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>
                        {v.workerGb !== undefined && <>Worker ≈ <b>{v.workerGb} GB</b> (Q4)</>}
                        {v.mainGb !== undefined && (
                          <>
                            {" "}
                            · main ≈ <b>{v.mainGb} GB</b> · total ≈ <b>{v.totalGb} GB</b> on your {cardGb} GB card —{" "}
                            <span style={{ color: fit.fits ? SUCCESS_GREEN : "#f0a868" }}>
                              {fit.fits ? `fits, ~${fit.headroomGb} GB free for KV cache` : `tight (~${fit.headroomGb} GB left)`}
                            </span>
                          </>
                        )}
                        {v.mainGb === undefined && v.workerGb !== undefined && (
                          <span style={{ opacity: 0.7 }}> · set a local main model to see the combined total</span>
                        )}
                      </div>
                    );
                  })()}
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
                    Recommended combos (Q4, ~32 GB card):
                    <div style={{ marginTop: 3, display: "grid", gap: 2 }}>
                      {RECOMMENDED_WORKER_COMBOS.map((c) => {
                        const cv = comboVramGb(c.main, c.worker);
                        return (
                          <div key={`${c.main}/${c.worker}`} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <span style={{ fontFamily: "monospace" }}>
                              {c.main} + {c.worker}
                            </span>
                            <span style={{ opacity: 0.75 }}>≈ {cv.totalGb} GB — {c.note}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </label>
              </>
            </Group>
          )}

          {(isDesktop || remote) && (
            <Group
              q={query}
              order={31}
              title="✅ Task automation (permission)"
              keywords="task automation reminders google calendar tasks without asking creative explore curiosity idle free time"
            >
              <>
                {onConnectGoogle && (
                  <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={value.allowTaskAutomation ?? false}
                      onChange={(e) => set({ allowTaskAutomation: e.target.checked })}
                    />
                    <span>
                      Let the Task Assistant work on tasks by itself
                      <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                        When working a task, create/update Google Tasks &amp; Calendar reminders, research, and draft
                        documents <b>without confirming each one</b>. It also picks up the next step it's allowed to do
                        on its own <b>while you're away</b> (only steps marked as its to do, on plans that aren't
                        waiting on an answer from you — and it stops after two tries rather than retrying forever). It
                        will <b>never</b> submit forms, pay, or send email — those stay your action. <b>Off by
                        default</b> (it asks first); needs Google connected.
                      </span>
                    </span>
                  </label>
                )}
                <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={value.allowCreativeIdle ?? false}
                    onChange={(e) => set({ allowCreativeIdle: e.target.checked })}
                  />
                  <span>
                    Let it explore something of its own while you're idle
                    <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                      A few times an hour, when you haven't been using the app, it follows its own curiosity: reads
                      around a topic on the web and writes up what it found interesting. It appears in its own{" "}
                      <b>✨ Creative</b> chat, so it never interrupts your conversations. It can only search, read and
                      write a document — it can <b>never</b> run commands, change your files, email anyone, or spend
                      anything, whatever your other permissions allow. <b>Off by default.</b>
                    </span>
                  </span>
                </label>
                {/* Proof it works, without waiting ten minutes to find out. Also the only way to tell
                    "it has never run" from "it ran and wrote nothing". */}
                {onExploreNow && (
                  <div style={{ ...rowStyle, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button
                      style={buttonStyle}
                      disabled={!value.allowCreativeIdle}
                      title={
                        value.allowCreativeIdle
                          ? "Start one now instead of waiting for an idle stretch"
                          : "Turn the setting above on first"
                      }
                      onClick={onExploreNow}
                    >
                      ✨ Explore something now
                    </button>
                    <span style={{ fontSize: 11, opacity: 0.55 }}>
                      {lastCreativeRun ? `Last run: ${lastCreativeRun}` : "Hasn't run since the app started"}
                    </span>
                  </div>
                )}
              </>
            </Group>
          )}

          {(isDesktop || remote) && (
            <Group
              q={query}
              order={41}
              title="📈 Schwab (markets · options · positions)"
              keywords="schwab markets options positions thinkorswim quotes greeks app key secret"
            >
              <>
                <div style={{ marginTop: 12, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>📈 Schwab (markets · options · positions)</div>
                  <p style={{ opacity: 0.55, fontSize: 11, margin: "0 0 6px" }}>
                    Connect your own Charles Schwab developer app (the platform behind thinkorswim) for real quotes,
                    option chains with Greeks, and your positions. Register an app at developer.schwab.com (set the
                    callback URL to <code>https://127.0.0.1</code>), paste its key + secret here, then click
                    <b> Connect Schwab</b> in the 📈 Markets panel. The assistant only reads/analyses — it never trades.
                  </p>
                  <label style={rowStyle}>
                    <span>Schwab app key</span>
                    <input
                      type="password"
                      value={value.keys.schwabClientId ?? ""}
                      onChange={(e) => setKey("schwabClientId", e.target.value.trim())}
                    />
                  </label>
                  <label style={rowStyle}>
                    <span>Schwab app secret</span>
                    <input
                      type="password"
                      value={value.keys.schwabClientSecret ?? ""}
                      onChange={(e) => setKey("schwabClientSecret", e.target.value.trim())}
                    />
                  </label>
                </div>
              </>
            </Group>
          )}

          <Group
            q={query}
            order={21}
            title="⚙️ Image — local engine & advanced"
            keywords="comfyui automatic1111 a1111 connect url lora style pack download sampler steps cfg scheduler vae text encoder native one api multimodal reference photos model files low vram lowvram fp8 memory offload gpu"
          >
          {sameVendorNative(value) && <NativeModeRow value={value} set={set} />}

          {(isDesktop || remote) && value.imageProvider === "local" && (
            // A linked phone sees the style-pack STATUS too (installed/size — mirrored via
            // installedLoras); the download button stays desktop-only, where the files land.
            <StyleLoraRow
              styleId={value.imageStyle ?? "auto"}
              family={localFamily}
              installedLoras={installedLoras}
              progress={downloadProgress}
              onDownload={isDesktop ? onDownloadStyleLora : undefined}
            />
          )}

          {value.imageProvider === "local" && installedLoras.length > 0 && (
            (() => {
              // Flag a chosen LoRA whose detected base architecture differs from the active
              // model — it won't load. (Detection reads the LoRA's safetensors header; an
              // unknown/undetected LoRA is never flagged.)
              const chosen = value.styleLoraOverride;
              const chosenFamily = chosen ? loraFamilies[chosen] : undefined;
              const mismatch =
                chosenFamily && localFamily !== "unknown" && chosenFamily !== localFamily;
              const fam = (name: string): string =>
                loraFamilies[name] ? ` · ${loraFamilies[name]!.toUpperCase()}` : "";
              return (
                <label style={rowStyle}>
                  <span>Style LoRA (override)</span>
                  <select
                    value={value.styleLoraOverride ?? ""}
                    onChange={(e) => set({ styleLoraOverride: e.target.value })}
                    title="Pick any LoRA installed in the engine's loras folder to use with the current style, or turn LoRAs off. Overrides the style's automatic pack. The tag shows each LoRA's detected base model."
                  >
                    <option value="">Automatic (match the art style)</option>
                    <option value="none">None — prompt-only styling</option>
                    {installedLoras.map((name) => (
                      <option key={name} value={name}>
                        {name}
                        {fam(name)}
                      </option>
                    ))}
                  </select>
                  {mismatch ? (
                    <span style={{ opacity: 0.85, fontSize: 11, color: "#e0716f" }}>
                      ⚠ This LoRA is {chosenFamily!.toUpperCase()} but your model is{" "}
                      {localFamily.toUpperCase()} — it won’t load. Pick a {localFamily.toUpperCase()}
                      -compatible LoRA, or the prompt style alone will be used.
                    </span>
                  ) : (
                    <span style={{ opacity: 0.55, fontSize: 11 }}>
                      A LoRA must match your model’s family (the tag shows each one’s detected base
                      model). The art-style prompt is always applied regardless.
                    </span>
                  )}
                </label>
              );
            })()
          )}

          {value.imageProvider === "local" && (
            <LocalEngine
              isDesktop={isDesktop}
              remote={remote}
              installedModels={installedModels}
              backend={value.localBackend ?? "a1111"}
              serverUrl={value.localServerUrl ?? ""}
              serverUrlByBackend={value.localServerUrlByBackend ?? {}}
              a1111Path={value.a1111Path ?? ""}
              showEngineConsole={value.showEngineConsole ?? false}
              selected={value.localModel}
              connecting={connectingLocal}
              downloadProgress={downloadProgress}
              downloadStage={downloadStage}
              engineStatus={engineStatus}
              onSet={set}
              onSelect={selectLocalModel}
              onDownload={onDownloadModel}
              onDownloadModelUrl={onDownloadModelUrl}
              onConnect={onConnectLocalServer}
            />
          )}

          {value.imageProvider === "local" && (
            <>
            {(() => {
              // Models + VRAM clarity: name BOTH loaded models (image + chat) and show whether they
              // fit the GPU at once. Always shown for the local image path — even for a model whose
              // size isn't in our table (then we say "size unknown" rather than hiding the whole line).
              const gpuGb = value.gpuVramMb ? Math.round((value.gpuVramMb / 1024) * 10) / 10 : undefined;
              const imgGb = imageModelVramCostGb(value.localModel ?? "");
              const imgName = value.localModel || "(none selected)";
              const CHAT_GB = 4; // built-in Llama 3.2 3B, approx
              const textLocal = value.textProvider === "local";
              const usingBundled = textLocal && textBackend === "bundled";
              const chatName = !textLocal
                ? `cloud (${value.textProvider})`
                : usingBundled
                  ? "Built-in Llama 3.2 3B"
                  : value.localTextBackend === "webgpu"
                    ? `on-device ${value.localTextModel ?? ""}`.trim()
                    : value.localServerTextModel || "local server";
              const both = imgGb + (usingBundled ? CHAT_GB : 0);
              const fits = gpuGb !== undefined && imgGb > 0 ? both + 2 <= gpuGb : undefined;
              return (
                <div style={{ ...rowStyle, fontSize: 11, opacity: 0.8 }}>
                  <span>🧠 Models &amp; VRAM{remote ? " (on desktop)" : ""}</span>
                  <span>
                    🖼 Image: <b>{imgName}</b>
                    {imgGb ? <> (~{imgGb} GB)</> : <> (size not in our table)</>} · 💬 Chat: <b>{chatName}</b>
                    {usingBundled ? " (~4 GB)" : ""}.
                    {gpuGb !== undefined ? (
                      <>
                        {" "}GPU: <b>{gpuGb} GB</b>.
                        {fits === true && " Both fit — the chat model stays loaded across renders (no reload)."}
                        {fits === false &&
                          " Tight — the chat model is freed for each render (turn on Low-VRAM mode below to also shrink the image model)."}
                      </>
                    ) : (
                      " GPU VRAM wasn't detected (non-NVIDIA?) — the chat model is freed for each render to be safe."
                    )}
                  </span>
                </div>
              );
            })()}
            <label style={{ ...rowStyle, alignItems: "flex-start" }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={value.lowVram ?? false}
                  onChange={(e) => set({ lowVram: e.target.checked })}
                />
                <span>Low-VRAM mode</span>
              </span>
              <span style={{ opacity: 0.6, fontSize: 11 }}>
                Loads the diffusion model in fp8 and (managed engine) runs ComfyUI with{" "}
                <code>--lowvram</code>, so the big text encoder offloads to system RAM after
                encoding instead of squatting VRAM. Roughly halves the resident footprint of
                heavy split-file models (Flux.2 / Z-Image / Qwen-Image) for a small speed/quality
                cost. {isDesktop ? "Takes effect next time the engine starts." : "For your own ComfyUI, also launch it with --lowvram."}
              </span>
            </label>
            {(() => {
              // IMAGE-GEN PAIRING: rank the installed chat models that can stay RESIDENT alongside the
              // chosen image model, so prompt-editing chat never starves it of VRAM (no evict/reload
              // thrash). Recommend-only — the reader clicks "Use" to apply (sets it as the local chat
              // model + a num_ctx that fits). Nothing fits ⇒ show the math + Low-VRAM / no-LLM options.
              if (!value.gpuVramMb || !value.localModel) return null;
              const rec = recommendImageModePairings({
                imageModel: value.localModel,
                gpuVramMb: value.gpuVramMb,
                installed: textModels.map((m) => m.id),
              });
              if (!rec) return null;
              const useModel = (model: string, numCtx: number) =>
                set({
                  textProvider: "local",
                  localTextBackend: "server",
                  localServerTextModel: model,
                  localContextByModel: { ...(value.localContextByModel ?? {}), [model]: numCtx },
                });
              return (
                <div style={{ ...rowStyle, fontSize: 11, flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                  <span>🎨 Image-gen pairing — a chat model that stays loaded WITH the image model</span>
                  <span style={{ opacity: 0.7 }}>
                    Image <b>{rec.imageGb} GB</b> on your <b>{rec.gpuGb} GB</b> GPU ⇒ ~<b>{Math.max(0, rec.freeGb)} GB</b> free for chat.
                  </span>
                  {rec.noneFit ? (
                    <span style={{ opacity: 0.85 }}>
                      ⚠ No installed chat model fits alongside this image model.{" "}
                      <button style={{ ...buttonStyle, padding: "1px 6px" }} onClick={() => set({ lowVram: true })}>
                        Turn on Low-VRAM mode
                      </button>{" "}
                      (frees the chat model for each render), or skip the LLM entirely and use the freeform image
                      box — your prompt goes straight to the model, nothing else in VRAM.
                    </span>
                  ) : (
                    <>
                      {rec.fits.slice(0, 4).map((f) => (
                        <div key={f.model} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                          <span>
                            {f.model} · ~{f.vramGb} GB · loads at {Math.round(f.suggestedNumCtx / 1024)}k
                          </span>
                          {value.textProvider === "local" && value.localServerTextModel === f.model ? (
                            <span style={{ color: SUCCESS_GREEN }}>✓ In use</span>
                          ) : (
                            <button style={{ ...buttonStyle, padding: "1px 6px" }} onClick={() => useModel(f.model, f.suggestedNumCtx)}>
                              Use
                            </button>
                          )}
                        </div>
                      ))}
                      <span style={{ opacity: 0.55 }}>
                        Best (largest that fits) first — “Use” makes it your chat model at a window that fits, so it
                        and the image model both stay on the GPU.
                      </span>
                    </>
                  )}
                </div>
              );
            })()}
            </>
          )}

          {value.imageProvider === "local" && (
            <label style={{ ...rowStyle, alignItems: "flex-start" }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={value.hires ?? false}
                  onChange={(e) => set({ hires: e.target.checked })}
                />
                <span>High resolution (two-pass)</span>
              </span>
              <span style={{ opacity: 0.6, fontSize: 11 }}>
                Renders at the model's native size (a single coherent subject), then upscales the
                latent ~2× toward 2048px and refines it in a second pass — a larger, more detailed
                image without the duplicated subjects you get from generating large from scratch.
                Works with every local model; roughly doubles render time. You can also just ask in
                chat (&ldquo;make it high-res&rdquo;).
              </span>
            </label>
          )}

          {value.imageProvider === "local" && (
            <details style={rowStyle}>
              <summary style={{ cursor: "pointer", fontSize: 13, opacity: 0.85 }}>
                Advanced: model files &amp; sampler (local engine)
              </summary>
              <p style={{ opacity: 0.6, fontSize: 11, margin: "4px 0 8px" }}>
                Split-file models (Flux.2 / Z-Image / Qwen-Image) load a separate text encoder +
                VAE. The app suggests the ones that fit your chosen image model and picks them on
                Auto — or pin a specific file below. The sampler fields override the per-model
                defaults. Leave any field blank/Auto to let the app decide.
              </p>
              {/* What the chosen image model needs — and whether a matching file is installed. */}
              <p
                style={{
                  fontSize: 11,
                  margin: "0 0 8px",
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "rgba(120,160,255,0.08)",
                  border: "1px solid rgba(120,160,255,0.18)",
                }}
              >
                <b>For “{value.localModel || "your model"}”:</b> {componentHint.note}
                {componentHint.usesComponents &&
                  installedTextEncoders.length === 0 &&
                  installedVaes.length === 0 && (
                    <span style={{ display: "block", opacity: 0.7, marginTop: 2 }}>
                      Connect to your engine (Connect button above) to list installed files — then these
                      become dropdowns.
                    </span>
                  )}
              </p>
              {!componentHint.usesComponents ? null : componentHint.encoderApplies ? (
                installedTextEncoders.length > 0 ? (
                  <ComponentSelect
                    label="Text encoder file"
                    valueId={value.localTextEncoder ?? ""}
                    options={installedTextEncoders}
                    recommended={componentHint.recommendedEncoder}
                    onPick={(id) => setComponent({ textEncoder: id })}
                  />
                ) : (
                  <label style={rowStyle}>
                    <span>Text encoder file</span>
                    <input
                      value={value.localTextEncoder ?? ""}
                      placeholder={`auto${componentHint.recommendedEncoder ? ` — e.g. ${componentHint.recommendedEncoder}` : " — e.g. qwen_3_8b_fp8mixed.safetensors"}`}
                      onChange={(e) => setComponent({ textEncoder: e.target.value.trim() })}
                    />
                  </label>
                )
              ) : (
                <p style={{ fontSize: 11, opacity: 0.55, margin: "0 0 8px" }}>
                  Text encoders are auto-detected for this model (
                  {localFamily === "hidream" ? "clip_l + clip_g + t5xxl + llama" : "t5xxl + clip_l"}) — no need to
                  pick one.
                </p>
              )}
              {componentHint.vaeApplies &&
                (installedVaes.length > 0 ? (
                  <ComponentSelect
                    label="VAE file"
                    valueId={value.localVae ?? ""}
                    options={installedVaes}
                    recommended={componentHint.recommendedVae}
                    onPick={(id) => setComponent({ vae: id })}
                  />
                ) : (
                  <label style={rowStyle}>
                    <span>VAE file</span>
                    <input
                      value={value.localVae ?? ""}
                      placeholder={`auto${componentHint.recommendedVae ? ` — e.g. ${componentHint.recommendedVae}` : " — e.g. ae.safetensors"}`}
                      onChange={(e) => setComponent({ vae: e.target.value.trim() })}
                    />
                  </label>
                ))}
              <label style={rowStyle}>
                <span>Sampler steps</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={value.localSteps ?? ""}
                  placeholder={`auto = ${localBaseSampler.steps} steps (per model)`}
                  onChange={(e) =>
                    set({ localSteps: e.target.value === "" ? undefined : Math.max(1, Math.floor(Number(e.target.value) || 1)) })
                  }
                />
                <span style={{ opacity: 0.55, fontSize: 11 }}>
                  How many denoising passes. More = more detail/coherence but slower; too many
                  rarely helps. Flux ≈ 20–28, SDXL ≈ 25–35, turbo models ≈ 6–10.
                </span>
              </label>
              <label style={rowStyle}>
                <span>CFG / guidance</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={value.localCfg ?? ""}
                  placeholder={`auto = ${defaultCfg} (per model)`}
                  onChange={(e) => set({ localCfg: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value) || 0) })}
                />
                <span style={{ opacity: 0.55, fontSize: 11 }}>
                  How strictly the image follows the prompt. Higher = more literal but can look
                  over-cooked; lower = looser/softer. Flux/Flux.2-dev use embedded guidance ≈ 3–5;
                  Klein/SDXL use real CFG ≈ 4–7. This sets whichever your model uses.
                </span>
              </label>
              <label style={rowStyle}>
                <span>Sampler</span>
                <select
                  value={value.localSampler ?? ""}
                  onChange={(e) => set({ localSampler: e.target.value })}
                  title="The denoising algorithm. Blank uses the per-model default. dpmpp_2m / dpmpp_2m_sde are strong all-rounders; euler is the safe baseline."
                >
                  <option value="">auto = {localBaseSampler.sampler} (per model)</option>
                  {SAMPLER_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label style={rowStyle}>
                <span>Scheduler</span>
                <select
                  value={value.localScheduler ?? ""}
                  onChange={(e) => set({ localScheduler: e.target.value })}
                  title="How the noise level steps down. Blank uses the per-model default. karras is a common choice for SD; flux/turbo models prefer simple."
                >
                  <option value="">auto = {localBaseSampler.scheduler} (per model)</option>
                  {SCHEDULER_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </details>
          )}
          </Group>

          <p style={{ opacity: 0.6, margin: "4px 0 0" }}>
            Keys are stored encrypted on this device only.
          </p>
        </div>,
      )}
    </div>
  );
}

/**
 * Render the settings panel at the top of the document instead of where the button is.
 *
 * The panel is `position: fixed` to the VIEWPORT's top-right — but the button lives in the app
 * header, and that header has a `backdrop-filter`. A filtered element becomes the containing block
 * for fixed descendants, so "fixed" quietly meant "fixed to the header": the panel hung from the
 * header's box instead of the window's, its `100dvh` height no longer matched the space it had, and
 * reaching its top or bottom needed a nudge of the page behind it. A portal puts it back on the
 * viewport, where its own measurements are true.
 *
 * No document (SSR / a test renderer without one) → render in place, as before.
 */
function portalled(node: ReactNode): ReactNode {
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

function GoogleConnectBlock({
  value,
  setKey,
  connected,
  email,
  onConnect,
  onDisconnect,
}: {
  value: ReaderSettings;
  setKey: (id: string, key: string) => void;
  connected: boolean;
  email?: string;
  onConnect: () => Promise<{ ok: boolean; email?: string; error?: string }>;
  onDisconnect?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await onConnect();
      if (!r.ok) setError(r.error ?? "Couldn't connect.");
    } catch (err) {
      // A thrown failure (loopback bind, network) must surface like an { ok:false } one.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const ready = !!value.keys.googleClientId && !!value.keys.googleClientSecret;
  const btn = {
    background: "rgba(122,162,255,0.22)",
    color: "inherit",
    border: "1px solid rgba(122,162,255,0.55)",
    borderRadius: 6,
    padding: "5px 12px",
    fontSize: 12,
    cursor: "pointer",
  } as const;
  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>📧 Google (Gmail · Calendar · Tasks)</div>
      <p style={{ opacity: 0.55, fontSize: 11, margin: "0 0 6px" }}>
        Let the assistant read your email, see &amp; create calendar events, and manage to-dos. One-time setup: create a
        Google Cloud OAuth client (Desktop app), then paste its ID + secret here. Step-by-step in SETUP.md.
      </p>
      <label style={rowStyle}>
        <span>Google client ID</span>
        <input
          type="password"
          value={value.keys.googleClientId ?? ""}
          placeholder="…apps.googleusercontent.com"
          onChange={(e) => setKey("googleClientId", e.target.value.trim())}
        />
      </label>
      <label style={rowStyle}>
        <span>Google client secret</span>
        <input
          type="password"
          value={value.keys.googleClientSecret ?? ""}
          onChange={(e) => setKey("googleClientSecret", e.target.value.trim())}
        />
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        {connected ? (
          <>
            <span style={{ fontSize: 12, color: SUCCESS_GREEN }}>✓ Connected{email ? ` as ${email}` : ""}</span>
            {onDisconnect && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Disconnect Google? The saved sign-in is forgotten — you'll need to approve access again to reconnect.")) onDisconnect();
                }}
                style={{ ...btn, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)" }}
              >
                Disconnect
              </button>
            )}
          </>
        ) : (
          <button type="button" disabled={busy || !ready} onClick={() => void connect()} style={btn}>
            {busy ? "Connecting… (approve in your browser)" : "Connect Google"}
          </button>
        )}
      </div>
      {error && <div style={{ color: DANGER_RED, fontSize: 11, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

function KeyField({ info, value, onChange }: { info: ProviderInfo; value: string; onChange: (k: string) => void }) {
  // Local draft, committed after a short pause (and on blur). Each commit flows
  // into app-level settings — re-rendering the whole app and, for keys, an
  // identity rebuild downstream — so it must not happen per keystroke.
  const [draft, setDraft] = useState(value);
  const commitFn = useRef(onChange);
  commitFn.current = onChange;
  const lastCommitted = useRef(value);
  const commit = (text: string): void => {
    lastCommitted.current = text;
    commitFn.current(text);
  };
  // A value change we DIDN'T commit (hydration/decryption after mount) wins over
  // the draft; our own commits round-tripping back must not clobber newer typing.
  useEffect(() => {
    if (value !== lastCommitted.current) {
      lastCommitted.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => commit(draft), 300);
    return () => clearTimeout(t);
  }, [draft, value]);
  const saved = value.trim().length > 0;
  return (
    <label style={rowStyle}>
      <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span>
          {info.label} key {saved && <span style={{ color: SUCCESS_GREEN }}>✓ saved</span>}
        </span>
        {info.keyUrl && (
          <a href={info.keyUrl} target="_blank" rel="noreferrer" style={{ color: ACCENT_BLUE }}>
            Get a key ↗
          </a>
        )}
      </span>
      <input
        type="password"
        value={draft}
        placeholder={info.keyHint ? `Paste your key (${info.keyHint})` : "Paste your key"}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) commit(draft);
        }}
      />
      {info.keyBlurb && <span style={{ opacity: 0.6, fontSize: 12 }}>{info.keyBlurb}</span>}
    </label>
  );
}

/** A small "paste a URL and fetch" control, reused for models and LoRAs. */
function PasteUrl({ placeholder, onSubmit }: { placeholder: string; onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const go = () => {
    if (url.trim()) {
      onSubmit(url.trim());
      setUrl("");
    }
  };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
      <input
        style={{ flex: 1 }}
        value={url}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button style={buttonStyle} disabled={!url.trim()} onClick={go}>
        Get
      </button>
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{ height: 4, background: "rgba(255,255,255,0.15)", borderRadius: 2, marginTop: 4 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: "#4663d6", borderRadius: 2 }} />
    </div>
  );
}

/**
 * Desktop: get the LoRA that matches the selected style. Three ways — it shows
 * "✓ installed" if a matching LoRA is already in the engine's folder; a
 * "Download style pack" button when the catalog has a source; and always a
 * paste-a-URL field so any LoRA can be fetched for this style.
 */
/** What "Auto" image quality resolves to at the given cadence, e.g. "Ultra (1536px)". */
function autoQualityLabel(pagesPerImage: number | "chapter"): string {
  const level = resolveQuality("auto", pagesPerImage);
  const name = level.charAt(0).toUpperCase() + level.slice(1);
  return `${name} (${qualityProfile(level).width}px)`;
}

/** True when one vendor (Gemini/OpenAI) drives BOTH text and images with a key set —
 * the only situation where "one API" native mode can engage. */
function sameVendorNative(v: ReaderSettings): boolean {
  return (
    v.textProvider === v.imageProvider &&
    (v.imageProvider === "gemini" || v.imageProvider === "openai") &&
    Boolean(v.keys[v.imageProvider])
  );
}

/**
 * "One API" native mode controls, shown only when the same vendor serves text + images.
 * Opt-in because it switches the image MODEL to the vendor's multimodal endpoint (which
 * accepts character reference photos). The experimental one-shot sub-toggle appears once
 * native is on.
 */
function NativeModeRow({
  value,
  set,
}: {
  value: ReaderSettings;
  set: (patch: Partial<ReaderSettings>) => void;
}) {
  const vendor = getProvider("image", value.imageProvider)?.label ?? value.imageProvider;
  return (
    <div style={rowStyle}>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={value.nativeIllustration === true}
          onChange={(e) => set({ nativeIllustration: e.target.checked })}
        />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span>Native “one API” mode</span>
          <span style={{ opacity: 0.6, fontSize: 11 }}>
            Render through {vendor}’s multimodal model so your uploaded character reference
            photos guide the art (cloud equivalent of local IP-Adapter). Uses a different
            image model than the default.
          </span>
        </span>
      </label>
      {value.nativeIllustration === true && (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginLeft: 24 }}>
          <input
            type="checkbox"
            checked={value.nativeOneShot === true}
            onChange={(e) => set({ nativeOneShot: e.target.checked })}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span>One-shot drawing (experimental)</span>
            <span style={{ opacity: 0.6, fontSize: 11 }}>
              Let the model read each passage and draw it directly, instead of rendering the
              pre-written scene prompt. Fewer steps, less control over the exact moment.
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

function StyleLoraRow({
  styleId,
  family,
  installedLoras,
  progress,
  onDownload,
}: {
  styleId: string;
  /** The active model's family, so an architecture-incompatible pack isn't offered. */
  family?: string;
  installedLoras: string[];
  progress: Record<string, number>;
  onDownload: ((styleId: string, url?: string) => void) | undefined;
}) {
  const lora = getImageStyle(styleId).local?.lora;
  if (!lora) return null; // style has no LoRA mapping (e.g. "auto")
  const label = getImageStyle(styleId).label;
  const catalog = styleLoraDownload(styleId); // present when the catalog has a URL
  // A curated pack only loads on its own architecture. Offer the one-click download
  // when the active model matches (or we can't tell); otherwise the pack is for a
  // different family — point the user to the override dropdown / paste-a-URL path.
  const packFamily = lora.family;
  const compatible = !packFamily || !family || family === "unknown" || family === packFamily;
  const installed = resolveAssetName(new Set(installedLoras), lora.name) !== undefined;
  const pct = progress[lora.name];
  const downloading = pct !== undefined && pct < 100;
  return (
    <div style={rowStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <span style={{ opacity: 0.8, fontSize: 12 }}>
          {label} style pack (LoRA){catalog?.sizeMB ? ` · ${catalog.sizeMB} MB` : ""}
        </span>
        {installed ? (
          <span style={{ color: SUCCESS_GREEN }}>✓ installed</span>
        ) : downloading ? (
          <span style={{ opacity: 0.7 }}>{Math.round(pct)}%</span>
        ) : catalog && compatible ? (
          <button style={buttonStyle} onClick={() => onDownload?.(styleId)}>
            Download style pack
          </button>
        ) : null}
      </div>
      {downloading && <ProgressBar pct={pct} />}
      {!installed && catalog && !compatible && (
        <span style={{ opacity: 0.7, fontSize: 11, color: "#e0b870" }}>
          The bundled {label} pack is built for {packFamily!.toUpperCase()} and won’t load on your{" "}
          {family!.toUpperCase()} model. Install a {family!.toUpperCase()}-compatible LoRA below (paste a
          URL or drop the file in), then pick it under “Style LoRA (override)”.
        </span>
      )}
      {!installed && !downloading && (
        <PasteUrl
          placeholder={`Or paste a .safetensors LoRA URL for ${label}`}
          onSubmit={(url) => onDownload?.(styleId, url)}
        />
      )}
      <span style={{ opacity: 0.55, fontSize: 11 }}>
        Or drop a LoRA named “{lora.name}.safetensors” into the engine’s loras folder.
      </span>
    </div>
  );
}

/**
 * Local-engine settings. Two backends (ComfyUI / AUTOMATIC1111), each connectable via its own row
 * below — whether that engine turns out to be the app's own auto-launched process or a server you run
 * yourself is resolved automatically (falling back to the app-managed ComfyUI when neither is reachable
 * yet), so there's nothing to choose here beyond which backend and, for local checkpoints, which model.
 */
function LocalEngine({
  isDesktop,
  remote,
  installedModels,
  backend,
  serverUrl,
  serverUrlByBackend,
  a1111Path,
  showEngineConsole,
  selected,
  connecting,
  downloadProgress,
  downloadStage,
  engineStatus,
  onSet,
  onSelect,
  onDownload,
  onDownloadModelUrl,
  onConnect,
}: {
  isDesktop: boolean;
  remote: boolean;
  installedModels: InstalledModel[];
  backend: LocalBackendId;
  serverUrl: string;
  /** Last-used URL per backend, so flipping the ComfyUI/A1111 dropdown restores the saved URL. */
  serverUrlByBackend: Partial<Record<LocalBackendId, string>>;
  /** AUTOMATIC1111 install folder (desktop auto-start). */
  a1111Path: string;
  /** Spawn engines with a visible console window. */
  showEngineConsole: boolean;
  selected: string | undefined;
  connecting: boolean;
  downloadProgress: Record<string, number>;
  downloadStage: Record<string, string>;
  engineStatus: string;
  onSet: (patch: Partial<ReaderSettings>) => void;
  onSelect: (id: string) => void;
  onDownload: ((id: string) => void) | undefined;
  onDownloadModelUrl: ((url: string) => void) | undefined;
  onConnect: ((backend: LocalBackendId, url: string) => void) | undefined;
}) {
  const hasManaged = isDesktop || remote;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {hasManaged && (
        // A linked phone gets the app-managed model PICKER (its pick relays to the desktop), but
        // not the DOWNLOAD controls — downloading runs on the desktop where the engine lives.
        <ManagedEngine
          installedModels={installedModels}
          selected={selected}
          allowDownload={isDesktop}
          downloadProgress={downloadProgress}
          downloadStage={downloadStage}
          engineStatus={engineStatus}
          onSelect={onSelect}
          onDownload={onDownload}
          onDownloadModelUrl={onDownloadModelUrl}
        />
      )}

      <div style={rowStyle}>
        <span>{hasManaged ? "Or use your own servers" : "Your image-generation servers"}</span>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          Connect BOTH if you like — then pick which one generates images. Video always renders on ComfyUI, so
          you can run e.g. images on AUTOMATIC1111 and video on ComfyUI at the same time.
        </span>
        {/* One independent row PER backend: connect/manage each on its own, and choose which is active for
            IMAGE generation (a "workflow swap") without losing the other's URL. */}
        {(["a1111", "comfyui"] as LocalBackendId[]).map((id) => {
          const isActive = backend === id;
          const url = isActive ? serverUrl : serverUrlByBackend[id] ?? "";
          const setUrl = (v: string) =>
            onSet({
              localServerUrlByBackend: { ...serverUrlByBackend, [id]: v },
              ...(isActive ? { localServerUrl: v } : {}),
            });
          return (
            <div key={id} style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {LOCAL_BACKEND_LABEL[id]}
                {isActive ? <span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 400 }}>✓ active for images</span> : null}
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  style={{ flex: 1, minWidth: 0 }}
                  value={url}
                  placeholder={LOCAL_ENGINE_DEFAULT_URL[id]}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <button
                  style={buttonStyle}
                  disabled={connecting}
                  onClick={() => onConnect?.(id, url.trim() || LOCAL_ENGINE_DEFAULT_URL[id])}
                  title={isActive ? "Reconnect this server" : "Connect this server and use it for image generation"}
                >
                  {connecting ? "Connecting…" : isActive ? "Reconnect" : "Use for images"}
                </button>
              </div>
              <span style={{ opacity: 0.55, fontSize: 11 }}>
                Start {LOCAL_BACKEND_LABEL[id]} with its API and allow this app's origin —
                {id === "a1111"
                  ? " e.g. ./webui.sh --api --cors-allow-origins=" + location.origin
                  : " e.g. python main.py --enable-cors-header " + location.origin}
                .
              </span>
              {id === "a1111" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>AUTOMATIC1111 install folder (auto-start)</span>
                  <input
                    style={{ flex: 1, minWidth: 0 }}
                    value={a1111Path}
                    placeholder="e.g. C:\\stable-diffusion-webui"
                    onChange={(e) => onSet({ a1111Path: e.target.value })}
                  />
                  <span style={{ opacity: 0.55, fontSize: 11 }}>
                    The folder with webui-user.bat — {isDesktop ? "the app" : "your desktop"} starts AUTOMATIC1111
                    with --api on :7860 when you connect it (alongside ComfyUI for video). Leave blank to start it
                    yourself.
                  </span>
                </div>
              )}
            </div>
          );
        })}
        <div style={{ marginTop: 8 }}>
          <ModelSelect installedModels={installedModels} selected={selected} onSelect={onSelect} />
        </div>
      </div>

      {isDesktop && (
        <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={showEngineConsole}
            onChange={(e) => onSet({ showEngineConsole: e.target.checked })}
          />
          <span>
            Show engine console windows
            <span style={{ opacity: 0.6 }}>
              {" "}
              — open the ComfyUI/AUTOMATIC1111 console so you can watch generation logs outside the app.
              Takes effect at the next engine start.
            </span>
          </span>
        </label>
      )}

      <span style={{ opacity: 0.55, fontSize: 11 }}>
        Video always renders on ComfyUI; images use the selected engine — both can run at once.
      </span>
    </div>
  );
}

/** Desktop app-managed engine: pick a downloaded model or grab a curated one. */
function ManagedEngine({
  installedModels,
  selected,
  allowDownload,
  downloadProgress,
  downloadStage,
  engineStatus,
  onSelect,
  onDownload,
  onDownloadModelUrl,
}: {
  installedModels: InstalledModel[];
  selected: string | undefined;
  /** Whether to show the download controls (desktop only — a linked phone gets the picker only,
   * since downloads run on the desktop's engine). */
  allowDownload: boolean;
  downloadProgress: Record<string, number>;
  downloadStage: Record<string, string>;
  engineStatus: string;
  onSelect: (id: string) => void;
  onDownload: ((id: string) => void) | undefined;
  onDownloadModelUrl: ((url: string) => void) | undefined;
}) {
  // Installed list reports model filenames; match the catalog by (main) filename.
  const installedNames = new Set(installedModels.map((m) => m.id));
  return (
    <div style={rowStyle}>
      <span>Local model (app-managed){!allowDownload ? " — on the desktop" : ""}</span>
      {engineStatus && <span style={{ opacity: 0.7, fontSize: 12 }}>{engineStatus}</span>}
      <ModelSelect installedModels={installedModels} selected={selected} onSelect={onSelect} />
      {!allowDownload && (
        <span style={{ opacity: 0.55, fontSize: 11, marginTop: 2 }}>
          Pick which installed model the desktop uses. Add new models on the desktop.
        </span>
      )}
      {allowDownload && (
      <>
      <span style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>Download a model — we set up the engine:</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
        {LOCAL_IMAGE_MODELS.map((m) => {
          const progress = downloadProgress[m.id];
          const downloading = progress !== undefined && progress < 100;
          const installed = installedNames.has(m.filename);
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <span style={{ opacity: 0.85 }}>
                  {m.label} · {m.sizeGB} GB{m.note ? ` · ${m.note}` : ""}
                </span>
                {installed ? (
                  <span style={{ color: SUCCESS_GREEN }}>✓ Installed</span>
                ) : downloading ? (
                  <span style={{ opacity: 0.7 }}>{Math.round(progress)}%</span>
                ) : m.url ? (
                  <button style={buttonStyle} onClick={() => onDownload?.(m.id)}>
                    Download
                  </button>
                ) : (
                  // No hosted URL for this one — paste a URL below or drop the file in manually.
                  <span style={{ opacity: 0.6, fontSize: 12 }} title={`Get ${m.filename} yourself and paste its URL below, or drop it into models/checkpoints.`}>
                    manual install
                  </span>
                )}
              </div>
              {downloading && (
                <>
                  {downloadStage[m.id] && (
                    <span style={{ opacity: 0.6, fontSize: 11 }}>{downloadStage[m.id]}</span>
                  )}
                  <div style={{ height: 4, background: "rgba(255,255,255,0.15)", borderRadius: 2 }}>
                    <div style={{ width: `${progress}%`, height: "100%", background: "#4663d6", borderRadius: 2 }} />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <span style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>Or paste a checkpoint URL:</span>
      <PasteUrl placeholder="Paste a .safetensors checkpoint URL" onSubmit={(url) => onDownloadModelUrl?.(url)} />
      <span style={{ opacity: 0.55, fontSize: 11 }}>
        You can also drop a checkpoint into the engine’s models/checkpoints folder.
      </span>
      </>
      )}
    </div>
  );
}

/** Connect to an OpenAI-compatible local LLM server and pick one of its models. */
function LocalTextServer({
  server,
  url,
  selected,
  textModels,
  connecting,
  onSet,
  onSelect,
  onConnect,
  onPull,
  pullProgress,
}: {
  server: LocalTextServerId;
  url: string;
  selected: string | undefined;
  textModels: InstalledModel[];
  connecting: boolean;
  onSet: (patch: Partial<ReaderSettings>) => void;
  onSelect: (id: string) => void;
  onConnect: ((server: LocalTextServerId, url: string) => void) | undefined;
  onPull: ((model: string) => void) | undefined;
  pullProgress: Record<string, { status: string; percent?: number }>;
}) {
  const placeholder = LOCAL_TEXT_SERVER_DEFAULT_URL[server];
  return (
    <div style={rowStyle}>
      <span>Local LLM server</span>
      <select value={server} onChange={(e) => onSet({ localTextServer: e.target.value as LocalTextServerId })}>
        {(Object.keys(LOCAL_TEXT_SERVER_LABEL) as LocalTextServerId[]).map((id) => (
          <option key={id} value={id}>
            {LOCAL_TEXT_SERVER_LABEL[id]}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          style={{ flex: 1 }}
          value={url}
          placeholder={placeholder}
          onChange={(e) => onSet({ localServerTextUrl: e.target.value })}
        />
        <button
          style={buttonStyle}
          disabled={connecting}
          onClick={() => onConnect?.(server, url.trim() || placeholder)}
        >
          {connecting ? "Connecting…" : "Connect"}
        </button>
      </div>
      <ModelSelect installedModels={textModels} selected={selected} onSelect={onSelect} />
      {server === "ollama" && onPull && (
        <OllamaModelMenu textModels={textModels} pullProgress={pullProgress} onPull={onPull} />
      )}
      <span style={{ opacity: 0.6, fontSize: 12 }}>
        {server === "ollama" ? (
          <>
            First time? Run <code>ollama-setup.bat</code> (Windows) or install Ollama from
            ollama.com, then download a model above. In a browser, Ollama needs{" "}
            <code>OLLAMA_ORIGINS={location.origin}</code> (the setup script sets it).
          </>
        ) : (
          <>
            Start {LOCAL_TEXT_SERVER_LABEL[server]} with a model loaded; it allows browser
            requests by default.
          </>
        )}
      </span>
    </div>
  );
}

/**
 * Curated one-click text-model downloads INTO Ollama (`/api/pull` — server-side
 * resumable, so re-clicking after an interruption continues). Plus a free-text
 * field for any other model name from ollama.com/library.
 */
function OllamaModelMenu({
  textModels,
  pullProgress,
  onPull,
}: {
  textModels: InstalledModel[];
  pullProgress: Record<string, { status: string; percent?: number }>;
  onPull: (model: string) => void;
}) {
  return (
    <>
      <span style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>Download a text model:</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
        {OLLAMA_TEXT_MODELS.map((m) => {
          const installed = textModels.some((t) => ollamaModelMatches(t.id, m.id));
          const pull = pullProgress[m.id];
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <span style={{ opacity: 0.85 }}>
                  {m.label} · {m.sizeGB} GB{m.note ? ` · ${m.note}` : ""}
                </span>
                {installed ? (
                  <span style={{ color: SUCCESS_GREEN }}>✓ Installed</span>
                ) : pull ? (
                  <span style={{ opacity: 0.7 }}>
                    {pull.percent !== undefined ? `${Math.round(pull.percent)}%` : pull.status}
                  </span>
                ) : (
                  <button style={buttonStyle} onClick={() => onPull(m.id)}>
                    Download
                  </button>
                )}
              </div>
              {pull?.percent !== undefined && <ProgressBar pct={pull.percent} />}
            </div>
          );
        })}
      </div>
      <PasteUrl placeholder="Or any model name from ollama.com/library" onSubmit={onPull} />
    </>
  );
}

/** Checkpoint dropdown; always includes the current selection so it survives reloads. */
function ModelSelect({
  installedModels,
  selected,
  onSelect,
}: {
  installedModels: InstalledModel[];
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  const options = [...installedModels];
  if (selected && !options.some((m) => m.id === selected)) options.unshift({ id: selected, label: selected });
  if (options.length === 0) {
    return <span style={{ opacity: 0.6, fontSize: 12 }}>Connect to load the available models.</span>;
  }
  return (
    <select value={selected ?? ""} onChange={(e) => onSelect(e.target.value)}>
      <option value="" disabled>
        Choose a model…
      </option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

/**
 * One titled, collapsible, SEARCHABLE settings group. The filter box hides
 * non-matching groups and force-opens matches — so finding a setting is "type a
 * word", not "scroll a 1400-line column". `keywords` carry the synonyms a user
 * might type (provider names, "nsfw", "cx"…) beyond the visible title/hint.
 */
function Group({
  q,
  title,
  hint,
  keywords,
  defaultOpen,
  order,
  children,
}: {
  q: string;
  title: string;
  hint?: string;
  keywords?: string;
  defaultOpen?: boolean;
  /** CSS flex `order` so a group renders under its top-level Section regardless of DOM position —
   * lets the panel be reorganized into sections without physically moving 1500 lines of JSX. */
  order?: number;
  children: ReactNode;
}) {
  const [userOpen, setUserOpen] = useState(defaultOpen ?? false);
  const query = q.trim().toLowerCase();
  const hay = `${title} ${hint ?? ""} ${keywords ?? ""}`.toLowerCase();
  const matches = !query || query.split(/\s+/).every((t) => hay.includes(t));
  if (!matches) return null;
  const isOpen = query ? true : userOpen; // searching always reveals the contents
  return (
    <details
      open={isOpen}
      onToggle={(e) => {
        if (!query) setUserOpen((e.target as HTMLDetailsElement).open);
      }}
      style={order !== undefined ? { ...groupStyle, order } : groupStyle}
    >
      <summary style={groupSummaryStyle}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        {hint ? <span style={{ ...sectionHintStyle, display: "block" }}>{hint}</span> : null}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>{children}</div>
    </details>
  );
}

/** A top-level settings SECTION header. Positioned by CSS `order` so it sits just above its group
 * cluster; hidden during a search (the matching groups show flat, no empty section chrome). */
function SectionHeader({ q, title, order }: { q: string; title: string; order: number }) {
  if (q.trim()) return null;
  return (
    <div
      style={{
        order,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        opacity: 0.5,
        margin: "8px 2px 0",
        paddingBottom: 2,
        borderBottom: "1px solid rgba(255,255,255,0.12)",
      }}
    >
      {title}
    </div>
  );
}

const groupStyle = {
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: "8px 10px",
  background: "rgba(255,255,255,0.03)",
} as const;

const groupSummaryStyle = {
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1.4,
} as const;

const searchStyle = {
  width: "100%",
  marginTop: 8,
  background: "rgba(255,255,255,0.07)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 12,
  boxSizing: "border-box",
} as const;

const buttonStyle = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
} as const;

const closeRowStyle = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  display: "flex",
  flexDirection: "column",
  margin: "-12px -16px 4px -12px", // span the panel's padding so the bar is flush
  padding: "10px 12px",
  background: "#16181d",
  borderBottom: "1px solid rgba(255,255,255,0.12)",
} as const;

const closeButtonStyle = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.25)",
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 12,
} as const;

const panelStyle = {
  // Floats OVER the page instead of pushing the header/reader down. Anchored to the
  // VIEWPORT's top-right (not the button) so it can never clip off-screen when the
  // button-heavy header wraps and the Settings button lands mid-row.
  position: "fixed",
  top: 8,
  right: 8,
  zIndex: 60,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  paddingRight: 16, // room for the internal scrollbar so it doesn't overlap inputs
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 8,
  width: "min(340px, calc(100vw - 16px))",
  background: "#16181d",
  boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
  // Own scrollbar instead of overflowing the screen. `dvh` (dynamic viewport height) tracks the
  // visible area on phones where the browser's address bar shows/hides — `vh` is taller than what's
  // on screen there, which left the bottom of the panel unreachable. Touch momentum + overscroll
  // containment make it scroll smoothly on a phone without dragging the page behind it.
  maxHeight: "calc(100dvh - 16px)",
  overflowY: "auto",
  WebkitOverflowScrolling: "touch",
  overscrollBehavior: "contain",
} as const;

const rowStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
} as const;

const sectionHintStyle = {
  fontWeight: 400,
  fontSize: 11,
  opacity: 0.6,
} as const;

/**
 * A split-file component picker (text encoder / VAE): a dropdown of the files the engine has,
 * with an "Auto (recommended: …)" default that maps to "" (let the backend resolve), the
 * suggested file flagged inline, and any pinned-but-absent value still shown so it isn't lost.
 */
function ComponentSelect({
  label,
  valueId,
  options,
  recommended,
  onPick,
}: {
  label: string;
  valueId: string;
  options: readonly string[];
  recommended: string | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <label style={rowStyle}>
      <span>{label}</span>
      <select value={valueId} onChange={(e) => onPick(e.target.value)}>
        <option value="">{recommended ? `Auto — recommended: ${recommended}` : "Auto (best match)"}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o === recommended ? `${o}  ✓ recommended` : o}
          </option>
        ))}
        {valueId && !options.includes(valueId) && (
          <option value={valueId}>{valueId} (not in engine list)</option>
        )}
      </select>
    </label>
  );
}
