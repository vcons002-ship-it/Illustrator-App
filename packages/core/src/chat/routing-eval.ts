/**
 * THE THIRTY CASES — a fixture for the question "did the model pick the right action?".
 *
 * WHY THIS EXISTS. `537c8de` reordered this prompt without changing a byte of its wording, and
 * produced three regressions and no confirmed improvement. Its own closing line: "Nothing here is
 * verifiable in this container beyond size and order." The regressions were found days later by the
 * reader watching a screen. That is the actual state of prompt work here — **there is no way to tell
 * an improvement from a regression**, so every prompt change is a guess whose result arrives as a
 * screenshot.
 *
 * WHAT IT IS NOT. Not a benchmark, not a quality score, not an LLM judge. Every case asserts one of
 * two mechanical facts about a single reply: WHICH TOOL was called first, and WHETHER A PLAN was
 * made. Both are read with `parseBuddyToolCalls`, the same parser production uses. A rubric would
 * need a judge, a judge needs its own prompt, and its own prompt would need an eval.
 *
 * WHERE THE CASES COME FROM. Every one is either a decision enumerated from the code or a failure
 * that actually happened and is recorded in a commit body. The ones marked `regressed` broke in
 * production and are the reason the fixture is worth running: they are the cases a plausible-looking
 * prompt edit has already been observed to break.
 *
 * PURE — no I/O, no model. The runner lives in the test beside it, and is skipped unless an endpoint
 * is configured, so this can sit in CI without a GPU.
 */

/** What a reply has to do for the case to pass. Both fields optional — a case may assert either. */
export interface RoutingExpectation {
  /** The tool that must be called FIRST. `null` means: no tool at all, answer in prose. */
  tool?: string | null;
  /** Whether `set_plan` must (true) or must not (false) appear anywhere in the reply. */
  plan?: boolean;
  /** The series marker must (true) or must not (false) appear. */
  marker?: boolean;
}

export interface RoutingCase {
  id: string;
  ask: string;
  expect: RoutingExpectation;
  /** Why this case is here — a decision from the code, or the commit whose failure it pins. */
  because: string;
  /** This one has broken in production before. The set that makes the fixture worth running. */
  regressed?: boolean;
}

/**
 * THE CONFUSABLE PAIRS, THE SHAPE DECISIONS, AND EVERY FAILURE THAT REACHED A SCREENSHOT.
 *
 * Ordered by decision, not by importance, so a gap in coverage is visible as a gap in the list.
 */
