import {
  Automatic1111Backend,
  BUNDLED_LLM,
  ComfyUIBackend,
  DirectTransport,
  GoogleImageSearch,
  KeylessSearch,
  LOCAL_TEXT_MODELS,
  MockImageProvider,
  MockLLMProvider,
  WebLLMProvider,
  createImageProvider,
  capQualityForVram,
  createLLMProvider,
  defaultLoadedWindow,
  getProvider,
  resolveQuality,
  type FigureSearch,
  type GenerationActivity,
  type ImageProvider,
  type LLMProvider,
  type LocalEngineBackend,
  type TierConfig,
  type Transport,
} from "@visual-reader/core";
import type { ReaderSettings } from "./SettingsPanel.js";

/**
 * Maps the user's settings to concrete providers — shared by every front-end
 * (web app worker, Chrome extension) so the wiring never drifts. Each slot is
 * independent: the chosen cloud provider is wired when its key is present, the
 * local image path uses the engine the user connected, and anything unconfigured
 * falls back to the network-free mocks so the app is always usable (demo mode).
 *
 * `fetch` is an optional injection point: hosts that cannot reach provider APIs
 * directly (the extension content script, blocked by page CORS) pass a fetch that
 * proxies through a privileged context. When omitted, providers use the platform
 * `fetch` directly (the web app's behaviour).
 *
 * Alongside the live providers it returns `diagnostics`, describing for each slot
 * whether the *real* provider is active or it silently fell back to a mock (and
 * why). The UI surfaces this so a missing key, absent WebGPU, or unselected
 * checkpoint is visible instead of looking like an endless "painting…".
 */
export interface BuildProvidersOptions {
  /** Proxy fetch routed through a CORS-exempt context (e.g. an extension SW). */
  fetch?: typeof fetch;
  /**
   * CORS-exempt fetch for the CORS-BLOCKED paths only (keyless DuckDuckGo
   * search + figure retrieval) — the desktop shell's native proxy. Unlike
   * `fetch` it does NOT reroute the provider APIs (those are CORS-open and
   * keep the platform fetch + its streaming); when both are set, `fetch`
   * already covers everything and wins.
   */
  corsFetch?: typeof fetch;
  /** Status line for local-model loading (on-device LLM download/progress). */
  onLocalStatus?: (text: string) => void;
  /** Live token progress during on-device generation (bible/prompt), for the UI. */
  onLocalActivity?: (activity: GenerationActivity) => void;
}

/** One slot's resolved state, for the status badge. */
export interface SlotDiagnostic {
  /** Resolved provider id ("local", "claude", … or "mock"). */
  id: string;
  /** Human-friendly description, e.g. "ComfyUI" or "On-device: Llama 3.2 3B". */
  label: string;
  /** True when this slot silently fell back to the network-free mock. */
  mock: boolean;
  /** Why the mock was chosen / extra detail (only set in notable cases). */
  reason?: string;
}

export interface ProvidersDiagnostics {
  llm: SlotDiagnostic;
  image: SlotDiagnostic;
}

interface BuiltLLM {
  provider: LLMProvider;
  diag: SlotDiagnostic;
}
interface BuiltImage {
  provider: ImageProvider;
  diag: SlotDiagnostic;
}

