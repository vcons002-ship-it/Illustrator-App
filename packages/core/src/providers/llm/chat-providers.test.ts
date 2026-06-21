import { describe, expect, it } from "vitest";
import { GeminiLLMProvider } from "./gemini-provider.js";
import { OpenAILLMProvider } from "./openai-provider.js";
import { LocalServerLLMProvider } from "./local-server-provider.js";
import { WebLLMProvider } from "./webllm-provider.js";
import { MockLLMProvider } from "./mock-llm-provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import {
  MIN_CACHE_PREFIX_CHARS,
  reasoningSoFar,
  supportsChat,
  systemCacheBlocks,
  type ChatTurn,
} from "./chat.js";
import type { Transport, TransportRequest, TransportResponse } from "../transport/transport.js";

class FakeTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly json: unknown) {}
  send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: <T>() => Promise.resolve(this.json as T),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      text: () => Promise.resolve(""),
    });
  }
}

const turns: ChatTurn[] = [
  { role: "system", content: "be helpful" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "what now?" },
];

describe("Gemini mature-mode safetySettings", () => {
  it("sends BLOCK_NONE safetySettings on chat only when allowMature is set", async () => {
    const off = new FakeTransport({ candidates: [{ content: { parts: [{ text: "hi" }] } }] });
    await new GeminiLLMProvider({ apiKey: "k", transport: off }).chat(turns);
    expect((off.requests[0]!.body as { safetySettings?: unknown }).safetySettings).toBeUndefined();

    const on = new FakeTransport({ candidates: [{ content: { parts: [{ text: "hi" }] } }] });
    await new GeminiLLMProvider({ apiKey: "k", transport: on, allowMature: true }).chat(turns);
    const s = (on.requests[0]!.body as { safetySettings: { category: string; threshold: string }[] })
      .safetySettings;
    expect(s).toHaveLength(4);
    expect(s.every((x) => x.threshold === "BLOCK_NONE")).toBe(true);
    expect(s.map((x) => x.category)).toContain("HARM_CATEGORY_SEXUALLY_EXPLICIT");
  });
});

describe("LocalServerLLMProvider chat errors", () => {
  /** Transport that fails with a status + body, to exercise error surfacing. */
  class FailTransport implements Transport {
    readonly requests: TransportRequest[] = [];
    constructor(
      private readonly status: number,
      private readonly body: string,
    ) {}
    send(request: TransportRequest): Promise<TransportResponse> {
      this.requests.push(request);
      return Promise.resolve({
        ok: false,
        status: this.status,
        json: <T>() => Promise.reject(new Error("not json")) as Promise<T>,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        text: () => Promise.resolve(this.body),
      });
    }
  }

  it("surfaces Ollama's error message and a 500 hint", async () => {
    const t = new FailTransport(500, '{"error":"model requires more system memory than is available"}');
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "llama3.2", transport: t });
    await expect(p.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /status 500: model requires more system memory/,
    );
    await expect(p.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/enough memory/);
  });

  it("adds a model-name hint on 404", async () => {
    const t = new FailTransport(404, "model 'llama3.2' not found");
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "llama3.2", transport: t });
    await expect(p.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/status 404.*not found/s);
    await expect(p.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/model id in Settings/);
  });
});

describe("LocalServerLLMProvider.contextLength", () => {
  it("reads BOTH the Modelfile num_ctx (loaded) and the architectural max", async () => {
    const t = new FakeTransport({
      parameters: "stop <|im_end|>\nnum_ctx 40960\ntemperature 0.6",
      model_info: { "qwen3.context_length": 262144, "qwen3.block_count": 32 },
    });
    const ctx = await LocalServerLLMProvider.contextLength("http://localhost:11434/v1", "qwen3", t);
    expect(ctx).toEqual({ loaded: 40960, max: 262144 });
    expect(t.requests[0]!.url).toContain("/api/show");
    expect((t.requests[0]!.body as { model: string }).model).toBe("qwen3");
  });

  it("returns only the architectural max when no num_ctx is set", async () => {
    const t = new FakeTransport({ model_info: { "llama.context_length": 131072 } });
    expect(await LocalServerLLMProvider.contextLength("http://x/v1", "llama3.2", t)).toEqual({
      max: 131072,
    });
  });

  it("returns undefined when neither signal is present", async () => {
    const t = new FakeTransport({ model_info: { "qwen2.block_count": 28 }, parameters: "temperature 0.7" });
    expect(await LocalServerLLMProvider.contextLength("http://x/v1", "qwen2", t)).toBeUndefined();
  });
});

