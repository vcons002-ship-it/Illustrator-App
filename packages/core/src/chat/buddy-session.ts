import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import type { ImageSearchHit, WebSearchHit } from "../providers/image/image-search.js";
import type { BookSearchHit } from "../providers/book-search.js";
import {
  MAX_BUDDY_TOOL_ROUNDS,
  describeBuddyToolActivity,
  formatBuddyToolResult,
  isRetryableError,
  looksLikeToolJson,
  parseBuddyToolCalls,
  stripToolCallJson,
  toolLimitNudge,
  type BuddyOpenedInfo,
  type BuddyToolCall,
  type BuddyToolResultPayload,
} from "./buddy-tools.js";
import type { CalendarEvent, EmailFull, EmailSummary, TaskItem } from "../providers/google.js";
import type { TaskPlan } from "./tasks.js";
import { findSetupGuide, setupGuideTopics } from "./setup-guides.js";
import { buildTradingScript, scriptLanguage } from "./trading-scripts.js";
import { parseSettingChange } from "./settings-control.js";
import { evaluateExpression, formatCalcResult } from "./calculator.js";
import { evaluateMath } from "./math-engine.js";
import { jsonGatedTokenSink } from "./chat-session.js";

/**
 * One user-message round of the landing-page buddy, including the tool loop —
 * worker-agnostic and fully testable with a scripted ChatCapable (the same shape
 * as chat-session.ts). Buddy tools auto-run: searches are free, settings changes
 * are reversible, and opening a book only loads it (generation still needs the
 * reader's Start unless they explicitly asked for visuals — the host enforces
 * that via the `visuals` flag). The one exception is `generate_image`, which
 * stops the loop for the reader's approval — same GPU/cost guard as the in-book
 * chat (chat-session.ts).
 */

/** Extra auto-continue passes per turn. This is a SAFETY valve against a model that loops forever
 * always-reporting "truncated", NOT a content cap — at ~30k tokens/pass on a big window that's
 * hundreds of thousands of tokens, and if it's ever hit the answer ends with a plain "say continue"
 * note (never a silent cut), so the reader can always get the rest. The Stop button also interrupts
 * between passes. */
const MAX_REPLY_CONTINUATIONS = 8;

/** How often to tick a transient "still working" activity heartbeat while waiting for the model's
 * first token. Kept well under the linked phone's silence watchdog (120s) so a slow large model's
 * long time-to-first-token never trips it. */
const HEARTBEAT_MS = 10_000;

