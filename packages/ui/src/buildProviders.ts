import {
  Automatic1111Backend,
  ComfyUIBackend,
  DirectTransport,
  LOCAL_TEXT_MODELS,
  MockImageProvider,
  MockLLMProvider,
  WebLLMProvider,
  createImageProvider,
  createLLMProvider,
  getProvider,
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
): { llm: LLMProvider; image: ImageProvider; tier: TierConfig; diagnostics: ProvidersDiagnostics } {
  const transport: Transport | undefined = opts.fetch ? new DirectTransport(opts.fetch) : undefined;
  const llm = buildLLM(settings, transport, opts.fetch, opts.onLocalStatus, opts.onLocalActivity);
  const image = buildImage(settings, transport);
  return {
    llm: llm.provider,
    image: image.provider,
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
      style: settings.imageStyle ?? "auto",
    },
  };
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
    // Local server (Ollama / LM Studio / llama.cpp) — an OpenAI-compatible server
    // the user runs themselves. Reliable alternative to WebGPU; mock when not set up.
    if (settings.localTextBackend === "server") {
      const baseUrl = settings.localServerTextUrl;
      if (!baseUrl) {
        return {
          provider: new MockLLMProvider(),
          diag: {
            id: "mock",
            label: MOCK_LABEL,
            mock: true,
            reason: "Local LLM server isn't connected — click Connect in Settings.",
          },
        };
      }
      const serverModel = settings.localServerTextModel;
      try {
        return {
          provider: createLLMProvider("local-server", {
            baseUrl,
            ...(serverModel ? { model: serverModel } : {}),
            ...(transport ? { transport } : {}),
          }),
          diag: {
            id: "local-server",
            label: `Local server: ${serverModel ?? "default model"}`,
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
            reason: "Couldn't initialise the local LLM server.",
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

function buildImage(settings: ReaderSettings, transport: Transport | undefined): BuiltImage {
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
    const isA1111 = settings.localBackend === "a1111";
    const backend: LocalEngineBackend = isA1111
      ? new Automatic1111Backend({ baseUrl, ...(transport ? { transport } : {}) })
      : new ComfyUIBackend({ baseUrl, ...(transport ? { transport } : {}) });
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
      provider: createImageProvider(id, { key, ...(transport ? { transport } : {}) }),
      diag: { id, label: providerLabel, mock: false },
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
