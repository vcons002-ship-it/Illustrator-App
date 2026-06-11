import { ClaudeProvider } from "./llm/claude-provider.js";
import { GeminiLLMProvider } from "./llm/gemini-provider.js";
import { OpenAILLMProvider } from "./llm/openai-provider.js";
import { MockLLMProvider } from "./llm/mock-llm-provider.js";
import { WebLLMProvider } from "./llm/webllm-provider.js";
import { LocalServerLLMProvider } from "./llm/local-server-provider.js";
import { DEFAULT_LOCAL_SERVER_TEXT_MODEL } from "./catalog.js";
import type { LLMProvider } from "./llm/llm-provider.js";
import { FluxProvider } from "./image/flux-provider.js";
import { GeminiNativeImageProvider } from "./image/gemini-native-image-provider.js";
import { OpenAIImageProvider } from "./image/openai-image-provider.js";
import { OpenAINativeImageProvider } from "./image/openai-native-image-provider.js";
import { MockImageProvider } from "./image/mock-image-provider.js";
import { ManagedEngineImageProvider } from "./image/local-engine/managed-engine-provider.js";
import type { LocalEngineBackend } from "./image/local-engine/backend.js";
import type { ImageProvider } from "./image/image-provider.js";
import type { Transport } from "./transport/transport.js";

/**
 * Resolves the concrete LLM + image providers from a provider id. This is the
 * single place that maps an id ("claude", "gemini", "flux", "local", …) to an
 * implementation, so front-ends pick a provider by id and never import providers
 * directly. Adding a provider = one case here. Callers (see buildProviders) decide
 * what to do when a key is missing (typically: fall back to the mock).
 *
 * `transport` / `fetch` are optional injection points: hosts that cannot call
 * provider APIs directly (the Chrome extension content script, blocked by page
 * CORS) pass a transport/fetch that proxies through a privileged context.
 */

export interface LLMProviderOptions {
  /** API key for the selected provider, when it needs one. */
  key?: string;
  /** Transport for the REST-based providers (Gemini / OpenAI / local server). */
  transport?: Transport;
  /** Custom fetch for the SDK-based provider (Claude). */
  fetch?: typeof fetch;
  /** Base URL for the local LLM server (required for id === "local-server"). */
  baseUrl?: string;
  /** Model id for the local LLM server. */
  model?: string;
}

export interface ImageProviderOptions {
  /** API key for the selected provider, when it needs one. */
  key?: string;
  /** App-managed local engine + chosen model (required for id === "local"). */
  engine?: { backend: LocalEngineBackend; model: string };
  /** Transport for the REST-based providers (Flux / Gemini / OpenAI). */
  transport?: Transport;
  /**
   * "One API" native mode: use the same vendor's MULTIMODAL image endpoint (which
   * accepts character reference photos) instead of the plain text-to-image path.
   * Only gemini/openai have a native variant; ignored for other ids.
   */
  native?: boolean;
  /** Pin a specific cloud model id (advanced). When unset, Gemini auto-selects the
   * best image model the key can access; other providers use their default. */
  model?: string;
}

export function createLLMProvider(id: string, opts: LLMProviderOptions = {}): LLMProvider {
  const transport = opts.transport;
  switch (id) {
    case "claude":
      return new ClaudeProvider({
        apiKey: requireKey(opts.key, "claude"),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
    case "gemini":
      return new GeminiLLMProvider({ apiKey: requireKey(opts.key, "gemini"), ...(transport ? { transport } : {}) });
    case "openai":
      return new OpenAILLMProvider({ apiKey: requireKey(opts.key, "openai"), ...(transport ? { transport } : {}) });
    case "local":
      return new WebLLMProvider();
    case "local-server": {
      if (!opts.baseUrl) throw new Error("Local LLM server requires a base URL");
      return new LocalServerLLMProvider({
        baseUrl: opts.baseUrl,
        model: opts.model ?? DEFAULT_LOCAL_SERVER_TEXT_MODEL,
        ...(opts.key ? { apiKey: opts.key } : {}),
        ...(transport ? { transport } : {}),
      });
    }
    case "mock":
      return new MockLLMProvider();
    default:
      throw new Error(`Unknown LLM provider: ${id}`);
  }
}

export function createImageProvider(id: string, opts: ImageProviderOptions = {}): ImageProvider {
  const transport = opts.transport;
  switch (id) {
    case "flux":
      return new FluxProvider({ apiKey: requireKey(opts.key, "flux"), ...(transport ? { transport } : {}) });
    case "gemini":
      // Multimodal generateContent (auto-selects the best image model the key can access —
      // Nano Banana Pro if available, else Flash): works on a standard key AND accepts
      // character reference photos. The Imagen :predict path is paid-tier only and 404s for
      // most keys, so it is no longer wired as a default.
      return new GeminiNativeImageProvider({
        apiKey: requireKey(opts.key, "gemini"),
        ...(opts.model ? { model: opts.model } : {}),
        ...(transport ? { transport } : {}),
      });
    case "openai":
      return opts.native
        ? new OpenAINativeImageProvider({ apiKey: requireKey(opts.key, "openai"), ...(transport ? { transport } : {}) })
        : new OpenAIImageProvider({ apiKey: requireKey(opts.key, "openai"), ...(transport ? { transport } : {}) });
    case "local": {
      if (!opts.engine) throw new Error("Local image provider requires a running engine");
      return new ManagedEngineImageProvider(opts.engine.backend, opts.engine.model);
    }
    case "mock":
      return new MockImageProvider();
    default:
      throw new Error(`Unknown image provider: ${id}`);
  }
}

function requireKey(key: string | undefined, provider: string): string {
  if (!key) throw new Error(`Missing API key for provider "${provider}"`);
  return key;
}
