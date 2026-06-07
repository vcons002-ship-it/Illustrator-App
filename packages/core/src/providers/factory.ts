import { ClaudeProvider } from "./llm/claude-provider.js";
import { GeminiLLMProvider } from "./llm/gemini-provider.js";
import { OpenAILLMProvider } from "./llm/openai-provider.js";
import { MockLLMProvider } from "./llm/mock-llm-provider.js";
import { WebLLMProvider } from "./llm/webllm-provider.js";
import type { LLMProvider } from "./llm/llm-provider.js";
import { FluxProvider } from "./image/flux-provider.js";
import { GeminiImageProvider } from "./image/gemini-image-provider.js";
import { OpenAIImageProvider } from "./image/openai-image-provider.js";
import { MockImageProvider } from "./image/mock-image-provider.js";
import { ManagedEngineImageProvider } from "./image/local-engine/managed-engine-provider.js";
import type { LocalEngineBackend } from "./image/local-engine/backend.js";
import type { ImageProvider } from "./image/image-provider.js";

/**
 * Resolves the concrete LLM + image providers from a provider id. This is the
 * single place that maps an id ("claude", "gemini", "flux", "local", …) to an
 * implementation, so front-ends pick a provider by id and never import providers
 * directly. Adding a provider = one case here. Callers (see buildProviders) decide
 * what to do when a key is missing (typically: fall back to the mock).
 */

export interface LLMProviderOptions {
  /** API key for the selected provider, when it needs one. */
  key?: string;
}

export interface ImageProviderOptions {
  /** API key for the selected provider, when it needs one. */
  key?: string;
  /** App-managed local engine + chosen model (required for id === "local"). */
  engine?: { backend: LocalEngineBackend; model: string };
}

export function createLLMProvider(id: string, opts: LLMProviderOptions = {}): LLMProvider {
  switch (id) {
    case "claude":
      return new ClaudeProvider({ apiKey: requireKey(opts.key, "claude") });
    case "gemini":
      return new GeminiLLMProvider({ apiKey: requireKey(opts.key, "gemini") });
    case "openai":
      return new OpenAILLMProvider({ apiKey: requireKey(opts.key, "openai") });
    case "local":
      return new WebLLMProvider();
    case "mock":
      return new MockLLMProvider();
    default:
      throw new Error(`Unknown LLM provider: ${id}`);
  }
}

export function createImageProvider(id: string, opts: ImageProviderOptions = {}): ImageProvider {
  switch (id) {
    case "flux":
      return new FluxProvider({ apiKey: requireKey(opts.key, "flux") });
    case "gemini":
      return new GeminiImageProvider({ apiKey: requireKey(opts.key, "gemini") });
    case "openai":
      return new OpenAIImageProvider({ apiKey: requireKey(opts.key, "openai") });
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