describe("systemCacheBlocks", () => {
  const long = "x".repeat(MIN_CACHE_PREFIX_CHARS);

  it("splits a long-enough prefix into a cached block + uncached remainder", () => {
    expect(systemCacheBlocks(`${long}TAIL`, long)).toEqual([{ text: long, cache: true }, { text: "TAIL" }]);
  });

  it("emits a single cached block when the prefix IS the whole system (buddy case)", () => {
    expect(systemCacheBlocks(long, long)).toEqual([{ text: long, cache: true }]);
  });

  it("does not split a prefix below the minimum length (API ignores it anyway)", () => {
    const short = "x".repeat(MIN_CACHE_PREFIX_CHARS - 1);
    expect(systemCacheBlocks(`${short}TAIL`, short)).toEqual([{ text: `${short}TAIL` }]);
  });

  it("falls back to one uncached block when the prefix isn't actually a prefix", () => {
    expect(systemCacheBlocks(`${long}TAIL`, `${long}DIFFERENT`)).toEqual([{ text: `${long}TAIL` }]);
  });

  it("returns one block when no prefix is given", () => {
    expect(systemCacheBlocks("just the system")).toEqual([{ text: "just the system" }]);
  });
});

describe("reasoningSoFar", () => {
  it("returns the live reasoning inside an unclosed <think> block", () => {
    expect(reasoningSoFar("<think>weighing the\noptions")).toBe("weighing the\noptions");
  });
  it("drops the answer once the think block closes", () => {
    expect(reasoningSoFar("<think>hmm</think>the answer")).toBe("hmm");
  });
  it("falls back to the raw text when there's no think tag yet", () => {
    expect(reasoningSoFar("  starting to reason")).toBe("starting to reason");
  });
});

describe("LocalServerLLMProvider.unload", () => {
  it("asks Ollama to evict the model (keep_alive 0) at the Ollama root", async () => {
    const t = new FakeTransport({});
    const p = new LocalServerLLMProvider({ baseUrl: "http://localhost:11434/v1", model: "qwen3", transport: t });
    await p.unload();
    expect(t.requests[0]!.url).toBe("http://localhost:11434/api/generate");
    expect(t.requests[0]!.body).toEqual({ model: "qwen3", keep_alive: 0 });
  });

  it("never throws when the server isn't Ollama / refuses", async () => {
    const throwing: Transport = { send: () => Promise.reject(new Error("no such endpoint")) };
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", transport: throwing });
    await expect(p.unload()).resolves.toBeUndefined();
  });
});

