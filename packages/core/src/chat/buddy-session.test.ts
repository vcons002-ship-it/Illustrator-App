import { describe, expect, it } from "vitest";
import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import {
  runBuddyTurn,
  nonEmptyAnswer,
  isBareAcknowledgement,
  MIN_CONTINUABLE_CHARS,
  type BuddyTurnEvent,
} from "./buddy-session.js";
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

describe("runBuddyTurn — a huge tool result doesn't cost the assistant its instructions", () => {
  it("still shows the model the system prompt and the request, after a 60k-char read", async () => {
    // The reported failure. A file read appends up to 60,000 characters mid-turn, which on a small
    // local window is several times the whole input allowance — the server then truncates from the
    // FRONT, taking the system prompt and the request with it. So it reads a file and immediately
    // doesn't know what it was doing.
    const llm = scriptedLlm(['{"tool":"read_file","path":"big.txt"}', "Done — invite created."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "SYSTEM: you can create calendar invites.",
      history: [
        { role: "user", content: "OLD: unrelated chatter" },
        { role: "assistant", content: "OLD: sure" },
        { role: "user", content: "GOAL: read big.txt then create the calendar invite." },
      ],
      contextChars: 4_000,
      deps: { ...baseDeps, readFile: async () => "x".repeat(60_000) },
    });
    expect(outcome.text).toContain("invite created");
    // The SECOND call is the one made after the file landed in the context.
    const afterRead = llm.calls[1]!;
    expect(afterRead[0]!.content).toContain("SYSTEM: you can create calendar invites.");
    expect(afterRead.some((m) => m.content.includes("GOAL: read big.txt"))).toBe(true);
    expect(afterRead.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(4_000);
  });

  it("sends everything when no budget is set — sub-agents and tests are unaffected", async () => {
    const llm = scriptedLlm(['{"tool":"read_file","path":"big.txt"}', "Done."]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "go" }],
      deps: { ...baseDeps, readFile: async () => "x".repeat(60_000) },
    });
    expect(llm.calls[1]!.reduce((n, m) => n + m.content.length, 0)).toBeGreaterThan(50_000);
  });
});

describe("runBuddyTurn — tools loaded on demand", () => {
  const docFor = (id: string) => `TOOLSET "${id}" — loaded.\n- {"tool":"run_command","command":"…"}`;

  it("loads a set when the model asks, and the tools then work", async () => {
    const llm = scriptedLlm([
      '{"tool":"load_toolset","name":"coding"}',
      '{"tool":"run_command","command":"ls"}',
      "Done.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "list the files" }],
      loadedToolsets: [],
      toolsetDoc: docFor,
      runHostTool: async () => ({ command: { stdout: "a.txt", stderr: "", code: 0, timedOut: false } }),
      deps: baseDeps,
    });
    expect(outcome.loadedToolsets).toContain("coding");
    const fed = outcome.transcript.map((t) => t.content).join("\n");
    expect(fed).toContain('TOOLSET "coding" — loaded');
    expect(fed).toContain("a.txt"); // the real call ran afterwards
  });

  it("SUPPLIES the documentation when the model forgets to load — never an error", async () => {
    // The property the whole scheme rests on: a model that guesses gets what it needed back, not a
    // refusal. It never has to remember to look something up first.
    const llm = scriptedLlm(['{"tool":"run_command","command":"ls"}', "Understood.", "Done."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "list the files" }],
      loadedToolsets: [],
      toolsetDoc: docFor,
      deps: baseDeps,
    });
    const fed = outcome.transcript.map((t) => t.content).join("\n");
    expect(fed).toContain('TOOLSET "coding" — loaded');
    expect(fed).toMatch(/Re-issue that call now/);
    expect(fed).not.toMatch(/failed|not available|can't/i);
    expect(outcome.loadedToolsets).toContain("coding");
  });

  it("carries a set the session already loaded, without re-fetching it", async () => {
    const llm = scriptedLlm(['{"tool":"run_command","command":"ls"}', "Done."]);
    let docs = 0;
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "again" }],
      loadedToolsets: ["coding"],
      toolsetDoc: (id) => { docs++; return docFor(id); },
      runHostTool: async () => ({ command: { stdout: "ok", stderr: "", code: 0, timedOut: false } }),
      deps: baseDeps,
    });
    expect(docs).toBe(0); // already had it
    expect(outcome.transcript.map((t) => t.content).join("\n")).toContain("ok");
  });

  it("names the real groups when asked for one that doesn't exist", async () => {
    // Parsed rather than dropped: a dropped call vanishes and the model learns nothing.
    const llm = scriptedLlm(['{"tool":"load_toolset","name":"telepathy"}', "Sorry."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "x" }],
      loadedToolsets: [],
      toolsetDoc: () => "",
      deps: baseDeps,
    });
    const fed = outcome.transcript.map((t) => t.content).join("\n");
    expect(fed).toContain("no toolset called");
    expect(fed).toContain("coding"); // …and lists the ones that do exist
  });

  it("does not gate anything when the host hasn't opted in", async () => {
    // Sub-agents and every existing caller keep the old behaviour: every tool callable, no index.
    const llm = scriptedLlm(['{"tool":"search_web","query":"q"}', "Found it."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "x" }],
      deps: { ...baseDeps, searchWeb: async () => [{ link: "https://x", title: "t", snippet: "s" }] },
    });
    expect(outcome.loadedToolsets).toBeUndefined();
    expect(outcome.text).toContain("Found it");
  });
});