export function buildProviders(
  settings: ReaderSettings,
  opts: BuildProvidersOptions = {},
): {
  llm: LLMProvider;
  image: ImageProvider;
  tier: TierConfig;
  diagnostics: ProvidersDiagnostics;
  /**
   * Real-figure retrieval for technical books — ALWAYS present: Google Custom Search
   * when credentials are set, else the keyless composite (DuckDuckGo full-web where
   * the transport is CORS-exempt, Wikipedia fallback, Wikimedia Commons figures).
   */
  imageSearch: FigureSearch;
  /** Which backend `imageSearch` resolved to, for the Settings status line. */
  searchBackend: "google" | "keyless";
  /**
   * Provider-agnostic grounding source for technical books: present when grounding is
   * on AND the reader isn't Gemini (which grounds in-call). Lets a local/Claude/OpenAI
   * reader still produce sourced facts — keylessly via Wikipedia when no Google creds.
   */
  webSearch?: FigureSearch;
} {
  const transport: Transport | undefined = opts.fetch ? new DirectTransport(opts.fetch) : undefined;
  const llm = buildLLM(settings, transport, opts.fetch, opts.onLocalStatus, opts.onLocalActivity);
  // A self-hosted local image engine (ComfyUI/AUTOMATIC1111) is NOT a CORS-open provider API — it's a
  // localhost/LAN server the browser's CORS blocks (esp. in the packaged app, whose Tauri-scheme origin
  // isn't in the server's allowlist). So route IT through the CORS-exempt `corsFetch` too (the desktop
  // shell's native fetch), unlike cloud APIs which keep the platform fetch + its streaming.
  const engineFetch = opts.fetch ?? opts.corsFetch;
  const engineTransport: Transport | undefined = engineFetch ? new DirectTransport(engineFetch) : undefined;
  // "One API" native mode needs to know it BEFORE building the image slot (it picks the
  // multimodal provider variant). It depends only on settings (same vendor + key + opt-in).
  const native = isNativeIllustration(settings);
  const image = buildImage(settings, transport, native, engineTransport);
  // Scientific sources: real-figure retrieval needs a Google API key AND the Programmable
  // Search Engine id. The dedicated Custom Search key wins; absent it, the Gemini key is
  // tried — the same Google Cloud key serves Custom Search when that API is enabled on its
  // project, and a 403 from an un-enabled project degrades silently like every other
  // search failure (the pipeline/engine wrap search calls in try/catch).
  const searchKey = settings.keys.search || settings.keys.gemini;
  const google =
    searchKey && settings.searchEngineId
      ? new GoogleImageSearch({
          apiKey: searchKey,
          engineId: settings.searchEngineId,
          ...(transport ? { transport } : {}),
        })
      : undefined;
  // No Google credentials → the keyless composite: DuckDuckGo full-web search where
  // the transport dodges CORS (extension proxy / desktop shell), Wikipedia as the
  // always-works fallback, Commons for figures — grounding works with zero setup.
  const searchTransport =
    transport ?? (opts.corsFetch ? new DirectTransport(opts.corsFetch) : undefined);
  const imageSearch: FigureSearch =
    google ?? new KeylessSearch(searchTransport ? { transport: searchTransport } : {});
  // External grounding runs for every reader EXCEPT Gemini (which grounds in-call via its
  // own google_search tool). So a local/Claude/OpenAI reader still gets sourced facts.
  const webSearch =
    settings.groundFacts && llm.provider.id !== "gemini" ? imageSearch : undefined;
  return {
    llm: llm.provider,
    image: image.provider,
    imageSearch,
    searchBackend: google ? "google" : "keyless",
    ...(webSearch ? { webSearch } : {}),
    diagnostics: { llm: llm.diag, image: image.diag },
    tier: {
      tier: settings.imageProvider === "local" ? "local" : "cloud",
      llmProvider: llm.provider.id,
      imageProvider: image.provider.id,
      quality:
        image.provider.id === "mock"
          ? "sketch"
          : image.provider.id === "local"
            ? "standard"
            : "cinematic",
      // Auto-quality is additionally capped to the GPU's VRAM (desktop local engine) so a
      // smaller card doesn't pick a canvas it can't render; an explicit level is untouched.
      renderQuality:
        !settings.imageQuality || settings.imageQuality === "auto"
          ? capQualityForVram(
              resolveQuality("auto", settings.pagesPerImage ?? 3),
              settings.imageProvider === "local" ? settings.gpuVramMb : undefined,
            )
          : resolveQuality(settings.imageQuality, settings.pagesPerImage ?? 3),
      ...(settings.aspectRatio && settings.aspectRatio !== "square"
        ? { aspectRatio: settings.aspectRatio }
        : {}),
      style: settings.imageStyle ?? "auto",
      // Manual style-LoRA override (local engine): a specific installed LoRA, or "none"
      // to render prompt-only. Anything else falls back to the style's automatic mapping.
      ...(settings.imageProvider === "local" && settings.styleLoraOverride === "none"
        ? { disableStyleLora: true }
        : settings.imageProvider === "local" && settings.styleLoraOverride
          ? { styleLoraOverride: settings.styleLoraOverride }
          : {}),
      ...(settings.imageProvider === "local" && settings.localSampler
        ? { localSampler: settings.localSampler }
        : {}),
      ...(settings.imageProvider === "local" && settings.localScheduler
        ? { localScheduler: settings.localScheduler }
        : {}),
      ...(settings.drawAsComicPage ? { drawAsComicPage: true } : {}),
      ...(settings.disableRegions ? { disableRegions: true } : {}),
      ...(settings.imageModelFamily && settings.imageModelFamily !== "auto"
        ? { imageModelFamily: settings.imageModelFamily }
        : {}),
      ...(settings.imageProvider === "local" && settings.localTextEncoder
        ? { localTextEncoder: settings.localTextEncoder }
        : {}),
      ...(settings.imageProvider === "local" && settings.localVae ? { localVae: settings.localVae } : {}),
      ...(settings.imageProvider === "local" && typeof settings.localSteps === "number"
        ? { localSteps: settings.localSteps }
        : {}),
      ...(settings.imageProvider === "local" && typeof settings.localCfg === "number"
        ? { localCfg: settings.localCfg }
        : {}),
      ...(settings.imageProvider === "local" && settings.lowVram ? { lowVram: true } : {}),
      ...(settings.imageProvider === "local" && settings.hires ? { hires: true } : {}),
      // "One API" native mode: the image slot used the vendor's multimodal endpoint, so
      // mark the tier (and carry the experimental one-shot sub-mode, only when native).
      ...(native && !image.diag.mock ? { nativeIllustration: true } : {}),
      ...(native && !image.diag.mock && settings.nativeOneShot ? { nativeOneShot: true } : {}),
      // Mature mode: also carried on the tier so the pipeline's extraction + prompt
      // writing tell the LLM to depict adult content faithfully (provider safety
      // knobs above are the other half).
      ...(settings.allowMature ? { allowMature: true } : {}),
    },
  };
}

