import { describe, expect, it } from "vitest";
import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import {
  runBuddyTurn,
  nonEmptyAnswer,
  isBareAcknowledgement,
  isStallConfirmation,
  type AppManagedNext,
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


/**
 * A scripted model that also REASONS — each entry is [thinking, reply]. The default scriptedLlm
 * cannot express the case below, where everything the model produced was reasoning.
 */
function thinkingLlm(script: { think?: string; reply: string }[]): ChatCapable & { calls: ChatTurn[][] } {
  const calls: ChatTurn[][] = [];
  return {
    calls,
    async chat(messages, opts) {
      calls.push([...messages]);
      const turn = script[Math.min(calls.length - 1, script.length - 1)]!;
      if (turn.think) (opts as { onThinking?: (t: string) => void } | undefined)?.onThinking?.(turn.think);
      return turn.reply;
    },
  };
}

/**
 * "IT TRIED THE FIRST TOOL OVER AND OVER WITH NO LUCK, THEN THE SECOND ATTEMPT WORKED."
 *
 * A reply that is entirely reasoning comes back EMPTY, because the provider strips thinking before
 * returning it. The wrap-up branch read that as "produced nothing" and answered a model that was
 * mid-way through acting with "reply in plain text — No tool calls", forbidding the one move that
 * would have recovered the turn. Neither side could see what happened: the model's own reasoning is
 * in front of it, so a call written there is indistinguishable from one it made, and no result reads
 * as a failed call — so it writes it again.
 */
describe("a tool call written inside the reasoning", () => {
  const callInThought = '{"tool":"search_web","query":"tide tables"}';

  it("is not answered with an instruction forbidding tool calls", async () => {
    const llm = thinkingLlm([
      { think: `I should look this up. ${callInThought}`, reply: "" },
      { reply: callInThought },
      { reply: "Here are the tide tables." },
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "when is high tide?" }],
      deps: { ...baseDeps, searchWeb: async () => [{ title: "t", link: "https://x", snippet: "s" }] },
    });
    const said = llm.calls.flat().map((m) => m.content).join("\n");
    expect(said, "the model was told not to call tools while it was trying to").not.toMatch(/No tool calls/);
    expect(said, "it is never told where the call actually went").toMatch(/was inside your reasoning/);
    // And the recovery lands: the tool really runs, in this same turn.
    expect(outcome.toolResults.map((r) => r.call.tool)).toContain("search_web");
  });

  it("names the tool it saw, so the correction is about the call it actually wrote", async () => {
    const llm = thinkingLlm([
      { think: 'thinking… {"tool":"generate_image","prompt":"a fox"}', reply: "" },
      { reply: "ok" },
    ]);
    await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "draw a fox" }], deps: baseDeps });
    expect(llm.calls.flat().map((m) => m.content).join("\n")).toMatch(/Your generate_image call was inside your reasoning/);
  });

  /**
   * "I NEED TO CALL send_message 26 TIMES (FOR A THROUGH Z) IN THIS TURN." — then it wrote "A".
   *
   * Verbatim from the reader's screen, with the memories and skills that could have taught an older
   * recipe already deleted. The model read the prompt correctly, decided correctly, and then emitted
   * the letter as ordinary content. No tool call, so the turn settled: one letter, and the reader had
   * to ask again for every single one.
   *
   * That is the instinct this tool fights. Writing the text IS sending it, as far as the model is
   * concerned, and only the app knows prose is what ENDS a turn. Every other tool asks for something
   * the model could not do by writing; this one asks it to route something it can.
   */
  it("catches the message being WRITTEN instead of sent, and says what that did", async () => {
    const llm = thinkingLlm([
      { think: "I need to call send_message 26 times (for A through Z) in this turn.", reply: "A" },
      { reply: '{"tool":"send_message","text":"A"}' },
      { reply: "…and so on." },
    ]);
    const sent: string[] = [];
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "write the entire alphabet, one message per letter" }],
      deps: baseDeps,
      onEvent: (e) => { if (e.kind === "stepDone") sent.push(e.text); },
    });
    const said = llm.calls.flat().map((m) => m.content).join("\n");
    expect(said, "the turn just ended on the first letter").toMatch(/became your ANSWER, which ends the turn/);
    expect(sent, "the letter never actually got sent as a message").toEqual(["A"]);
  });

  it("only rescues send_message — reasoning about any OTHER tool and then answering is a decision", async () => {
    // The scope that keeps this from forcing calls nobody asked for. Considering search_web and then
    // answering from knowledge is ordinary; there is nothing to recover.
    const llm = thinkingLlm([
      { think: "Should I use search_web for this? No, I know the answer.", reply: "Paris." },
    ]);
    await runBuddyTurn({
      llm, system: "sys", history: [{ role: "user", content: "capital of France?" }], deps: baseDeps,
    });
    expect(llm.calls.flat().map((m) => m.content).join("\n")).not.toMatch(/became your ANSWER/);
  });

  it("is bounded, so a model that keeps writing prose still finishes the turn", async () => {
    const llm = thinkingLlm([
      { think: "call send_message now", reply: "A" },
      { think: "call send_message again, really", reply: "B" },
      { think: "send_message, third time", reply: "C" },
      { think: "send_message, fourth", reply: "D" },
    ]);
    const outcome = await runBuddyTurn({
      llm, system: "sys", history: [{ role: "user", content: "letters" }], deps: baseDeps,
    });
    const nudges = llm.calls[llm.calls.length - 1]!.map((m) => m.content).join("\n").match(/became your ANSWER/g) ?? [];
    expect(nudges, "the correction repeats without end").toHaveLength(2);
    expect(outcome.text.trim(), "the turn never produced an answer").not.toBe("");
  });

  it("leaves a model that reasoned and then ANSWERED alone", async () => {
    // Considering a tool and deciding against it is ordinary. Nudging here would force a call nobody
    // asked for, which is why this is scoped to an empty reply rather than to "no tool ran".
    const llm = thinkingLlm([
      { think: `maybe ${callInThought}? no, I know this one.`, reply: "High tide is at 06:12." },
    ]);
    await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "when is high tide?" }], deps: baseDeps });
    expect(llm.calls.flat().map((m) => m.content).join("\n")).not.toMatch(/was inside your reasoning/);
  });

  it("gives up after two, rather than repeating one correction forever", async () => {
    // A model that keeps doing it after being told is not going to be talked out of it, and each
    // nudge costs a round of the turn's budget.
    //
    // The reasoning has to DIFFER per round: `roundThinking` is empty when a round's thinking is
    // byte-identical to the last, which is a deliberate guard against handing back stale intent, and
    // it means a model that repeats itself word for word is not nudged twice anyway.
    const llm = thinkingLlm([
      { think: `stuck. ${callInThought}`, reply: "" },
      { think: `still stuck, retrying. ${callInThought}`, reply: "" },
      { think: `and again, third time. ${callInThought}`, reply: "" },
      { think: `a fourth. ${callInThought}`, reply: "" },
    ]);
    await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "x" }], deps: baseDeps });
    const lastTurn = llm.calls[llm.calls.length - 1]!.map((m) => m.content).join("\n");
    expect(lastTurn.match(/was inside your reasoning/g) ?? [], "the nudge is unbounded").toHaveLength(2);
    // And the turn still ends properly rather than spinning: the wrap-up takes over.
    expect(lastTurn).toMatch(/Now reply to the reader in plain text/);
  });
});

