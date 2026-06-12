import { DirectTransport, type Transport } from "../transport/transport.js";
import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import {
  extractionSystemFor,
  promptSystemFor,
  extractionUserContent,
  isEmptyExtraction,
  mergeExtraction,
  promptUserContent,
  stripThink,
} from "./extraction.js";
import { EXTRACTION_JSON_INSTRUCTION, parseExtraction } from "./webllm-provider.js";
import { streamSse } from "./sse.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";
import {
  DEFAULT_CHAT_MAX_TOKENS,
  type ChatCapable,
  type ChatOptions,
  type ChatTurn,
} from "./chat.js";

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
  /** Raw fetch for STREAMING chat (Transport buffers); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
}

interface ModelsResponse {
  data?: { id: string }[];
}

/** Subset of Ollama `/api/show` we use: `model_info` carries the ARCHITECTURAL
 * max ("<arch>.context_length"); `parameters` is the Modelfile parameter dump
 * ("num_ctx 40960\n…") — when present, num_ctx is what Ollama actually LOADS. */
interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
  parameters?: string;
}

/** A local model's context window, as well as it can be known. */
export interface LocalContextInfo {
  /** The context Ollama actually loads (Modelfile `num_ctx`) — trustworthy. */
  loaded?: number;
  /** The architecture's maximum (e.g. llama 3.2 = 131072) — what the model COULD
   * do, NOT what's loaded; budgeting to this overflows a default setup. */
  max?: number;
}

/** One installed local model + its context window in tokens when discoverable. */
export interface LocalModelInfo {
  id: string;
  label: string;
  contextLength?: number;
}

export class LocalServerLLMProvider implements LLMProvider, ChatCapable {
  readonly id = "local-server";
  private readonly transport: Transport;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;

  private readonly fetchImpl: typeof fetch;

