import { useEffect, useRef, useState, type ReactNode } from "react";
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
  type LocalTextServerId,
  type ProviderInfo,
} from "@visual-reader/core";

/**
 * Settings: pick a text provider and an image provider independently, each with
 * its own remembered key, plus the local-model picker when "On my computer" is
 * chosen. Keys are handed to the host to encrypt + persist. Provider lists come
 * from the core catalog so the UI and the engine wiring never drift.
 */

export type TextProviderId = "claude" | "gemini" | "openai" | "local";
export type ImageProviderId = "flux" | "gemini" | "openai" | "local";
/** Which local engine HTTP API to speak when the image provider is "local". */
export type LocalBackendId = "comfyui" | "a1111";

/** Default localhost URL for each local engine, used as the field placeholder. */
export const LOCAL_ENGINE_DEFAULT_URL: Record<LocalBackendId, string> = {
  comfyui: "http://127.0.0.1:8188",
  a1111: "http://127.0.0.1:7860",
};

const LOCAL_BACKEND_LABEL: Record<LocalBackendId, string> = {
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
  /** Which local engine API to talk to (browser "your own server" path). */
  localBackend?: LocalBackendId;
  /** Base URL of a local engine you run yourself (browser path; persisted). */
  localServerUrl?: string;
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
  /** Enable GitHub repo work using your OWN local `gh` login (gh auth login) instead
   * of a stored token — so the assistant's GitHub mode turns on without `keys.github`. */
  githubLocalAuth?: boolean;
  /** Let the Task Assistant schedule + prep automatically (create/update Google Tasks
   * & Calendar reminders, run inbox scans, research, draft docs) without asking each
   * time. Never submits forms, pays, or sends. Default off. */
  allowTaskAutomation?: boolean;
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
  /** Optional MCP servers the buddy can call — one per line: `name https://host/mcp`. */
  mcpServers?: string;
  /** Transient: base URL of the app-managed local engine (desktop; not persisted). */
  engineBaseUrl?: string;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  textProvider: "claude",
  imageProvider: "flux",
  keys: {},
};

/** A downloaded local model reported by the running engine. */
export interface InstalledModel {
  id: string;
  label: string;
}

export interface SettingsPanelProps {
  value: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
  /** True when running inside the desktop app (enables the local GPU engine). */
  isDesktop?: boolean;
  /** Models the running engine has downloaded. */
  installedModels?: InstalledModel[];
  /** Text-encoder files the local engine exposes (for the split-file dropdown). */
  installedTextEncoders?: string[];
  /** VAE files the local engine exposes (for the split-file dropdown). */
  installedVaes?: string[];
  /** Start downloading a curated model; desktop only. */
  onDownloadModel?: (id: string) => void;
  /** Download a checkpoint from a pasted URL into the managed engine. */
  onDownloadModelUrl?: (url: string) => void;
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
}