/** Cloud vendors whose single API serves text AND has a multimodal image endpoint. */
const NATIVE_VENDORS = new Set(["gemini", "openai"]);

/**
 * True when "one API" native mode should engage: the user opted in AND the SAME native
 * vendor drives both the text and image slots with a key present (e.g. text=gemini,
 * image=gemini). Opt-in (not automatic) because it switches the image MODEL — different
 * cost/quality than the plain text-to-image path.
 */
function isNativeIllustration(settings: ReaderSettings): boolean {
  return (
    settings.nativeIllustration === true &&
    settings.textProvider === settings.imageProvider &&
    NATIVE_VENDORS.has(settings.imageProvider) &&
    Boolean(settings.keys[settings.imageProvider])
  );
}

const MOCK_LABEL = "Mock (placeholder art/text)";

function buildLLM(
  settings: ReaderSettings,
  transport: Transport | undefined,
  fetchImpl: typeof fetch | undefined,
  onLocalStatus: ((text: string) => void) | undefined,
  onLocalActivity: ((activity: GenerationActivity) => void) | undefined,
): BuiltLLM {
  const id = settings.textProvider;
  if (id === "local") {
    // Two server-backed paths share the same OpenAI-compatible provider:
    //  - "server": a server the USER runs (Ollama / LM Studio / llama.cpp).
    //  - "bundled": the model the DESKTOP app ships and auto-launches (BUNDLED_LLM);
    //    the desktop runtime fills in localServerTextUrl/Model once llama-server is up.
    // Both read localServerTextUrl/Model; only the label + "not ready yet" copy differ.
    if (settings.localTextBackend === "server" || settings.localTextBackend === "bundled") {
      const bundled = settings.localTextBackend === "bundled";
      const baseUrl = settings.localServerTextUrl;
      if (!baseUrl) {
        return {
          provider: new MockLLMProvider(),
          diag: {
            id: "mock",
            label: MOCK_LABEL,
            mock: true,
            reason: bundled
              ? "Starting the built-in model… (the desktop app launches it on first use)."
              : "Local LLM server isn't connected — click Connect in Settings.",
          },
        };
      }
      const serverModel = settings.localServerTextModel ?? (bundled ? BUNDLED_LLM.model : undefined);
      // Per-model num_ctx is OLLAMA-only (its native /api/chat) — never for the bundled llama-server
      // or LM Studio / llama.cpp, which have no such endpoint. When set, the provider loads the model
      // at this window so its KV cache fits the GPU. An explicit per-model override wins; otherwise we
      // CAP the window to a safe default — Ollama with no num_ctx loads at its own huge default and
      // pre-allocates a KV cache sized to that whole window, which makes its load-time fit estimate
      // overflow VRAM and offload a small model to shared RAM. A modest default keeps it on the GPU.
      const numCtx =
        !bundled && (settings.localTextServer ?? "ollama") === "ollama" && serverModel
          ? (settings.localContextByModel?.[serverModel] ?? defaultLoadedWindow(serverModel, settings.gpuVramMb))
          : undefined;
      try {
        return {
          provider: createLLMProvider("local-server", {
            baseUrl,
            ...(serverModel ? { model: serverModel } : {}),
            ...(transport ? { transport } : {}),
            ...(numCtx ? { numCtx } : {}),
          }),
          diag: {
            id: "local-server",
            label: bundled ? BUNDLED_LLM.label : `Local server: ${serverModel ?? "default model"}`,
            mock: false,
          },
        };
      } catch {
        return {
          provider: new MockLLMProvider(),
          diag: {
            id: "mock",
            label: MOCK_LABEL,
            mock: true,
            reason: bundled
              ? "Couldn't start the built-in model."
              : "Couldn't initialise the local LLM server.",
          },
        };
      }
    }
    // On-device LLM via WebLLM (WebGPU). Falls back to the mock where WebGPU is
    // unavailable (the provider also self-degrades to the mock on any load error).
    if (!hasWebGPU()) {
      return {
        provider: new MockLLMProvider(),
        diag: {
          id: "mock",
          label: MOCK_LABEL,
          mock: true,
          reason: "On-device text needs WebGPU, which isn't available here.",
        },
      };
    }
    const modelId = settings.localTextModel || undefined;
    const modelLabel = LOCAL_TEXT_MODELS.find((m) => m.id === modelId)?.label ?? "Llama 3.2 3B";
    return {
      provider: new WebLLMProvider({
        ...(modelId ? { model: modelId } : {}),
        ...(onLocalStatus
          ? {
              onProgress: (r) =>
                onLocalStatus(
                  r.progress >= 1 ? "" : `Loading local model… ${Math.round(r.progress * 100)}%`,
                ),
              // A failed/stalled on-device model degrades to the mock — say so in the
              // status line instead of silently producing placeholder analysis.
              onFallback: (reason) => onLocalStatus(`⚠ ${reason}`),
            }
          : {}),
        ...(onLocalActivity ? { onActivity: onLocalActivity } : {}),
      }),
      diag: {
        id: "local",
        label: `On-device: ${modelLabel}`,
        mock: false,
        reason: "Loads on first use; if WebGPU load fails it falls back to mock text.",
      },
    };
  }
  const key = settings.keys[id];
  const providerLabel = getProvider("text", id)?.label ?? id;
  if (!key) {
    return {
      provider: new MockLLMProvider(),
      diag: { id: "mock", label: MOCK_LABEL, mock: true, reason: `No API key set for ${providerLabel}.` },
    };
  }
  try {
    return {
      provider: createLLMProvider(id, {
        key,
        ...(transport ? { transport } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        // Gemini only: ground technical analysis in Google Search (same Gemini key).
        ...(id === "gemini" && settings.groundFacts ? { ground: true } : {}),
        ...(settings.allowMature ? { allowMature: true } : {}),
      }),
      diag: { id, label: providerLabel, mock: false },
    };
  } catch {
    return {
      provider: new MockLLMProvider(),
      diag: { id: "mock", label: MOCK_LABEL, mock: true, reason: `Couldn't initialise ${providerLabel}.` },
    };
  }
}

function buildImage(
  settings: ReaderSettings,
  transport: Transport | undefined,
  native: boolean,
  /** CORS-exempt transport for the self-hosted local engine (ComfyUI/A1111) — see buildProviders. */
  engineTransport: Transport | undefined,
): BuiltImage {
  const id = settings.imageProvider;
  if (id === "local") {
    // Base URL comes from the desktop shell (auto-managed engine) or, elsewhere,
    // from the server the user connected to in Settings.
    const baseUrl = settings.engineBaseUrl ?? settings.localServerUrl;
    if (!baseUrl) {
      return {
        provider: new MockImageProvider(),
        diag: {
          id: "mock",
          label: MOCK_LABEL,
          mock: true,
          reason: "Local engine isn't connected yet.",
        },
      };
    }
    if (!settings.localModel) {
      return {
        provider: new MockImageProvider(),
        diag: {
          id: "mock",
          label: MOCK_LABEL,
          mock: true,
          reason: "No checkpoint selected — pick a model in Settings.",
        },
      };
    }
    // The ACTIVE engine's protocol: `engineBackend` (set by engine resolution — "comfyui" for the
    // managed engine and for any fallback to it) wins over the user's `localBackend` choice, so a
    // fallback to the managed ComfyUI talks ComfyUI even when the server pick was A1111.
    const isA1111 = (settings.engineBackend ?? settings.localBackend) === "a1111";
    const backend: LocalEngineBackend = isA1111
      ? new Automatic1111Backend({ baseUrl, ...(engineTransport ? { transport: engineTransport } : {}) })
      : new ComfyUIBackend({ baseUrl, ...(engineTransport ? { transport: engineTransport } : {}) });
    return {
      provider: createImageProvider("local", { engine: { backend, model: settings.localModel } }),
      diag: {
        id: "local",
        label: `${isA1111 ? "AUTOMATIC1111" : "ComfyUI"} · ${settings.localModel}`,
        mock: false,
      },
    };
  }
  const key = settings.keys[id];
  const providerLabel = getProvider("image", id)?.label ?? id;
  if (!key) {
    return {
      provider: new MockImageProvider(),
      diag: { id: "mock", label: MOCK_LABEL, mock: true, reason: `No API key set for ${providerLabel}.` },
    };
  }
  try {
    return {
      provider: createImageProvider(id, {
        key,
        ...(transport ? { transport } : {}),
        ...(native ? { native: true } : {}),
        ...(settings.imageModel ? { model: settings.imageModel } : {}),
        ...(settings.allowMature ? { allowMature: true } : {}),
      }),
      diag: {
        id,
        label: native ? `${providerLabel} (native, one API)` : providerLabel,
        mock: false,
      },
    };
  } catch {
    return {
      provider: new MockImageProvider(),
      diag: { id: "mock", label: MOCK_LABEL, mock: true, reason: `Couldn't initialise ${providerLabel}.` },
    };
  }
}

/** WebGPU available in this context (page or worker)? Gates the on-device LLM. */
function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}
