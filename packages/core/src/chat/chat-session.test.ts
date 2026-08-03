import { afterEach, describe, expect, it, vi } from "vitest";
import { runChatTurn,
  isOnlyTurnStamp,
  stampAssistantContent,
  stampTurnContent,
  stripTurnStamp,
} from "./chat-session.js";
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

describe("trimTurnMessages (the context a turn actually sends)", () => {
  const sys = { role: "system" as const, content: "SYSTEM: you are the assistant." };
  const goal = { role: "user" as const, content: "GOAL: create the calendar invite for Friday." };

  /** The reported sequence: a task, a huge file read, then the model's next move. */
  function turnAfterFileRead(fileChars: number) {
    return [
      sys,
      { role: "user" as const, content: "OLD: unrelated chatter from an earlier turn." },
      { role: "assistant" as const, content: "OLD: sure." },
      goal,
      { role: "assistant" as const, content: '{"tool":"read_file"}' },
      { role: "user" as const, content: `FILE:${"x".repeat(fileChars)}` },
    ];
  }

  it("keeps the system prompt and the request that started the turn when a big read blows the budget", async () => {
    const { trimTurnMessages } = await import("./chat-session.js");
    // This is the whole bug: drop-oldest would delete the GOAL first, so the assistant reads a file
    // and immediately no longer knows what it was doing.
    const out = trimTurnMessages(turnAfterFileRead(5_000), 3, 2_000);
    expect(out[0]).toEqual(sys);
    expect(out.some((m) => m.content.startsWith("GOAL:"))).toBe(true);
    expect(out.some((m) => m.content.startsWith("OLD:"))).toBe(false);
  });

  it("keeps the newest result even when it alone exceeds the budget, cut in the middle", async () => {
    const { trimTurnMessages, TRUNCATED_RESULT_MARKER } = await import("./chat-session.js");
    const out = trimTurnMessages(turnAfterFileRead(50_000), 3, 2_000);
    const last = out[out.length - 1]!;
    // Dropping it outright would answer "read this file" with nothing — a different failure, no better.
    expect(last.content).toContain("FILE:");
    expect(last.content).toContain(TRUNCATED_RESULT_MARKER);
    expect(last.content.length).toBeLessThan(2_000);
  });

  it("says that it trimmed, so a partial view isn't mistaken for the whole conversation", async () => {
    const { trimTurnMessages, TRIMMED_MARKER } = await import("./chat-session.js");
    const out = trimTurnMessages(turnAfterFileRead(5_000), 3, 2_000);
    expect(out.some((m) => m.content === TRIMMED_MARKER)).toBe(true);
  });

  it("does NOT delete the conversation when the system prompt alone busts the budget", async () => {
    // The reported failure, reproduced. A ~66,000-character system prompt against a 58,982-character
    // allowance: every message was dropped, the marker went in its place, and the model reported to
    // the reader that the conversation had evaporated — while the screen showed it right there.
    // Dropping it achieved nothing, because the overflow was the system prompt.
    const { trimTurnMessages } = await import("./chat-session.js");
    const messages = [
      { role: "system" as const, content: "S".repeat(66_000) },
      { role: "user" as const, content: "first thing I said" },
      { role: "assistant" as const, content: "my reply" },
      { role: "user" as const, content: "second thing" },
      { role: "assistant" as const, content: "second reply" },
      { role: "user" as const, content: "What have we been talking about?" },
    ];
    const kept = trimTurnMessages(messages, 5, 58_982).map((m) => m.content);
    expect(kept).toContain("first thing I said");
    expect(kept).toContain("second reply");
    expect(kept).toContain("What have we been talking about?");
  });

  it("still bounds the conversation to its share when the pinned content is oversized", async () => {
    const { trimTurnMessages, MIN_HISTORY_SHARE } = await import("./chat-session.js");
    const messages = [
      { role: "system" as const, content: "S".repeat(50_000) },
      ...Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `m${i}:${"x".repeat(500)}` })),
    ];
    const out = trimTurnMessages(messages, 1, 10_000);
    const conversation = out.filter((m) => m.content.startsWith("m")).reduce((n, m) => n + m.content.length, 0);
    // Bounded — a share of the budget, not everything — but emphatically not zero.
    expect(conversation).toBeGreaterThan(1_000);
    expect(conversation).toBeLessThanOrEqual(10_000 * MIN_HISTORY_SHARE + 600);
  });

  it("leaves a turn that fits completely alone", async () => {
    const { trimTurnMessages } = await import("./chat-session.js");
    const messages = turnAfterFileRead(100);
    expect(trimTurnMessages(messages, 3, 1_000_000)).toEqual(messages);
    expect(trimTurnMessages(messages, 3, 0)).toEqual(messages); // no budget set → no bound
  });

  it("keeps the newest rounds and sheds the oldest ones in between", async () => {
    const { trimTurnMessages } = await import("./chat-session.js");
    const messages = [
      sys,
      goal,
      { role: "user" as const, content: `R1:${"a".repeat(900)}` },
      { role: "user" as const, content: `R2:${"b".repeat(900)}` },
      { role: "user" as const, content: `R3:${"c".repeat(900)}` },
    ];
    const out = trimTurnMessages(messages, 1, 2_100).map((m) => m.content.slice(0, 2));
    expect(out).toContain("R3");
    expect(out).not.toContain("R1");
  });
});

