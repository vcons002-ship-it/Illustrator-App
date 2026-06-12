import { describe, expect, it } from "vitest";
import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import { runBuddyTurn, type BuddyTurnEvent } from "./buddy-session.js";
import { MAX_BUDDY_TOOL_ROUNDS, type BuddyOpenedInfo } from "./buddy-tools.js";

/** ChatCapable that replays scripted replies and records what it was sent. */
function scriptedLlm(replies: string[]): ChatCapable & { calls: ChatTurn[][] } {
  const calls: ChatTurn[][] = [];
  return {
    calls,
    async chat(messages) {
      calls.push([...messages]);
      return replies[Math.min(calls.length - 1, replies.length - 1)]!;
    },
  };
}

const opened = (title: string): BuddyOpenedInfo => ({ title, chapters: 3, pages: 12, visuals: true });

describe("runBuddyTurn", () => {
  it("returns plain prose without touching any tool", async () => {
    const llm = scriptedLlm(["You'd love Dracula — gothic, epistolary, a page-turner."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "what should I read?" }],
      deps: {
        openLibraryBook: async () => {
          throw new Error("must not be called");
        },
        openWebText: async () => {
          throw new Error("must not be called");
        },
      },
    });
    expect(outcome.text).toContain("Dracula");
    expect(outcome.toolResults).toHaveLength(0);
    expect(outcome.transcript).toEqual([{ role: "assistant", content: outcome.text }]);
  });

  it("runs a search → open → prose flow, emitting events and the right deps", async () => {
    const llm = scriptedLlm([
      '{"tool":"search_books","query":"frankenstein"}',
      '{"tool":"open_web_text","url":"https://g.test/84.txt","title":"Frankenstein","mode":"fiction","visuals":true}',
      "It's open and illustrating — shall we talk about the framing letters first?",
    ]);
    const events: BuddyTurnEvent[] = [];
    const openedCalls: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "open frankenstein and illustrate it" }],
      deps: {
        searchBooks: async (q) => {
          expect(q).toBe("frankenstein");
          return [{ title: "Frankenstein", author: "Mary Shelley", textUrl: "https://g.test/84.txt" }];
        },
        openLibraryBook: async () => {
          throw new Error("not this path");
        },
        openWebText: async (call) => {
          openedCalls.push(call.url);
          expect(call.visuals).toBe(true);
          return opened(call.title ?? "?");
        },
      },
      onEvent: (e) => events.push(e),
    });
    expect(openedCalls).toEqual(["https://g.test/84.txt"]);
    expect(outcome.text).toContain("open and illustrating");
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["search_books", "open_web_text"]);
    expect(events.filter((e) => e.kind === "tool")).toHaveLength(2);
    // Transcript alternates assistant tool JSON with user-role feedback, ending in prose.
    expect(outcome.transcript.map((t) => t.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(outcome.transcript[1]!.content).toContain("Frankenstein — Mary Shelley");
  });

  it("feeds tool failures back to the model instead of throwing", async () => {
    const llm = scriptedLlm([
      '{"tool":"open_library_book","id":"nope"}',
      "That one isn't in your library — want me to search Project Gutenberg?",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "open it" }],
      deps: {
        openLibraryBook: async () => {
          throw new Error("that id isn't in the library");
        },
        openWebText: async () => opened("?"),
      },
    });
    expect(outcome.toolResults[0]!.result.error).toContain("isn't in the library");
    expect(outcome.text).toContain("Gutenberg");
    // The failure reached the model as a user-role turn.
    expect(llm.calls[1]!.some((t) => t.role === "user" && t.content.includes("failed"))).toBe(true);
  });

  it("stops tool-looping after MAX_BUDDY_TOOL_ROUNDS", async () => {
    const llm = scriptedLlm(['{"tool":"search_web","query":"loop"}']);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "hi" }],
      deps: {
        searchWeb: async () => [],
        openLibraryBook: async () => opened("?"),
        openWebText: async () => opened("?"),
      },
    });
    // Round cap reached: the final (still-JSON) reply is returned as text rather
    // than executed again.
    expect(outcome.toolResults).toHaveLength(MAX_BUDDY_TOOL_ROUNDS);
    expect(llm.calls).toHaveLength(MAX_BUDDY_TOOL_ROUNDS + 1);
  });
});
