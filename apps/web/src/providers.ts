import {
  ClaudeProvider,
  FluxProvider,
  MockImageProvider,
  MockLLMProvider,
  DEFAULT_TIER_CONFIG,
  type ImageProvider,
  type LLMProvider,
  type TierConfig,
} from "@visual-reader/core";
import type { ReaderSettings } from "@visual-reader/ui";

/**
 * Maps the user's settings to concrete providers. With cloud keys present we
 * wire Claude + Flux; otherwise we fall back to the network-free mocks so the
 * app is fully usable for a demo with no keys.
 */
export function buildProviders(settings: ReaderSettings): {
  llm: LLMProvider;
  image: ImageProvider;
  tier: TierConfig;
} {
  const hasCloudKeys = settings.tier === "cloud" && settings.llmKey && settings.imageKey;
  if (hasCloudKeys) {
    return {
      llm: new ClaudeProvider({ apiKey: settings.llmKey }),
      image: new FluxProvider({ apiKey: settings.imageKey }),
      tier: DEFAULT_TIER_CONFIG,
    };
  }
  return {
    llm: new MockLLMProvider(),
    image: new MockImageProvider(),
    tier: { tier: "cloud", llmProvider: "mock", imageProvider: "mock", quality: "sketch" },
  };
}
