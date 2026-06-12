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
        setVisualStyle: async () => ({}),
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
        setVisualStyle: async () => ({}),
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
        setVisualStyle: async () => ({}),
      },
    });
    expect(outcome.toolResults[0]!.result.error).toContain("isn't in the library");
    expect(outcome.text).toContain("Gutenberg");
    // The failure reached the model as a user-role turn.
    expect(llm.calls[1]!.some((t) => t.role === "user" && t.content.includes("failed"))).toBe(true);
  });

  it("stops on generate_image and surfaces it as a pending tool", async () => {
    const llm = scriptedLlm(['{"tool":"generate_image","prompt":"a red apple","style":"watercolor"}']);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "generate a picture of an apple" }],
      deps: {
        openLibraryBook: async () => opened("?"),
        openWebText: async () => opened("?"),
        setVisualStyle: async () => ({}),
      },
    });
    expect(outcome.pendingTool).toEqual({
      tool: "generate_image",
      prompt: "a red apple",
      style: "watercolor",
    });
    expect(outcome.text).toBe("");
    expect(outcome.toolResults).toHaveLength(0);
    expect(llm.calls).toHaveLength(1); // the loop stopped for approval
  });

  it("applies a style change then opens with visuals in one flow", async () => {
    const llm = scriptedLlm([
      '{"tool":"set_visual_style","style":"oil painting"}',
      '{"tool":"random_books"}',
      '{"tool":"open_web_text","url":"https://g.test/345.txt","title":"Dracula","mode":"fiction","visuals":true}',
      "Dracula it is, in oils — generating now!",
    ]);
    const applied: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "open a random classic in oil painting style and illustrate it" }],
      deps: {
        randomBooks: async () => [{ title: "Dracula", textUrl: "https://g.test/345.txt" }],
        openLibraryBook: async () => opened("?"),
        openWebText: async (call) => opened(call.title ?? "?"),
        setVisualStyle: async (call) => {
          applied.push(call.style ?? "");
          return { style: "Oil painting" };
        },
      },
    });
    expect(applied).toEqual(["oil painting"]);
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual([
      "set_visual_style",
      "random_books",
      "open_web_text",
    ]);
    expect(outcome.text).toContain("Dracula");
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
        setVisualStyle: async () => ({}),
      },
    });
    // Round cap reached: the final (still-JSON) reply is returned as text rather
    // than executed again.
    expect(outcome.toolResults).toHaveLength(MAX_BUDDY_TOOL_ROUNDS);
    expect(llm.calls).toHaveLength(MAX_BUDDY_TOOL_ROUNDS + 1);
  });
});
