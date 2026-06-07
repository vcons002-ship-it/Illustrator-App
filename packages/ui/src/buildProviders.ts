import {
  Automatic1111Backend,
  ComfyUIBackend,
  DirectTransport,
  MockImageProvider,
  MockLLMProvider,
  createImageProvider,
  createLLMProvider,
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
 */
export interface BuildProvidersOptions {
  /** Proxy fetch routed through a CORS-exempt context (e.g. an extension SW). */
  fetch?: typeof fetch;
}

export function buildProviders(
  settings: ReaderSettings,
  opts: BuildProvidersOptions = {},
): { llm: LLMProvider; image: ImageProvider; tier: TierConfig } {
  const transport: Transport | undefined = opts.fetch ? new DirectTransport(opts.fetch) : undefined;
  const llm = buildLLM(settings, transport, opts.fetch);
  const image = buildImage(settings, transport);
  return {
    llm,
    image,
    tier: {
      tier: settings.imageProvider === "local" ? "local" : "cloud",
      llmProvider: llm.id,
      imageProvider: image.id,
      quality: image.id === "mock" ? "sketch" : image.id === "local" ? "standard" : "cinematic",
    },
  };
}

function buildLLM(
  settings: ReaderSettings,
  transport: Transport | undefined,
  fetchImpl: typeof fetch | undefined,
): LLMProvider {
  const id = settings.textProvider;
  // Local on-device text (WebLLM) is not wired yet — fall back to the mock so the
  // pipeline keeps working; the seam is ready for it to land.
  if (id === "local") return new MockLLMProvider();
  const key = settings.keys[id];
  if (!key) return new MockLLMProvider();
  try {
    return createLLMProvider(id, {
      key,
      ...(transport ? { transport } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  } catch {
    return new MockLLMProvider();
  }
}

function buildImage(settings: ReaderSettings, transport: Transport | undefined): ImageProvider {
  const id = settings.imageProvider;
  if (id === "local") {
    // Base URL comes from the desktop shell (auto-managed engine) or, elsewhere,
    // from the server the user connected to in Settings.
    const baseUrl = settings.engineBaseUrl ?? settings.localServerUrl;
    if (!baseUrl || !settings.localModel) return new MockImageProvider();
    const backend: LocalEngineBackend =
      settings.localBackend === "a1111"
        ? new Automatic1111Backend({ baseUrl, ...(transport ? { transport } : {}) })
        : new ComfyUIBackend({ baseUrl, ...(transport ? { transport } : {}) });
    return createImageProvider("local", { engine: { backend, model: settings.localModel } });
  }
  const key = settings.keys[id];
  if (!key) return new MockImageProvider();
  try {
    return createImageProvider(id, { key, ...(transport ? { transport } : {}) });
  } catch {
    return new MockImageProvider();
  }
}