/**
 * THE ALPHABET IN ONE REPLY — no tools, no rounds, nothing to forget.
 *
 * Reported over and over: the model reads the prompt correctly, decides correctly ("I need to call
 * send_message 26 times for A through Z"), and then writes "A" as prose, which ends the turn. Or it
 * writes the call into its reasoning where nothing runs it. Or the result tells it to keep going and
 * it cannot stop. Every one of those failures lives in the ROUNDS — and a recitation does not need
 * any. The model knows the alphabet; the renderer can do the splitting.
 */
describe("runBuddyTurn — a series written in one reply", () => {
  it("turns one reply into a message each, with no tool call anywhere", async () => {
    const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const llm = scriptedLlm([letters.join("\n[[next]]\n")]);
    const sent: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "write the entire alphabet, one message per letter" }],
      deps: baseDeps,
      onEvent: (e) => { if (e.kind === "stepDone") sent.push(e.text); },
    });
    // ONE model call for the whole alphabet, where the tool path took twenty-six.
    expect(llm.calls, "it still costs a round per letter").toHaveLength(1);
    expect(outcome.toolResults, "a tool was involved after all").toHaveLength(0);
    // A–Y arrive as their own messages; Z is the turn's answer and takes the ordinary path, which is
    // what keeps the thinking and the empty-answer net attached to it.
    expect(sent).toEqual(letters.slice(0, 25));
    expect(outcome.text.trim()).toBe("Z");
    expect(outcome.transcript.map((t) => t.content)).toEqual(letters);
  });

  it("leaves an ordinary answer as one message", async () => {
    // The safety property, end to end: every reply passes through the splitter.
    const prose = "Paris.\n\nIt has been the capital since 987 — give or take a few interruptions.";
    const sent: string[] = [];
    const outcome = await runBuddyTurn({
      llm: scriptedLlm([prose]),
      system: "sys",
      history: [{ role: "user", content: "capital of France?" }],
      deps: baseDeps,
      onEvent: (e) => { if (e.kind === "stepDone") sent.push(e.text); },
    });
    expect(sent, "an ordinary answer was chopped up").toEqual([]);
    expect(outcome.text.trim()).toBe(prose);
  });

  it("works alongside real work in the same turn", async () => {
    // The marker splits the ANSWER; a turn that also ran tools still returns their results.
    const llm = scriptedLlm(['{"tool":"calculate","expression":"1+1"}', "two\n[[next]]\nthat's it"]);
    const sent: string[] = [];
    const outcome = await runBuddyTurn({
      llm, system: "sys", history: [{ role: "user", content: "what is 1+1" }], deps: baseDeps,
      onEvent: (e) => { if (e.kind === "stepDone") sent.push(e.text); },
    });
    expect(outcome.toolResults.map((r) => r.call.tool)).toEqual(["calculate"]);
    expect(sent).toEqual(["two"]);
    expect(outcome.text.trim()).toBe("that's it");
  });
});