describe("provider chat()", () => {
  it("openai maps the turns 1:1 onto chat/completions", async () => {
    const t = new FakeTransport({ choices: [{ message: { content: " answer " } }] });
    const p = new OpenAILLMProvider({ apiKey: "k", transport: t });
    expect(await p.chat(turns)).toBe("answer");
    const body = t.requests[0]!.body as { messages: ChatTurn[]; response_format?: unknown };
    expect(body.messages).toEqual(turns);
    expect(body.response_format).toBeUndefined(); // chat is prose, never JSON-mode
  });

  it("local server maps turns 1:1 and strips a thinking preamble", async () => {
    const t = new FakeTransport({
      choices: [{ message: { content: "<think>hmm</think>real answer" } }],
    });
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", transport: t });
    expect(await p.chat(turns)).toBe("real answer");
    const body = t.requests[0]!.body as { messages: ChatTurn[] };
    expect(body.messages).toEqual(turns);
  });

  it("streams with reasoning_effort, retrying WITHOUT it when a strict server rejects it", async () => {
    const sseOk = (deltas: string[]): Response => {
      const lines = [
        ...deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`),
        "data: [DONE]\n\n",
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder();
            for (const l of lines) c.enqueue(enc.encode(l));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const bodies: Array<{ reasoning_effort?: string }> = [];
    let call = 0;
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as { reasoning_effort?: string });
      return ++call === 1 ? new Response("unknown reasoning_effort", { status: 400 }) : sseOk(["hi ", "there"]);
    }) as unknown as typeof fetch;
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    let streamed = "";
    const out = await p.chat(turns, { onToken: (t) => (streamed += t), reasoningEffort: "none" });
    expect(out).toBe("hi there");
    expect(streamed).toBe("hi there");
    expect(bodies[0]!.reasoning_effort).toBe("none"); // first attempt carried the thinking level
    expect(bodies[1]!.reasoning_effort).toBeUndefined(); // strict-server retry dropped it
    expect(call).toBe(2);
  });

  it("gemini maps assistant→model and system→systemInstruction", async () => {
    const t = new FakeTransport({
      candidates: [{ content: { parts: [{ text: "gm" }] } }],
    });
    const p = new GeminiLLMProvider({ apiKey: "k", transport: t });
    expect(await p.chat(turns)).toBe("gm");
    const body = t.requests[0]!.body as {
      systemInstruction?: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
    };
    expect(body.systemInstruction?.parts[0]!.text).toBe("be helpful");
    expect(body.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
  });

  it("webllm streams text deltas through onToken", async () => {
    const p = new WebLLMProvider({
      complete: async (messages, opts) => {
        expect(messages[0]!.role).toBe("system");
        opts.onText?.("hel");
        opts.onText?.("lo");
        return "hello";
      },
    });
    const deltas: string[] = [];
    expect(await p.chat(turns, { onToken: (d) => deltas.push(d) })).toBe("hello");
    expect(deltas).toEqual(["hel", "lo"]);
  });

  it("the mock answers deterministically (keyless demo mode)", async () => {
    const p = new MockLLMProvider();
    const a = await p.chat(turns);
    expect(a).toContain("what now?");
    expect(a).toBe(await p.chat(turns));
  });

  it("claude marks a cache breakpoint after the stable prefix, leaving the volatile tail uncached", async () => {
    let body: { system?: { text: string; cache_control?: unknown }[] } = {};
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      body = JSON.parse(String(init!.body)) as typeof body;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const p = new ClaudeProvider({ apiKey: "k", fetch: fetchImpl });
    const prefix = "STABLE TOOL DEFS AND GUARD. ".repeat(100); // > MIN_CACHE_PREFIX_CHARS
    const system = `${prefix}\n\nVOLATILE book text at the reader's position`;
    await p.chat([{ role: "system", content: system }, { role: "user", content: "hi" }], {
      cachePrefix: prefix,
    });
    expect(body.system).toHaveLength(2);
    expect(body.system![0]!.text).toBe(prefix);
    expect(body.system![0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system![1]!.cache_control).toBeUndefined();
    expect(body.system![1]!.text).toContain("VOLATILE book text");

    // No cachePrefix → a single, uncached system block.
    await p.chat([{ role: "system", content: "be helpful" }, { role: "user", content: "hi" }]);
    expect(body.system).toHaveLength(1);
    expect(body.system![0]!.cache_control).toBeUndefined();
  });

  it("supportsChat guards every in-repo provider", () => {
    expect(supportsChat(new MockLLMProvider())).toBe(true);
    expect(supportsChat(new OpenAILLMProvider({ apiKey: "k" }))).toBe(true);
    expect(supportsChat(new GeminiLLMProvider({ apiKey: "k" }))).toBe(true);
    expect(supportsChat(new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m" }))).toBe(true);
    expect(supportsChat(new WebLLMProvider())).toBe(true);
  });
});
