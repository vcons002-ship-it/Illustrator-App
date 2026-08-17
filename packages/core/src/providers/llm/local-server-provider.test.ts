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

const JSON_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

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
  it("requests json_object mode on the OpenAI-compatible streaming path", async () => {
    const frames = contentFrame('{"summary":"local"}') + "data: [DONE]\n\n";
    const { fetchImpl, requests } = streamingFetch([frames]);
    const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const text = await p.chat([{ role: "user", content: "summarize" }], {
      onToken: () => {},
      responseFormat: "json",
      jsonSchema: JSON_SCHEMA,
    });
    expect(text).toBe('{"summary":"local"}');
    expect(requests[0]!.body).toMatchObject({
      stream: true,
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("sends the supplied schema grammar to the bundled llama.cpp streaming endpoint", async () => {
    const frames = contentFrame('{"summary":"local"}') + "data: [DONE]\n\n";
    const { fetchImpl, requests } = streamingFetch([frames]);
    const p = new LocalServerLLMProvider({
      baseUrl: "http://x/v1",
      model: "m",
      serverType: "llamacpp",
      fetchImpl,
    });
    await p.chat([{ role: "user", content: "summarize" }], {
      onToken: () => {},
      responseFormat: "json",
      jsonSchema: JSON_SCHEMA,
    });
    expect(requests[0]!.body).toMatchObject({
      response_format: { type: "json_object", schema: JSON_SCHEMA },
    });
  });

  it("falls back to generic JSON only after a llama.cpp request-shape rejection", async () => {
    const requests: unknown[] = [];
    let call = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      call += 1;
      if (call === 1) return new Response("unsupported schema", { status: 400 });
      return new Response(
        contentFrame('{"summary":"fallback"}') + "data: [DONE]\n\n",
        { status: 200 },
      );
    };
    const p = new LocalServerLLMProvider({
      baseUrl: "http://x/v1",
      model: "m",
      serverType: "llamacpp",
      fetchImpl,
    });

    await expect(
      p.chat([{ role: "user", content: "summarize" }], {
        onToken: () => {},
        responseFormat: "json",
        jsonSchema: JSON_SCHEMA,
      }),
    ).resolves.toBe('{"summary":"fallback"}');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      response_format: { type: "json_object", schema: JSON_SCHEMA },
    });
    expect(requests[1]).toMatchObject({
      response_format: { type: "json_object" },
    });
    expect(requests[1]).not.toMatchObject({
      response_format: { schema: expect.anything() },
    });
  });

  it("does not retry or drop the schema after a server failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("out of memory", { status: 500 })) as
      unknown as typeof fetch;
    const p = new LocalServerLLMProvider({
      baseUrl: "http://x/v1",
      model: "m",
      serverType: "llamacpp",
      fetchImpl,
    });

    await expect(
      p.chat([{ role: "user", content: "summarize" }], {
        onToken: () => {},
        responseFormat: "json",
        jsonSchema: JSON_SCHEMA,
      }),
    ).rejects.toThrow(/status 500/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not retry or drop the schema after cancellation", async () => {
    const aborted = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const fetchImpl = vi.fn(async () => {
      throw aborted;
    }) as unknown as typeof fetch;
    const p = new LocalServerLLMProvider({
      baseUrl: "http://x/v1",
      model: "m",
      serverType: "llamacpp",
      fetchImpl,
    });

    await expect(
      p.chat([{ role: "user", content: "summarize" }], {
        onToken: () => {},
        responseFormat: "json",
        jsonSchema: JSON_SCHEMA,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

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
  it("uses the supplied schema grammar on the native streaming path", async () => {
    const lines = [
      JSON.stringify({ message: { content: '{"summary":"ollama"}' } }),
      JSON.stringify({ done: true }),
    ].join("\n");
    const { fetchImpl, requests } = streamingFetch([lines]);
    const p = new LocalServerLLMProvider({
      baseUrl: "http://x/v1",
      model: "m",
      fetchImpl,
      numCtx: 4096,
    });
    const text = await p.chat([{ role: "user", content: "summarize" }], {
      onToken: () => {},
      responseFormat: "json",
      jsonSchema: JSON_SCHEMA,
    });
    expect(text).toBe('{"summary":"ollama"}');
    expect(requests[0]!.body).toMatchObject({
      stream: true,
      format: JSON_SCHEMA,
      options: { temperature: 0 },
    });
  });

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

  /**
   * CUTTING A RUNAWAY DELIBERATION — the "some other way" the think:false revert concluded was needed.
   *
   * Reasoning and reply share one `num_predict` on Ollama, so a model that deliberates long enough
   * ends its generation inside the thinking block and returns an empty string. Reported as "it would
   * think until it couldn't, run out of budget, then restart." Asking for less thinking is not
   * available — `reasoningEffort: "none"` reaches Ollama as `think: false`, which makes a thinking
   * model reason in plain content and publish its monologue as the reader's answer. So the app stops
   * READING instead, which needs no cooperation from the model at all.
   */
  describe("the runaway-deliberation cut", () => {
    /** A stream that never stops thinking — the exact shape that burns a whole generation. */
    const ruminating = (deltas: number, then: string[] = []) =>
      [
        ...Array.from({ length: deltas }, () => JSON.stringify({ message: { thinking: "x".repeat(100) } })),
        ...then,
        JSON.stringify({ done: true, done_reason: "stop" }),
      ].join("\n");

    it("stops reading once the reasoning passes the bound with nothing written", async () => {
      const { fetchImpl } = streamingFetch([ruminating(50)]);
      const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, numCtx: 4096 });
      let truncated: boolean | undefined;
      let thinking = "";
      const text = await p.chat([{ role: "user", content: "code me an html page" }], {
        onToken: () => {},
        onThinking: (t) => (thinking = t),
        onComplete: (m) => (truncated = m.truncated),
        thinkingBudgetChars: 500,
      });
      expect(text, "the cut invented an answer").toBe("");
      // The turn loop's existing empty-and-truncated recovery is what this hands off to.
      expect(truncated, "the cut did not report itself as a truncation").toBe(true);
      // Everything it thought before the cut still reached the app — that is what gets handed back.
      expect(thinking.length).toBeGreaterThanOrEqual(500);
      expect(thinking.length, "it kept reading long past the bound").toBeLessThan(5000);
    });

    it("never cuts a model that has started writing, however long it thinks afterwards", async () => {
      // The bound is on deliberating INSTEAD of answering. Once a character of the reply exists the
      // model is working, and interleaved reasoning after that is not a runaway — cutting there
      // would truncate a real answer, which is worse than the bug.
      const lines = [
        JSON.stringify({ message: { thinking: "brief" } }),
        JSON.stringify({ message: { content: "<!DOCTYPE html>" } }),
        // Far past the bound, and irrelevant now: `full` is no longer empty.
        ...Array.from({ length: 50 }, () => JSON.stringify({ message: { thinking: "x".repeat(100) } })),
        JSON.stringify({ message: { content: "<body></body>" } }),
        JSON.stringify({ done: true, done_reason: "stop" }),
      ].join("\n");
      const { fetchImpl } = streamingFetch([lines]);
      const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, numCtx: 4096 });
      let truncated: boolean | undefined;
      const text = await p.chat([{ role: "user", content: "hi" }], {
        onToken: () => {},
        onComplete: (m) => (truncated = m.truncated),
        thinkingBudgetChars: 200,
      });
      expect(text, "a reply that had begun was cut off").toBe("<!DOCTYPE html><body></body>");
      expect(truncated).toBe(false);
    });

    /**
     * THE CUT MUST NEVER COST AN ANSWER, and getting this wrong made it worse than the bug.
     *
     * The first version skipped every frame after the cut and reported truncated unconditionally. An
     * abort does not always stop the stream — this provider is handed a custom `fetchImpl`, and on
     * the desktop that is a Tauri bridge under no obligation to honour a signal. So the model went on
     * and wrote the whole page, every byte was discarded, and the turn reported an empty truncated
     * reply. Reported as "every time the thinking is stopped it just freezes where it is and
     * accomplishes nothing".
     */
    it("keeps content that arrives after the cut — the model started writing, which is the point", async () => {
      const lines = [
        ...Array.from({ length: 20 }, () => JSON.stringify({ message: { thinking: "x".repeat(100) } })),
        // The abort did not take: a proxied fetch ignored it and the model wrote the answer anyway.
        JSON.stringify({ message: { content: "<!DOCTYPE html>" } }),
        JSON.stringify({ message: { content: "<body>the whole page</body>" } }),
        JSON.stringify({ done: true, done_reason: "stop" }),
      ].join("\n");
      const { fetchImpl } = streamingFetch([lines]);
      const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, numCtx: 4096 });
      let truncated: boolean | undefined;
      const text = await p.chat([{ role: "user", content: "code me an html page" }], {
        onToken: () => {},
        onComplete: (m) => (truncated = m.truncated),
        thinkingBudgetChars: 500,
      });
      expect(text, "the cut threw away the answer it was supposed to make room for").toBe(
        "<!DOCTYPE html><body>the whole page</body>",
      );
      expect(truncated, "a generation that produced the answer was reported as truncated").toBe(false);
    });

    it("stops accumulating reasoning after the cut, so a stream that ignores the abort is still bounded", async () => {
      const lines = [
        ...Array.from({ length: 40 }, () => JSON.stringify({ message: { thinking: "x".repeat(100) } })),
        JSON.stringify({ done: true, done_reason: "stop" }),
      ].join("\n");
      const { fetchImpl } = streamingFetch([lines]);
      const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, numCtx: 4096 });
      let thinking = "";
      await p.chat([{ role: "user", content: "hi" }], {
        onToken: () => {},
        onThinking: (t) => (thinking = t),
        thinkingBudgetChars: 500,
      });
      expect(thinking.length, "it kept reading reasoning long past the bound").toBeLessThan(2000);
    });

    it("does nothing at all when no bound is set", async () => {
      const { fetchImpl } = streamingFetch([ruminating(50, [JSON.stringify({ message: { content: "done" } })])]);
      const p = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", fetchImpl, numCtx: 4096 });
      const text = await p.chat([{ role: "user", content: "hi" }], { onToken: () => {} });
      expect(text).toBe("done");
    });
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
