import { describe, expect, it } from "vitest";
import { GeminiLLMProvider } from "./gemini-provider.js";
import { OpenAILLMProvider } from "./openai-provider.js";
import { LocalServerLLMProvider } from "./local-server-provider.js";
import { WebLLMProvider } from "./webllm-provider.js";
import { MockLLMProvider } from "./mock-llm-provider.js";
import { supportsChat, type ChatTurn } from "./chat.js";
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

describe("LocalServerLLMProvider.contextLength", () => {
  it("reads the architecture-prefixed context_length from /api/show", async () => {
    const t = new FakeTransport({ model_info: { "llama.context_length": 131072, "llama.block_count": 32 } });
    const ctx = await LocalServerLLMProvider.contextLength("http://localhost:11434/v1", "llama3.2", t);
    expect(ctx).toBe(131072);
    expect(t.requests[0]!.url).toContain("/api/show");
    expect((t.requests[0]!.body as { model: string }).model).toBe("llama3.2");
  });

  it("returns undefined when no context_length key is present", async () => {
    const t = new FakeTransport({ model_info: { "qwen2.block_count": 28 } });
    expect(await LocalServerLLMProvider.contextLength("http://x/v1", "qwen2", t)).toBeUndefined();
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

  it("supportsChat guards every in-repo provider", () => {
    expect(supportsChat(new MockLLMProvider())).toBe(true);
    expect(supportsChat(new OpenAILLMProvider({ apiKey: "k" }))).toBe(true);
    expect(supportsChat(new GeminiLLMProvider({ apiKey: "k" }))).toBe(true);
    expect(supportsChat(new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m" }))).toBe(true);
    expect(supportsChat(new WebLLMProvider())).toBe(true);
  });
});