describe("runBuddyTurn — extract_from_document", () => {
  const bigDoc = Array.from({ length: 4_000 }, (_, i) => `line ${i + 1}: some contract text here`).join("\n");

  it("sweeps the whole document and returns findings, never the document", async () => {
    // The point of the tool: a document far larger than the window costs one result-sized message.
    const llm = scriptedLlm([
      '{"tool":"extract_from_document","path":"/c.txt","question":"every deadline"}',
      '{"findings":[{"text":"Deadline: 3 March","line":12}]}',
      "There's one deadline: 3 March.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "find every deadline in /c.txt" }],
      contextChars: 30_000,
      deps: { ...baseDeps, readFile: async () => bigDoc },
    });
    expect(outcome.text).toContain("3 March");
    const fedBack = outcome.transcript.map((t) => t.content).join("\n");
    expect(fedBack).toContain("line 12: Deadline: 3 March");
    // The document did not enter the conversation.
    expect(fedBack).not.toContain("line 3000: some contract text");
    expect(fedBack.length).toBeLessThan(5_000);
  });

  it("tells the model to just READ a file small enough to read, instead of sweeping it", async () => {
    // No silent degradation: chunking a short file is a slower, lossier route to an answer it could
    // have had in full.
    const llm = scriptedLlm([
      '{"tool":"extract_from_document","path":"/small.txt","question":"every deadline"}',
      "Reading it directly instead.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "find every deadline" }],
      contextChars: 30_000,
      deps: { ...baseDeps, readFile: async () => "a short file" },
    });
    const fedBack = outcome.transcript.map((t) => t.content).join("\n");
    expect(fedBack).toContain("small enough to read directly");
    expect(fedBack).toContain('"tool":"read"');
    expect(outcome.text).toContain("Reading it directly");
  });

  it("says so rather than pretending, when file access is off", async () => {
    const llm = scriptedLlm([
      '{"tool":"extract_from_document","path":"/c.txt","question":"q"}',
      "I can't read your files.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "sweep it" }],
      deps: baseDeps,
    });
    expect(outcome.transcript.map((t) => t.content).join("\n")).toContain("isn't enabled");
  });
});

describe("runBuddyTurn — story-mode empty-reply repair", () => {
  it("re-prompts for the next BEAT (not a meta wrap-up) and returns the recovered prose", async () => {
    const llm = scriptedLlm(["", "She steps into the rain, and the door clicks shut behind her."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "go on" }],
      deps: baseDeps,
      storyMode: true,
    });
    // The recovered reply IS the beat (so the worker's shouldAppendBeat will append it).
    expect(outcome.text).toBe("She steps into the rain, and the door clicks shut behind her.");
    // The second call's wrap directive asked for the next beat, NOT "say what you did".
    const wrap = llm.calls[1]!.map((t) => t.content).join("\n");
    expect(wrap).toMatch(/next beat/i);
    expect(wrap).not.toMatch(/say what you did/i);
  });

  it("falls back to the generic wrap-up when not in story mode", async () => {
    const llm = scriptedLlm(["", "I searched and found three results."]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "go on" }],
      deps: baseDeps,
    });
    const wrap = llm.calls[1]!.map((t) => t.content).join("\n");
    expect(wrap).toMatch(/plain text/i);
    expect(wrap).not.toMatch(/next beat/i);
  });
});

describe("runBuddyTurn — turn-local steering stays out of the persisted transcript", () => {
  /** A turn that keeps calling tools until the per-turn round cap trips the "Do NOT call another
   * tool now" nudge. */
  const runToToolLimit = async () => {
    const llm = scriptedLlm([...Array<string>(MAX_BUDDY_TOOL_ROUNDS).fill('{"tool":"search_web","query":"q"}'), "Here's the summary."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "research this" }],
      deps: { ...baseDeps, searchWeb: async () => [{ title: "T", link: "http://x.test", snippet: "S" }] },
    });
    return { llm, outcome };
  };

  it("does not persist the tool-limit directive as chat history", async () => {
    // The transcript is replayed verbatim as history on EVERY later turn. Persisting "Do NOT call
    // another tool now" made it a standing instruction long after the limit was irrelevant — the
    // model would then reason about why it was forbidden from calling tools.
    const { outcome } = await runToToolLimit();
    const persisted = outcome.transcript.map((t) => t.content).join("\n");
    expect(persisted).not.toMatch(/Do NOT call another tool/i);
    expect(persisted).not.toMatch(/tool-call limit/i);
    expect(persisted).not.toMatch(/Before your NEXT tool call/i);
    expect(persisted).not.toMatch(/Re-issue the remaining host tool/i);
  });

  it("still keeps the tool RESULTS in the transcript (the durable record of what happened)", async () => {
    const { outcome } = await runToToolLimit();
    const persisted = outcome.transcript.map((t) => t.content).join("\n");
    expect(persisted).toMatch(/x\.test|search_web/i); // the result line survives
  });

  it("still SHOWS the model the limit directive during the turn that hit it", async () => {
    // Dropping it from the transcript must not stop it steering the live turn — otherwise the model
    // spends its last round on a tool whose result it can never follow up on.
    const { llm } = await runToToolLimit();
    const lastSent = llm.calls[llm.calls.length - 1]!.map((t) => t.content).join("\n");
    expect(lastSent).toMatch(/Do NOT call another tool/i);
  });
});

