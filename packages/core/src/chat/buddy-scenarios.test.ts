// Tool AUDIT scenarios for the landing-page buddy: does natural language reach the right tool, and
// do multi-step asks CHAIN (each tool's result feeding the next)? Three layers:
//   1. NL → tool: the JSON a model emits for a realistic ask parses to the right BuddyToolCall
//      (incl. the sloppy shapes weak local models produce — prose prefix, fences, trailing commas).
//   2. The system prompt actually carries the disambiguation guidance for the easily-confused pairs,
//      so the model HAS the rule it needs to pick correctly.
//   3. End-to-end chains through runBuddyTurn with a scripted model: tools run in order and each
//      result is fed back so the model can act on it (search→open, write→run, gmail read→read→draft,
//      markets read→read→gated order, fan-out, error-recovery), plus the gated-suspend handoff.
import { describe, expect, it } from "vitest";
import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import { runBuddyTurn, type BuddyDeps, type BuddyTurnEvent } from "./buddy-session.js";
import {
  buildBuddySystemPrompt,
  parseBuddyToolCall,
  parseBuddyToolCalls,
  type BuddyToolResultPayload,
} from "./buddy-tools.js";

/** ChatCapable that replays scripted replies and records what it was sent (one reply per round). */
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

/** The five non-optional BuddyDeps, stubbed; spread overrides on top per scenario. */
function baseDeps(over: Partial<BuddyDeps> = {}): BuddyDeps {
  return {
    openLibraryBook: async () => ({ title: "x", chapters: 1, pages: 1, visuals: false }),
    openWebText: async (c) => ({ title: c.title ?? "x", chapters: 1, pages: 1, visuals: c.visuals }),
    openPastedText: async (c) => ({ title: c.title, chapters: 1, pages: 1, visuals: c.visuals }),
    removeLibraryBook: async () => ({ removed: "x" }),
    setVisualStyle: async () => ({}),
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. NATURAL LANGUAGE → THE RIGHT TOOL (the JSON a model emits for each ask)
// ───────────────────────────────────────────────────────────────────────────
describe("scenario: a realistic ask maps to the right tool call", () => {
  const cases: { ask: string; reply: string; expected: ReturnType<typeof parseBuddyToolCall> }[] = [
    {
      ask: "look up the latest news on fusion energy",
      reply: '{"tool":"search_web","query":"latest fusion energy news"}',
      expected: { tool: "search_web", query: "latest fusion energy news" },
    },
    {
      ask: "find me a copy of Frankenstein to read",
      reply: '{"tool":"search_books","query":"Frankenstein Mary Shelley"}',
      expected: { tool: "search_books", query: "Frankenstein Mary Shelley" },
    },
    {
      ask: "show me what a capybara actually looks like",
      reply: '{"tool":"search_images","query":"capybara"}',
      expected: { tool: "search_images", query: "capybara" },
    },
    {
      ask: "draw me a dragon over a neon city",
      reply: '{"tool":"generate_image","prompt":"a dragon soaring over a neon city skyline at night"}',
      expected: { tool: "generate_image", prompt: "a dragon soaring over a neon city skyline at night" },
    },
    {
      ask: "what's 12.5% of 840 plus sqrt(196)?",
      reply: '{"tool":"calculate","expression":"840*0.125 + sqrt(196)"}',
      expected: { tool: "calculate", expression: "840*0.125 + sqrt(196)" },
    },
    {
      ask: "what's AAPL trading at?",
      reply: '{"tool":"stock_quote","symbol":"AAPL"}',
      expected: { tool: "stock_quote", symbol: "AAPL" },
    },
    {
      ask: "alert me when TSLA crosses above 250",
      reply: '{"tool":"set_price_alert","symbol":"TSLA","type":"above","value":250}',
      expected: { tool: "set_price_alert", symbol: "TSLA", type: "above", value: 250 },
    },
    {
      ask: "open the book with id text-7 and illustrate it",
      reply: '{"tool":"open_library_book","id":"text-7","visuals":true}',
      expected: { tool: "open_library_book", id: "text-7", visuals: true },
    },
    {
      ask: "open this Python file as a code book",
      reply: '{"tool":"open_code","code":"print(\\"hi\\")","title":"app.py","language":"python","visuals":false}',
      expected: { tool: "open_code", code: 'print("hi")', title: "app.py", language: "python", visuals: false },
    },
    {
      ask: "remember that I prefer watercolor style",
      reply: '{"tool":"remember","note":"Prefers watercolor illustration style"}',
      expected: { tool: "remember", note: "Prefers watercolor illustration style" },
    },
    {
      ask: "draft an email to sam@x.com about lunch Friday",
      reply: '{"tool":"draft_email","to":["sam@x.com"],"subject":"Lunch Friday?","body":"Hi Sam — lunch Friday?"}',
      expected: { tool: "draft_email", to: ["sam@x.com"], subject: "Lunch Friday?", body: "Hi Sam — lunch Friday?" },
    },
    {
      ask: "search my computer for my resume",
      reply: '{"tool":"find_files","query":"resume"}',
      expected: { tool: "find_files", query: "resume" },
    },
    {
      ask: "every morning summarize my unread email",
      reply: '{"tool":"schedule_task","title":"Morning email digest","prompt":"Summarize my unread email","rule":"daily","time":"08:00"}',
      expected: {
        tool: "schedule_task",
        title: "Morning email digest",
        prompt: "Summarize my unread email",
        rule: "daily",
        time: "08:00",
      },
    },
    {
      ask: "save this script then run it",
      reply: '{"tool":"write_file","path":"run.py","content":"print(2+2)"}',
      expected: { tool: "write_file", path: "run.py", content: "print(2+2)" },
    },
  ];

  for (const c of cases) {
    it(`"${c.ask}" → ${c.expected?.tool}`, () => {
      expect(parseBuddyToolCall(c.reply)).toEqual(c.expected);
    });
  }

  it("recovers a tool call even when a weak model wraps it in prose + a fence + a trailing comma", () => {
    const sloppy = 'Sure, let me look that up!\n```json\n{"tool":"search_web","query":"VA SOL Algebra 1 standards",}\n```';
    expect(parseBuddyToolCall(sloppy)).toEqual({ tool: "search_web", query: "VA SOL Algebra 1 standards" });
  });

  it("parses SEVERAL batched calls so the model can string tools together in one reply", () => {
    const reply =
      '{"tool":"create_task","title":"Milk"}\n' +
      '{"tool":"create_task","title":"Bread"}\n' +
      '{"tool":"create_task","title":"Eggs"}';
    const calls = parseBuddyToolCalls(reply);
    expect(calls.map((c) => c.tool)).toEqual(["create_task", "create_task", "create_task"]);
    expect(calls.map((c) => (c.tool === "create_task" ? c.title : ""))).toEqual(["Milk", "Bread", "Eggs"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE PROMPT CARRIES THE DISAMBIGUATION GUIDANCE for the confusable pairs
// ───────────────────────────────────────────────────────────────────────────
describe("scenario: the system prompt instructs the natural-language → tool mapping", () => {
  const prompt = buildBuddySystemPrompt({
    persona: "freeform",
    library: [{ id: "text-1", title: "Dune", author: "Frank Herbert", addedAt: 1 }],
    canSearchFiles: true,
    canRunCommands: true,
    canAutonomousWorkspace: true,
    canWolfram: true,
    canGoogle: true,
    canSchwab: true,
    canTvBridge: true,
    mcpServers: ["notes"],
    canAutomateTasks: true,
  });

  it("search_images vs generate_image: real-vs-new image rule is present", () => {
    expect(prompt).toContain("PICKING THE IMAGE TOOL");
    expect(prompt).toContain("wants a REAL image → search_images");
    expect(prompt).toContain("wants NEW art → generate_image");
  });
  it("calculate vs wolfram: 'use calculate for pure math' is present", () => {
    expect(prompt).toContain("use calculate for pure math");
  });
  it("open_code vs open_pasted_text: 'NOT open_pasted_text' for code is present", () => {
    expect(prompt).toContain("NOT open_pasted_text");
  });
  it("write_file vs the chat Save button: 'Save button' caveat is present", () => {
    expect(prompt).toContain("Save button");
  });
  it("draft_email vs send_email: draft is the default ('draft_email instead')", () => {
    expect(prompt).toContain("draft_email instead");
  });
  it("find_files vs search_*: local-vs-web domain rule is present", () => {
    expect(prompt).toContain("search_books / search_web");
  });
  it("delegate vs spawn_agents: parallel-vs-single rule is present", () => {
    expect(prompt).toContain("faster than delegating");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. MULTI-STEP CHAINS EXECUTE AND FEED RESULTS FORWARD (runBuddyTurn loop)
// ───────────────────────────────────────────────────────────────────────────
describe("scenario: chains run in order and each result feeds the next round", () => {
  it("research → open: search_books, then open the hit, then answer", async () => {
    const llm = scriptedLlm([
      '{"tool":"search_books","query":"thermodynamics"}',
      '{"tool":"open_web_text","url":"https://g.test/thermo.txt","title":"Thermodynamics","mode":"technical","visuals":true}',
      "Opened it in technical mode so the diagrams come through — want to start with the first law?",
    ]);
    const openedUrls: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "find a thermodynamics book and open it" }],
      deps: baseDeps({
        searchBooks: async (q) => {
          expect(q).toBe("thermodynamics");
          return [{ title: "Thermodynamics", author: "Fermi", textUrl: "https://g.test/thermo.txt" }];
        },
        openWebText: async (call) => {
          openedUrls.push(call.url);
          return { title: call.title ?? "?", chapters: 5, pages: 120, visuals: true };
        },
      }),
    });
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["search_books", "open_web_text"]);
    expect(openedUrls).toEqual(["https://g.test/thermo.txt"]);
    expect(outcome.text).toContain("technical mode");
    expect(llm.calls).toHaveLength(3); // the model saw BOTH tool results before answering
  });

  it("write → run → fix loop: write_file then run_command execute out-of-band and feed output back", async () => {
    const llm = scriptedLlm([
      '{"tool":"write_file","path":"calc.py","content":"print(6*7)"}',
      '{"tool":"run_command","command":"python calc.py"}',
      "Ran it — it prints 42, so the script works.",
    ]);
    const ran: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "write a script that prints 6*7 and run it" }],
      deps: baseDeps(),
      // The write-capable path (coding agent / autonomous workspace): host tools execute inline and
      // their results feed back, instead of suspending the turn.
      runHostTool: async (call): Promise<BuddyToolResultPayload> => {
        ran.push(call.tool);
        if (call.tool === "write_file") return { writeFile: { path: call.path, ok: true } };
        if (call.tool === "run_command") return { command: { stdout: "42\n", stderr: "", code: 0 } };
        return { error: "unexpected tool" };
      },
    });
    expect(ran).toEqual(["write_file", "run_command"]);
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["write_file", "run_command"]);
    expect(outcome.text).toContain("42");
    expect(llm.calls).toHaveLength(3);
  });

  it("gated handoff: a host tool with NO out-of-band runner suspends the turn for approval", async () => {
    const llm = scriptedLlm(['{"tool":"run_command","command":"rm -rf build && make"}']);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "rebuild the project" }],
      deps: baseDeps(),
      // no runHostTool → run_command can't run inline; it's handed up for the reader to approve.
    });
    expect(outcome.pendingTool).toEqual({ tool: "run_command", command: "rm -rf build && make" });
    expect(outcome.text).toBe(""); // turn paused, no prose yet
    expect(outcome.toolResults).toHaveLength(0);
  });

  it("email triage: gmail_search → read_email → draft_email, each fed the prior result", async () => {
    const llm = scriptedLlm([
      '{"tool":"gmail_search","query":"acme invoice"}',
      '{"tool":"read_email","id":"m1"}',
      '{"tool":"draft_email","to":["billing@acme.test"],"subject":"Re: Invoice 88","body":"Thanks — paying today."}',
      "Drafted a reply to Acme — it's in your Drafts to review.",
    ]);
    const seq: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "reply to the acme invoice email" }],
      deps: baseDeps({
        gmailSearch: async (q) => {
          seq.push(`search:${q}`);
          return [{ id: "m1", from: "Acme <billing@acme.test>", subject: "Invoice 88", date: "2026-06-20", snippet: "Due today" }];
        },
        readEmail: async (id) => {
          seq.push(`read:${id}`);
          return { id, from: "Acme <billing@acme.test>", subject: "Invoice 88", date: "2026-06-20", snippet: "Due today", body: "Invoice 88 for $200 is due today." };
        },
        draftEmail: async (d) => {
          seq.push(`draft:${d.to.join(",")}`);
          return { id: "draft-1" };
        },
      }),
    });
    expect(seq).toEqual(["search:acme invoice", "read:m1", "draft:billing@acme.test"]);
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["gmail_search", "read_email", "draft_email"]);
    expect(outcome.text).toContain("Drafted");
    expect(llm.calls).toHaveLength(4);
  });

  it("markets: read the watchlist, quote a symbol, then a gated prep_order suspends for review", async () => {
    const llm = scriptedLlm([
      '{"tool":"schwab_watchlists"}',
      '{"tool":"schwab_quote","symbol":"NVDA"}',
      '{"tool":"prep_order","assetType":"EQUITY","symbol":"NVDA","instruction":"BUY","quantity":10,"orderType":"LIMIT","price":120}',
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "pull a trade from my watchlist and prep it" }],
      deps: baseDeps({
        schwabWatchlists: async () => [{ name: "Ideas", items: [] } as unknown as Awaited<ReturnType<NonNullable<BuddyDeps["schwabWatchlists"]>>>[number]],
        schwabQuote: async () => ({ symbol: "NVDA", last: 118 } as unknown as Awaited<ReturnType<NonNullable<BuddyDeps["schwabQuote"]>>>),
      }),
    });
    // The two reads run inline and feed back; the order is the ALWAYS-gated step → suspends.
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["schwab_watchlists", "schwab_quote"]);
    expect(outcome.pendingTool?.tool).toBe("prep_order");
  });

  it("fan-out: spawn_agents runs subtasks in parallel and feeds all results back at once", async () => {
    const llm = scriptedLlm([
      '{"tool":"spawn_agents","tasks":["EV battery suppliers","solid-state startups"]}',
      "Here's the comparison across both research threads.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "research two angles in parallel" }],
      deps: baseDeps(),
      runSubAgents: async (tasks) => tasks.map((t) => ({ task: t, result: `findings for ${t}` })),
    });
    const sub = outcome.toolResults[0]?.result.subAgents ?? [];
    expect(sub.map((s) => s.task)).toEqual(["EV battery suppliers", "solid-state startups"]);
    expect(outcome.text).toContain("comparison");
    expect(llm.calls).toHaveLength(2);
  });

  it("no dead-end on failure: a failed tool's error is fed back and the model recovers with another", async () => {
    const events: BuddyTurnEvent[] = [];
    const llm = scriptedLlm([
      '{"tool":"wolfram","query":"distance earth to mars"}', // no wolfram dep wired → error
      '{"tool":"search_web","query":"current distance earth to mars km"}',
      "Wolfram wasn't available, so I checked the web — they're about 0.5 AU apart right now.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "how far is mars right now" }],
      deps: baseDeps({ searchWeb: async () => [{ link: "https://x.test", title: "Mars distance", snippet: "~0.5 AU" }] }),
      onEvent: (e) => events.push(e),
    });
    expect(outcome.toolResults[0]?.result.error).toBeTruthy(); // wolfram failed
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["wolfram", "search_web"]); // recovered
    expect(outcome.text).toContain("web");
    expect(llm.calls).toHaveLength(3);
  });

  it("batched in ONE reply: two to-dos + a web search all run in a single round", async () => {
    const created: string[] = [];
    const searched: string[] = [];
    const llm = scriptedLlm([
      '{"tool":"create_task","title":"Book outbound flight"}\n' +
        '{"tool":"create_task","title":"Book return flight"}\n' +
        '{"tool":"search_web","query":"flights to Iowa City"}',
      "Added both to-dos and here are some flight options.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "add the flight to-dos and find flights" }],
      deps: baseDeps({
        createTask: async (t) => {
          created.push(t.title);
          return { id: String(created.length), title: t.title };
        },
        searchWeb: async (q) => {
          searched.push(q);
          return [];
        },
      }),
    });
    expect(created).toEqual(["Book outbound flight", "Book return flight"]);
    expect(searched).toEqual(["flights to Iowa City"]);
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["create_task", "create_task", "search_web"]);
    expect(llm.calls).toHaveLength(2); // all three ran in ONE round, then the model answered
  });

  it("no real limit: a chain of 8 sequential tool rounds all run (well past the old cap of 5)", async () => {
    const replies = Array.from({ length: 8 }, (_, i) => `{"tool":"search_web","query":"step ${i}"}`);
    replies.push("Worked through all eight lookups — here's the synthesis.");
    const llm = scriptedLlm(replies);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "research this thoroughly, take as many steps as you need" }],
      deps: baseDeps({ searchWeb: async () => [] }),
    });
    expect(outcome.toolResults).toHaveLength(8); // not truncated at 5
    expect(outcome.text).toContain("synthesis");
    expect(llm.calls).toHaveLength(9); // 8 tool rounds + the final answer
  });

  it("reply-as-you-go: a progress-chunk directive reaches the model partway through a long run", async () => {
    const replies = Array.from({ length: 8 }, (_, i) => `{"tool":"search_web","query":"q${i}"}`);
    replies.push("Done.");
    const llm = scriptedLlm(replies);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "long research job" }],
      deps: baseDeps({ searchWeb: async () => [] }),
    });
    // Somewhere in the back-and-forth the loop fed the model a "narrate progress so it's recoverable"
    // directive (every TOOL_PROGRESS_EVERY rounds) — so a long run surfaces resumable chunks.
    const sawProgressDirective = llm.calls
      .flat()
      .some((m) => m.role === "user" && /follow along/i.test(typeof m.content === "string" ? m.content : ""));
    expect(sawProgressDirective).toBe(true);
  });
});
