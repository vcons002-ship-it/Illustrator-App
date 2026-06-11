import { DirectTransport, type Transport } from "../transport/transport.js";
import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM,
  promptSystemFor,
  type RawExtraction,
  extractionUserContent,
  mergeExtraction,
  promptUserContent,
} from "./extraction.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";

/**
 * Cloud LLM provider backed by Google Gemini, for users who bring a Gemini key.
 *
 * Uses the REST `generateContent` API through the injectable `Transport` seam
 * (no SDK needed): extraction asks for JSON via `responseSchema`; prompt building
 * is a plain completion. Behaviour matches ClaudeProvider via the shared
 * `extraction` helpers, so swapping providers does not change results.
 */

export interface GeminiProviderOptions {
  apiKey: string;
  /** Gemini model id. Flash is fast + cheap and good enough for extraction. */
  model?: string;
  /** Override base URL — point at a proxy when server-ready. */
  baseUrl?: string;
  transport?: Transport;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export class GeminiLLMProvider implements LLMProvider {
  readonly id = "gemini";
  private readonly transport: Transport;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: GeminiProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.model = opts.model ?? "gemini-2.0-flash";
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.apiKey = opts.apiKey;
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const text = await this.generate(extractionUserContent(input), {
      system: EXTRACTION_SYSTEM,
      json: true,
    });
    let raw: RawExtraction = { characters: [], environments: [], spoilers: [] };
    try {
      raw = { ...raw, ...(JSON.parse(text) as Partial<RawExtraction>) };
    } catch {
      /* fall through with empty extraction; chapter still marked processed */
    }
    return mergeExtraction(input.existing, raw, input.chapterIndex, input.unitRanges);
  }

  async buildImagePrompt(request: VisualRequest, bible: VisualBible): Promise<string> {
    const text = await this.generate(promptUserContent(request, bible), { system: promptSystemFor(request.kind) });
    return text.trim();
  }

  private async generate(userText: string, opts: { system: string; json?: boolean }): Promise<string> {
    const res = await this.transport.send({
      url: `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      method: "POST",
      body: {
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: opts.json
          ? { responseMimeType: "application/json", responseSchema: EXTRACTION_JSON_SCHEMA }
          : {},
      },
    });
    if (!res.ok) throw new Error(`Gemini request failed with status ${res.status}`);
    const data = await res.json<GeminiResponse>();
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
  }
}
