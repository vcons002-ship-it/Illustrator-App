import { DirectTransport, type Transport } from "../transport/transport.js";
import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import {
  EXTRACTION_SYSTEM,
  PROMPT_SYSTEM,
  extractionUserContent,
  mergeExtraction,
  promptUserContent,
  stripThink,
} from "./extraction.js";
import { EXTRACTION_JSON_INSTRUCTION, parseExtraction } from "./webllm-provider.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";

/**
 * Local LLM server provider — talks to an OpenAI-compatible server running on the
 * user's machine (Ollama, LM Studio, llama.cpp, …) over `/v1/chat/completions`.
 *
 * This is the reliable alternative to the on-device WebGPU path (`WebLLMProvider`):
 * the model runs as a normal local process, so there's no browser weight download
 * and no WebGPU. Unlike `OpenAILLMProvider` (which uses strict `json_schema`, that
 * local servers reject), extraction asks for `response_format: json_object` and
 * parses with the tolerant `parseExtraction`, so small/loose models still work.
 *
 * The `Transport` seam is injected, so the same code runs in tests (fake
 * transport), in the web app (direct fetch to localhost), and in the Chrome
 * extension (proxied through the background worker to bypass page CORS).
 */

export interface LocalServerProviderOptions {
  /** Base URL of the server, e.g. http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  /** Model id the server exposes, e.g. "llama3.2". */
  model: string;
  /** Optional bearer token — Ollama/LM Studio ignore it; proxies may need it. */
  apiKey?: string;
  transport?: Transport;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

interface ModelsResponse {
  data?: { id: string }[];
}

export class LocalServerLLMProvider implements LLMProvider {
  readonly id = "local-server";
  private readonly transport: Transport;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(opts: LocalServerProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const text = await this.complete(
      `${EXTRACTION_SYSTEM}\n${EXTRACTION_JSON_INSTRUCTION}`,
      extractionUserContent(input),
      true,
      input.signal,
    );
    return mergeExtraction(input.existing, parseExtraction(text), input.chapterIndex, input.unitRanges);
  }

  async buildImagePrompt(request: VisualRequest, bible: VisualBible, signal?: AbortSignal): Promise<string> {
    const text = await this.complete(PROMPT_SYSTEM, promptUserContent(request, bible), false, signal);
    return stripThink(text).trim();
  }

  private async complete(system: string, user: string, json: boolean, signal?: AbortSignal): Promise<string> {
    const res = await this.transport.send({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      ...(signal ? { signal } : {}),
      body: {
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: json ? 0 : 0.7,
        // Bound the response so a model can't run away generating an enormous JSON
        // blob (which on a local GPU stalls the whole bible build). The extraction
        // schema is small; a prompt fits comfortably. There is still NO request
        // timeout — a slow-but-working model is never cut off.
        max_tokens: json ? 4096 : 512,
        // Keep the model resident between the many sequential bible calls so the
        // server doesn't unload/reload it each time (Ollama honours `keep_alive`;
        // other OpenAI-compatible servers ignore the extra field).
        keep_alive: "30m",
        ...(json ? { response_format: { type: "json_object" } } : {}),
      },
    });
    if (!res.ok) throw new Error(`Local LLM server request failed with status ${res.status}`);
    const data = await res.json<ChatResponse>();
    return data.choices?.[0]?.message?.content ?? "";
  }

  /**
   * List the models the server exposes (GET /models), for the Settings "Connect"
   * flow — mirrors `ComfyUIBackend.listModels()`. Static because the connect step
   * runs before a provider instance/model is chosen.
   */
  static async listModels(
    baseUrl: string,
    transport?: Transport,
  ): Promise<{ id: string; label: string }[]> {
    const t = transport ?? new DirectTransport();
    const res = await t.send({ url: `${baseUrl.replace(/\/$/, "")}/models`, method: "GET" });
    if (!res.ok) throw new Error(`Local LLM server listModels failed with status ${res.status}`);
    const data = await res.json<ModelsResponse>();
    return (data.data ?? []).map((m) => ({ id: m.id, label: m.id }));
  }

  /**
   * Download a model INTO Ollama (`POST /api/pull`, an Ollama-native endpoint below
   * the OpenAI-compatible `/v1`), streaming NDJSON progress so the Settings menu can
   * show a live bar — no terminal `ollama pull` needed. Server-side the pull is
   * resumable: re-calling after an interruption continues where it left off.
   *
   * Uses a raw `fetch` (injectable for tests) rather than the `Transport` seam
   * because Transport buffers whole responses — no streaming. Hosts that can't
   * stream (the extension's proxy) use `pullModelViaTransport` instead.
   */
  static async pullModel(
    baseUrl: string,
    model: string,
    onProgress?: (p: OllamaPullProgress) => void,
    fetchImpl: typeof fetch = fetch,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetchImpl(`${ollamaRoot(baseUrl)}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`Ollama pull failed with status ${res.status}`);
    const emit = (line: string): void => {
      if (!line.trim()) return;
      let msg: { status?: string; error?: string; total?: number; completed?: number };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return; // tolerate partial/malformed frames
      }
      if (msg.error) throw new Error(msg.error);
      onProgress?.({
        status: msg.status ?? "downloading",
        ...(msg.total ? { percent: ((msg.completed ?? 0) / msg.total) * 100 } : {}),
      });
    };
    if (!res.body) {
      // No streaming support — fall back to parsing the buffered NDJSON at the end.
      (await res.text()).split("\n").forEach(emit);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(emit);
    }
    emit(buffer);
  }

  /**
   * Non-streaming pull (`stream: false` — the response arrives once the model is
   * fully downloaded) for hosts whose network goes through a buffering `Transport`
   * proxy (the extension). No live progress; the caller shows an indeterminate state.
   */
  static async pullModelViaTransport(
    baseUrl: string,
    model: string,
    transport: Transport,
  ): Promise<void> {
    const res = await transport.send({
      url: `${ollamaRoot(baseUrl)}/api/pull`,
      method: "POST",
      body: { model, stream: false },
    });
    if (!res.ok) throw new Error(`Ollama pull failed with status ${res.status}`);
    const data = await res.json<{ status?: string; error?: string }>();
    if (data.error) throw new Error(data.error);
  }
}

/** Live progress for an Ollama model pull. */
export interface OllamaPullProgress {
  /** Ollama's phase text, e.g. "pulling manifest", "downloading", "success". */
  status: string;
  /** 0..100 when the current layer reports sizes. */
  percent?: number;
}

/** Ollama's API root from a configured base URL (strips the OpenAI-compat `/v1`). */
function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
}