export interface BuddyDeps {
  searchWeb?: (query: string) => Promise<WebSearchHit[]>;
  searchBooks?: (query: string) => Promise<BookSearchHit[]>;
  searchImages?: (query: string) => Promise<ImageSearchHit[]>;
  /** Fetch a URL's readable text so the model can read/learn from a page. */
  readUrl?: (url: string) => Promise<{ title?: string; text: string }>;
  /** Wolfram|Alpha grounding (optional; present only when an AppID is configured). */
  wolfram?: (query: string) => Promise<string>;
  /** A keyless stock quote (Stooq), or undefined when unavailable. */
  stockQuote?: (symbol: string) => Promise<import("../providers/stocks.js").StockQuote | undefined>;
  /** Keyless technical indicators over a bar window, or undefined when unavailable. */
  marketIndicators?: (symbol: string, interval?: string, range?: string) => Promise<import("../providers/market-data.js").Indicators | undefined>;
  /** In-app price alerts — set/list/cancel over the shared store. */
  setPriceAlert?: (call: Extract<BuddyToolCall, { tool: "set_price_alert" }>) => Promise<{ id: string; describe: string } | undefined>;
  listAlerts?: () => Promise<{ id: string; describe: string; enabled: boolean }[]>;
  cancelAlert?: (id: string) => Promise<boolean>;
  /** Schwab Trader API (present only when connected). */
  schwabQuote?: (symbol: string) => Promise<import("../providers/schwab.js").SchwabQuote | undefined>;
  schwabOptions?: (symbol: string, opts?: { contractType?: "CALL" | "PUT" | "ALL"; strikeCount?: number }) => Promise<import("../providers/schwab.js").OptionChain | undefined>;
  schwabPositions?: () => Promise<import("../providers/schwab.js").SchwabPosition[]>;
  schwabWatchlists?: () => Promise<import("../providers/schwab.js").SchwabWatchlist[]>;
  /** MCP servers (present only when the reader configured some). */
  mcpTools?: (server: string) => Promise<import("./mcp.js").McpTool[] | undefined>;
  mcpCall?: (server: string, toolName: string, args: Record<string, unknown>) => Promise<string | undefined>;
  /** Random picks from the catalog's most-loved shelf ("surprise me"). */
  randomBooks?: () => Promise<BookSearchHit[]>;
  /** Open a library book by id; the host posts the BookSource to the UI itself. */
  openLibraryBook: (call: Extract<BuddyToolCall, { tool: "open_library_book" }>) => Promise<BuddyOpenedInfo>;
  /** Fetch a URL's text, build a BookSource, and open it (host-side). */
  openWebText: (call: Extract<BuddyToolCall, { tool: "open_web_text" }>) => Promise<BuddyOpenedInfo>;
  /** Build a BookSource from chat-pasted text and open it (host-side). */
  openPastedText: (call: Extract<BuddyToolCall, { tool: "open_pasted_text" }>) => Promise<BuddyOpenedInfo>;
  /** Build a `code` BookSource from chat-shared source and open it (host-side). */
  openCode?: (call: Extract<BuddyToolCall, { tool: "open_code" }>) => Promise<BuddyOpenedInfo>;
  /** Generate a new spreadsheet from a column/row spec and open it (host-side). */
  createSpreadsheet?: (call: Extract<BuddyToolCall, { tool: "create_spreadsheet" }>) => Promise<BuddyOpenedInfo>;
  /** Remove a library book by id; returns its title (undefined when absent). */
  removeLibraryBook: (
    call: Extract<BuddyToolCall, { tool: "remove_library_book" }>,
  ) => Promise<{ removed?: string }>;
  /** Apply art style / cadence; returns what was ACTUALLY applied. */
  setVisualStyle: (
    call: Extract<BuddyToolCall, { tool: "set_visual_style" }>,
  ) => Promise<{ style?: string; pagesPerImage?: number | "chapter"; illustrateAfter?: "chapter" | "book" }>;
  /** Apply a validated settings change (host owns ReaderSettings + persistence). */
  applySetting?: (change: { key: string; value: boolean | number | string; label: string; valueLabel: string }) => Promise<void>;
  /** Long-term reader memory (see reader-memory.ts); returns the kept count. */
  remember?: (note: string) => Promise<number>;
  forget?: (match: string) => Promise<number>;
  /** Skills (durable playbooks — see skills.ts). readSkill returns the body ("" if
   * none); saveSkill/forgetSkill return the kept count. */
  readSkill?: (name: string) => Promise<string>;
  saveSkill?: (name: string, description: string, body: string) => Promise<number>;
  forgetSkill?: (match: string) => Promise<number>;
  /** Google (Gmail read; Calendar + Tasks read/create) — present when connected. */
  gmailSearch?: (query: string, max?: number) => Promise<EmailSummary[]>;
  readEmail?: (id: string) => Promise<EmailFull>;
  /** Download + read an email attachment's text (auto-run; safe internal "gather" work). */
  readAttachment?: (messageId: string, attachmentId: string) => Promise<{ filename: string; mimeType: string; text?: string; bytesLen: number }>;
  /** Draft an email (saved to Gmail Drafts; auto-run — a draft is reversible). */
  draftEmail?: (d: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] }) => Promise<{ id?: string }>;
  /** Send an email directly (ALWAYS approval-gated by the host). */
  sendEmail?: (d: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] }) => Promise<{ id?: string }>;
  /** Search the reader's computer (planner; gated by the autonomous-file-search setting). */
  findFiles?: (query: string) => Promise<{ name: string; path: string }[]>;
  /** Read a local file's text (planner; gated by the auto-pull-files setting). */
  readFile?: (path: string) => Promise<string>;
  /** Open an image file INTO the chat (the host shows its bytes inline). Returns the picture's name,
   * mime + base64 bytes (the host renders them; never folded into the model turn) and an optional
   * vision observation. */
  openImage?: (path: string) => Promise<{ name: string; mimeType: string; base64: string; observation?: string }>;
  listEvents?: (opts: { max?: number; timeMin?: string; timeMax?: string }) => Promise<CalendarEvent[]>;
  createEvent?: (ev: { summary: string; start: string; end: string; description?: string; location?: string }) => Promise<CalendarEvent>;
  listTasks?: (max?: number) => Promise<TaskItem[]>;
  createTask?: (t: { title: string; notes?: string; due?: string }) => Promise<TaskItem>;
  /** Create a PARENT to-do with nested SUB-TASKS (Google Tasks + a mirrored in-app plan). */
  addTaskGroup?: (group: { title: string; due?: string; subtasks: { title: string; due?: string }[] }) => Promise<{ title: string; count: number }>;
  /** Scheduled/periodic tasks — created/listed/cancelled over the shared store. */
  scheduleTask?: (call: Extract<BuddyToolCall, { tool: "schedule_task" }>) => Promise<{ id: string; title: string; describe: string }>;
  listScheduled?: () => Promise<{ id: string; title: string; describe: string; enabled: boolean }[]>;
  cancelScheduled?: (id: string) => Promise<boolean>;
  /** Task-plan execution (the orchestrator) — wired over the shared store. */
  markStepDone?: (planId: string, stepId: string) => Promise<{ planTitle: string; nextStep?: string; completed: boolean } | undefined>;
  updateTaskStep?: (planId: string, stepId: string, patch: { status?: string; notes?: string }) => Promise<{ planTitle: string } | undefined>;
  /** Add/replace the steps of an existing plan (defaults to the active task when planId omitted). */
  addTaskSteps?: (args: { planId?: string; steps: { title: string; detail?: string; actor?: "ai_prep" | "user_action"; dueIso?: string }[]; replace?: boolean }) => Promise<{ planTitle: string; count: number; replaced: boolean } | undefined>;
  listTaskPlans?: () => Promise<{ id: string; title: string; status: string; nextStep?: string; deadlineIso?: string }[]>;
  getTaskPlan?: (id: string) => Promise<TaskPlan | undefined>;
}

