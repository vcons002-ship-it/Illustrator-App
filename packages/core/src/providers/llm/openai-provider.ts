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
import { streamSse } from "./sse.js";
import {
  DEFAULT_CHAT_MAX_TOKENS,
  type ChatCapable,
  type ChatOptions,
  type ChatTurn,
} from "./chat.js";

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
  /** Raw fetch for STREAMING chat (Transport buffers); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

/** One Chat Completions SSE frame (stream: true). */
interface ChatStreamEvent {
  choices?: { delta?: { content?: string } }[];
}

export class OpenAILLMProvider implements LLMProvider, ChatCapable {
  readonly id = "openai";
  private readonly transport: Transport;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.model = opts.model ?? "gpt-4o-mini";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const text = await this.complete(
      [
        { role: "system", content: extractionSystemFor(input.contentMode) },
        { role: "user", content: extractionUserContent(input) },
      ],
      { json: true, ...(input.signal ? { signal: input.signal } : {}) },
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
    const text = await this.complete(
      [
        { role: "system", content: promptSystemFor(request.kind) },
        { role: "user", content: promptUserContent(request, bible) },
      ],
      { json: false, ...(signal ? { signal } : {}) },
    );
    return text.trim();
  }

  /** Reading-companion chat. STREAMS deltas to `onToken` when the caller wants
   * them (SSE via raw fetch — Transport buffers); buffered otherwise. */
  async chat(messages: ChatTurn[], opts: ChatOptions = {}): Promise<string> {
    if (opts.onToken) {
      let text = "";
      await streamSse(this.fetchImpl, `${this.baseUrl}/chat/completions`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: {
          model: this.model,
          messages,
          max_tokens: opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
          stream: true,
        },
        ...(opts.signal ? { signal: opts.signal } : {}),
        onEvent: (e) => {
          const delta = (e as ChatStreamEvent).choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            opts.onToken!(delta);
          }
        },
      }).catch((err) => {
        throw new Error(`OpenAI chat stream failed with ${err instanceof Error ? err.message : String(err)}`);
      });
      return text.trim();
    }
    const text = await this.complete(messages, {
      json: false,
      maxTokens: opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return text.trim();
  }

  private async complete(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    opts: { json: boolean; signal?: AbortSignal; maxTokens?: number },
  ): Promise<string> {
    const res = await this.transport.send({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: {
        model: this.model,
        messages,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.json
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