describe("runBuddyTurn — transient-error auto-retry", () => {
  it("retries a read-only tool once, turning the blip into a silent recovery", async () => {
    const llm = scriptedLlm(['{"tool":"search_web","query":"q"}', "Found it."]);
    let attempts = 0;
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "?" }],
      deps: {
        ...baseDeps,
        searchWeb: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("fetch failed");
          return [{ title: "T", link: "http://x.test", snippet: "S" }];
        },
      },
    });
    expect(attempts).toBe(2);
    expect(outcome.text).toBe("Found it.");
  });

  it("never re-runs a write tool — the error surfaces instead of duplicating the side effect", async () => {
    // A "retryable" error can arrive AFTER the write landed (a timeout on the response);
    // re-running create_task here would create the task twice.
    const llm = scriptedLlm(['{"tool":"create_task","title":"buy milk"}', "That failed, sorry."]);
    let attempts = 0;
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "add it" }],
      deps: {
        ...baseDeps,
        createTask: async () => {
          attempts += 1;
          throw new Error("Request timed out");
        },
      },
    });
    expect(attempts).toBe(1);
    expect(outcome.toolResults[0]?.result.error).toMatch(/timed out/i);
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

/**
 * "SEND ME THE ALPHABET, ONE LETTER PER MESSAGE."
 *
 * A turn ends when the model stops calling tools, so this was unanswerable: it wrote A, the turn was
 * over, and the reader had to ask twenty-five more times. The only workaround was a checklist — and
 * a 26-step checklist for the alphabet is heavier than the request, hit the step cap, and filled the
 * screen with a list nobody wanted.
 *
 * Nothing else was missing. A turn already allows fifty rounds, and prose written before a tool call
 * already becomes its own chat message. All that was absent was a way to say "not finished".
 */
/**
 * "TRUNCATED" MEANS THE TOKEN BUDGET RAN OUT — NOT THAT THE ANSWER WAS CUT OFF.
 *
 * On a reasoning model those are routinely different things: it can spend the whole budget thinking
 * and emit one visible character. The auto-continue loop believed the flag, told a model that had
 * written "A" to "pick up at the next character", and got back the only sensible reply to an
 * impossible request — "please provide the exact text where the previous response was cut off".
 * Then it did that eight more times, pushing its own reply and the directive into the context each
 * pass, until a two-message chat was at 100% of the window and being compacted.
 */
describe("runBuddyTurn — a budget spent thinking is not an answer cut short", () => {
  /** A scripted model that always reports it hit the token budget. */
  function truncatedLlm(replies: string[]): ChatCapable & { calls: ChatTurn[][] } {
    const calls: ChatTurn[][] = [];
    return {
      calls,
      async chat(messages, opts) {
        calls.push([...messages]);
        opts?.onComplete?.({ truncated: true });
        return replies[Math.min(calls.length - 1, replies.length - 1)]!;
      },
    };
  }

  it("does not ask a one-character reply to continue itself", async () => {
    const llm = truncatedLlm(["A", "Please provide the exact text where the previous response was cut off."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send me the alphabet, one letter per message" }],
      deps: baseDeps,
    });
    expect(llm.calls, "it went back for a continuation of a single character").toHaveLength(1);
    expect(outcome.text).toBe("A");
    // …and does not tell the reader it paused mid-thought, which would invite them to ask for a
    // continuation that does not exist.
    expect(outcome.text, "offered to continue something that was never started").not.toMatch(/paused here/);
  });

  it("still continues a long answer that really was cut short", async () => {
    const long = "x".repeat(MIN_CONTINUABLE_CHARS + 10);
    const llm = truncatedLlm([long, "…and the rest of it."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "write the whole thing" }],
      deps: baseDeps,
    });
    expect(llm.calls.length, "a genuinely truncated document was not continued").toBeGreaterThan(1);
    expect(outcome.text).toContain("and the rest of it");
  });

  it("stops the moment a continuation adds nothing", async () => {
    // A pass that adds nothing will not add anything next time either, and each one costs a model
    // call and two more messages of context. The old loop ran all eight regardless.
    const long = "y".repeat(MIN_CONTINUABLE_CHARS + 10);
    const llm = truncatedLlm([long, "   "]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "write it" }],
      deps: baseDeps,
    });
    expect(llm.calls.length, "it kept asking a model that had nothing more to give").toBeLessThanOrEqual(2);
  });
});