export type BuddyTurnEvent =
  | { kind: "token"; text: string }
  /** A thinking model is reasoning (no visible answer yet); `text` is the live reasoning. */
  | { kind: "thinking"; text: string }
  /** A transient "working" heartbeat so the turn never looks frozen while the model streams
   * MUTED content (tool-call JSON is gated out of the visible stream) or thinks silently — the one
   * signal a linked phone gets that the buddy is busy. Cleared by the first visible token / the
   * settled answer. */
  | { kind: "activity"; text: string }
  | { kind: "tool"; round: number; call: BuddyToolCall }
  | { kind: "toolResult"; round: number; call: BuddyToolCall; result: BuddyToolResultPayload };

export interface BuddyTurnOutcome {
  /** Final assistant prose (empty ONLY when the round ended on a pending tool). */
  text: string;
  /** Turns appended THIS round, ready to extend the stored history. */
  transcript: ChatTurn[];
  /** An un-executed generate_image awaiting the reader's approval. */
  pendingTool?: BuddyToolCall;
  toolResults: { call: BuddyToolCall; result: BuddyToolResultPayload }[];
  /** The turn's reasoning (a thinking model's scratchpad), kept so the UI can show it as a
   * collapsible on the settled message instead of losing it when the turn ends. */
  thinking?: string;
}

/** A user-facing answer is never empty: a model that ended on a tool/blank with no prose would
 * otherwise show an empty bubble. Fall back to a short line (acknowledging tools if any ran). PURE. */
export function nonEmptyAnswer(text: string, hadTools: boolean): string {
  const t = text.trim();
  if (t) return t;
  return hadTools ? "Done — see the results above." : "I didn't catch that — could you rephrase?";
}

/** Tools that stop the auto-run loop for the host/UI (approval, a render, a main-thread run, or
 * a research pass). They can't run inside the worker turn, so they're handed up as a pendingTool. */
type HostToolName =
  | "generate_image"
  | "find_files"
  | "run_command"
  | "write_file"
  | "screenshot"
  | "plan_task"
  | "prep_order"
  | "tv_chart"
  | "delegate"
  | "send_email"
  | "spawn_coding_agents";
const HOST_TOOLS = new Set<HostToolName>([
  "generate_image",
  "find_files",
  "run_command",
  "write_file",
  "screenshot",
  "plan_task",
  "prep_order",
  "tv_chart",
  "delegate",
  // send_email is outward-facing + irreversible — handed up so the host shows an approval card
  // (draft_email stays auto-run below: a draft just sits in Gmail for the reader to review).
  "send_email",
  // spawn_coding_agents needs host orchestration (approval, git worktrees, merge) — handed up.
  "spawn_coding_agents",
]);
/** Type-guard so the non-host branch narrows to the tools `runBuddyTool` can execute. */
function isHostTool(call: BuddyToolCall): call is Extract<BuddyToolCall, { tool: HostToolName }> {
  return (HOST_TOOLS as Set<string>).has(call.tool);
}