describe("runBuddyTurn — a series driven by send_message", () => {
  /**
   * THE REPLACEMENT FOR keep_going, AND THE FOUR THINGS IT FIXES AT ONCE.
   *
   * keep_going was a tool that did nothing: every message was a two-part act — write the prose, then
   * remember to attach a no-op call — and one miss in twenty-six ended the task in silence. It was
   * also absent from `ollamaToolSchemas`, so a model on native tool-calling could not emit it at all.
   *
   * Sending IS the call now. The loop continues because a tool was called, which is how every
   * published harness decides to continue, and it ends when the model stops calling — no permission,
   * no stall question, no token to forget.
   */
  it("publishes each message and keeps the turn, with no continuation token at all", async () => {
    const llm = scriptedLlm([
      '{"tool":"send_message","text":"Z"}',
      '{"tool":"send_message","text":"Y"}',
      '{"tool":"send_message","text":"X"}',
      "That's the first three, backwards.",
    ]);
    const sent: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send the alphabet backwards, one letter per message" }],
      deps: baseDeps,
      onEvent: (e) => { if (e.kind === "stepDone") sent.push(e.text); },
    });
    // Note what is NOT in the script: not one keep_going. The rounds were bought by the work.
    expect(outcome.toolResults.filter((r) => r.call.tool === "send_message")).toHaveLength(3);
    expect(sent, "the reader never saw the messages as separate bubbles").toEqual(["Z", "Y", "X"]);
    expect(outcome.transcript.map((t) => t.content)).toEqual(expect.arrayContaining(["Z", "Y", "X"]));
    expect(outcome.text).toContain("backwards");
  });

  it("ends the turn when the model stops calling it — nothing has to say it is finished", async () => {
    // The old design could not tell "I forgot the token" from "that was the last one", so it had to
    // ASK, and the question then ate the final message. Stopping is the signal now.
    const llm = scriptedLlm(['{"tool":"send_message","text":"1"}', "Done — that's all of them."]);
    const outcome = await runBuddyTurn({
      llm, system: "sys", history: [{ role: "user", content: "count to one, one per message" }], deps: baseDeps,
    });
    expect(llm.calls, "it kept asking after the model had stopped").toHaveLength(2);
    expect(outcome.text).toContain("Done");
  });

  it("hands the position back as the CALL'S RESULT, not as prose in the reader's voice", async () => {
    // The sharpest finding of the harness research: the model ALREADY had its position — the old
    // series echo carried all 26 letters, well under its cap — and lost its place anyway, because
    // the note arrived under role "user" contradicting the model's own turn two lines above. Same
    // facts, delivered as the answer to something it asked for.
    const llm = scriptedLlm([
      '{"tool":"send_message","text":"Z"}',
      '{"tool":"send_message","text":"Y"}',
      "done",
    ]);
    await runBuddyTurn({
      llm, system: "sys", history: [{ role: "user", content: "two letters, one each" }], deps: baseDeps,
    });
    const fed = llm.calls.flat().map((m) => m.content).join("\n");
    expect(fed, "the model is never told what it has sent").toMatch(/1 message sent this turn/);
    expect(fed, "the order is not handed back, so it must re-read its own turns").toMatch(/in order: "Z"/);
  });

  /**
   * "IT GAVE THE FULL ALPHABET THEN GOT STUCK ON ITS TURN SENDING RANDOM MESSAGES."
   *
   * Off the reader's screen: X, Y, Z, then "That's the whole alphabet!", "All done.", "Bye!", "!",
   * "1", and then reasoning about whether "2" was wanted. The cause was this app's own text. Every
   * send_message came back with "[go on — … Send the NEXT one]", inherited from keep_going where
   * saying "go on" was the entire job. As a RESULT it fires after every message, so a run that had
   * just finished the alphabet was told by the app to send another one — and there is no count at
   * which that stops being true.
   *
   * The model quoted it back while trying to obey: "Maybe 'Send the NEXT one' refers to the
   * alphabet? I finished Z."
   */
  it("never hands back anything that reads as 'now send another'", async () => {
    const llm = scriptedLlm([
      '{"tool":"send_message","text":"Y"}',
      '{"tool":"send_message","text":"Z"}',
      "That's the whole alphabet.",
    ]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "finish the alphabet, one letter per message" }],
      deps: baseDeps,
    });
    // Everything the app said to the model this turn, minus the system prompt and the reader's line.
    const appSaid = llm.calls
      .flat()
      .filter((m) => m.role === "user" && m.content.trim().startsWith("["))
      .map((m) => m.content)
      .join("\n");
    expect(appSaid, "no app text reached the model at all — the gate proves nothing").toBeTruthy();
    expect(appSaid, "the app is still telling it to keep going").not.toMatch(/go on/i);
    expect(appSaid, "the app is still asking for the next message").not.toMatch(/next one|send (?:the )?next/i);
  });

  it("still tells it what has been delivered, which is the half worth keeping", async () => {
    const llm = scriptedLlm(['{"tool":"send_message","text":"Y"}', '{"tool":"send_message","text":"Z"}', "done"]);
    await runBuddyTurn({
      llm, system: "sys", history: [{ role: "user", content: "two letters" }], deps: baseDeps,
    });
    const fed = llm.calls.flat().map((m) => m.content).join("\n");
    expect(fed).toMatch(/2 messages sent this turn/);
    expect(fed).toMatch(/"Y", "Z"/);
  });

  it("does not ask 'was that the last one?' — the question that swallowed the final message", async () => {
    // The stall check exists only for keep_going, and must not fire here. It once ate the last letter
    // of a series: the model answered a question the reader never saw and "Z" never reached the screen.
    const llm = scriptedLlm(['{"tool":"send_message","text":"A"}', "that's it"]);
    await runBuddyTurn({
      llm, system: "sys", history: [{ role: "user", content: "one message please" }], deps: baseDeps,
    });
    expect(llm.calls.flat().map((m) => m.content).join("\n")).not.toMatch(/Was that the last one/);
  });

  it("refuses to publish an empty message rather than sending a blank bubble", async () => {
    const llm = scriptedLlm(['{"tool":"send_message","text":"   "}', "sorry, here: A"]);
    const sent: string[] = [];
    await runBuddyTurn({
      llm, system: "sys", history: [{ role: "user", content: "send a letter" }], deps: baseDeps,
      onEvent: (e) => { if (e.kind === "stepDone") sent.push(e.text); },
    });
    expect(sent, "a blank bubble reached the reader").toEqual([]);
  });

  it("still understands a keep_going from a model that learned the old shape", async () => {
    // Retired, undocumented, and still honoured — erroring at a model mid-conversation for using the
    // spelling it saw earlier would lose the reader's messages to make a point.
    const llm = scriptedLlm(['A\n{"tool":"keep_going"}', "B"]);
    const outcome = await runBuddyTurn({
      llm, system: "sys", history: [{ role: "user", content: "two messages" }], deps: baseDeps,
    });
    expect(outcome.toolResults.filter((r) => r.result.error), "the old spelling is now refused").toHaveLength(0);
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
  it("names both ways out when it asks for plain text, and commands neither", async () => {
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
    /**
     * THE CARVE-OUT BECAME THE PROBLEM IT WAS ADDED TO SOLVE.
     *
     * It read "No tool calls — except send_message, which you should still call if you have more
     * messages to send", inherited from keep_going where a blanket ban had killed a series outright.
     * But this directive only fires once the model has ALREADY stopped calling, so naming the tool
     * here is the app asking a finished run to start again. Counting to -100, the model read it back
     * and did: "the specific constraint 'except send_message' allows me to break out of the 'plain
     * text only' rule for this task." It then never ended the turn.
     *
     * Both ways out are named now, and neither is commanded — the same correction the series receipt
     * needed. The case the carve-out protected is covered by the two recoveries that fire before this.
     */
    expect(wrap, "a finished run is invited to start sending again").not.toMatch(/except send_message/);
    expect(wrap, "the blanket ban is back, which once killed a series outright").not.toMatch(/No tool calls/);
    expect(wrap, "carrying on is not named as available").toMatch(/genuinely still has items left, carry on/);
    expect(wrap, "wrapping up is not named as available").toMatch(/otherwise this is the wrap-up/);
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

  /**
   * THE THINKING BUDGET IS ONE VALUE FOR THE TURN, AND HAS TO STAY THAT WAY.
   *
   * A per-round budget was built here and then reverted, and these tests exist so it is not built
   * again the same way. The idea was fine: a round executing an already-decided series has nothing
   * left to decide, so send it `reasoningEffort: "none"`. The mechanism is what fails.
   *
   * "none" reaches Ollama as `think: false`, and a thinking model told not to think does not stop
   * reasoning — it stops emitting <think> tags. `stripThink` then has nothing to strip, and the
   * monologue is delivered to the reader as an ordinary message. Asked to count to 20, they got a
   * chat bubble reading "The user is asking me to continue, but I've already completed the task...
   * I don't need another keep_going." The knob does not shrink the deliberation; it publishes it.
   *
   * `ollamaThink` is binary as well — there is no "low" — so on a local model this setting offers
   * think, or think in public. Cutting deliberation has to be done some other way.
   */
  function effortLlm(replies: string[]): ChatCapable & { efforts: (string | undefined)[] } {
    let n = 0;
    const efforts: (string | undefined)[] = [];
    return {
      efforts,
      async chat(_messages, opts) {
        efforts.push(opts?.reasoningEffort);
        return replies[Math.min(n++, replies.length - 1)]!;
      },
    };
  }

  it("sends the reader's setting on every round of a series, unchanged", async () => {
    const llm = effortLlm(['A\n{"tool":"keep_going"}', 'B\n{"tool":"keep_going"}', "C"]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "send me A to C, one letter at a time" }],
      deps: baseDeps,
      reasoningEffort: "high",
    });
    expect(llm.efforts.length, "the series did not run").toBeGreaterThan(2);
    expect(
      llm.efforts.filter((e) => e !== "high"),
      "a round was quietly given a different thinking budget — see the note above",
    ).toEqual([]);
  });

  it("never sends none, which is the value that leaks reasoning into the chat", async () => {
    const llm = effortLlm(['A\n{"tool":"keep_going"}', "B", "done"]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "A then B" }],
      deps: baseDeps,
      reasoningEffort: "medium",
    });
    expect(llm.efforts).not.toContain("none");
  });

  it("leaves the reader's setting alone when they haven't chosen one", async () => {
    const llm = effortLlm(["Paris."]);
    await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "capital?" }], deps: baseDeps });
    expect(llm.efforts, "an effort was invented where the reader set none").toEqual([undefined]);
  });

  /**
   * "IT NEVER OUTPUTS Z THOUGH IT THINKS IT DOES" — and it had.
   *
   * A series message becomes its own bubble only because the host flushes streamed prose when a TOOL
   * CALL follows it, and the LAST message of a series has no keep_going after it by definition. So it
   * arrives as the turn's answer — where the stall check swallowed it and handed the reader the
   * model's reply to a question they never saw ("yes, that's the whole alphabet"). The model was
   * telling the truth and the letter was real; it just never reached the screen.
   */
  describe("telling a confirmation from a closing line", () => {
    it("recognises the shapes a model actually confirms with", () => {
      for (const t of ["Yes.", "Yes, that was the last one.", "That's all", "Done.", "All done!", "No more", "Finished."]) {
        expect(isStallConfirmation(t), `${t} was not read as a confirmation`).toBe(true);
      }
    });

    it("keeps a closing line that merely starts like one", () => {
      // The first version anchored only the opening and let the rest run to the first full stop, so
      // this was dropped for beginning with the word "That's".
      expect(isStallConfirmation("That's the whole alphabet — 26 letters, A through Z.")).toBe(false);
      expect(isStallConfirmation("Done — the file is saved to notes.md and the tests pass.")).toBe(false);
    });

    it("never swallows a real message", () => {
      for (const t of ["Z", "The capital of France is Paris.", "Yesterday I read that book."]) {
        expect(isStallConfirmation(t), `${t} would have been thrown away`).toBe(false);
      }
    });
  });

  it("returns the last message of a series, not its answer about the last message", async () => {
    const llm = scriptedLlm([
      'Y\n{"tool":"keep_going"}',
      "Z", // the final letter: no keep_going, because there is nothing after it
      "Yes, that was the last one.", // the reply to a question the reader never sees
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "finish the alphabet, one letter at a time" }],
      deps: baseDeps,
    });
    expect(outcome.text, "the last letter was replaced by the stall check's answer").toBe("Z");
    expect(outcome.text).not.toMatch(/last one/);
  });

  it("keeps anything the model added beyond the acknowledgement", async () => {
    // The drop is only safe for a bare "yes, done". A model that uses the same reply to say something
    // real must not have it thrown away, so the held message leads and the rest follows.
    const llm = scriptedLlm(['Y\n{"tool":"keep_going"}', "Z", "That's the whole alphabet — 26 letters, A through Z."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "finish the alphabet" }],
      deps: baseDeps,
    });
    expect(outcome.text).toContain("Z");
    expect(outcome.text).toContain("26 letters");
  });

  it("records a held message exactly once when the series carries on", async () => {
    // The other exit: the stall question is answered by continuing. The held message is a real
    // message of the run, so it goes to the transcript there — and must not ALSO be merged into the
    // final answer, which would show it twice.
    const llm = scriptedLlm([
      'A\n{"tool":"keep_going"}',
      "B", // the stall — the model forgot keep_going
      'C\n{"tool":"keep_going"}', // ...and then carried on anyway
      "D",
      "done",
    ]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "A to D please" }],
      deps: baseDeps,
    });
    const said = outcome.transcript.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(said.filter((t) => t.trim() === "B"), "B was recorded twice, or not at all").toHaveLength(1);
    for (const letter of ["A", "C", "D"]) {
      expect(said.join(" "), `${letter} went missing`).toContain(letter);
    }
  });

  /**
   * "EVERY 6TH MESSAGE IT ADDED A LITTLE BLURB."
   *
   * TOOL_PROGRESS_EVERY: once every six rounds the model is told to write a line of progress before
   * its next tool call, so a long silent tool loop doesn't leave the reader watching nothing happen.
   * A message series is the opposite of silent — every round of it IS a message to the reader — so
   * the nudge buys nothing there and costs the thing they asked for: "Just finished R, now sending
   * S." arrived in the same bubble as S, which is not one letter per message.
   */
  it("does not ask a series to narrate progress it is already showing", async () => {
    // Long enough to cross the six-round mark twice over.
    const llm = scriptedLlm([...Array.from({ length: 14 }, (_, i) => `${i}\n{"tool":"keep_going"}`), "done"]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "count to 14, one number per message" }],
      deps: baseDeps,
    });
    const nudged = llm.calls
      .flat()
      .filter((m) => /short plain-text line of progress/.test(m.content));
    expect(nudged, "the series was asked to narrate progress it was already making").toHaveLength(0);
  });

  it("still nudges a silent tool loop, which is what the nudge is for", async () => {
    // Seven search rounds: nothing reaches the reader until the turn settles, so the periodic
    // progress line is the only thing keeping them in the loop. Removing it there would trade this
    // bug for the one it was written to prevent.
    const llm = scriptedLlm([...Array.from({ length: 7 }, () => '{"tool":"search_web","query":"X"}'), "Found it."]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "research X thoroughly" }],
      deps: { ...baseDeps, searchWeb: async () => [{ title: "T", link: "http://x.test", snippet: "S" }] },
    });
    const nudged = llm.calls
      .flat()
      .filter((m) => /short plain-text line of progress/.test(m.content));
    expect(nudged.length, "a silent tool loop lost its progress line").toBeGreaterThan(0);
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