describe("historyBudget (what the conversation actually gets)", () => {
  it("gives the conversation everything the system prompt didn't use", async () => {
    const { historyBudget } = await import("./chat-session.js");
    expect(historyBudget(14_745, 2_000)).toBe(12_745);
  });

  it("is dramatically larger than the old fixed fraction where there is no book", async () => {
    // The landing-page chat has NO book section, so the 70/30 split reserved most of the window for
    // something that isn't there. On an 8k-window model that capped the conversation at ~4,400
    // characters — two or three exchanges — which is what "it forgets what we just said" was.
    const { historyBudget } = await import("./chat-session.js");
    const input = 14_745;
    const oldFixed = Math.floor(input * 0.3);
    expect(historyBudget(input, 2_500)).toBeGreaterThan(oldFixed * 2);
  });

  it("guarantees the conversation a share when the system prompt takes everything", async () => {
    // The reported case, from a screenshot: a 32k-token model, a ~66,000-character system prompt
    // (role + tools + identity notes + memories + skills), and an assistant answering "the first
    // message I see in this chat is your current question" under a visibly long conversation.
    // Leftovers were negative, so a flat floor was all the conversation ever got.
    const { historyBudget, MIN_HISTORY_SHARE } = await import("./chat-session.js");
    const input = 82_576; // a 32k window, less the reply
    // Thousands of words of conversation, not one turn. (Against the OLD allowance of 58,982 the
    // leftover was negative and this was 2,000.)
    expect(historyBudget(input, 66_000)).toBeGreaterThan(16_000);
    // And when the system prompt is bigger still, the guarantee is what stops it reaching zero.
    expect(historyBudget(input, 80_000)).toBe(Math.floor(input * MIN_HISTORY_SHARE));
    expect(historyBudget(input, 200_000)).toBe(Math.floor(input * MIN_HISTORY_SHARE));
  });

  it("takes the leftover when it is larger than the guaranteed share", async () => {
    const { historyBudget } = await import("./chat-session.js");
    expect(historyBudget(82_576, 10_000)).toBe(72_576);
  });

  it("still has an absolute backstop on a tiny window", async () => {
    const { historyBudget, MIN_HISTORY_CHARS } = await import("./chat-session.js");
    expect(historyBudget(1_000, 50_000)).toBe(MIN_HISTORY_CHARS);
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

describe("stampTurnContent — when a message was sent", () => {
  // A conversation handed to a model is a flat list with no clock in it: yesterday, this morning and
  // three weeks ago all look like the line above. Fine for one sitting, wrong for a chat kept for
  // months, resumed from a phone and woken by scheduled runs.
  const at = new Date(2026, 7, 1, 9, 14).getTime(); // local time, like the reader's clock

  it("puts the local date and time in front", () => {
    expect(stampTurnContent("what's left on the party list?", at)).toBe("[2026-08-01 09:14:00] what's left on the party list?");
  });

  it("is idempotent, because history is rebuilt every turn", () => {
    const once = stampTurnContent("hello", at);
    expect(stampTurnContent(once, at)).toBe(once);
    expect(stampTurnContent(once, at + 86_400_000)).toBe(once); // and never re-dated by a later pass
  });

  it("dates the assistant's own reply at the END, where it can't open a turn", () => {
    // Its replies DO need dating: a scheduled run or unattended work has no reader message beside it
    // to be dated by, and "when did I last do this" is exactly the question that arises then. But a
    // LEADING prefix on every message is a turn delimiter, and the model produced one instead of an
    // answer. A trailing marker can't be produced instead of content — to write it, the reply has to
    // exist first.
    const out = stampAssistantContent("I added those to the event.", at);
    expect(out).toBe("I added those to the event.\n[sent 2026-08-01 09:14:00]");
    expect(out.startsWith("[")).toBe(false);
  });

  it("never dates an empty reply into looking like a real one", () => {
    expect(stampAssistantContent("", at)).toBe("");
    expect(stampAssistantContent("   ", at)).toBe("   ");
  });

  it("re-stamps rather than accumulating, however often history is rebuilt", () => {
    const once = stampAssistantContent("done", at);
    expect(stampAssistantContent(once, at)).toBe(once);
    expect(stampAssistantContent(once, at + 3_600_000)).toBe("done\n[sent 2026-08-01 10:14:00]");
  });

  it("strips either stamp the app adds", () => {
    expect(stripTurnStamp("[2026-08-01 09:14] hello")).toBe("hello");
    expect(stripTurnStamp("done\n[sent 2026-08-01 09:14]")).toBe("done");
  });

  it("recognises a reply that is nothing but a timestamp", () => {
    // What the reported screenshot showed: the reasoning block held a complete, correct plan and the
    // reply was "[2026-08-02 10:05]" and nothing else. Every message the model could see began with
    // that prefix, so asked for the next one it wrote the prefix and stopped — in the pattern it had
    // been shown, what follows a prefix is the OTHER party's turn.
    expect(isOnlyTurnStamp("[2026-08-02 10:05]")).toBe(true);
    expect(isOnlyTurnStamp("[2026-08-02 10:05]   ")).toBe(true);
    expect(isOnlyTurnStamp("[2026-08-02 10:05] I'll add those to the event.")).toBe(false);
    expect(isOnlyTurnStamp("Here you go.")).toBe(false);
    expect(isOnlyTurnStamp("")).toBe(false); // an empty reply is a different failure, reported elsewhere
  });

  it("lets the app's clock overrule one the model wrote itself", () => {
    // What makes it safe to stamp the ASSISTANT'S OWN turns. Shown its prior replies with a prefix, a
    // model will eventually write one — and a stamp the model wrote is a GUESS, which would then be
    // stored, re-read, and treated as the authoritative time. Stripping first means the app's clock
    // always wins and a mimicked prefix costs nothing. A convention it cannot break, not one it has
    // to be told to follow.
    const mimicked = "[2019-01-01 00:00] I looked that up for you";
    expect(stampTurnContent(stripTurnStamp(mimicked), at)).toBe("[2026-08-01 09:14:00] I looked that up for you");
  });

  it("leaves a message with no stamp exactly as it is", () => {
    expect(stripTurnStamp("just talking")).toBe("just talking");
    expect(stripTurnStamp("[not a date] hello")).toBe("[not a date] hello");
  });

  it("leaves a message alone when there is no time to give it", () => {
    for (const bad of [undefined, 0, NaN]) expect(stampTurnContent("hello", bad as number | undefined)).toBe("hello");
  });

  it("pads so the stamps line up and sort", () => {
    expect(stampTurnContent("x", new Date(2026, 0, 5, 4, 7, 5).getTime())).toBe("[2026-01-05 04:07:05] x");
  });
});

describe("the stamp carries SECONDS, and still reads the ones written before it did", () => {
  const at = new Date(2026, 7, 1, 9, 14, 37).getTime();

  it("writes seconds, so events inside one minute can be ordered", () => {
    // A scheduled run, the tool results it produced and the reply it wrote all land in the same
    // minute — and "what did you do, and in what order" is what these stamps are read for. At
    // minute resolution two events a second apart looked simultaneous.
    expect(stampTurnContent("hello", at)).toBe("[2026-08-01 09:14:37] hello");
    expect(stampAssistantContent("done", at)).toBe("done\n[sent 2026-08-01 09:14:37]");
  });

  it("still strips a stamp written in the OLD minute-only form", () => {
    // A reader's chat outlives a format change. A stamp that stops being recognised stops being
    // stripped — which puts a bare clock back in front of an old message, and back into the model's
    // mouth as something to imitate.
    expect(stripTurnStamp("[2026-08-01 09:14] hello")).toBe("hello");
    expect(stripTurnStamp("done\n[sent 2026-08-01 09:14]")).toBe("done");
    expect(isOnlyTurnStamp("[2026-08-02 10:05]")).toBe(true);
    expect(isOnlyTurnStamp("[2026-08-02 10:05:41]")).toBe(true);
  });

  it("doesn't double-stamp a message that already carries either form", () => {
    expect(stampTurnContent("[2026-08-01 09:14] hi", at)).toBe("[2026-08-01 09:14] hi");
    expect(stampTurnContent("[2026-08-01 09:14:37] hi", at)).toBe("[2026-08-01 09:14:37] hi");
  });
});
