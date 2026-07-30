import { DirectTransport, type Transport } from "../transport/transport.js";
import { MATURE_SAFETY_SETTINGS } from "../gemini-safety.js";
import { bytesToBase64 } from "../image/base64.js";
import { streamSse } from "./sse.js";
import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import {
  EXTRACTION_JSON_SCHEMA,
  extractionSystemFor,
  promptSystemFor,
  type RawExtraction,
  extractionUserContent,
  isEmptyExtraction,
  mergeExtraction,
  promptUserContent,
} from "./extraction.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";
import {
  DEFAULT_CHAT_MAX_TOKENS,
  splitSystem,
  type ChatCapable,
  type ChatOptions,
  type ChatTurn,
  type VisionCapable,
} from "./chat.js";

/**
 * Cloud LLM provider backed by Google Gemini, for users who bring a Gemini key.
 *
 * Uses the REST `generateContent` API through the injectable `Transport` seam
 * (no SDK needed): extraction asks for JSON via `responseJsonSchema`; prompt building
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
  /**
   * Ground TECHNICAL analysis in Google Search (the per-request `google_search` tool,
   * same Gemini key): definitions/quantities come from live sources instead of model
   * memory, and the cited source URLs are folded into the glossary as a per-chapter
   * "References" entry. If a grounded call is rejected (tool/JSON-mode combinations
   * vary by model), it silently retries ungrounded — grounding never breaks analysis.
   */
  ground?: boolean;
  /**
   * Mature mode: send `safetySettings: BLOCK_NONE` so Gemini doesn't filter the
   * explicit/adult content of the book being illustrated and discussed. Off by
   * default — Gemini's standard filters apply.
   */
  allowMature?: boolean;
  /** Raw fetch for STREAMING chat (Transport buffers); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Bound for BUFFERED cloud calls (matches OpenAILLMProvider): generous — a long extraction can
 * take a while — but a dead connection must not hang a chapter forever. Streaming is exempt: it
 * goes through streamSse, which bounds only its connect phase. A caller signal still cancels earlier. */
const CLOUD_REQUEST_TIMEOUT_MS = 120_000;

/** The request timeout composed with an optional caller cancel signal. */
function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    /** Why the candidate stopped — "STOP" is clean; "MAX_TOKENS" means the JSON was truncated. */
    finishReason?: string;
    groundingMetadata?: {
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
    };
  }[];
}

