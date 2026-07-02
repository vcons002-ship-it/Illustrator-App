import { afterEach, describe, expect, it, vi } from "vitest";
import { runChatTurn } from "./chat-session.js";
import { MAX_TOOL_ROUNDS } from "./chat-tools.js";
import type { ChatCapable, ChatOptions, ChatTurn } from "../providers/llm/chat.js";

/** Scripted ChatCapable: returns queued replies in order, recording each call. */
class FakeChat implements ChatCapable {
  readonly calls: ChatTurn[][] = [];
  constructor(private readonly replies: string[]) {}
  async chat(messages: ChatTurn[], opts?: ChatOptions): Promise<string> {
    this.calls.push([...messages]);
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)] ?? "";
    opts?.onToken?.(reply);
    return reply;
  }
}

const SEARCH = '{"tool":"search_web","query":"Krebs cycle"}';

describe("runChatTurn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks a working heartbeat while the model is slow to produce its first token", async () => {
    // A big local model can take a long time before the FIRST token. The phone's silence watchdog
    // only resets on a stream event, so the turn must emit periodic activity heartbeats during that
    // wait — without them a slow time-to-first-token would trip the "chat went quiet" timeout.
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const llm: ChatCapable = {
      async chat(_messages, opts) {
        await new Promise<void>((r) => {
          release = r;
        });
        opts?.onToken?.("done");
        return "done";
      },
    };
    const events: string[] = [];
    const turn = runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "hi" }],
      tools: {},
      onEvent: (e) => {
        if (e.kind === "activity") events.push(e.text);
      },
    });
    // Advance past several heartbeat intervals while the model is still "loading".
    await vi.advanceTimersByTimeAsync(35_000);
    expect(events.some((t) => /Still working/.test(t))).toBe(true);
    const beatsWhileWaiting = events.filter((t) => /Still working/.test(t)).length;
    expect(beatsWhileWaiting).toBeGreaterThanOrEqual(2);
    // First token arrives → heartbeat stops; no more "still working" beats after completion.
    release?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.filter((t) => /Still working/.test(t)).length).toBe(beatsWhileWaiting);
    const out = await turn;
    expect(out.text).toBe("done");
  });

  it("answers plain prose without touching tools", async () => {
    const llm = new FakeChat(["It's a great chapter."]);
    const out = await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "thoughts?" }],
      tools: {},
    });
    expect(out.text).toBe("It's a great chapter.");
    expect(out.transcript).toEqual([{ role: "assistant", content: "It's a great chapter." }]);
    expect(out.toolResults).toEqual([]);
  });

  it("forwards the response budget (maxTokens) to the provider", async () => {
    let seen: number | undefined;
    const llm: ChatCapable = {
      async chat(_messages, opts) {
        seen = opts?.maxTokens;
        return "ok";
      },
    };
    await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "hi" }],
      tools: {},
      maxTokens: 4096,
    });
    expect(seen).toBe(4096); // without this, providers cap replies at their 1024 default
  });

  it("executes a search call, feeds the result back, and returns the follow-up", async () => {
    const llm = new FakeChat([SEARCH, "Per [1], it's the citric acid cycle."]);
    const out = await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "what is it?" }],
      tools: { searchWeb: async () => [{ link: "https://a", title: "A", snippet: "citric acid" }] },
    });
    expect(out.text).toContain("citric acid cycle");
    expect(out.toolResults).toHaveLength(1);
    // The second model call saw the tool feedback as a user turn.
    const second = llm.calls[1]!;
    expect(second[second.length - 1]!.role).toBe("user");
    expect(second[second.length - 1]!.content).toContain("[1] A");
    // Transcript: tool JSON + feedback + final answer.
    expect(out.transcript.map((t) => t.role)).toEqual(["assistant", "user", "assistant"]);
  });

  it("halts a tool-looping model at MAX_TOOL_ROUNDS", async () => {
    const llm = new FakeChat([SEARCH]); // always wants to search
    const out = await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "?" }],
      tools: { searchWeb: async () => [] },
    });
    // MAX_TOOL_ROUNDS tool rounds + the final forced-prose round.
    expect(llm.calls.length).toBe(MAX_TOOL_ROUNDS + 1);
    expect(out.toolResults).toHaveLength(MAX_TOOL_ROUNDS);
    // The cap round's reply is still tool JSON — it must be stripped, never shown verbatim.
    expect(out.text).not.toContain('"tool"');
    expect(out.text).toMatch(/tool limit/i);
  });

  it("keeps the prose when the cap round mixes an answer with a tool call", async () => {
    const llm = new FakeChat([SEARCH, SEARCH, SEARCH, `Here is what I found so far.\n${SEARCH}`]);
    const out = await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "?" }],
      tools: { searchWeb: async () => [] },
    });
    expect(out.text).toBe("Here is what I found so far.");
  });

  it("returns generate_image as pendingTool WITHOUT executing anything", async () => {
    const llm = new FakeChat(['{"tool":"generate_image","prompt":"a dragon","steps":12}']);
    const out = await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "draw it" }],
      tools: { searchWeb: async () => [] },
    });
    expect(out.pendingTool).toEqual({ tool: "generate_image", prompt: "a dragon", steps: 12 });
    expect(out.text).toBe("");
    expect(llm.calls).toHaveLength(1); // the loop stopped for approval
  });

  it("formats a missing tool dependency into the transcript and continues", async () => {
    const llm = new FakeChat([SEARCH, "Can't search, but from the book…"]);
    const out = await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "?" }],
      tools: {}, // no search available
    });
    expect(out.text).toContain("from the book");
    expect(out.transcript[1]!.content).toContain("failed");
  });

  it("forwards streaming deltas via onEvent", async () => {
    const llm = new FakeChat(["hello"]);
    const tokens: string[] = [];
    await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "hi" }],
      tools: {},
      onEvent: (e) => {
        if (e.kind === "token") tokens.push(e.text);
      },
    });
    expect(tokens).toEqual(["hello"]);
  });

  it("never streams a tool-JSON round into the visible bubble", async () => {
    const llm = new FakeChat([SEARCH, "Found it."]);
    const tokens: string[] = [];
    await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "look it up" }],
      tools: { searchWeb: async () => [] },
      onEvent: (e) => {
        if (e.kind === "token") tokens.push(e.text);
      },
    });
    // The JSON round emitted nothing; only the prose round streamed.
    expect(tokens.join("")).toBe("Found it.");
  });

  it("forwards the model's live reasoning text as thinking events", async () => {
    const llm: ChatCapable = {
      async chat(_messages, opts) {
        opts?.onThinking?.("weighing");
        opts?.onThinking?.("weighing the options");
        opts?.onToken?.("done");
        return "done";
      },
    };
    const seen: string[] = [];
    await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "hi" }],
      tools: {},
      onEvent: (e) => {
        if (e.kind === "thinking") seen.push(e.text);
      },
    });
    expect(seen).toEqual(["weighing", "weighing the options"]);
  });

  it("rejects when the signal aborts", async () => {
    const ac = new AbortController();
    ac.abort();
    const llm = new FakeChat(["never"]);
    await expect(
      runChatTurn({
        llm,
        system: "sys",
        history: [{ role: "user", content: "hi" }],
        tools: {},
        signal: ac.signal,
      }),
    ).rejects.toThrow();
  });
});

