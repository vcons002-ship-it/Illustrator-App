import {
  ComfyUIBackend,
  MockImageProvider,
  MockLLMProvider,
  createImageProvider,
  createLLMProvider,
  type ImageProvider,
  type LLMProvider,
  type TierConfig,
} from "@visual-reader/core";
import type { ReaderSettings } from "@visual-reader/ui";

/**
 * Maps the user's settings to concrete providers. Each slot is independent: the
 * chosen cloud provider is wired when its key is present, the local image path
 * uses the app-managed engine when one is running, and anything unconfigured
 * falls back to the network-free mocks so the app is always usable (demo mode).
 */
export function buildProviders(settings: ReaderSettings): {
  llm: LLMProvider;
  image: ImageProvider;
  tier: TierConfig;
} {
  const llm = buildLLM(settings);
  const image = buildImage(settings);
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

function buildLLM(settings: ReaderSettings): LLMProvider {
  const id = settings.textProvider;
  // Local on-device text (WebLLM) is not wired yet — fall back to the mock so the
  // pipeline keeps working; the seam is ready for it to land.
  if (id === "local") return new MockLLMProvider();
  const key = settings.keys[id];
  if (!key) return new MockLLMProvider();
  try {
    return createLLMProvider(id, { key });
  } catch {
    return new MockLLMProvider();
  }
}

function buildImage(settings: ReaderSettings): ImageProvider {
  const id = settings.imageProvider;
  if (id === "local") {
    // Desktop only: the shell discovers the engine and passes its base URL in.
    if (!settings.engineBaseUrl || !settings.localModel) return new MockImageProvider();
    const backend = new ComfyUIBackend({ baseUrl: settings.engineBaseUrl });
    return createImageProvider("local", { engine: { backend, model: settings.localModel } });
  }
  const key = settings.keys[id];
  if (!key) return new MockImageProvider();
  try {
    return createImageProvider(id, { key });
  } catch {
    return new MockImageProvider();
  }
}
