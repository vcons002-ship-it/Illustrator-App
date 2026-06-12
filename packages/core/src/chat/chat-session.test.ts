import { describe, expect, it } from "vitest";
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
    expect(out.text).toBe(SEARCH); // surfaced as the answer rather than executed again
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