export async function runBuddyTurn(opts: {
  llm: ChatCapable;
  system: string;
  /** Stable leading portion of `system` to cache (see ChatOptions.cachePrefix). */
  cachePrefix?: string;
  /** Prior turns + the new user message (caller appends it before calling). */
  history: ChatTurn[];
  deps: BuddyDeps;
  /** Response budget (tokens); unset = the provider's default. */
  maxTokens?: number;
  onEvent?: (e: BuddyTurnEvent) => void;
  /** Run `spawn_agents` subtasks as concurrent read-only sub-agents (host-provided so it owns the
   * concurrency cap + which model tier the sub-agents use). Absent ⇒ the tool reports unavailable. */
  runSubAgents?: (tasks: string[]) => Promise<{ task: string; result: string }[]>;
  /**
   * Execute a HOST tool (run_command / write_file / …) OUT-OF-BAND and feed its result back into
   * this turn, instead of suspending and returning it as a `pendingTool`. This is what makes a
   * WRITE-CAPABLE sub-agent possible: a coding agent runs in the worker, but its commands/writes
   * execute on the main thread in the agent's worktree (the host provides this, optionally behind a
   * per-step approval). Absent ⇒ host tools suspend the turn as before (the main buddy's path).
   */
  runHostTool?: (call: BuddyToolCall) => Promise<BuddyToolResultPayload>;
  signal?: AbortSignal;
  /** Thinking level for local reasoning models (passed straight to the provider's chat). */
  reasoningEffort?: "none" | "low" | "medium" | "high";
}): Promise<BuddyTurnOutcome> {
  const messages: ChatTurn[] = [{ role: "system", content: opts.system }, ...opts.history];
  const transcript: ChatTurn[] = [];
  const toolResults: BuddyTurnOutcome["toolResults"] = [];
  let lastThinking = ""; // the latest round's reasoning, persisted onto the settled message
  let wrappedUp = false; // guard: only re-prompt for a plain-text wrap-up once
  let lastTruncated = false; // did the last reply get CUT OFF at the token budget? (→ auto-continue)

  // One model call against the current `messages` — a FRESH token gate each time (tool JSON never
  // streams visibly), capturing whether the server cut us off at the budget so a long answer can be
  // continued in another pass and stitched together.
  const chatOnce = (): Promise<string> => {
    lastTruncated = false;
    // First-token heartbeat: a big local model (e.g. a 27B over the phone tunnel) can take a long
    // time to load/process the prompt before the FIRST token arrives. The linked phone's silence
    // watchdog only resets on a stream event, so a long time-to-first-token used to trip it ("the
    // chat went quiet"). Tick a transient activity event with elapsed seconds every few seconds
    // until the first token (or thinking) shows up — this only feeds the watchdog, never caps the
    // reply. Cleared the instant any real content streams or the call settles.
    let sawContent = false;
    const startedAt = Date.now();
    const heartbeat = opts.onEvent
      ? setInterval(() => {
          if (sawContent) return;
          const secs = Math.round((Date.now() - startedAt) / 1000);
          opts.onEvent?.({ kind: "activity", text: `Still working… (${secs}s — large models can be slow to start)` });
        }, HEARTBEAT_MS)
      : undefined;
    const noteContent = () => {
      sawContent = true;
    };
    const settled = opts.llm.chat(messages, {
      ...(opts.onEvent
        ? {
            onToken: jsonGatedTokenSink((text) => {
              noteContent();
              opts.onEvent?.({ kind: "token", text });
            }),
            onThinking: (text: string) => {
              noteContent();
              lastThinking = text;
              opts.onEvent?.({ kind: "thinking", text });
            },
          }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.cachePrefix ? { cachePrefix: opts.cachePrefix } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      onComplete: (m) => {
        lastTruncated = m.truncated;
      },
    });
    if (heartbeat !== undefined) {
      const stop = () => clearInterval(heartbeat);
      settled.then(stop, stop);
    }
    return settled;
  };

  for (let round = 0; ; round++) {
    // Heartbeat: the reply may stream entirely MUTED (tool-call JSON is gated out of the visible
    // token stream) or the model may think silently for a while — without this the turn looks frozen,
    // which is exactly what a linked phone saw. A visible token / the final answer clears it.
    opts.onEvent?.({ kind: "activity", text: round === 0 ? "Thinking…" : "Working on it…" });
    const reply = await chatOnce();
    const calls = round < MAX_BUDDY_TOOL_ROUNDS ? parseBuddyToolCalls(reply) : [];
    const withThinking = (out: BuddyTurnOutcome): BuddyTurnOutcome =>
      lastThinking.trim() ? { ...out, thinking: lastThinking.trim() } : out;
    if (calls.length === 0) {
      // A reply that LOOKED like tool JSON but didn't parse into any known call must NOT be
      // dumped to the reader as prose (that's the raw-JSON-in-chat bug). Nudge the model to
      // re-issue it properly; otherwise it's a normal plain-text answer.
      if (round < MAX_BUDDY_TOOL_ROUNDS && looksLikeToolJson(reply)) {
        transcript.push({ role: "assistant", content: reply });
        messages.push({ role: "assistant", content: reply });
        const nudge =
          "[That looked like a tool call but wasn't something I could run. Re-issue each tool call " +
          "as its own JSON object (one per line, no prose around them), or just answer in plain text.]";
        transcript.push({ role: "user", content: nudge });
        messages.push({ role: "user", content: nudge });
        continue;
      }
      let clean = stripToolCallJson(reply).trim();
      // The model ended on a tool/blank with NO prose. Ask once for a plain-text wrap-up so the
      // reader never gets an empty bubble; if it's still empty, fall back to a short line.
      if (!clean && !wrappedUp) {
        transcript.push({ role: "assistant", content: reply });
        wrappedUp = true;
        const wrap =
          "[Now reply to the reader in plain text — briefly say what you did or found. No tool calls.]";
        messages.push({ role: "user", content: wrap });
        transcript.push({ role: "user", content: wrap });
        continue;
      }
      // AUTO-CONTINUE: the server CUT THE ANSWER OFF at the token budget. Keep asking it to pick up
      // where it left off and stitch the parts, so a big document (a full worksheet, a long file)
      // isn't capped at one reply — the reader sees each part stream in with a "part N" status.
      let rawSoFar = reply;
      for (let part = 0; lastTruncated && part < MAX_REPLY_CONTINUATIONS; part++) {
        opts.onEvent?.({ kind: "activity", text: `Writing the answer… (part ${part + 2})` });
        messages.push({ role: "assistant", content: rawSoFar });
        messages.push({
          role: "user",
          content:
            "[You hit the length limit mid-answer. Continue EXACTLY where you left off — pick up at the " +
            "next character, do NOT repeat anything already written, no preamble and no tool calls — " +
            "until the answer is complete.]",
        });
        rawSoFar = await chatOnce();
        const more = stripToolCallJson(rawSoFar).trim();
        if (more) clean = clean ? `${clean}\n${more}` : more;
      }
      // If we stopped only because of the per-turn safety cap (still truncated), say so plainly so a
      // genuinely huge document is never SILENTLY cut — the reader can just ask for the rest.
      if (lastTruncated) {
        clean += '\n\n_(This is running very long — I paused here. Say "continue" and I\'ll pick up exactly where I left off.)_';
      }
      transcript.push({ role: "assistant", content: clean });
      // Safety net: never hand the reader stray tool-call JSON or an empty string.
      return withThinking({ text: nonEmptyAnswer(clean, toolResults.length > 0), transcript, toolResults });
    }
    transcript.push({ role: "assistant", content: reply });
    messages.push({ role: "assistant", content: reply });

    // Run every tool the model batched this round, in order. A host/UI tool (needs approval or a
    // main-thread run) stops the batch: if it's first, hand it up as a pendingTool (as before);
    // if auto-run tools already ran this round, defer it so their results aren't lost — the model
    // re-issues it next round.
    const feedbacks: string[] = [];
    let deferred = false;
    for (const call of calls) {
      // Parallel fan-out: run the independent subtasks as concurrent read-only sub-agents (the host
      // caps how many run at once) and feed all their results back at once.
      if (call.tool === "spawn_agents") {
        opts.onEvent?.({ kind: "tool", round, call });
        const subAgents = opts.runSubAgents ? await opts.runSubAgents(call.tasks) : undefined;
        const result: BuddyToolResultPayload = subAgents
          ? { subAgents }
          : { error: "parallel sub-agents aren't available here" };
        toolResults.push({ call, result });
        opts.onEvent?.({ kind: "toolResult", round, call, result });
        feedbacks.push(formatBuddyToolResult(call, result));
        continue;
      }
      if (isHostTool(call)) {
        // Write-capable sub-agent: execute the host tool out-of-band (host runs it in the agent's
        // worktree, optionally after an approval) and continue, rather than suspending the turn.
        if (opts.runHostTool) {
          opts.onEvent?.({ kind: "tool", round, call });
          const result = await opts.runHostTool(call);
          toolResults.push({ call, result });
          opts.onEvent?.({ kind: "toolResult", round, call, result });
          feedbacks.push(formatBuddyToolResult(call, result));
          continue;
        }
        if (feedbacks.length === 0) {
          opts.onEvent?.({ kind: "tool", round, call });
          return { text: "", transcript, pendingTool: call, toolResults };
        }
        deferred = true;
        break;
      }
      opts.onEvent?.({ kind: "tool", round, call });
      // Name the specific action in the status line ("Searching the web for …") so the reader sees
      // exactly what's happening while the (muted) tool runs — clarity the phone especially needs.
      opts.onEvent?.({ kind: "activity", text: describeBuddyToolActivity(call) });
      let result = await runBuddyTool(call, opts.deps);
      // One automatic retry for a transient (network/timeout/rate-limit) failure before the
      // error is shown to the model — turns a flaky blip into a silent recovery.
      if (result.error && isRetryableError(result.error)) {
        result = await runBuddyTool(call, opts.deps);
      }
      toolResults.push({ call, result });
      opts.onEvent?.({ kind: "toolResult", round, call, result });
      feedbacks.push(formatBuddyToolResult(call, result));
    }
    // On the final tool round, append a wrap-up nudge so the model answers now instead of
    // spending its last round on a tool whose result it can't follow up on.
    const feedback =
      feedbacks.join("\n\n") +
      (deferred ? "\n\n[Re-issue the remaining host tool (image/command/plan/etc.) now if you still need it.]" : "") +
      toolLimitNudge(round);
    transcript.push({ role: "user", content: feedback });
    messages.push({ role: "user", content: feedback });
  }
}

/** Execute one auto-run buddy tool (everything but generate_image). Exported for
 * the slash-command path, which runs tools directly without an LLM round. */
export async function runBuddyTool(
  call: Exclude<BuddyToolCall, { tool: "generate_image" | "find_files" | "run_command" | "write_file" | "screenshot" | "plan_task" | "prep_order" | "tv_chart" | "delegate" | "spawn_agents" | "send_email" | "spawn_coding_agents" }>,
  deps: BuddyDeps,
): Promise<BuddyToolResultPayload> {
  try {
    switch (call.tool) {
      case "search_web":
        if (!deps.searchWeb) return { error: "web search isn't available right now" };
        return { hits: await deps.searchWeb(call.query) };
      case "read_url":
        if (!deps.readUrl) return { error: "reading web pages isn't available right now" };
        return { page: await deps.readUrl(call.url) };
      case "search_books":
        if (!deps.searchBooks) return { error: "book search isn't available right now" };
        return { books: await deps.searchBooks(call.query) };
      case "search_images":
        if (!deps.searchImages) return { error: "image search isn't available right now" };
        return { imageHits: await deps.searchImages(call.query) };
      case "random_books":
        if (!deps.randomBooks) return { error: "book discovery isn't available right now" };
        return { books: await deps.randomBooks() };
      case "calculate":
        // Grounded math via mathjs (units, matrices, derivatives, stats…); on a bad
        // expression OR when mathjs can't load, fall back to the keyless arithmetic
        // parser so basic computation always works.
        try {
          return { calc: { expression: call.expression, result: await evaluateMath(call.expression) } };
        } catch (err) {
          try {
            return {
              calc: { expression: call.expression, result: formatCalcResult(evaluateExpression(call.expression)) },
            };
          } catch {
            return { error: err instanceof Error ? err.message : "couldn't compute that" };
          }
        }
      case "wolfram":
        if (!deps.wolfram) return { error: "Wolfram|Alpha isn't set up (add an AppID in Settings)." };
        return { wolfram: { query: call.query, answer: await deps.wolfram(call.query) } };
      case "stock_quote": {
        if (!deps.stockQuote) return { error: "stock quotes aren't available right now" };
        const quote = await deps.stockQuote(call.symbol);
        return quote ? { quote } : {};
      }
      case "market_analysis": {
        if (!deps.marketIndicators) return { error: "market analytics aren't available right now" };
        const indicators = await deps.marketIndicators(call.symbol, call.interval, call.range);
        return indicators ? { indicators } : {};
      }
      case "set_price_alert": {
        if (!deps.setPriceAlert) return { error: "price alerts aren't available right now" };
        const alert = await deps.setPriceAlert(call);
        return alert ? { alert } : {};
      }
      case "list_alerts":
        if (!deps.listAlerts) return { error: "price alerts aren't available right now" };
        return { alertsList: await deps.listAlerts() };
      case "cancel_alert":
        if (!deps.cancelAlert) return { error: "price alerts aren't available right now" };
        await deps.cancelAlert(call.id);
        return {};
      case "schwab_quote": {
        if (!deps.schwabQuote) return { error: "Schwab isn't connected (connect it in Settings)." };
        const q = await deps.schwabQuote(call.symbol);
        return q ? { schwabQuote: q } : {};
      }
      case "schwab_options": {
        if (!deps.schwabOptions) return { error: "Schwab isn't connected (connect it in Settings)." };
        const chain = await deps.schwabOptions(call.symbol, { ...(call.contractType ? { contractType: call.contractType } : {}), ...(call.strikeCount !== undefined ? { strikeCount: call.strikeCount } : {}) });
        return chain ? { optionChain: chain } : {};
      }
      case "schwab_positions": {
        if (!deps.schwabPositions) return { error: "Schwab isn't connected (connect it in Settings)." };
        return { positions: await deps.schwabPositions() };
      }
      case "schwab_watchlists": {
        if (!deps.schwabWatchlists) return { error: "Schwab isn't connected (connect it in Settings)." };
        return { watchlists: await deps.schwabWatchlists() };
      }
      case "mcp_tools": {
        if (!deps.mcpTools) return { error: "No MCP servers are configured (add some in Settings)." };
        const tools = await deps.mcpTools(call.server);
        return tools ? { mcpToolsList: { server: call.server, tools } } : {};
      }
      case "mcp_call": {
        if (!deps.mcpCall) return { error: "No MCP servers are configured (add some in Settings)." };
        const text = await deps.mcpCall(call.server, call.toolName, call.args ?? {});
        return text !== undefined ? { mcpResult: { server: call.server, tool: call.toolName, text } } : {};
      }
      case "trading_script": {
        // Pure: verified Pine/thinkScript templates, no host dependency.
        const { lang, where } = scriptLanguage(call.platform);
        const script = buildTradingScript(call.platform, call.kind, {
          ...(call.level !== undefined ? { level: call.level } : {}),
          ...(call.length !== undefined ? { length: call.length } : {}),
          ...(call.fast !== undefined ? { fast: call.fast } : {}),
          ...(call.slow !== undefined ? { slow: call.slow } : {}),
          ...(call.maType ? { maType: call.maType } : {}),
        });
        return { tradingScript: { lang, script, where } };
      }
      case "open_library_book":
        return { opened: await deps.openLibraryBook(call) };
      case "open_web_text":
        return { opened: await deps.openWebText(call) };
      case "open_pasted_text":
        return { opened: await deps.openPastedText(call) };
      case "open_code":
        if (!deps.openCode) return { error: "opening code isn't available right now" };
        return { opened: await deps.openCode(call) };
      case "create_spreadsheet":
        if (!deps.createSpreadsheet) return { error: "creating spreadsheets isn't available right now" };
        return { opened: await deps.createSpreadsheet(call) };
      case "remove_library_book":
        return await deps.removeLibraryBook(call);
      case "set_visual_style":
        return { applied: await deps.setVisualStyle(call) };
      case "remember":
        if (!deps.remember) return { error: "memory isn't available right now" };
        return { memory: { action: "remembered", note: call.note, count: await deps.remember(call.note) } };
      case "forget":
        if (!deps.forget) return { error: "memory isn't available right now" };
        return { memory: { action: "forgot", note: call.match, count: await deps.forget(call.match) } };
      case "update_setting": {
        // Validate purely (coerce + bound to the controllable table), then hand the
        // concrete patch to the host, which owns ReaderSettings and persistence.
        const r = parseSettingChange(call.field, call.value);
        if (!r.ok) return { settingChange: { error: r.error } };
        if (!deps.applySetting) return { error: "changing settings isn't available right now" };
        await deps.applySetting({ key: r.key, value: r.value, label: r.label, valueLabel: r.valueLabel });
        return { settingChange: { label: r.label, valueLabel: r.valueLabel, sensitive: r.sensitive } };
      }
      case "setup_help": {
        // Pure lookup over the built-in guides — no host dependency, always available.
        const guide = findSetupGuide(call.topic);
        return { setupHelp: guide ? { guide } : { topics: setupGuideTopics() } };
      }
      case "read_skill": {
        if (!deps.readSkill) return { error: "skills aren't available right now" };
        const body = await deps.readSkill(call.name);
        return { skill: body ? { action: "read", name: call.name, body } : { action: "missing", name: call.name } };
      }
      case "save_skill":
        if (!deps.saveSkill) return { error: "skills aren't available right now" };
        return {
          skill: { action: "saved", name: call.name, count: await deps.saveSkill(call.name, call.description, call.body) },
        };
      case "forget_skill":
        if (!deps.forgetSkill) return { error: "skills aren't available right now" };
        return { skill: { action: "forgot", name: call.match, count: await deps.forgetSkill(call.match) } };
      case "gmail_search":
        if (!deps.gmailSearch) return { error: "Google isn't connected (connect it in Settings)." };
        return { emails: await deps.gmailSearch(call.query, call.max) };
      case "read_email":
        if (!deps.readEmail) return { error: "Google isn't connected (connect it in Settings)." };
        return { emailFull: await deps.readEmail(call.id) };
      case "draft_email": {
        if (!deps.draftEmail) return { error: "Google isn't connected (connect it in Settings)." };
        const d = {
          to: call.to,
          subject: call.subject,
          body: call.body,
          ...(call.cc ? { cc: call.cc } : {}),
          ...(call.bcc ? { bcc: call.bcc } : {}),
        };
        try {
          const r = await deps.draftEmail(d);
          return { email: { sent: false, to: call.to, subject: call.subject, ...(r.id ? { id: r.id } : {}) } };
        } catch (err) {
          return { email: { sent: false, to: call.to, subject: call.subject, error: err instanceof Error ? err.message : String(err) } };
        }
      }
      case "read_attachment":
        if (!deps.readAttachment) return { error: "Google isn't connected (connect it in Settings)." };
        return { attachment: await deps.readAttachment(call.messageId, call.attachmentId) };
      case "read_file":
        if (!deps.readFile) return { error: "reading local files isn't enabled (turn on file pulling in Settings, on desktop)." };
        return { fileText: await deps.readFile(call.path) };
      case "open_image":
        if (!deps.openImage) return { error: "opening images isn't enabled (turn on file pulling in Settings, on desktop)." };
        return { openedImage: await deps.openImage(call.path) };
      case "list_events":
        if (!deps.listEvents) return { error: "Google isn't connected (connect it in Settings)." };
        return {
          events: await deps.listEvents({
            ...(call.max !== undefined ? { max: call.max } : {}),
            ...(call.timeMin ? { timeMin: call.timeMin } : {}),
            ...(call.timeMax ? { timeMax: call.timeMax } : {}),
          }),
        };
      case "create_event":
        if (!deps.createEvent) return { error: "Google isn't connected (connect it in Settings)." };
        return {
          eventCreated: await deps.createEvent({
            summary: call.summary,
            start: call.start,
            end: call.end,
            ...(call.description ? { description: call.description } : {}),
            ...(call.location ? { location: call.location } : {}),
          }),
        };
      case "list_tasks":
        if (!deps.listTasks) return { error: "Google isn't connected (connect it in Settings)." };
        return { tasks: await deps.listTasks(call.max) };
      case "create_task":
        if (!deps.createTask) return { error: "Google isn't connected (connect it in Settings)." };
        return {
          taskCreated: await deps.createTask({
            title: call.title,
            ...(call.notes ? { notes: call.notes } : {}),
            ...(call.due ? { due: call.due } : {}),
          }),
        };
      case "add_task_group":
        if (!deps.addTaskGroup) return { error: "Google isn't connected (connect it in Settings)." };
        return {
          taskGroup: await deps.addTaskGroup({
            title: call.title,
            ...(call.due ? { due: call.due } : {}),
            subtasks: call.subtasks,
          }),
        };
      case "mark_step_done": {
        if (!deps.markStepDone) return { error: "task plans aren't available" };
        const r = await deps.markStepDone(call.planId, call.stepId);
        return r ? { taskAction: { planTitle: r.planTitle, ...(r.nextStep ? { nextStep: r.nextStep } : {}), completed: r.completed } } : {};
      }
      case "update_task_step": {
        if (!deps.updateTaskStep) return { error: "task plans aren't available" };
        const r = await deps.updateTaskStep(call.planId, call.stepId, {
          ...(call.status ? { status: call.status } : {}),
          ...(call.notes ? { notes: call.notes } : {}),
        });
        return r ? { taskAction: { planTitle: r.planTitle } } : {};
      }
      case "add_task_steps": {
        if (!deps.addTaskSteps) return { error: "task plans aren't available" };
        const r = await deps.addTaskSteps({ steps: call.steps, ...(call.planId ? { planId: call.planId } : {}), ...(call.replace ? { replace: true } : {}) });
        return r ? { stepsAdded: r } : {};
      }
      case "schedule_task":
        if (!deps.scheduleTask) return { error: "scheduled tasks aren't available right now" };
        return { scheduled: await deps.scheduleTask(call) };
      case "list_scheduled":
        if (!deps.listScheduled) return { error: "scheduled tasks aren't available right now" };
        return { scheduledList: await deps.listScheduled() };
      case "cancel_scheduled":
        if (!deps.cancelScheduled) return { error: "scheduled tasks aren't available right now" };
        await deps.cancelScheduled(call.id);
        return {};
      case "list_task_plans":
        if (!deps.listTaskPlans) return { error: "task plans aren't available" };
        return { taskPlansList: await deps.listTaskPlans() };
      case "get_task_plan": {
        if (!deps.getTaskPlan) return { error: "task plans aren't available" };
        const p = await deps.getTaskPlan(call.id);
        return p ? { taskPlan: p } : {};
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