describe("runBuddyTurn — a turn that is many messages, without a checklist", () => {
  it("keeps sending until the model stops asking for another round", async () => {
    const llm = scriptedLlm([
      'A\n{"tool":"keep_going"}',
      'B\n{"tool":"keep_going"}',
      'C\n{"tool":"keep_going"}',
      "That's the first three.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send me the alphabet, one letter per message" }],
      deps: baseDeps,
    });
    expect(outcome.toolResults.filter((r) => r.call.tool === "keep_going")).toHaveLength(3);
    expect(outcome.toolResults.every((r) => !r.result.error), "a keep_going was refused").toBe(true);
    // Each round's message survives in the transcript, in order — that is what the reader sees as
    // separate bubbles, via the prose-before-a-tool handling in App.
    const said = outcome.transcript.map((t) => t.content).join("\n");
    expect(said).toContain("A");
    expect(said).toContain("B");
    expect(said).toContain("C");
    expect(outcome.text).toContain("first three");
  });

  it("makes NO checklist for it — the plan is the thing this replaces", async () => {
    let planned = false;
    const llm = scriptedLlm(['A\n{"tool":"keep_going"}', "B"]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "count to two, one per message" }],
      deps: { ...baseDeps, setPlan: () => { planned = true; return { steps: [] }; } },
    });
    expect(planned, "it still built a checklist for a job that is just more messages").toBe(false);
  });

  /**
   * THE DIRECTIVE THAT KILLED IT, CAUGHT IN THE MODEL'S OWN WORDS.
   *
   * A reply carrying no visible prose triggers a wrap-up directive — routine for a reasoning model,
   * whose first pass can be all thinking. That directive said "No tool calls", and the reader's
   * transcript showed exactly what the model did with it: "Since I am explicitly told 'No tool
   * calls', this instruction about keep_going is overridden for *this* turn. I must stop after
   * sending 'A'."
   *
   * It reasoned correctly. The clause exists to stop the model reaching for ANOTHER tool instead of
   * answering; keep_going runs nothing and only says the turn is unfinished.
   */
  it("does not forbid keep_going when it asks for plain text", async () => {
    // Round 0 is all thinking and no prose — the state that fires the wrap-up.
    const llm = scriptedLlm(["", 'A\n{"tool":"keep_going"}', "B"]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send me the alphabet, one letter at a time" }],
      deps: baseDeps,
    });
    const wrap = llm.calls
      .flat()
      .map((m) => m.content)
      .find((c) => /Now reply to the reader in plain text/.test(c));
    expect(wrap, "the wrap-up directive was never sent").toBeTruthy();
    expect(wrap, "it still tells the model every tool is off, keep_going included").toMatch(
      /except keep_going/,
    );
  });

  /**
   * This one PASSES against the old code, and says so on purpose. A scripted model does as it is
   * told by the script, not by the directive, so no test here can show a model obeying "no tool
   * calls" — only the wording assertion above guards the actual fix. What this pins is the other
   * half: that a keep_going arriving after a wrap-up round is honoured at all, so the round loop
   * cannot quietly stop buying rounds once a turn has been through the wrap-up path.
   */
  it("honours a keep_going that arrives after a wrap-up round", async () => {
    const llm = scriptedLlm(["", 'A\n{"tool":"keep_going"}', 'B\n{"tool":"keep_going"}', "C"]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send me the alphabet, one letter at a time" }],
      deps: baseDeps,
    });
    expect(
      outcome.toolResults.filter((r) => r.call.tool === "keep_going" && !r.result.error),
      "the turn ended on the first letter again",
    ).toHaveLength(2);
  });

  /**
   * ONE FORGOTTEN keep_going USED TO END THE WHOLE RUN.
   *
   * The alphabet needs twenty-six consecutive correct emissions, and a miss on any one of them ends
   * the turn silently — "F" with no keep_going is byte-for-byte what "F was the last one" looks
   * like. Asking costs one model call per stall and converts an unrecoverable run into a recoverable
   * one.
   */
  it("asks rather than assumes when a running series stops asking for rounds", async () => {
    const llm = scriptedLlm([
      'A\n{"tool":"keep_going"}',
      "B", // the miss — under the old code the turn ended here, on B
      'C\n{"tool":"keep_going"}',
      "D",
      "that's all",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send me A to D, one letter at a time" }],
      deps: baseDeps,
    });
    const said = outcome.transcript
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join(" ");
    for (const letter of ["A", "B", "C", "D"]) {
      expect(said, `the run stopped before ${letter}`).toContain(letter);
    }
  });

  it("asks again on a later stall, instead of spending its one question on the first", async () => {
    // B stalls, C revives it, D stalls again. If the question were once-per-turn rather than
    // once-per-stall, a long run would get exactly one rescue and then end at the next miss.
    const llm = scriptedLlm([
      'A\n{"tool":"keep_going"}',
      "B",
      'C\n{"tool":"keep_going"}',
      "D",
      "that's all",
    ]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send me A to D, one letter at a time" }],
      deps: baseDeps,
    });
    const asks = llm.calls
      .flat()
      .map((m) => m.content)
      .filter((c) => /Was that the last one\?/.test(c));
    expect(asks.length, "the second stall was never questioned").toBeGreaterThanOrEqual(2);
  });

  it("never questions a turn that was only ever one answer", async () => {
    // The guard that keeps this off ordinary chat: no keep_going has carried a message, so there is
    // no series to be in the middle of, and a plain reply must cost exactly one model call.
    const llm = scriptedLlm(["Paris."]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "what is the capital of France?" }],
      deps: baseDeps,
    });
    expect(llm.calls, "a one-line answer was interrogated about a series it never started").toHaveLength(1);
  });

  /**
   * THE THING THAT ACTUALLY KILLED THE ALPHABET AT F.
   *
   * Each round's reasoning tail is fed back on the next round so a tool loop doesn't re-derive its
   * plan. It goes in as a `user` message — bracketed and addressed to the model as its own, but role
   * beats prose. On a tool round that is a fair trade. On a message series it is one narration of the
   * model's inner monologue per letter, and by the tenth the model stopped believing the transcript:
   *
   *   Wait, looking at the previous turn in the prompt (Turn 10/11):
   *   User: "... I need to send E next..." -> Model sent E.
   *   Is it possible that "E" was actually F?
   *   ... The simulation in Turn 12 claims history is up to F.
   *
   * It audited the history against itself, called it a simulation, spent the turn's whole budget
   * there and answered with the empty-answer fallback.
   */
  function thinkingLlm(replies: string[]): ChatCapable & { seen: string[] } {
    let n = 0;
    const seen: string[] = [];
    return {
      seen,
      async chat(messages, opts) {
        for (const m of messages) seen.push(m.content);
        opts?.onThinking?.(`I need to send letter number ${n + 1} next, then keep going.`);
        return replies[Math.min(n++, replies.length - 1)]!;
      },
    };
  }

  it("does not narrate the model's own reasoning back at it between messages", async () => {
    const llm = thinkingLlm(['A\n{"tool":"keep_going"}', 'B\n{"tool":"keep_going"}', "C"]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send me A to C, one letter at a time" }],
      deps: baseDeps,
      onEvent: () => {},
    });
    expect(
      llm.seen.filter((c) => /Your own reasoning just before that call/.test(c)),
      "the series still replays its own thinking as a reader turn, once per message",
    ).toHaveLength(0);
  });

  it("still carries reasoning across a round where facts actually arrived", async () => {
    // The narrow half of the fix. A search result is exactly the case the recap was built for — the
    // facts are in front of the model and the intent it had for them is not — so dropping it there
    // would trade one bug for the one it was written to prevent.
    const llm = thinkingLlm(['{"tool":"search_web","query":"X facts"}', "Found it."]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "look up X" }],
      deps: { ...baseDeps, searchWeb: async () => [{ title: "T", link: "http://x.test", snippet: "S" }] },
      onEvent: () => {},
    });
    expect(
      llm.seen.filter((c) => /Your own reasoning just before that call/.test(c)).length,
      "a tool round lost the intent that asked for its results",
    ).toBeGreaterThan(0);
  });

  it("refuses a round bought with nothing written", async () => {
    // A keep_going with no message buys a round and sends nothing, and fifty of those is a turn
    // that looks like thinking and produces silence.
    const llm = scriptedLlm(['{"tool":"keep_going"}', "Sorry — here it is: A"]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "go" }],
      deps: baseDeps,
    });
    const kg = outcome.toolResults.filter((r) => r.call.tool === "keep_going");
    expect(kg).toHaveLength(1);
    expect(kg[0]!.result.error, "an empty keep_going was granted").toMatch(/nothing was sent/);
  });

  it("cannot run away — the turn's round budget still bounds it", async () => {
    // The model asks forever; the existing per-turn cap is what stops it, and nothing here may
    // extend that.
    const llm = scriptedLlm(['x\n{"tool":"keep_going"}']);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "go" }],
      deps: baseDeps,
    });
    expect(outcome.toolResults.length).toBeLessThanOrEqual(MAX_BUDDY_TOOL_ROUNDS);
    expect(llm.calls.length).toBeLessThanOrEqual(MAX_BUDDY_TOOL_ROUNDS + 2);
  });
});

