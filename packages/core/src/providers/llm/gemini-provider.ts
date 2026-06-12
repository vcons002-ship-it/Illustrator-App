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
import {
  DEFAULT_CHAT_MAX_TOKENS,
  splitSystem,
  type ChatCapable,
  type ChatOptions,
  type ChatTurn,
} from "./chat.js";

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
  /**
   * Ground TECHNICAL analysis in Google Search (the per-request `google_search` tool,
   * same Gemini key): definitions/quantities come from live sources instead of model
   * memory, and the cited source URLs are folded into the glossary as a per-chapter
   * "References" entry. If a grounded call is rejected (tool/JSON-mode combinations
   * vary by model), it silently retries ungrounded — grounding never breaks analysis.
   */
  ground?: boolean;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: {
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
    };
  }[];
}

export class GeminiLLMProvider implements LLMProvider, ChatCapable {
  readonly id = "gemini";
  private readonly transport: Transport;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly ground: boolean;

  constructor(opts: GeminiProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.model = opts.model ?? "gemini-2.0-flash";
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.apiKey = opts.apiKey;
    this.ground = opts.ground ?? false;
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const technical = input.contentMode === "technical";
    const { text, sources } = await this.generate(extractionUserContent(input), {
      system: extractionSystemFor(input.contentMode),
      json: true,
      ground: this.ground && technical,
    });
    let raw: RawExtraction = { characters: [], environments: [], spoilers: [] };
    try {
      raw = { ...raw, ...(JSON.parse(text) as Partial<RawExtraction>) };
    } catch {
      /* fall through with empty extraction; chapter still marked processed */
    }
    // Grounded facts come with citations — keep them: fold the source URLs into the
    // glossary as a per-chapter References entry (visible in the bible/export).
    if (sources.length > 0) {
      raw.glossary = [
        ...(raw.glossary ?? []),
        { term: `References (chapter ${input.chapterIndex + 1})`, definition: sources.join(" · ") },
      ];
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
    const res = await this.transport.send({
      url: `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      method: "POST",
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: turns.map((t) => ({
          role: t.role === "assistant" ? "model" : "user",
          parts: [{ text: t.content }],
        })),
        generationConfig: { maxOutputTokens: opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS },
      },
    });
    if (!res.ok) throw new Error(`Gemini chat request failed with status ${res.status}`);
    const data = await res.json<GeminiResponse>();
    return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  }

  private async generate(
    userText: string,
    opts: { system: string; json?: boolean; ground?: boolean },
  ): Promise<{ text: string; sources: string[] }> {
    const body = (withTool: boolean): Record<string, unknown> => ({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: opts.json
        ? { responseMimeType: "application/json", responseSchema: EXTRACTION_JSON_SCHEMA }
        : {},
      ...(withTool ? { tools: [{ google_search: {} }] } : {}),
    });
    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
    let res = await this.transport.send({ url, method: "POST", body: body(opts.ground === true) });
    // Some model/mode combinations reject tools alongside JSON output (a 400) — retry
    // plain rather than failing the chapter (grounding is an enhancement, never a
    // gate). Only on 400: a 429/5xx would fail ungrounded too, and re-sending the
    // full chapter immediately doubles traffic exactly when the API is saturated.
    if (!res.ok && res.status === 400 && opts.ground) {
      res = await this.transport.send({ url, method: "POST", body: body(false) });
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
    return { text, sources };
  }
}
