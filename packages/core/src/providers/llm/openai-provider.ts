import { DirectTransport, type Transport } from "../transport/transport.js";
import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import {
  EXTRACTION_JSON_SCHEMA,
  extractionSystemFor,
  promptSystemFor,
  type RawExtraction,
  extractionUserContent,
  mergeExtraction,
  promptUserContent,
} from "./extraction.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";

/**
 * Cloud LLM provider backed by OpenAI, for users who bring an OpenAI key.
 *
 * Uses the Chat Completions REST API through the injectable `Transport` seam:
 * extraction requests strict JSON via `response_format: json_schema`; prompt
 * building is a plain completion. Shares the `extraction` helpers with the other
 * providers so behaviour is identical regardless of which one the user picks.
 */

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  /** Override base URL — point at a proxy or Azure/OpenAI-compatible endpoint. */
  baseUrl?: string;
  transport?: Transport;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

export class OpenAILLMProvider implements LLMProvider {
  readonly id = "openai";
  private readonly transport: Transport;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: OpenAIProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.model = opts.model ?? "gpt-4o-mini";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.apiKey = opts.apiKey;
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const text = await this.complete(
      extractionSystemFor(input.contentMode),
      extractionUserContent(input),
      true,
      input.signal,
    );
    let raw: RawExtraction = { characters: [], environments: [], spoilers: [] };
    try {
      raw = { ...raw, ...(JSON.parse(text) as Partial<RawExtraction>) };
    } catch {
      /* fall through with empty extraction; chapter still marked processed */
    }
    return mergeExtraction(input.existing, raw, input.chapterIndex, input.unitRanges);
  }

  async buildImagePrompt(request: VisualRequest, bible: VisualBible, signal?: AbortSignal): Promise<string> {
    const text = await this.complete(promptSystemFor(request.kind), promptUserContent(request, bible), false, signal);
    return text.trim();
  }

  private async complete(system: string, user: string, json: boolean, signal?: AbortSignal): Promise<string> {
    const res = await this.transport.send({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      ...(signal ? { signal } : {}),
      body: {
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(json
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "visual_bible", strict: true, schema: EXTRACTION_JSON_SCHEMA },
              },
            }
          : {}),
      },
    });
    if (!res.ok) throw new Error(`OpenAI request failed with status ${res.status}`);
    const data = await res.json<ChatResponse>();
    return data.choices?.[0]?.message?.content ?? "";
  }
}
