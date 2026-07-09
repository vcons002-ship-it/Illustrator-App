import { describe, expect, it, vi } from "vitest";
import { LocalServerLLMProvider } from "./local-server-provider.js";
import { nativeToolCallsToText, type ToolSchema } from "./chat.js";
import type { Transport, TransportResponse } from "../transport/transport.js";

/** A fetch that streams the given chunks as a ReadableStream body and records each request. */
function streamingFetch(chunks: string[]): {
  fetchImpl: typeof fetch;
  requests: { url: string; body: unknown }[];
} {
  const requests: { url: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };
  return { fetchImpl, requests };
}

const sseFrame = (e: unknown): string => `data: ${JSON.stringify(e)}\n\n`;
const contentFrame = (content: string): string => sseFrame({ choices: [{ delta: { content } }] });
const toolFrame = (index: number, fn: { name?: string; arguments?: string }): string =>
  sseFrame({ choices: [{ delta: { tool_calls: [{ index, function: fn }] } }] });

describe("nativeToolCallsToText", () => {
  it("serializes object arguments into the app's tool-call text line", () => {
    expect(nativeToolCallsToText([{ function: { name: "create_task", arguments: { title: "buy milk" } } }])).toBe(
      '{"tool":"create_task","title":"buy milk"}',
    );
  });

  it("parses string arguments (some servers return the args as JSON text)", () => {
    expect(nativeToolCallsToText([{ function: { name: "create_task", arguments: '{"title":"x"}' } }])).toBe(
      '{"tool":"create_task","title":"x"}',
    );
  });

  it("still names the tool when the argument string isn't JSON, or args are an array", () => {
    expect(nativeToolCallsToText([{ function: { name: "ping", arguments: "not json{" } }])).toBe('{"tool":"ping"}');
    expect(nativeToolCallsToText([{ function: { name: "ping", arguments: [1, 2] } }])).toBe('{"tool":"ping"}');
  });

  it("accepts the flat {name, arguments} shape", () => {
    expect(nativeToolCallsToText([{ name: "ping", arguments: { a: 1 } }])).toBe('{"tool":"ping","a":1}');
  });

  it("skips nameless calls and joins multiple calls with newlines", () => {
    const text = nativeToolCallsToText([
      { function: { arguments: { lost: true } } }, // no name → dropped
      { function: { name: "a" } },
      { function: { name: "b", arguments: { x: 2 } } },
    ]);
    expect(text).toBe('{"tool":"a"}\n{"tool":"b","x":2}');
  });
});

describe("LocalServerLLMProvider streaming merge (/v1 SSE)", () => {
  it("merges content deltas and tool-call argument fragments split across events and chunks", async () => {
    const frames = [
      contentFrame("On "),
      contentFrame("it."),
      toolFrame(0, { name: "create_task" }),
      toolFrame(0, { arguments: '{"title":' }),
      toolFrame(0, { arguments: '"buy milk"}' }),
      "data: [DONE]\n\n",
    ].join("");
    // Awkward byte boundaries so the SSE re-assembly is exercised alongside the merge.
    const chunks = [frames.slice(0, 45), frames.slice(45, 133), frames.slice(133)];
    const { fetchImpl } = streamingFetch(chunks);
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const tokens: string[] = [];
    const text = await p.chat([{ role: "user", content: "add a task" }], { onToken: (t) => tokens.push(t) });
    // Content streamed as-is; the assembled native call was appended as the text protocol.
    expect(tokens.join("")).toBe("On it.");
    expect(text).toBe('On it.\n{"tool":"create_task","title":"buy milk"}');
  });

  it("keeps two interleaved tool calls separate by index", async () => {
    const frames = [
      toolFrame(0, { name: "create_task" }),
      toolFrame(1, { name: "create_event" }),
      toolFrame(0, { arguments: '{"title":"a"' }),
      toolFrame(1, { arguments: '{"title":"b"}' }),
      toolFrame(0, { arguments: "}" }),
      "data: [DONE]\n\n",
    ].join("");
    const { fetchImpl } = streamingFetch([frames]);
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const text = await p.chat([{ role: "user", content: "both" }], { onToken: () => {} });
    expect(text).toBe('{"tool":"create_task","title":"a"}\n{"tool":"create_event","title":"b"}');
  });

  it("reports a max_tokens cutoff (finish_reason length) via onComplete", async () => {
    const frames =
      contentFrame("partial answ") +
      sseFrame({ choices: [{ delta: {}, finish_reason: "length" }] }) +
      "data: [DONE]\n\n";
    const { fetchImpl } = streamingFetch([frames]);
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    let meta: { truncated: boolean } | undefined;
    const text = await p.chat([{ role: "user", content: "hi" }], {
      onToken: () => {},
      onComplete: (m) => {
        meta = m;
      },
    });
    expect(text).toBe("partial answ");
    expect(meta).toEqual({ truncated: true });
  });

  it("sends the native tool schemas only when the model advertises the tools capability", async () => {
    const show = (caps: string[]): Transport => ({
      send: async (req) => {
        expect(req.url).toBe("http://x/api/show"); // capability probe on the Ollama root
        return {
          ok: true,
          status: 200,
          json: async () => ({ capabilities: caps }),
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as TransportResponse;
      },
    });
    const tools: ToolSchema[] = [
      {
        type: "function",
        function: { name: "create_task", description: "d", parameters: { type: "object", properties: {} } },
      },
    ];
    const frames = contentFrame("ok") + "data: [DONE]\n\n";
    {
      const { fetchImpl, requests } = streamingFetch([frames]);
      const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, transport: show(["tools"]) });
      await p.chat([{ role: "user", content: "hi" }], { onToken: () => {}, tools });
      expect((requests[0]!.body as { tools?: unknown }).tools).toEqual(tools);
    }
    {
      const { fetchImpl, requests } = streamingFetch([frames]);
      const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, transport: show([]) });
      await p.chat([{ role: "user", content: "hi" }], { onToken: () => {}, tools });
      expect((requests[0]!.body as { tools?: unknown }).tools).toBeUndefined();
    }
  });
});

