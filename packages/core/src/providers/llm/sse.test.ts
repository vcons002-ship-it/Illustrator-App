import { describe, expect, it } from "vitest";
import { streamSse } from "./sse.js";
import { OpenAILLMProvider } from "./openai-provider.js";
import { LocalServerLLMProvider } from "./local-server-provider.js";

/** A fetch that streams the given chunks as a ReadableStream body. */
function streamingFetch(chunks: string[], status = 200): typeof fetch {
  return async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(status === 200 ? body : "boom", { status });
  };
}

describe("streamSse", () => {
  it("parses events split across chunks, joins multi-line data, skips [DONE]", async () => {
    const events: unknown[] = [];
    await streamSse(
      streamingFetch([
        'data: {"a":1}\n\nda', // event boundary inside a chunk + partial next frame
        'ta: {"b"',
        ':2}\n\ndata: part1\ndata: still-not-json\n\n', // malformed → tolerated
        "data: [DONE]\n\n",
        'data: {"c":3}', // final event without trailing blank line → flushed at end
      ]),
      "http://x/stream",
      { body: {}, onEvent: (e) => events.push(e) },
    );
    expect(events).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("throws with the status + body text on a non-ok response", async () => {
    await expect(
      streamSse(streamingFetch([], 429), "http://x/stream", { body: {}, onEvent: () => {} }),
    ).rejects.toThrow(/status 429: boom/);
  });
});

describe("provider streaming chat", () => {
  const sse = (deltas: string[]) =>
    deltas
      .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
      .concat("data: [DONE]\n\n");

  it("OpenAI streams deltas to onToken and returns the joined text", async () => {
    const p = new OpenAILLMProvider({
      apiKey: "k",
      fetchImpl: streamingFetch(sse(["Hel", "lo ", "world"])),
    });
    const tokens: string[] = [];
    const text = await p.chat([{ role: "user", content: "hi" }], { onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(["Hel", "lo ", "world"]);
    expect(text).toBe("Hello world");
  });

  it("local server gates a thinking preamble out of the streamed tokens", async () => {
    const p = new LocalServerLLMProvider({
      baseUrl: "http://x/v1",
      model: "m",
      fetchImpl: streamingFetch(sse(["<think>hmm", " pondering</think>", "real ", "answer"])),
    });
    const tokens: string[] = [];
    const thinking: number[] = [];
    const text = await p.chat([{ role: "user", content: "hi" }], {
      onToken: (t) => tokens.push(t),
      onThinking: (c) => thinking.push(c),
    });
    expect(tokens.join("")).toBe("real answer"); // reasoning never reached the panel
    expect(text).toBe("real answer");
    // …but its PROGRESS was reported (otherwise a long think reads as a hang).
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking[thinking.length - 1]!).toBeGreaterThanOrEqual("<think>hmm pondering".length);
  });
});
