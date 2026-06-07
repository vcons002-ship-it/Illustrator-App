import type { TierConfig } from "../types/tier.js";
import { ClaudeProvider } from "./llm/claude-provider.js";
import { MockLLMProvider } from "./llm/mock-llm-provider.js";
import { WebLLMProvider } from "./llm/webllm-provider.js";
import type { LLMProvider } from "./llm/llm-provider.js";
import { FluxProvider } from "./image/flux-provider.js";
import { MockImageProvider } from "./image/mock-image-provider.js";
import { OnnxDiffusionProvider } from "./image/onnx-provider.js";
import type { ImageProvider } from "./image/image-provider.js";

/**
 * Resolves the concrete LLM + image providers for a tier config. This is the
 * single place that maps a provider key ("claude", "flux", "mock", …) to an
 * implementation, so front-ends select a tier without importing providers
 * directly. Adding a provider = one case here; no pipeline changes.
 */

export interface ProviderKeys {
  /** API key / token for the selected LLM provider, when it needs one. */
  llmKey?: string;
  /** API key / token for the selected image provider, when it needs one. */
  imageKey?: string;
}

export function createLLMProvider(config: TierConfig, keys: ProviderKeys): LLMProvider {
  switch (config.llmProvider) {
    case "claude":
      return new ClaudeProvider({ apiKey: requireKey(keys.llmKey, "claude") });
    case "webllm":
      return new WebLLMProvider();
    case "mock":
      return new MockLLMProvider();
    default:
      throw new Error(`Unknown LLM provider: ${config.llmProvider}`);
  }
}

export function createImageProvider(config: TierConfig, keys: ProviderKeys): ImageProvider {
  switch (config.imageProvider) {
    case "flux":
      return new FluxProvider({ apiKey: requireKey(keys.imageKey, "flux") });
    case "onnx-webgpu":
      return new OnnxDiffusionProvider();
    case "mock":
      return new MockImageProvider();
    default:
      throw new Error(`Unknown image provider: ${config.imageProvider}`);
  }
}

function requireKey(key: string | undefined, provider: string): string {
  if (!key) throw new Error(`Missing API key for provider "${provider}"`);
  return key;
}