export class GeminiLLMProvider implements LLMProvider, ChatCapable, VisionCapable {
  readonly id = "gemini";
  private readonly transport: Transport;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly ground: boolean;
  private readonly safetySettings?: readonly { category: string; threshold: string }[];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.model = opts.model ?? "gemini-2.0-flash";
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.apiKey = opts.apiKey;
    this.ground = opts.ground ?? false;
    if (opts.allowMature) this.safetySettings = MATURE_SAFETY_SETTINGS;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const technical = input.contentMode === "technical";
    const { text, sources, finishReason } = await this.generate(extractionUserContent(input), {
      system: extractionSystemFor(input.contentMode),
      json: true,
      ground: this.ground && technical,
    });
    let raw: RawExtraction = { characters: [], environments: [], spoilers: [] };
    let parseFailed = false;
    try {
      raw = { ...raw, ...(JSON.parse(text) as Partial<RawExtraction>) };
    } catch {
      parseFailed = true;
    }
    // Grounded facts come with citations — keep them: fold the source URLs into the
    // glossary as a per-chapter References entry (visible in the bible/export). Folded BEFORE the
    // empty-guard so a chapter that yielded only grounded References still counts as real output.
    if (sources.length > 0) {
      raw.glossary = [
        ...(raw.glossary ?? []),
        { term: `References (chapter ${input.chapterIndex + 1})`, definition: sources.join(" · ") },
      ];
    }
    // FAIL rather than commit an empty chapter (matches LocalServerLLMProvider.extractEntities): a
    // parse error, a MAX_TOKENS truncation, or a body that carried nothing usable would otherwise mark
    // the chapter processed with no keyEvents — leaving its units stuck "waiting to be illustrated"
    // forever, with no error and no retry. Throwing lets the engine's retry/recovery kick in.
    if (parseFailed || finishReason === "MAX_TOKENS" || isEmptyExtraction(raw)) {
      throw new Error(
        parseFailed
          ? "Gemini extraction response was not parseable JSON (likely truncated)."
          : finishReason === "MAX_TOKENS"
            ? "Gemini extraction was truncated at the token limit — the chapter will be retried."
            : "Gemini returned an empty extraction response.",
      );
    }
    return mergeExtraction(input.existing, raw, input.chapterIndex, input.unitRanges);
  }

  async buildImagePrompt(request: VisualRequest, bible: VisualBible): Promise<string> {
    const { text } = await this.generate(promptUserContent(request, bible), {
      system: promptSystemFor(request.kind),
      // Grounded prompt-writing for technical units: real stage counts/structures
      // make the visualization plan factually right, not just plausible.
      ground: this.ground && request.kind === "technical_illustration",
    });
    return text.trim();
  }

  /**
   * Reading-companion chat (buffered). Multi-turn: assistant turns map to the
   * API's "model" role, system turns to `systemInstruction`. The chat's own
   * provider-agnostic tool protocol replaces in-call grounding here, so no
   * google_search tool is attached.
   */
  async chat(messages: ChatTurn[], opts: ChatOptions = {}): Promise<string> {
    const { system, turns } = splitSystem(messages);
    const body = {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: turns.map((t) => ({
        role: t.role === "assistant" ? "model" : "user",
        parts: [{ text: t.content }],
      })),
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
        ...(opts.responseFormat === "json"
          ? {
              responseMimeType: "application/json",
              ...(opts.jsonSchema ? { responseJsonSchema: opts.jsonSchema } : {}),
            }
          : {}),
      },
      ...(this.safetySettings ? { safetySettings: this.safetySettings } : {}),
    };
    // STREAMING path (SSE via raw fetch — Transport buffers) when tokens are wanted.
    if (opts.onToken) {
      let text = "";
      await streamSse(
        this.fetchImpl,
        `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse`,
        {
          headers: { "x-goog-api-key": this.apiKey },
          body,
          ...(opts.signal ? { signal: opts.signal } : {}),
          onEvent: (e) => {
            const delta = ((e as GeminiResponse).candidates?.[0]?.content?.parts ?? [])
              .map((p) => p.text ?? "")
              .join("");
            if (delta) {
              text += delta;
              opts.onToken!(delta);
            }
          },
        },
      ).catch((err) => {
        throw new Error(`Gemini chat stream failed with ${err instanceof Error ? err.message : String(err)}`);
      });
      return text.trim();
    }
    const res = await this.transport.send({
      url: `${this.baseUrl}/models/${this.model}:generateContent`,
      method: "POST",
      headers: { "x-goog-api-key": this.apiKey },
      signal: boundedSignal(opts.signal),
      body,
    });
    if (!res.ok) throw new Error(`Gemini chat request failed with status ${res.status}`);
    const data = await res.json<GeminiResponse>();
    return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  }

  /** Vision: look at an image and answer the prompt in text (generateContent). */
  async describeImage(input: {
    bytes: ArrayBuffer;
    mimeType: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const res = await this.transport.send({
      url: `${this.baseUrl}/models/${this.model}:generateContent`,
      method: "POST",
      headers: { "x-goog-api-key": this.apiKey },
      signal: boundedSignal(input.signal),
      body: {
        contents: [
          {
            role: "user",
            parts: [
              { text: input.prompt },
              { inline_data: { mime_type: input.mimeType, data: bytesToBase64(input.bytes) } },
            ],
          },
        ],
        ...(this.safetySettings ? { safetySettings: this.safetySettings } : {}),
      },
    });
    if (!res.ok) throw new Error(`Gemini vision request failed with status ${res.status}`);
    const data = await res.json<GeminiResponse>();
    return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  }

  private async generate(
    userText: string,
    opts: { system: string; json?: boolean; ground?: boolean },
  ): Promise<{ text: string; sources: string[]; finishReason?: string }> {
    const body = (withTool: boolean): Record<string, unknown> => ({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: opts.json
        ? { responseMimeType: "application/json", responseJsonSchema: EXTRACTION_JSON_SCHEMA }
        : {},
      ...(withTool ? { tools: [{ google_search: {} }] } : {}),
      ...(this.safetySettings ? { safetySettings: this.safetySettings } : {}),
    });
    const url = `${this.baseUrl}/models/${this.model}:generateContent`;
    // API key in the header, not the `?key=` query string (query strings get logged by proxies / devtools).
    const headers = { "x-goog-api-key": this.apiKey };
    let res = await this.transport.send({ url, method: "POST", headers, body: body(opts.ground === true), signal: boundedSignal() });
    // Some model/mode combinations reject tools alongside JSON output (a 400) — retry
    // plain rather than failing the chapter (grounding is an enhancement, never a
    // gate). Only on 400: a 429/5xx would fail ungrounded too, and re-sending the
    // full chapter immediately doubles traffic exactly when the API is saturated.
    if (!res.ok && res.status === 400 && opts.ground) {
      res = await this.transport.send({ url, method: "POST", headers, body: body(false), signal: boundedSignal() });
    }
    if (!res.ok) throw new Error(`Gemini request failed with status ${res.status}`);
    const data = await res.json<GeminiResponse>();
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => c.web?.uri)
      .filter((u): u is string => Boolean(u))
      .filter((u, i, all) => all.indexOf(u) === i)
      .slice(0, 5);
    return { text, sources, ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}) };
  }
}
