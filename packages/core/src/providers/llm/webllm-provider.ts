import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";

/**
 * Local (opt-in) LLM provider — on-device inference via WebLLM (Phi-4-mini /
 * Llama-3.2). Stubbed for v1: the interface is fixed so the full implementation
 * can land later (Phase F) with no pipeline changes. Proves the tier seam.
 *
 * Real implementation would lazily import `@mlc-ai/web-llm`, load a model into
 * the WebGPU engine, and mirror ClaudeProvider's extraction/prompt logic.
 */
export class WebLLMProvider implements LLMProvider {
  readonly id = "webllm";

  async extractEntities(_input: EntityExtractionInput): Promise<VisualBible> {
    throw new Error(
      "WebLLMProvider is not implemented yet (local tier — planned for Phase F).",
    );
  }

  async buildImagePrompt(_request: VisualRequest, _bible: VisualBible): Promise<string> {
    throw new Error(
      "WebLLMProvider is not implemented yet (local tier — planned for Phase F).",
    );
  }
}