export function SettingsPanel({
  value,
  onChange,
  isDesktop = false,
  installedModels = [],
  installedTextEncoders = [],
  installedVaes = [],
  onDownloadModel,
  onDownloadModelUrl,
  downloadProgress = {},
  downloadStage = {},
  engineStatus = "",
  installedLoras = [],
  loraFamilies = {},
  onDownloadStyleLora,
  onConnectLocalServer,
  connectingLocal = false,
  textModels = [],
  onConnectLocalTextServer,
  connectingLocalText = false,
  onPullTextModel,
  pullProgress = {},
  onTestSubAgentEndpoint,
  googleConnected,
  googleEmail,
  onConnectGoogle,
  onDisconnectGoogle,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  // Settings filter: typing hides non-matching groups and force-opens matches.
  const [query, setQuery] = useState("");
  // Worker-endpoint connection test: status for the "Test" button under the sub-agent settings.
  const [subTest, setSubTest] = useState<{ state: "idle" | "testing" | "ok" | "err"; msg?: string }>({ state: "idle" });
  const set = (patch: Partial<ReaderSettings>) => onChange({ ...value, ...patch });
  const setKey = (id: string, key: string) => set({ keys: { ...value.keys, [id]: key } });

  const textInfo = getProvider("text", value.textProvider);
  const imageInfo = getProvider("image", value.imageProvider);

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
      {open && (
        <div style={panelStyle}>
          {/* The panel floats at the viewport's top-right, over the Settings button —
              so it needs its OWN always-visible close control. */}
          <div style={closeRowStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong>Settings</strong>
              <button onClick={() => setOpen(false)} style={closeButtonStyle} aria-label="Close settings">
                ✕ Close
              </button>
            </div>
            <input
              type="search"
              placeholder="Find a setting… (style, key, context, chat, quality)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={searchStyle}
              aria-label="Filter settings"
            />
          </div>
          <Group
            q={query}
            title="📖 1 · Read & analyse — text model"
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
                value={value.localTextBackend ?? (isDesktop ? "bundled" : "webgpu")}
                onChange={(e) =>
                  set({ localTextBackend: e.target.value as "webgpu" | "server" | "bundled" })
                }
              >
                {isDesktop && (
                  <option value="bundled">Built-in model (shipped with the app, no setup)</option>
                )}
                <option value="webgpu">On-device (WebGPU, no install)</option>
                <option value="server">Local server (Ollama / LM Studio / llama.cpp)</option>
              </select>
              {(value.localTextBackend ?? (isDesktop ? "bundled" : "webgpu")) === "bundled" ? (
                <span style={{ opacity: 0.6, fontSize: 12 }}>
                  {BUNDLED_LLM.label} runs automatically inside the app — nothing to install or
                  connect. Best for reading and chat out of the box; switch to a Local server for a
                  bigger model, or keep Text on a cloud key for the strongest story understanding.
                </span>
              ) : (value.localTextBackend ?? (isDesktop ? "bundled" : "webgpu")) === "webgpu" ? (
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
              <label style={rowStyle}>
                <span>Context window (tokens) — optional</span>
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
                  What your server actually loads. Auto reads the model's Modelfile num_ctx
                  from Ollama (many new models ship one — qwen3 = 40960), else assumes
                  Ollama's ~4k default. Set this if you raised OLLAMA_CONTEXT_LENGTH (not
                  visible to apps) or use LM Studio/WebLLM. Bigger window = the chat sends
                  more book/history per turn — large values prefill slowly on local GPUs.
                </span>
              </label>
            </div>
          )}
          </Group>

          <Group
            q={query}
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
            title="🎨 2 · Paint — image provider"
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
            title="🔞 Content"
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
          <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
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
          <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
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
          </label>
          </Group>

          <Group
            q={query}
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
                <a href="https://developer.wolframalpha.com/access" target="_blank" rel="noreferrer" style={{ color: "#9db4ff" }}>
                  developer.wolframalpha.com ↗
                </a>
                . Without it, math still works via the built-in calculator (units, matrices, calculus,
                stats — keyless). Needs the desktop app or extension to dodge browser CORS.
              </span>
            </label>
          </Group>

          <Group
            q={query}
            title="💬 Chat (buddy & reading companion)"
            keywords="chat buddy companion local model ollama webllm chat provider chat image override private vision describe image screenshot run commands shell agentic assistant workspace test code find files allow wolfram alpha math knowledge appid github git gh token clone commit push pull request pr issue repository repo google gmail email calendar tasks schedule to-do todo oauth connect"
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
                  {((value.localTextBackend ?? "webgpu") === "server"
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
            {isDesktop && (
              <>
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: "1px solid rgba(255,255,255,0.1)",
                    fontSize: 12,
                    opacity: 0.85,
                  }}
                >
                  🛠 <b>Assistant abilities (desktop)</b>
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
                    <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" style={{ color: "#9db4ff" }}>
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
                        <span style={{ fontSize: 11, color: subTest.state === "ok" ? "#6ee7a8" : "#f0a868" }}>{subTest.msg}</span>
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
                            <span style={{ color: fit.fits ? "#6ee7a8" : "#f0a868" }}>
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
                {onConnectGoogle && (
                  <label style={{ ...rowStyle, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={value.allowTaskAutomation ?? false}
                      onChange={(e) => set({ allowTaskAutomation: e.target.checked })}
                    />
                    <span>
                      Let the Task Assistant create reminders without asking
                      <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                        When working a task, create/update Google Tasks &amp; Calendar reminders, research, and draft
                        documents <b>without confirming each one</b>. It will <b>never</b> submit forms, pay, or send
                        email — those stay your action. <b>Off by default</b> (it asks first); needs Google connected.
                      </span>
                    </span>
                  </label>
                )}
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
            )}
          </Group>

          <Group
            q={query}
            title="⚙️ Local engine & advanced"
            keywords="comfyui automatic1111 a1111 connect url lora style pack download sampler steps cfg scheduler vae text encoder native one api multimodal reference photos model files low vram lowvram fp8 memory offload gpu"
          >
          {sameVendorNative(value) && <NativeModeRow value={value} set={set} />}

          {isDesktop && value.imageProvider === "local" && (
            <StyleLoraRow
              styleId={value.imageStyle ?? "auto"}
              family={localFamily}
              installedLoras={installedLoras}
              progress={downloadProgress}
              onDownload={onDownloadStyleLora}
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
              installedModels={installedModels}
              backend={value.localBackend ?? "a1111"}
              serverUrl={value.localServerUrl ?? ""}
              selected={value.localModel}
              connecting={connectingLocal}
              downloadProgress={downloadProgress}
              downloadStage={downloadStage}
              engineStatus={engineStatus}
              onSet={set}
              onSelect={(id) => set({ localModel: id })}
              onDownload={onDownloadModel}
              onDownloadModelUrl={onDownloadModelUrl}
              onConnect={onConnectLocalServer}
            />
          )}

          {value.imageProvider === "local" && (
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
                    onPick={(id) => set({ localTextEncoder: id })}
                  />
                ) : (
                  <label style={rowStyle}>
                    <span>Text encoder file</span>
                    <input
                      value={value.localTextEncoder ?? ""}
                      placeholder={`auto${componentHint.recommendedEncoder ? ` — e.g. ${componentHint.recommendedEncoder}` : " — e.g. qwen_3_8b_fp8mixed.safetensors"}`}
                      onChange={(e) => set({ localTextEncoder: e.target.value.trim() })}
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
                    onPick={(id) => set({ localVae: id })}
                  />
                ) : (
                  <label style={rowStyle}>
                    <span>VAE file</span>
                    <input
                      value={value.localVae ?? ""}
                      placeholder={`auto${componentHint.recommendedVae ? ` — e.g. ${componentHint.recommendedVae}` : " — e.g. ae.safetensors"}`}
                      onChange={(e) => set({ localVae: e.target.value.trim() })}
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
        </div>
      )}
    </div>
  );
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
            <span style={{ fontSize: 12, color: "#7ddf9a" }}>✓ Connected{email ? ` as ${email}` : ""}</span>
            {onDisconnect && (
              <button type="button" onClick={onDisconnect} style={{ ...btn, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)" }}>
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
      {error && <div style={{ color: "#ff9b9b", fontSize: 11, marginTop: 4 }}>{error}</div>}
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
          {info.label} key {saved && <span style={{ color: "#7dd87f" }}>✓ saved</span>}
        </span>
        {info.keyUrl && (
          <a href={info.keyUrl} target="_blank" rel="noreferrer" style={{ color: "#9db4ff" }}>
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
          <span style={{ color: "#7dd87f" }}>✓ installed</span>
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
 * Local-engine settings. Two ways to generate on your own hardware:
 *  - Desktop: the app-managed engine, with a curated one-click model download.
 *  - Anywhere (incl. the browser): connect to a Stable Diffusion server you run
 *    yourself — AUTOMATIC1111 or ComfyUI — and pick from its installed models.
 */
function LocalEngine({
  isDesktop,
  installedModels,
  backend,
  serverUrl,
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
  installedModels: InstalledModel[];
  backend: LocalBackendId;
  serverUrl: string;
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
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {isDesktop && (
        <ManagedEngine
          installedModels={installedModels}
          selected={selected}
          downloadProgress={downloadProgress}
          downloadStage={downloadStage}
          engineStatus={engineStatus}
          onSelect={onSelect}
          onDownload={onDownload}
          onDownloadModelUrl={onDownloadModelUrl}
        />
      )}

      <div style={rowStyle}>
        <span>{isDesktop ? "Or use your own server" : "Your Stable Diffusion server"}</span>
        <select value={backend} onChange={(e) => onSet({ localBackend: e.target.value as LocalBackendId })}>
          {(["a1111", "comfyui"] as LocalBackendId[]).map((id) => (
            <option key={id} value={id}>
              {LOCAL_BACKEND_LABEL[id]}
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={{ flex: 1 }}
            value={serverUrl}
            placeholder={LOCAL_ENGINE_DEFAULT_URL[backend]}
            onChange={(e) => onSet({ localServerUrl: e.target.value })}
          />
          <button
            style={buttonStyle}
            disabled={connecting}
            onClick={() => onConnect?.(backend, serverUrl.trim() || LOCAL_ENGINE_DEFAULT_URL[backend])}
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </div>
        <ModelSelect installedModels={installedModels} selected={selected} onSelect={onSelect} />
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          Start {LOCAL_BACKEND_LABEL[backend]} with its API and allow this app's origin —
          {backend === "a1111"
            ? " e.g. ./webui.sh --api --cors-allow-origins=" + location.origin
            : " e.g. python main.py --enable-cors-header " + location.origin}
          .
        </span>
      </div>
    </div>
  );
}

/** Desktop app-managed engine: pick a downloaded model or grab a curated one. */
function ManagedEngine({
  installedModels,
  selected,
  downloadProgress,
  downloadStage,
  engineStatus,
  onSelect,
  onDownload,
  onDownloadModelUrl,
}: {
  installedModels: InstalledModel[];
  selected: string | undefined;
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
      <span>Local model (app-managed)</span>
      {engineStatus && <span style={{ opacity: 0.7, fontSize: 12 }}>{engineStatus}</span>}
      <ModelSelect installedModels={installedModels} selected={selected} onSelect={onSelect} />
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
                  <span style={{ color: "#7dd87f" }}>✓ Installed</span>
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
                  <span style={{ color: "#7dd87f" }}>✓ Installed</span>
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
  children,
}: {
  q: string;
  title: string;
  hint?: string;
  keywords?: string;
  defaultOpen?: boolean;
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
      style={groupStyle}
    >
      <summary style={groupSummaryStyle}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        {hint ? <span style={{ ...sectionHintStyle, display: "block" }}>{hint}</span> : null}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>{children}</div>
    </details>
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
  // Own scrollbar instead of overflowing the screen.
  maxHeight: "calc(100vh - 16px)",
  overflowY: "auto",
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
