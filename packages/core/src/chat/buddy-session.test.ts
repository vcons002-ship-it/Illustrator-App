import { describe, expect, it } from "vitest";
import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import { runBuddyTurn, nonEmptyAnswer, type BuddyTurnEvent } from "./buddy-session.js";
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

const baseDeps = {
  openLibraryBook: async () => {
    throw new Error("nope");
  },
  openWebText: async () => {
    throw new Error("nope");
  },
  openPastedText: async (call: { title: string }) => opened(call.title),
  removeLibraryBook: async () => ({ removed: "x" }),
  setVisualStyle: async () => ({}),
};

describe("nonEmptyAnswer", () => {
  it("keeps real text, falls back on empty (tool-aware)", () => {
    expect(nonEmptyAnswer("hello", false)).toBe("hello");
    expect(nonEmptyAnswer("  ", true)).toMatch(/results/i);
    expect(nonEmptyAnswer("", false)).toMatch(/rephrase/i);
  });
});

describe("runBuddyTurn — spawn_agents parallel fan-out", () => {
  it("runs the subtasks via runSubAgents and feeds all results back to synthesize", async () => {
    const llm = scriptedLlm([
      '{"tool":"spawn_agents","tasks":["research A","research B"]}',
      "A is bigger than B.",
    ]);
    let gotTasks: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "compare A and B" }],
      deps: baseDeps,
      runSubAgents: async (tasks) => {
        gotTasks = tasks;
        return tasks.map((t) => ({ task: t, result: `result for ${t}` }));
      },
    });
    expect(gotTasks).toEqual(["research A", "research B"]);
    expect(outcome.text).toBe("A is bigger than B.");
    expect(outcome.toolResults).toHaveLength(1);
    // The synthesis round was given both sub-agent results.
    const fedBack = llm.calls[1]!.map((t) => t.content).join("\n");
    expect(fedBack).toContain("result for research A");
    expect(fedBack).toContain("result for research B");
  });

  it("reports unavailable when no runSubAgents is wired", async () => {
    const llm = scriptedLlm(['{"tool":"spawn_agents","tasks":["x","y"]}', "Done."]);
    const outcome = await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "go" }], deps: baseDeps });
    expect(llm.calls[1]!.some((t) => /aren't available/.test(t.content))).toBe(true);
    expect(outcome.text).toBe("Done.");
  });
});

describe("runBuddyTurn — write-capable sub-agent (runHostTool)", () => {
  it("executes a host tool out-of-band and feeds the result back instead of suspending", async () => {
    // A coding agent runs a command, sees the output, then answers — no pendingTool suspension.
    const llm = scriptedLlm([
      '{"tool":"run_command","command":"pytest -q"}',
      "Tests pass — 12 passed.",
    ]);
    const ran: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "run the tests" }],
      deps: baseDeps,
      runHostTool: async (call) => {
        if (call.tool === "run_command") ran.push(call.command);
        return { command: { stdout: "12 passed", stderr: "", code: 0, timedOut: false } };
      },
    });
    expect(ran).toEqual(["pytest -q"]);
    expect(outcome.pendingTool).toBeUndefined(); // did NOT suspend
    expect(outcome.text).toBe("Tests pass — 12 passed.");
    // The command output was fed into the next round.
    expect(llm.calls[1]!.map((t) => t.content).join("\n")).toContain("12 passed");
  });

  it("without runHostTool, a host tool still suspends as a pendingTool (main-buddy path)", async () => {
    const llm = scriptedLlm(['{"tool":"run_command","command":"ls"}', "done"]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "list" }],
      deps: baseDeps,
    });
    expect(outcome.pendingTool).toEqual({ tool: "run_command", command: "ls" });
  });
});