describe("LocalServerLLMProvider Ollama native path (numCtx)", () => {
  it("streams NDJSON from /api/chat, loading the model at the configured window", async () => {
    const lines = [
      JSON.stringify({ message: { content: "Hel" } }),
      JSON.stringify({ message: { content: "lo" } }),
      JSON.stringify({ message: { tool_calls: [{ function: { name: "create_task", arguments: { title: "x" } } }] } }),
      JSON.stringify({ done: true, done_reason: "stop" }),
    ].join("\n");
    // Chunk boundary mid-line so the NDJSON line buffering is exercised.
    const chunks = [lines.slice(0, 10), lines.slice(10)];
    const { fetchImpl, requests } = streamingFetch(chunks);
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, numCtx: 4096 });
    const tokens: string[] = [];
    const text = await p.chat([{ role: "user", content: "hi" }], { onToken: (t) => tokens.push(t) });
    expect(requests[0]!.url).toBe("http://x/api/chat"); // native endpoint, /v1 stripped
    expect(requests[0]!.body).toMatchObject({ stream: true, options: { num_ctx: 4096 } });
    expect(tokens.join("")).toBe("Hello");
    // Native tool_calls (object args) were appended as the app's text protocol.
    expect(text).toBe('Hello\n{"tool":"create_task","title":"x"}');
  });

  it("streams separated `thinking` deltas to onThinking without leaking them into the reply", async () => {
    const lines = [
      JSON.stringify({ message: { thinking: "let me" } }),
      JSON.stringify({ message: { thinking: " think" } }),
      JSON.stringify({ message: { content: "answer" } }),
      JSON.stringify({ done: true }),
    ].join("\n");
    const { fetchImpl } = streamingFetch([lines]);
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, numCtx: 4096 });
    const tokens: string[] = [];
    const thinking: string[] = [];
    const text = await p.chat([{ role: "user", content: "hi" }], {
      onToken: (t) => tokens.push(t),
      onThinking: (t) => thinking.push(t),
    });
    expect(tokens.join("")).toBe("answer");
    expect(text).toBe("answer");
    // onThinking is replace-semantics: the last emission carries the full reasoning so far.
    expect(thinking[thinking.length - 1]).toBe("let me think");
  });

  it("reports done_reason length as truncation for auto-continuation", async () => {
    const lines = [
      JSON.stringify({ message: { content: "partial" } }),
      JSON.stringify({ done: true, done_reason: "length" }),
    ].join("\n");
    const { fetchImpl } = streamingFetch([lines]);
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, numCtx: 4096 });
    let meta: { truncated: boolean } | undefined;
    const text = await p.chat([{ role: "user", content: "hi" }], {
      onToken: () => {},
      onComplete: (m) => {
        meta = m;
      },
    });
    expect(text).toBe("partial");
    expect(meta).toEqual({ truncated: true });
  });
});

describe("LocalServerLLMProvider stream hygiene (R4)", () => {
  it("pullModel cancels the reader (releases the socket) when an error frame throws", async () => {
    let cancelled = false;
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: "pull failed on the server" }) + "\n"));
            // Deliberately DON'T close — only reader.cancel() (in the finally) releases this stream.
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );
    await expect(
      LocalServerLLMProvider.pullModel("http://x", "llama3.2", undefined, fetchImpl),
    ).rejects.toThrow(/pull failed on the server/);
    expect(cancelled).toBe(true); // the socket wasn't left dangling for GC
  });

  it("the native NDJSON /api/chat path bounds the CONNECT phase (a wedged Ollama can't hang the turn)", async () => {
    vi.useFakeTimers();
    // A fetch that never resolves on its own — only the 30s connect-timeout abort rejects it.
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason), { once: true });
      });
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, numCtx: 4096 });
    const promise = p.chat([{ role: "user", content: "hi" }], { onToken: () => {} });
    const assertion = expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    vi.useRealTimers();
  });
});