/**
 * "IT'S THINKING THAT CAN'T SEEM TO ESCAPE INTO AN ACTUAL TOOL CALL — THE THINKING HAS NO OUTLET."
 *
 * G3 grammar-constrains the reply to the tool the active step owes, so a stubborn small model cannot
 * narrate instead of acting. It was computed ONCE per turn, which was right when a turn was one step.
 * A checklist now runs every step inside one turn, so the grammar stayed pinned to step ONE's tool
 * while the tick moved on: from step two the sampler admitted only a call the model had already made
 * and no longer needed. Not the tool it wanted, and not plain text either — and on a reasoning model
 * the one channel still unconstrained was the thinking.
 *
 * That also explains "trying the same tool call over and over": the stale grammar permitted exactly
 * one shape, so every attempt came out as the same call.
 */
describe("the reply grammar follows the step, not the turn", () => {
  const fmt = (tool: string) => ({ type: "object", properties: { tool: { enum: [tool] } } });

  it("is resolved every round rather than fixed when the turn opened", async () => {
    const seen: (string | undefined)[] = [];
    const llm: ChatCapable & { calls: ChatTurn[][] } = {
      calls: [],
      async chat(messages, opts) {
        this.calls.push([...messages]);
        const f = (opts as { toolFormat?: { properties?: { tool?: { enum?: string[] } } } } | undefined)?.toolFormat;
        seen.push(f?.properties?.tool?.enum?.[0]);
        return this.calls.length < 3 ? '{"tool":"calculate","expression":"1+1"}' : "done";
      },
    };
    // The grammar moves with the step: first two rounds owe search_web, then generate_image.
    let step = 0;
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "two steps" }],
      deps: baseDeps,
      toolFormat: () => (step++ < 2 ? fmt("search_web") : fmt("generate_image")),
    });
    expect(seen.slice(0, 2), "the grammar never moved off the opening step").toEqual(["search_web", "search_web"]);
    expect(seen[2], "a later round is still locked to the first step's tool").toBe("generate_image");
  });

  it("still accepts a plain object, so nothing that passes one regresses", async () => {
    const seen: (string | undefined)[] = [];
    const llm: ChatCapable & { calls: ChatTurn[][] } = {
      calls: [],
      async chat(_m, opts) {
        this.calls.push([]);
        const f = (opts as { toolFormat?: { properties?: { tool?: { enum?: string[] } } } } | undefined)?.toolFormat;
        seen.push(f?.properties?.tool?.enum?.[0]);
        return "done";
      },
    };
    await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "x" }], deps: baseDeps, toolFormat: fmt("write_file") });
    expect(seen[0]).toBe("write_file");
  });

  it("sends no grammar at all when the resolver declines", async () => {
    const seen: unknown[] = [];
    const llm: ChatCapable & { calls: ChatTurn[][] } = {
      calls: [],
      async chat(_m, opts) {
        this.calls.push([]);
        seen.push((opts as { toolFormat?: unknown } | undefined)?.toolFormat);
        return "done";
      },
    };
    await runBuddyTurn({ llm, system: "sys", history: [{ role: "user", content: "x" }], deps: baseDeps, toolFormat: () => undefined });
    expect(seen[0], "an undefined grammar is still sent as a constraint").toBeUndefined();
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

  /**
   * "ON THE FIRST TURN AFTER MAKING A MULTI-STEP PLAN IT COULDN'T SEEM TO SEND THE TOOL CALL —
   * IT LOOPED WITHIN REASONING TRYING THE SAME ONE OVER AND OVER."
   *
   * The early return above jumps out of the dispatch loop before the tool RESULT is recorded. The
   * model's reply is already in the transcript (that push happens earlier), so the step-1 turn opened
   * on a history reading: the request, an assistant turn calling set_plan, then a checklist directive
   * in the reader's voice — with no confirmation anywhere that the call had worked.
   *
   * Everywhere else in that same transcript a call is followed by its result, so its absence here
   * means what absence means everywhere else: the call did not land. The model has called set_plan,
   * seen nothing come back, and is being told a checklist exists. Trying again is reasonable.
   */
  it("leaves the plan in the transcript, so the next turn can tell it was made", async () => {
    const outcome = await runBuddyTurn({
      llm: scriptedLlm(script),
      system: "sys",
      history: [{ role: "user", content: "make me three images" }],
      ...planHarness(),
    });
    const record = outcome.transcript.map((t) => t.content).join("\n");
    expect(record, "the turn whose whole job was set_plan leaves no record of it").toContain("plan");
    expect(outcome.transcript.length, "nothing at all was recorded").toBeGreaterThan(0);
  });

  it("records the RESULT after the call, the way every other tool does", async () => {
    // The specific asymmetry: the call was there, its outcome was not. A call with nothing after it
    // is, everywhere else in this transcript, a call that failed.
    const outcome = await runBuddyTurn({
      llm: scriptedLlm(script),
      system: "sys",
      history: [{ role: "user", content: "make me three images" }],
      ...planHarness(),
    });
    const roles = outcome.transcript.map((t) => t.role);
    const callAt = outcome.transcript.findIndex((t) => t.content.includes('"tool":"set_plan"'));
    expect(callAt, "the call itself is missing").toBeGreaterThanOrEqual(0);
    expect(roles.slice(callAt + 1), "nothing follows the call, so it reads as having failed").toContain("user");
  });

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

/**
 * TWENTY-SIX LETTERS WERE TWENTY-SIX TURNS.
 *
 * App-managed steps judged a SETTLED TURN and then dispatched a fresh one whose opening user message
 * was "Now do ONLY step 2 of 26 … Call its tool and stop". The reader watched it stall, and the
 * model's reasoning said why: "The user's prompt in this specific turn [2026-08-13 13:16:43.860] is
 * the system telling me to do step 1." A turn-opening directive is indistinguishable from the reader
 * speaking. And "call its tool and stop" is an instruction to END THE TURN, handed to a step whose
 * entire deliverable is the letter A — there is no tool, so it wrote text and waited.
 *
 * A step that needs nothing from the host has no reason to be its own turn.
 */
describe("an app-managed checklist runs inside one turn", () => {
  /** A host that judges each round done and hands back the next step, then stops. */
  function collar(steps: number) {
    let done = 0;
    return {
      seen: [] as string[],
      tick(evidence: { text: string }): AppManagedNext {
        this.seen.push(evidence.text);
        done += 1;
        return done < steps ? { kind: "continue", directive: `[Now do step ${done + 1} of ${steps}.]` } : { kind: "stop" };
      },
    };
  }

  it("walks every step without the turn ending", async () => {
    const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const llm = scriptedLlm(letters);
    const host = collar(26);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "write the alphabet, one letter per message" }],
      deps: baseDeps,
      appManagedTick: (e) => host.tick(e),
    });
    expect(host.seen, "the run did not reach Z inside one turn").toHaveLength(26);
    expect(host.seen[0]).toBe("A");
    expect(host.seen[25]).toBe("Z");
  });

  /**
   * THREE STEPS TICKED OFF ONE RENDER.
   *
   * `toolResults` is the TURN's record and is only ever appended to — it has to be, it is what the
   * turn returns. Every tick was handed the whole of it, so step 2's "an image rendered" contract was
   * satisfied by step 1's picture, and a three-image checklist could finish on one. The host's own
   * end-of-turn executor resets its evidence on each advance; the in-turn path did not.
   */
  it("gives each step only the evidence produced since the last advance", async () => {
    const seen: number[] = [];
    let step = 0;
    const llm = scriptedLlm([
      '{"tool":"search_web","query":"one"}',
      "narrating instead of working",
      "second step's answer",
      "done",
    ]);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "two steps" }],
      deps: baseDeps,
      appManagedTick: (e) => {
        seen.push(e.toolResults.length);
        step += 1;
        // Round 2 is a NUDGE (same step, no advance); round 3 advances; round 4 stops.
        if (step === 1) return { kind: "continue", directive: "[still step 1.]" };
        if (step === 2) return { kind: "continue", directive: "[step 2 now.]", advanced: true };
        return { kind: "stop" };
      },
    });
    // The search happened before any of these ticks, so step 1 sees it — twice, because a nudge is
    // the same step still owing its work and must not lose what it already produced.
    expect(seen[0], "step 1 cannot see the search it just made").toBe(1);
    expect(seen[1], "a nudge threw away the step's own evidence").toBe(1);
    // The advance is the cut. Step 2 starts empty, so it cannot be satisfied by step 1's search.
    expect(seen[2], "step 2 inherited step 1's tool result and can tick off on it").toBe(0);
  });

  it("emits a boundary per step, or the letters never become messages", async () => {
    // The host flushes streamed prose into a bubble when a TOOL CALL follows it, and a text step has
    // none. Without this event each letter would sit in the stream buffer and be overwritten by the
    // next — exactly how the last letter of a plan-free series went missing once already.
    const llm = scriptedLlm(["A", "B", "C"]);
    const host = collar(3);
    const steps: string[] = [];
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "A to C" }],
      deps: baseDeps,
      appManagedTick: (e) => host.tick(e),
      onEvent: (e) => {
        if (e.kind === "stepDone") steps.push(e.text);
      },
    });
    // A and B are mid-run boundaries. C is not: when the collar says stop, the last step's text
    // becomes the TURN'S ANSWER and is delivered by the ordinary path. Emitting it here as well
    // would put the final letter on screen twice.
    expect(steps).toEqual(["A", "B"]);
  });

  it("delivers the last step as the answer, exactly once", async () => {
    const llm = scriptedLlm(["A", "B", "C"]);
    const host = collar(3);
    const seen: string[] = [];
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "A to C" }],
      deps: baseDeps,
      appManagedTick: (e) => host.tick(e),
      onEvent: (e) => {
        if (e.kind === "stepDone") seen.push(e.text);
      },
    });
    expect(outcome.text, "the final step is not the turn's answer").toBe("C");
    expect(seen, "the final step was announced as a boundary as well as answered").not.toContain("C");
    const said = outcome.transcript.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(said.filter((t) => t === "C"), "C is recorded twice").toHaveLength(1);
  });

  it("puts every step in the transcript, so the run survives the turn", async () => {
    const llm = scriptedLlm(["A", "B", "C"]);
    const host = collar(3);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "A to C" }],
      deps: baseDeps,
      appManagedTick: (e) => host.tick(e),
    });
    const said = outcome.transcript.filter((m) => m.role === "assistant").map((m) => m.content);
    for (const l of ["A", "B", "C"]) expect(said, `${l} is missing from the record`).toContain(l);
  });

  it("hands the directive back as a round, not as a turn-opening message", async () => {
    // The whole point. Inside a turn it arrives as machinery, next to the round it belongs to;
    // as a fresh turn's first line it reads as the reader talking, which is what the model said.
    const llm = scriptedLlm(["A", "B"]);
    const host = collar(2);
    await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "A then B" }],
      deps: baseDeps,
      appManagedTick: (e) => host.tick(e),
    });
    const directives = llm.calls.flat().filter((m) => /Now do step 2 of 2/.test(m.content));
    expect(directives.length, "the directive never reached the model").toBeGreaterThan(0);
    // It rides the SAME conversation the turn was already having: the run never restarted.
    expect(llm.calls.length, "the turn ended and a new one began").toBeGreaterThan(1);
  });

  it("leaves an ordinary turn alone when no checklist is running", async () => {
    const llm = scriptedLlm(["Paris."]);
    const outcome = await runBuddyTurn({
      llm,
      system: "sys",
      history: [{ role: "user", content: "capital of France?" }],
      deps: baseDeps,
    });
    expect(outcome.text).toBe("Paris.");
    expect(llm.calls).toHaveLength(1);
  });
});