export const ROUTING_CASES: readonly RoutingCase[] = [
  // ── Is this a task at all, or just conversation? ───────────────────────────────────────────────
  { id: "chat-greeting", ask: "hey, how's it going?", expect: { tool: null, plan: false },
    because: "conductRules: most messages deserve a plain conversational reply, not a tool" },
  { id: "chat-opinion", ask: "what did you think of the ending of that book?", expect: { tool: null },
    because: "conductRules: never steer the chat toward operating the app" },
  { id: "chat-known-fact", ask: "what's the capital of France?", expect: { tool: null },
    because: "routingGuide: a fact you are sure of needs no search" },

  // ── One action, or many? ───────────────────────────────────────────────────────────────────────
  { id: "single-image", ask: "draw me a dragon over a neon city", expect: { tool: "generate_image", plan: false },
    because: "planningRule: a SINGLE action calls its tool directly; do NOT plan one step" },
  { id: "three-images", ask: "generate 3 images of yourself", expect: { plan: true }, regressed: true,
    because: "88f21bc/d688fee/6efa8ae — came back as ONE picture with no checklist, three times running" },
  { id: "three-images-elephants", ask: "I want to generate 3 images. Create 3 prompts for images of elephants",
    expect: { plan: true }, regressed: true,
    because: "d9a63d6 — a finished checklist still claimed the turn and this produced one elephant" },
  { id: "write-and-draw", ask: "write a short story about a goat, then draw a picture of it", expect: { plan: true },
    because: "planningRule: WRITING and MAKING are two actions" },
  { id: "research-then-writeup", ask: "research tide tables and write me a summary", expect: { plan: true },
    because: "planningRule: research → write-up is 2+ distinct actions" },

  // ── Many MESSAGES is not many ACTIONS ──────────────────────────────────────────────────────────
  { id: "alphabet", ask: "write the entire alphabet, one message per letter",
    expect: { marker: true, plan: false, tool: null }, regressed: true,
    because: "the failure this whole line of work came from — 26 turns, then 26 tool calls, now one reply" },
  { id: "alphabet-backwards", ask: "send the alphabet backwards from Z to A, skipping Q, one letter per message",
    expect: { marker: true, plan: false }, regressed: true,
    because: "fbb9d2d — read the rule correctly, then wrote 'A' as prose and ended the turn" },
  { id: "countdown", ask: "count down from 20 to 1, one message at a time", expect: { marker: true, plan: false },
    because: "multiStepGuide: the SAME small thing over and over needs no checklist and no tools" },
  { id: "count-range", ask: "count from 15 to 25, one message at a time", expect: { marker: true, plan: false },
    regressed: true,
    because: "2b27d25 — an app-side counter read '25' as the message count when the answer is 11" },
  { id: "reader-asks-for-plan", ask: "make me a plan for writing out the alphabet", expect: { plan: true },
    regressed: true,
    because: "ec6ca8e — the no-checklist rule outranked an explicit request for a plan" },

  // ── The confusable tool pairs ──────────────────────────────────────────────────────────────────
  { id: "show-vs-draw-show", ask: "show me what a capybara actually looks like", expect: { tool: "search_images" },
    because: "routingGuide: 'show me / what does X look like' is a REAL image" },
  { id: "show-vs-draw-draw", ask: "draw me a capybara in a raincoat", expect: { tool: "generate_image" },
    because: "routingGuide: 'draw / generate / imagine' is NEW art" },
  { id: "search-verb-web", ask: "search for the latest news on fusion energy", expect: { tool: "search_web" },
    because: "routingGuide: a bare 'search' means the WEB" },
  { id: "find-verb-files", ask: "find my resume on my computer", expect: { tool: "find_files" },
    because: "routingGuide: THE VERB DECIDES where — a bare 'find' means their PC" },
  { id: "unsure-fact", ask: "what was the exact population of Reykjavik in 2024?", expect: { tool: "search_web" },
    because: "routingGuide: a fact you are unsure of → search_web" },
  { id: "real-math", ask: "what's 12.5% of 840 plus the square root of 196?", expect: { tool: "calculate" },
    because: "routingGuide: any real math → calculate, never in your head" },
  { id: "read-a-page", ask: "summarize what's on https://example.com/article", expect: { tool: "read" },
    because: "routingGuide: 'read / summarize this page' → read(source:url)" },
  { id: "book-search", ask: "find me a copy of Frankenstein to read", expect: { tool: "search_books" },
    because: "the library path is distinct from a web search" },

  // ── Turn boundaries: the class that was factually false in the prompt until recently ───────────
  { id: "chain-search-then-answer", ask: "look up who won the 2024 Booker Prize and tell me about them",
    expect: { tool: "search_web", plan: false },
    because: "routingGuide: a search comes BACK to you — chain it, do not plan it" },
  { id: "write-then-run", ask: "write a python script that prints 2+2 and then run it", expect: { plan: true },
    because: "43976a4 — write_file and run_command BOTH end the turn, so this is not a chain" },

  // ── Asking rather than guessing ────────────────────────────────────────────────────────────────
  { id: "ambiguous-book", ask: "open that book we talked about", expect: { tool: null },
    because: "conductRules: ambiguous — you'd have to guess which book — so ask, in plain text" },
  { id: "ambiguous-style", ask: "make it better", expect: { tool: null },
    because: "conductRules: STOP and ask rather than guessing at an irreversible action" },

  // ── Deferred capability: the model must load before it can call ────────────────────────────────
  { id: "deferred-toolset", ask: "what's AAPL trading at right now?", expect: { tool: "load_toolset" },
    because: "the markets tools are deferred; guessing the call before loading cannot work" },

  // ── Grounding and honesty, expressed as a routing choice ───────────────────────────────────────
  { id: "no-invented-fact", ask: "what's in my calendar tomorrow?", expect: { plan: false },
    because: "conductRules: never state a fact you did not verify this turn" },
  { id: "memory-write", ask: "remember that I prefer watercolor illustrations", expect: { tool: "remember" },
    because: "a durable preference is a memory write, not a reply" },

  // ── The mixed shape that has broken twice ──────────────────────────────────────────────────────
  { id: "series-with-work", ask: "search for three facts about octopuses and send each one as its own message",
    expect: { plan: true },
    because: "real WORK separates the items, so this is a checklist rather than one reply of markers" },
  { id: "single-then-stop", ask: "just say hello", expect: { tool: null, marker: false },
    because: "the marker must not fire on an ordinary one-line answer" },
] as const;

/** What a scored reply looked like. PURE data — the runner fills it in. */
export interface RoutingResult {
  id: string;
  pass: boolean;
  /** Why it failed, in one line, for the report. */
  detail: string;
}

/**
 * Score ONE reply against ONE case.
 *
 * `firstTool` is the first tool name the reply called (or undefined), `tools` every tool it called,
 * and `text` the reply's prose. Kept as plain inputs rather than a parser call so this stays pure and
 * the test can feed it fixtures as well as live replies. PURE.
 */
export function scoreRoutingCase(
  c: RoutingCase,
  reply: { firstTool?: string; tools: readonly string[]; text: string },
  marker: string,
): RoutingResult {
  const fail = (detail: string): RoutingResult => ({ id: c.id, pass: false, detail });
  if (c.expect.tool === null && reply.firstTool) return fail(`expected no tool, got ${reply.firstTool}`);
  if (typeof c.expect.tool === "string" && reply.firstTool !== c.expect.tool)
    return fail(`expected ${c.expect.tool}, got ${reply.firstTool ?? "no tool"}`);
  if (c.expect.plan === true && !reply.tools.includes("set_plan")) return fail("expected a plan, none was made");
  if (c.expect.plan === false && reply.tools.includes("set_plan")) return fail("made a plan when it should not");
  const hasMarker = reply.text.toLowerCase().includes(marker);
  if (c.expect.marker === true && !hasMarker) return fail("expected the series marker, none present");
  if (c.expect.marker === false && hasMarker) return fail("used the series marker on a single answer");
  return { id: c.id, pass: true, detail: "" };
}

/** The regression set — cases that have actually broken in production. PURE. */
export function regressionCases(): readonly RoutingCase[] {
  return ROUTING_CASES.filter((c) => c.regressed);
}