describe("runBuddyTurn — never-empty answer + thinking", () => {
  it("re-prompts for a plain-text wrap-up when a tool round ends with no prose", async () => {
    const llm = scriptedLlm(['{"tool":"search_books","query":"x"}', "", "All set — nothing notable came back."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "look something up" }],
      deps: { ...baseDeps, searchBooks: async () => [] },
    });
    expect(outcome.text).toBe("All set — nothing notable came back."); // not an empty bubble
    expect(outcome.toolResults).toHaveLength(1);
  });

  it("falls back to a non-empty line when even the wrap-up is blank", async () => {
    const llm = scriptedLlm(["", ""]); // blank, then blank again after the wrap-up nudge
    const outcome = await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "hi" }], deps: baseDeps });
    expect(outcome.text).toMatch(/rephrase/i);
  });

  it("carries the turn's thinking onto the outcome", async () => {
    const llm: ChatCapable = {
      async chat(_messages, opts) {
        opts?.onThinking?.("weighing the options…");
        return "Go with the blue one.";
      },
    };
    const outcome = await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "which?" }], deps: baseDeps, onEvent: () => {} });
    expect(outcome.text).toBe("Go with the blue one.");
    expect(outcome.thinking).toBe("weighing the options…");
  });
});

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
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
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
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
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
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
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
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
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
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
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

  it("opens chat-pasted text directly (no fetch)", async () => {
    const llm = scriptedLlm([
      '{"tool":"open_pasted_text","text":"Two roads diverged in a yellow wood","title":"The Road Not Taken","mode":"fiction","visuals":true}',
      "Opened your poem — illustrating it now.",
    ]);
    let pasted = "";
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "illustrate this poem: Two roads diverged in a yellow wood" }],
      deps: {
        openLibraryBook: async () => opened("?"),
        openWebText: async () => {
          throw new Error("should not fetch");
        },
        openPastedText: async (call) => {
          pasted = call.text;
          return opened(call.title);
        },
        removeLibraryBook: async () => ({ removed: "x" }),
        setVisualStyle: async () => ({}),
      },
    });
    expect(pasted).toBe("Two roads diverged in a yellow wood");
    expect(outcome.toolResults[0]!.call.tool).toBe("open_pasted_text");
    expect(outcome.text).toContain("poem");
  });

  it("removes a library book and reports the title", async () => {
    const llm = scriptedLlm([
      '{"tool":"remove_library_book","id":"text-dune"}',
      "Done — Dune is off your shelf.",
    ]);
    const removedIds: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "remove Dune from my library" }],
      deps: {
        openLibraryBook: async () => opened("?"),
        openWebText: async () => opened("?"),
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async (call) => {
          removedIds.push(call.id);
          return { removed: "Dune" };
        },
        setVisualStyle: async () => ({}),
      },
    });
    expect(removedIds).toEqual(["text-dune"]);
    expect(outcome.toolResults[0]!.result.removed).toBe("Dune");
    expect(outcome.text).toContain("Dune");
  });

  it("runs calculate in-core and feeds the exact value back", async () => {
    const llm = scriptedLlm([
      '{"tool":"calculate","expression":"sqrt(144) * 2"}',
      "That works out to exactly 24.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "what's sqrt(144) times 2?" }],
      deps: {
        openLibraryBook: async () => opened("?"),
        openWebText: async () => opened("?"),
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
        setVisualStyle: async () => ({}),
      },
    });
    expect(outcome.toolResults[0]!.result.calc).toEqual({ expression: "sqrt(144) * 2", result: "24" });
    expect(llm.calls[1]!.some((t) => t.role === "user" && t.content.includes("= 24"))).toBe(true);
    expect(outcome.text).toContain("24");
  });

  it("routes remember/forget to the memory deps (and errors without them)", async () => {
    const remembered: string[] = [];
    const llm = scriptedLlm([
      '{"tool":"remember","note":"prefers watercolor"}',
      "Got it — watercolor it is.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "remember I prefer watercolor" }],
      deps: {
        remember: async (note) => {
          remembered.push(note);
          return 1;
        },
        openLibraryBook: async () => opened("?"),
        openWebText: async () => opened("?"),
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
        setVisualStyle: async () => ({}),
      },
    });
    expect(remembered).toEqual(["prefers watercolor"]);
    expect(outcome.toolResults[0]!.result.memory).toEqual({
      action: "remembered",
      note: "prefers watercolor",
      count: 1,
    });
    // Without the dep, the tool fails soft (the model is told and recovers).
    const noDep = await runBuddyTurn({
      llm: scriptedLlm(['{"tool":"forget","match":"x"}', "Sorry, no memory here."]),
      system: "sys",
      history: [{ role: "user", content: "forget x" }],
      deps: {
        openLibraryBook: async () => opened("?"),
        openWebText: async () => opened("?"),
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
        setVisualStyle: async () => ({}),
      },
    });
    expect(noDep.toolResults[0]!.result.error).toContain("memory isn't available");
  });

  it("executes EVERY tool call when the model BATCHES several in one reply (one round)", async () => {
    const created: string[] = [];
    const searched: string[] = [];
    const llm = scriptedLlm([
      '{"tool":"create_task","title":"Book outbound flight"}\n' +
        '{"tool":"create_task","title":"Book return flight"}\n' +
        '{"tool":"search_web","query":"flights to Iowa City"}',
      "Added both to-dos and here are flight options.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "add the flight tasks and find flights" }],
      deps: {
        createTask: async (t) => {
          created.push(t.title);
          return { id: String(created.length), title: t.title };
        },
        searchWeb: async (q) => {
          searched.push(q);
          return [];
        },
        openLibraryBook: async () => opened("?"),
        openWebText: async () => opened("?"),
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
        setVisualStyle: async () => ({}),
      },
    });
    expect(created).toEqual(["Book outbound flight", "Book return flight"]);
    expect(searched).toEqual(["flights to Iowa City"]);
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["create_task", "create_task", "search_web"]);
    expect(llm.calls).toHaveLength(2); // all three ran in ONE round, then the final prose
    expect(outcome.text).toContain("flight options");
  });

  it("doesn't leak an unparseable tool-shaped reply as prose — nudges instead", async () => {
    const llm = scriptedLlm([
      '{"tool":"totally_unknown_tool","x":1}', // looks like a tool call, but isn't one we run
      "Okay, here's a plain answer instead.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "do the thing" }],
      deps: {
        openLibraryBook: async () => opened("?"),
        openWebText: async () => opened("?"),
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
        setVisualStyle: async () => ({}),
      },
    });
    expect(outcome.text).toBe("Okay, here's a plain answer instead."); // NOT the raw JSON
    expect(llm.calls).toHaveLength(2); // it was nudged to retry
    expect(llm.calls[1]!.some((t) => t.role === "user" && t.content.includes("tool call"))).toBe(true);
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
        openPastedText: async (call) => opened(call.title),
        removeLibraryBook: async () => ({ removed: "x" }),
        setVisualStyle: async () => ({}),
      },
    });
    // Round cap reached: the tool stops executing (toolResults capped). The final still-JSON reply
    // strips to empty, so instead of an empty bubble we make ONE plain-text wrap-up attempt; it's
    // still JSON, so the answer falls back to a short non-empty line.
    expect(outcome.toolResults).toHaveLength(MAX_BUDDY_TOOL_ROUNDS);
    expect(llm.calls).toHaveLength(MAX_BUDDY_TOOL_ROUNDS + 2); // +1 cap round, +1 wrap-up
    expect(outcome.text.trim()).not.toBe(""); // never an empty answer
  });
});