describe("runChatTurn memory tools", () => {
  it("routes remember to the dep and feeds the confirmation back", async () => {
    const llm = new FakeChat(['{"tool":"remember","note":"never spoil endings"}', "Noted!"]);
    const remembered: string[] = [];
    const out = await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "never spoil endings please" }],
      tools: {
        remember: async (note) => {
          remembered.push(note);
          return 2;
        },
      },
    });
    expect(remembered).toEqual(["never spoil endings"]);
    expect(out.toolResults[0]!.result.memory).toEqual({
      action: "remembered",
      note: "never spoil endings",
      count: 2,
    });
    expect(out.text).toBe("Noted!");
  });

  it("fails soft when the memory dep is missing", async () => {
    const llm = new FakeChat(['{"tool":"forget","match":"x"}', "I can't right now."]);
    const out = await runChatTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "forget x" }],
      tools: {},
    });
    expect(out.toolResults[0]!.result.error).toContain("memory isn't available");
    expect(out.text).toBe("I can't right now.");
  });
});

describe("jsonGatedTokenSink", () => {
  it("streams prose live after the first non-JSON character proves it", async () => {
    const { jsonGatedTokenSink } = await import("./chat-session.js");
    const out: string[] = [];
    const sink = jsonGatedTokenSink((t) => out.push(t));
    sink("  ");
    sink("He"); // proves prose → flushes buffered whitespace + text
    sink("llo");
    expect(out.join("")).toBe("  Hello");
  });

  it("mutes replies that open like a tool call or code fence", async () => {
    const { jsonGatedTokenSink } = await import("./chat-session.js");
    for (const opener of ['{"tool":', "```json\n{"]) {
      const out: string[] = [];
      const sink = jsonGatedTokenSink((t) => out.push(t));
      for (const ch of opener) sink(ch);
      sink("more");
      expect(out).toEqual([]);
    }
  });

  it("streams the prose but mutes a tool call the model appends on its own line", async () => {
    const { jsonGatedTokenSink } = await import("./chat-session.js");
    const out: string[] = [];
    const sink = jsonGatedTokenSink((t) => out.push(t));
    // Token-by-token so the "\n{" boundary is split across deltas (the real streaming case).
    for (const ch of 'Here is your briefing.\n\n{"tool":"list_tasks","max":20}') sink(ch);
    expect(out.join("").trim()).toBe("Here is your briefing.");
    expect(out.join("")).not.toContain("{");
  });

  it("mutes an INLINE tool call the model runs straight onto a sentence (no newline)", async () => {
    const { jsonGatedTokenSink } = await import("./chat-session.js");
    const out: string[] = [];
    const sink = jsonGatedTokenSink((t) => out.push(t));
    for (const ch of 'Sure, drawing it now: {"tool":"generate_image","prompt":"a cat"}') sink(ch);
    expect(out.join("").trim()).toBe("Sure, drawing it now:");
    expect(out.join("")).not.toContain("{");
  });

  it("still streams prose that merely contains balanced braces", async () => {
    const { jsonGatedTokenSink } = await import("./chat-session.js");
    const out: string[] = [];
    const sink = jsonGatedTokenSink((t) => out.push(t));
    for (const ch of "Use the {placeholder} token in your template.") sink(ch);
    expect(out.join("")).toBe("Use the {placeholder} token in your template.");
  });
});

describe("trimChatHistory", () => {
  it("keeps the newest whole turns within budget, always at least the last", async () => {
    const { trimChatHistory } = await import("./chat-session.js");
    const turns = [
      { role: "user" as const, content: "a".repeat(100) },
      { role: "assistant" as const, content: "b".repeat(100) },
      { role: "user" as const, content: "c".repeat(100) },
    ];
    expect(trimChatHistory(turns, 1000)).toEqual(turns); // fits → untouched
    expect(trimChatHistory(turns, 250)).toEqual(turns.slice(1)); // oldest dropped
    expect(trimChatHistory(turns, 150)).toEqual(turns.slice(2));
    // The newest turn survives even when it alone exceeds the budget.
    expect(trimChatHistory(turns, 10)).toEqual(turns.slice(2));
    expect(trimChatHistory([], 100)).toEqual([]);
  });
});