describe("runBuddyTurn — multi-step checklists run EVERY step (no skipping)", () => {
  // A stateful working checklist, exactly like the host's set_plan/complete_step, so a full plan can
  // be driven through the loop and we can assert every step's tool actually fired.
  type Plan = { goal?: string; steps: { text: string; status: "pending" | "done"; note?: string }[] } | undefined;
  function planHarness() {
    let plan: Plan;
    const deps = {
      ...baseDeps,
      setPlan: (goal: string | undefined, steps: string[]) => {
        plan = { ...(goal ? { goal } : {}), steps: steps.map((t) => ({ text: t, status: "pending" as const })) };
        return plan;
      },
      completeStep: (note?: string) => {
        if (!plan) return undefined;
        const i = plan.steps.findIndex((s) => s.status !== "done");
        if (i < 0) return undefined;
        plan.steps[i] = { ...plan.steps[i]!, status: "done", ...(note ? { note } : {}) };
        return plan;
      },
    };
    return { deps, get plan() { return plan; } };
  }

  it("a 3-image checklist renders EVERY image and ticks EVERY step — none skipped", async () => {
    const h = planHarness();
    const llm = scriptedLlm([
      '{"tool":"set_plan","goal":"3 sunset images","steps":["Generate image 1 of the sunset","Generate image 2 of the sunset","Generate image 3 of the sunset"]}',
      '{"tool":"generate_image","prompt":"sunset one"}\n{"tool":"complete_step","note":"image 1 done"}',
      '{"tool":"generate_image","prompt":"sunset two"}\n{"tool":"complete_step","note":"image 2 done"}',
      '{"tool":"generate_image","prompt":"sunset three"}\n{"tool":"complete_step","note":"image 3 done"}',
      "All three sunsets are done!",
    ]);
    const rendered: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "generate 3 images of a sunset, one at a time" }],
      deps: h.deps,
      // Execute the host render in-band (what the app does between turns) so the whole queue runs here.
      runHostTool: async (call) => {
        if (call.tool === "generate_image") rendered.push(call.prompt);
        return { image: { ok: true } };
      },
    });
    // Every image was actually rendered, in order — not skipped, not deduped, not "already done".
    expect(rendered).toEqual(["sunset one", "sunset two", "sunset three"]);
    expect(outcome.toolResults.filter((r) => r.call.tool === "generate_image")).toHaveLength(3);
    expect(outcome.toolResults.filter((r) => r.call.tool === "complete_step")).toHaveLength(3);
    expect(h.plan!.steps.every((s) => s.status === "done")).toBe(true); // all 3 ticked
    expect(outcome.pendingTool).toBeUndefined();
    expect(outcome.text).toBe("All three sunsets are done!");
  });

  it("refuses a back-to-back complete_step (no work between) so a step can't be skipped", async () => {
    const h = planHarness();
    const llm = scriptedLlm([
      '{"tool":"set_plan","goal":"3 images","steps":["Generate image 1","Generate image 2","Generate image 3"]}',
      // Renders image 1, then tries to tick TWO steps at once — the exact "jumped ahead" bug.
      '{"tool":"generate_image","prompt":"img1"}\n{"tool":"complete_step"}\n{"tool":"complete_step"}',
      "ok",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "3 images" }],
      deps: h.deps,
      runHostTool: async () => ({ image: { ok: true } }),
    });
    // Only ONE step got ticked — the second check-off (no render between) was refused, so image 2's
    // step stays unfinished instead of being silently skipped.
    expect(h.plan!.steps.filter((s) => s.status === "done")).toHaveLength(1);
    expect(outcome.toolResults.filter((r) => r.call.tool === "complete_step" && r.result.error)).toHaveLength(1);
    const fedBack = llm.calls.flatMap((c) => c.map((t) => t.content)).join("\n");
    expect(fedBack).toMatch(/complete_step IGNORED — you just checked off a step with no work in between/);
  });

  /**
   * THE STALL: A CHECKLIST WHOSE STEPS ARE JUST MESSAGES NEVER GOT PAST THE SECOND ONE.
   *
   * The anti-skip guard cleared on a tool result and on nothing else, because it was written for a
   * checklist of renders — its own advice was "actually call generate_image". A step whose whole
   * deliverable is prose calls no tool at all, so the first tick armed the guard and every tick
   * after it was refused as "checked off too fast", with the work sitting finished on screen.
   */
  it("works a checklist whose steps are only messages, with no tool to show for them", async () => {
    const h = planHarness();
    const llm = scriptedLlm([
      '{"tool":"set_plan","goal":"explain the chapter","steps":["Explain the rigging","Explain the squall","Explain the lantern"]}',
      "The rigging is the standing and running gear that holds the masts and works the sails; black " +
        "against the sky it is easy to mistake for a figure at the rail.\n" +
        '{"tool":"complete_step","note":"rigging"}',
      "A squall is a short violent burst of wind and rain, usually gone within the hour, which is why " +
        "the boards are still wet while the sky has already cleared.\n" +
        '{"tool":"complete_step","note":"squall"}',
      "The lantern was her father's, introduced in chapter two, and has stood in for him in every " +
        "scene since — which is why she looks at it rather than at the rail.\n" +
        '{"tool":"complete_step","note":"lantern"}',
      "That's all three.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "explain the rigging, the squall and the lantern" }],
      deps: h.deps,
    });
    expect(h.plan!.steps.filter((s) => s.status === "done"), "a prose checklist stalled after step one")
      .toHaveLength(3);
    expect(
      outcome.toolResults.filter((r) => r.call.tool === "complete_step" && r.result.error),
      "a check-off earned by writing the answer was refused",
    ).toHaveLength(0);
  });

  it("still refuses a tick bought with a bare acknowledgement", async () => {
    // The other side of the same line: if any prose at all counted, a model could tick a whole
    // checklist off with "Done." and never do a thing. Only a real answer earns the next check-off.
    const h = planHarness();
    const llm = scriptedLlm([
      '{"tool":"set_plan","goal":"explain","steps":["Explain the rigging","Explain the squall"]}',
      'The rigging is the standing and running gear that holds the masts and works the sails, and it ' +
        'is what she actually saw at the rail.\n{"tool":"complete_step"}',
      'Done.\n{"tool":"complete_step"}',
      "ok",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "explain them" }],
      deps: h.deps,
    });
    expect(h.plan!.steps.filter((s) => s.status === "done"), "“Done.” bought a step").toHaveLength(1);
    expect(outcome.toolResults.filter((r) => r.call.tool === "complete_step" && r.result.error)).toHaveLength(1);
  });

  /**
   * "SEND ME THE ALPHABET, ONE LETTER PER MESSAGE" — where the whole deliverable of a step is one
   * character. The first version of the prose rule asked for 80 characters, on the theory that a
   * real answer is longer than a hand-off. It usually is, and here it never is: every step failed
   * the test that was meant to let text steps through, and the run stopped with 0 of 12 ticked.
   */
  it("lets a step whose entire deliverable is one character check itself off", async () => {
    const h = planHarness();
    const llm = scriptedLlm([
      '{"tool":"set_plan","goal":"alphabet","steps":["Send A","Send B","Send C"]}',
      'A\n{"tool":"complete_step"}',
      'B\n{"tool":"complete_step"}',
      'C\n{"tool":"complete_step"}',
      "That's the first three.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send me the alphabet, one letter per message" }],
      deps: h.deps,
    });
    expect(h.plan!.steps.filter((s) => s.status === "done"), "a one-letter step could not tick").toHaveLength(3);
    expect(outcome.toolResults.filter((r) => r.call.tool === "complete_step" && r.result.error)).toHaveLength(0);
  });

  it("knows a hand-off from an answer, whatever its length", () => {
    for (const ack of ["Done.", "done", "OK", "Next", "✓ done", "Step 2 is complete", "on to the next step", "Got it!"]) {
      expect(isBareAcknowledgement(ack), `"${ack}" should not buy a step`).toBe(true);
    }
    for (const work of ["A", "B", "42", "The rigging is the standing gear.", "Done — the barn is painted red and the door is open."]) {
      expect(isBareAcknowledgement(work), `"${work}" is real work`).toBe(false);
    }
  });

  it("still refuses two check-offs inside one reply, however much was written", async () => {
    // A round is the unit on purpose: one reply is one blob of prose and can only ever be one step's
    // worth of work, so writing more must not buy more than one tick.
    const h = planHarness();
    const llm = scriptedLlm([
      '{"tool":"set_plan","goal":"explain","steps":["Explain the rigging","Explain the squall"]}',
      "The rigging is the standing and running gear that holds the masts and works the sails. A squall " +
        "is a short violent burst of wind and rain that is usually gone within the hour.\n" +
        '{"tool":"complete_step"}\n{"tool":"complete_step"}',
      "ok",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "explain them" }],
      deps: h.deps,
    });
    expect(h.plan!.steps.filter((s) => s.status === "done")).toHaveLength(1);
    expect(outcome.toolResults.filter((r) => r.call.tool === "complete_step" && r.result.error)).toHaveLength(1);
  });

  it("a research → compute chain runs each step's tool in order and ticks each step", async () => {
    const h = planHarness();
    const llm = scriptedLlm([
      '{"tool":"set_plan","goal":"research","steps":["Search the web for X","Compute the total"]}',
      '{"tool":"search_web","query":"X facts"}\n{"tool":"complete_step","note":"searched"}',
      '{"tool":"calculate","expression":"21 * 2"}\n{"tool":"complete_step","note":"computed"}',
      "Found it — the total is 42.",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "research X then compute the total" }],
      deps: { ...h.deps, searchWeb: async () => [{ title: "T", link: "http://x.test", snippet: "S" }] },
    });
    // The tools ran in the planned order, once each, with a tick after each.
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual([
      "set_plan",
      "search_web",
      "complete_step",
      "calculate",
      "complete_step",
    ]);
    expect(h.plan!.steps.every((s) => s.status === "done")).toBe(true);
    expect(outcome.text).toBe("Found it — the total is 42.");
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
    // The internal "reply in plain text" wrap directive must NOT leak into the persisted transcript
    // (it showed up in the chat as a "user" message — a real reported bug). The tool RESULT is a
    // legitimate user-role turn (the round-trip context); only the internal directive is forbidden.
    expect(outcome.transcript.some((t) => /reply to the reader in plain text/i.test(t.content))).toBe(false);
  });

  it("never persists a re-issue nudge into the transcript when a reply looks like tool JSON but doesn't parse", async () => {
    // First reply LOOKS like a tool call but isn't a known tool → the loop nudges (context only),
    // then the model answers in prose. The nudge must stay out of the stored transcript.
    const llm = scriptedLlm(['{"tool":"definitely_not_a_real_tool","x":1}', "Here's the plain answer."]);
    const outcome = await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "go" }], deps: baseDeps });
    expect(outcome.text).toBe("Here's the plain answer.");
    expect(outcome.transcript.some((t) => /Re-issue each tool call/i.test(t.content))).toBe(false);
    // No internal directive leaked as a user turn (no tool ran here, so there are no legit user turns).
    expect(outcome.transcript.some((t) => t.role === "user")).toBe(false);
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

  it("auto-continues a CUT-OFF answer and stitches the parts into one", async () => {
    // A scripted model that reports finish_reason "length" (truncated) for its first two replies,
    // then finishes — exactly the long-document case. Each chunk is a worksheet section.
    // Realistically sized: a chunk the server cut at the token budget is a section of a document,
    // not a fragment. A reply too short to have been mid-sentence is one whose budget went
    // elsewhere — see MIN_CONTINUABLE_CHARS — and is deliberately NOT continued.
    const pad = (body: string): string => body + "\n" + "Show your working for each. ".repeat(9);
    const chunks = [
      pad("## Algebra 1 — part A\n1) 2x+3=7"),
      pad("2) x^2-9=0"),
      pad("3) factor x^2+5x+6\nThat's the set!"),
    ];
    let n = 0;
    const llm: ChatCapable = {
      async chat(_messages, opts) {
        const i = n++;
        const truncated = i < chunks.length - 1; // last chunk finishes cleanly
        opts?.onComplete?.({ truncated });
        return chunks[Math.min(i, chunks.length - 1)]!;
      },
    };
    const events: BuddyTurnEvent[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "make an algebra worksheet" }],
      deps: baseDeps,
      onEvent: (e) => events.push(e),
    });
    // All three parts are present, in order, stitched together.
    expect(outcome.text).toContain("part A");
    expect(outcome.text).toContain("x^2-9=0");
    expect(outcome.text).toContain("That's the set!");
    // The model was called once + twice more for the continuations (3 total).
    expect(n).toBe(3);
    // The reader saw "part 2"/"part 3" progress while it wrote.
    expect(events.some((e) => e.kind === "activity" && /part 2/.test(e.text))).toBe(true);
    // History keeps ONE assistant turn (the assembled answer), not the truncated fragments.
    expect(outcome.transcript.filter((t) => t.role === "assistant")).toEqual([
      { role: "assistant", content: outcome.text },
    ]);
  });

  it("does NOT continue when the model finishes cleanly (no truncation)", async () => {
    let n = 0;
    const llm: ChatCapable = {
      async chat(_messages, opts) {
        n++;
        opts?.onComplete?.({ truncated: false });
        return "All done in one go.";
      },
    };
    const outcome = await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "hi" }], deps: baseDeps });
    expect(n).toBe(1);
    expect(outcome.text).toBe("All done in one go.");
  });

  it("stops at the per-turn safety cap with a 'continue' note (never a silent cut)", async () => {
    let n = 0;
    const llm: ChatCapable = {
      async chat(_messages, opts) {
        n++;
        opts?.onComplete?.({ truncated: true }); // a model that never finishes
        // Long enough to be a document still being written — a short reply that merely exhausted
        // the budget is not continued at all, which is a different test above.
        return `chunk${n} ` + "and it keeps going and going. ".repeat(9);
      },
    };
    const outcome = await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "write forever" }], deps: baseDeps });
    // 1 initial reply + MAX_REPLY_CONTINUATIONS (8) passes, then it stops — bounded, not infinite.
    expect(n).toBe(9);
    // The reader is told it paused and can continue — the answer is never silently truncated.
    expect(outcome.text).toMatch(/continue/i);
    expect(outcome.text).toContain("chunk1");
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
      about: "reader",
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