  constructor(opts: LocalServerProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const text = await this.complete(
      [
        {
          role: "system",
          content: `${extractionSystemFor(input.contentMode)}\n${EXTRACTION_JSON_INSTRUCTION}`,
        },
        { role: "user", content: extractionUserContent(input) },
      ],
      { json: true, ...(input.signal ? { signal: input.signal } : {}) },
    );
    const raw = parseExtraction(text);
    // Nothing usable parsed — an empty/absent body, truncated/malformed JSON, or a
    // thinking preamble that ate the budget. A JSON extraction always carries at least
    // a summary + keyEvents, so an empty result (incl. an empty body, which would
    // otherwise slip past) means failure. Committing it would leave the chapter's units
    // with no scene prompts — stuck at "waiting to be illustrated" — so FAIL instead:
    // the engine retries once, then the per-chapter prompt pass covers it.
    if (isEmptyExtraction(raw)) {
      throw new Error(
        text.trim()
          ? "Local LLM extraction response was not parseable JSON (likely truncated)."
          : "Local LLM returned an empty extraction response.",
      );
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
    return stripThink(text).trim();
  }

  /** Reading-companion chat. STREAMS deltas to `onToken` (SSE — Ollama/LM Studio
   * both speak OpenAI-style `stream: true`); buffered otherwise. Thinking-model
   * preambles are stripped in both paths — streamed tokens are gated until the
   * `<think>` block closes so reasoning never flashes in the panel. */
  async chat(messages: ChatTurn[], opts: ChatOptions = {}): Promise<string> {
    if (opts.onToken) {
      let full = "";
      let emitted = 0;
      await streamSse(this.fetchImpl, `${this.baseUrl}/chat/completions`, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        body: {
          model: this.model,
          messages,
          temperature: 0.7,
          max_tokens: opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
          keep_alive: "30m",
          stream: true,
        },
        ...(opts.signal ? { signal: opts.signal } : {}),
        onEvent: (e) => {
          const delta = (e as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta
            ?.content;
          if (!delta) return;
          full += delta;
          // Visible text = the reply minus any (possibly still-open) think block.
          const stripped = stripThink(full);
          const visible = stripped.trimStart().startsWith("<think>") ? "" : stripped;
          if (visible.length > emitted) {
            opts.onToken!(visible.slice(emitted));
            emitted = visible.length;
          }
        },
      }).catch((err) => {
        throw new Error(
          `Local LLM server stream failed with ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return stripThink(full).trim();
    }
    const text = await this.complete(messages, {
      json: false,
      maxTokens: opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return stripThink(text).trim();
  }

  private async complete(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    opts: { json: boolean; signal?: AbortSignal; maxTokens?: number },
  ): Promise<string> {
    const json = opts.json;
    const res = await this.transport.send({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: {
        model: this.model,
        messages,
        temperature: json ? 0 : 0.7,
        // Bound the response so a model can't run away (which on a local GPU stalls
        // the whole bible build) — but with real headroom: a long chapter's extraction
        // carries one folded scene prompt PER render unit plus new entities (and a
        // thinking model spends tokens before the JSON), and a truncated response
        // parses to nothing, leaving the chapter with no prompts. A prompt fits
        // comfortably. There is still NO request timeout — a slow-but-working model
        // is never cut off.
        max_tokens: opts.maxTokens ?? (json ? 12288 : 512),
        // Keep the model resident between the many sequential bible calls so the
        // server doesn't unload/reload it each time (Ollama honours `keep_alive`;
        // other OpenAI-compatible servers ignore the extra field).
        keep_alive: "30m",
        ...(json ? { response_format: { type: "json_object" } } : {}),
      },
    });
    if (!res.ok) {
      // Surface the server's own error body — Ollama/LM Studio return a JSON or text
      // reason (model not loaded, out of memory, context exceeded…). A bare status
      // code left the user guessing; a 500 in particular is almost always one of
      // those server-side conditions, not a bug in the request.
      const detail = (await res.text().catch(() => "")).trim();
      const reason = parseServerError(detail);
      const hint =
        res.status === 500
          ? " — the local server hit an error loading or running this model (check it's pulled and your machine has enough memory; see the server's console)."
          : res.status === 404
            ? " — the server doesn't have a model by that name (re-check the model id in Settings)."
            : "";
      throw new Error(
        `Local LLM server request failed with status ${res.status}${reason ? `: ${reason}` : ""}${hint}`,
      );
    }
    const data = await res.json<ChatResponse>();
    const choice = data.choices?.[0];
    // The server cut the response at max_tokens. For the JSON path that means a
    // truncated, unparseable extraction — fail loudly (the engine retries / the
    // prompt pass recovers) rather than silently committing an empty chapter.
    if (json && choice?.finish_reason === "length") {
      throw new Error(
        "Local LLM extraction was truncated at the response limit — the chapter will be retried.",
      );
    }
    return choice?.message?.content ?? "";
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
   * One model's context window via Ollama's `/api/show` — the only place a local
   * server reports it. Returns BOTH signals when present: the Modelfile `num_ctx`
   * (what Ollama actually loads — many recent library models ship one, e.g. qwen3
   * = 40960) and the architectural max. Best-effort: undefined for non-Ollama
   * servers (no such endpoint) or any failure, so callers degrade gracefully.
   */
  static async contextLength(
    baseUrl: string,
    model: string,
    transport?: Transport,
  ): Promise<LocalContextInfo | undefined> {
    const t = transport ?? new DirectTransport();
    try {
      const res = await t.send({
        url: `${ollamaRoot(baseUrl)}/api/show`,
        method: "POST",
        body: { model },
        // Best-effort sizing must never hang the chat turn — a wedged/slow local
        // server would otherwise block the whole request before it even starts.
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return undefined;
      const data = await res.json<OllamaShowResponse>();
      const out: LocalContextInfo = {};
      // Modelfile parameter dump: "num_ctx 40960" on its own line when set.
      const numCtx = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(data.parameters ?? "")?.[1];
      if (numCtx) out.loaded = Number(numCtx);
      // Architecture-prefixed key ("llama.context_length", "qwen3.context_length"…).
      const info = data.model_info ?? {};
      for (const [key, value] of Object.entries(info)) {
        if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
          out.max = value;
          break;
        }
      }
      return out.loaded || out.max ? out : undefined;
    } catch {
      return undefined;
    }
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

/** Pull a human reason out of a server error body: `{"error":{"message":…}}`,
 * `{"error":"…"}`, or plain text. Capped so a giant HTML 500 page can't flood. */
function parseServerError(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const err = parsed.error;
    const msg = typeof err === "string" ? err : (err as { message?: string } | undefined)?.message;
    if (msg) return msg.slice(0, 300);
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