describe("app-managed steps: compiling the checklist is the whole turn", () => {
  // Reported: "it generated image 3 in step 1, then realised its mistake and generated image 1 before
  // checking off step 1." Both renders were real. The first happened in the SAME turn as set_plan —
  // the model acting on a plan the app hadn't yet given it a position in, so it reached for whichever
  // subject it was holding. The app can see THAT an image rendered but not WHAT it depicts, so that
  // render was discarded and step 1 was driven properly on the next turn. Correct, and wasteful: the
  // fix is to stop the turn at set_plan so the wrong render never happens.
  function planHarness() {
    let plan: { goal?: string; steps: { text: string; status: "pending" | "done" }[] } | undefined;
    return {
      deps: {
        ...baseDeps,
        appManagedSteps: true,
        setPlan: (goal: string | undefined, steps: string[]) => {
          plan = { ...(goal ? { goal } : {}), steps: steps.map((t) => ({ text: t, status: "pending" as const })) };
          return plan;
        },
      },
    };
  }
  const script = [
    '{"tool":"set_plan","goal":"3 images","steps":["Generate an image of a goat","Now the barn","And the tractor"]}',
    '{"tool":"generate_image","prompt":"the tractor"}', // what it would have done unprompted
  ];

  it("settles the moment the plan compiles, before the model can act on it", async () => {
    const rendered: string[] = [];
    const outcome = await runBuddyTurn({
      llm: scriptedLlm(script),
      system: "sys",
      history: [{ role: "user", content: "make me three pictures" }],
      deps: planHarness().deps,
      runHostTool: async (call) => {
        if (call.tool === "generate_image") rendered.push(call.prompt);
        return { image: { ok: true } };
      },
    });
    expect(rendered).toEqual([]); // nothing rendered on the planning turn
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["set_plan"]);
    expect(outcome.pendingTool).toBeUndefined();
  });

  it("leaves the legacy model-driven path running on, as it always did", async () => {
    // Without app-managed steps the model owns its own checklist, so ending its turn at set_plan
    // would strand it — there is no executor waiting to hand it step 1.
    const rendered: string[] = [];
    const { deps } = planHarness();
    await runBuddyTurn({
      llm: scriptedLlm(script),
      system: "sys",
      history: [{ role: "user", content: "make me three pictures" }],
      deps: { ...deps, appManagedSteps: false },
      runHostTool: async (call) => {
        if (call.tool === "generate_image") rendered.push(call.prompt);
        return { image: { ok: true } };
      },
    });
    // (the scripted model repeats its last line once the script runs out, so just assert it acted)
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered[0]).toBe("the tractor");
  });
});
