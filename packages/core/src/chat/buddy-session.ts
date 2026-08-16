import { rememberRouteFor } from "./souls.js";
import { dateMath } from "./date-math.js";
import type { ChatCapable, ChatTurn, ToolSchema } from "../providers/llm/chat.js";
import type { ImageSearchHit, WebSearchHit } from "../providers/image/image-search.js";
import type { BookSearchHit } from "../providers/book-search.js";
import {
  MAX_BUDDY_TOOL_ROUNDS,
  MAX_LIVE_CONTROL_ROUNDS,
  LIVE_REPEAT_LIMIT,
  roundSignature,
  stuckOnRepeat,
  describeBuddyToolActivity,
  formatBuddyToolResult,
  readFileWindow,
  isRetryableError,
  looksLikeToolJson,
  parseBuddyToolCalls,
  roundThinkingRecap,
  seriesProgressNote,
  progressNudge,
  stripToolCallJson,
  toolLimitNudge,
  type BuddyOpenedInfo,
  type BuddyPlan,
  type BuddyToolCall,
  type BuddyToolResultPayload,
  MAX_PLAN_STEPS,
  HOST_TOOLS,
  type HostToolName,
  toolCallsInThinking,
  meantToSendMessage,
  splitSeriesMessages,
} from "./buddy-tools.js";
import type { CalendarEvent, EmailFull, EmailSummary, TaskItem } from "../providers/google.js";
import type { TaskPlan } from "./tasks.js";
import { findSetupGuide, setupGuideTopics } from "./setup-guides.js";
import { buildTradingScript, scriptLanguage } from "./trading-scripts.js";
import { parseSettingChange } from "./settings-control.js";
import { evaluateExpression, formatCalcResult } from "./calculator.js";
import { evaluateMath } from "./math-engine.js";
import { jsonGatedTokenSink, trimTurnMessages } from "./chat-session.js";
import { TOOLSET_IDS, isToolAvailable, toolsetForTool } from "./toolsets.js";
import {
  MIN_CHUNKED_DOCUMENT_CHARS,
  chunkDocument,
  extractFromDocument,
} from "../files/document-extraction.js";
import { allowedInCreativeIdle } from "./tool-approval.js";

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

/**
 * How many times one turn will tell the model its call was in its reasoning rather than its reply.
 *
 * Two, because the correction either lands immediately or is not going to: a model that writes the
 * call into its thinking twice after being told is doing something the wording will not fix, and the
 * wrap-up is a better ending for the reader than an unbounded loop of the same sentence. Each nudge
 * also costs a full round of the turn's budget.
 */
const MAX_THOUGHT_ONLY_NUDGES = 2;

/**
 * HOW MUCH VISIBLE ANSWER THERE MUST BE BEFORE "CONTINUE WHERE YOU LEFT OFF" MEANS ANYTHING.
 *
 * `truncated` says the TOKEN BUDGET ran out. It does not say the ANSWER was cut off, and on a
 * reasoning model those are routinely different things: it can spend the whole budget thinking and
 * emit one visible character. Asked to "pick up at the next character" of a one-character reply, a
 * model has nothing to continue — the reported case answered "please provide the exact text where
 * the previous response was cut off", which is the only sensible reply to an impossible request.
 *
 * The loop exists for a big document capped at one reply, so the question is whether the model was
 * still WRITING when the budget ran out. Under a couple of sentences it was not: it had finished,
 * and the budget went somewhere else. Below this, hand over what there is.
 *
 * The errors are not symmetric, which is what sets the number. Refusing to continue something that
 * really was cut off costs the reader one "continue" — they can see the answer stopped. Continuing
 * something that was not costs a nonsensical reply, up to eight wasted model calls, and a context
 * window filled with the loop's own directives. 200 leans toward the cheap mistake.
 */
export const MIN_CONTINUABLE_CHARS = 200;

/**
 * Is this reply a hand-off rather than a step's work?
 *
 * The anti-skip guard has to tell "I did the thing" from "I'm moving on", and for a step whose
 * deliverable is text there is nothing but the text to go on. Length was the first attempt and is
 * wrong in both directions — it fails "send me the alphabet, one letter per message", where a whole
 * step is the character A, and it passes any padded acknowledgement.
 *
 * Bounded to SHORT strings so nothing that actually answers anything can match: a real answer that
 * happens to open with "Done." is longer than this and is judged on the rest of it.
 */
export function isBareAcknowledgement(text: string): boolean {
  const t = text.trim();
  if (t.length > 40) return false;
  return /^(?:✓\s*)?(?:ok(?:ay)?|done|next|finished|complete(?:d)?|got it|moving on|(?:step\s*\d+\s*(?:is\s*)?(?:done|complete(?:d)?|finished))|on to (?:the )?next(?: step)?)[\s.!,;:—-]*$/i.test(t);
}


/**
 * Is this reply nothing but "yes, that was the last one"?
 *
 * The stall check asks a question the reader never sees, so the answer to it must never become the
 * reader's last message of a series — that is how the alphabet ended on "yes, that's the whole
 * alphabet" with Z sent but never shown. Anything beyond a confirmation is kept, because a model
 * that used the same reply to say something real must not have it thrown away.
 *
 * Separate from `isBareAcknowledgement`, which serves the anti-skip guard and is deliberately
 * narrow. This one answers a different question and a wrong match costs differently: there it would
 * let a step be skipped; here it would drop a closing line the reader might have wanted. Hence the
 * length bound, and a pattern that has to match the WHOLE reply.
 */
export function isStallConfirmation(text: string): boolean {
  const t = text.trim();
  if (t.length > 80) return false;
  // The WHOLE reply has to be a confirmation. An earlier version anchored only the opening and let
  // the rest run to the first full stop, which passed "That's the whole alphabet — 26 letters, A
  // through Z." — a closing line worth keeping, thrown away for starting with the word "That's".
  return /^(?:(?:yes|yep|yeah|ok(?:ay)?)[\s,—-]*)?(?:that(?:'s| is| was)?\s*(?:the\s*)?(?:all|it|last(?:\s*one)?)|all done|no more|nothing more|finished|complete(?:d)?|done)?[\s.!,;:—-]*$/i.test(
    t,
  );
}

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
  /** Make a real document (Markdown → PDF/Word), save it to the workspace, and surface it as a
   * downloadable file card (host-side). Returns the saved-document info for the chat confirmation. */
  createDocument?: (
    call: Extract<BuddyToolCall, { tool: "create_document" }>,
  ) => Promise<NonNullable<BuddyToolResultPayload["document"]>>;
  /** Revise the active document by search/replace against its FULL stored text — the path that lets a
   * document be changed without re-emitting it (and without losing the part the model never saw). */
  editDocument?: (patch: {
    edits?: { search: string; replace: string }[];
    setLines?: { match: string; line: string }[];
  }) => Promise<NonNullable<BuddyToolResultPayload["documentEdit"]>>;
  /** The active document's real text — the whole thing, or one section by heading. */
  readDocument?: (section?: string) => Promise<NonNullable<BuddyToolResultPayload["documentText"]>>;
  /** Story "as you go": start a new co-written illustrated story, open it, render beat one. */
  startStory?: (call: Extract<BuddyToolCall, { tool: "start_story" }>) => Promise<BuddyOpenedInfo>;
  /** Append the next beat to the OPEN story (prose + an image per the cadence). Returns the
   * grown story info + whether this beat auto-illustrated. */
  continueStory?: (
    call: Extract<BuddyToolCall, { tool: "continue_story" }>,
  ) => Promise<BuddyOpenedInfo & { beats: number; illustrated: boolean }>;
  /** Illustrate beats [from..to] of the open story on demand; returns how many rendered. */
  renderScene?: (
    call: Extract<BuddyToolCall, { tool: "render_scene" }>,
  ) => Promise<{ rendered: number; from: number; to: number }>;
  /** Change the open story's auto-illustration cadence; returns what was applied. */
  setStoryCadence?: (
    call: Extract<BuddyToolCall, { tool: "set_story_cadence" }>,
  ) => Promise<{ mode: "per-response" | "every-n" | "manual"; n?: number }>;
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
  remember?: (note: string, about?: "reader" | "self" | "user") => Promise<number>;
  forget?: (match: string, about?: "reader" | "self" | "user") => Promise<number>;
  /** Lightweight chat-scoped working checklist. setPlan creates/replaces it; completeStep ticks the
   * first unfinished step. Both return the updated plan (host owns the canonical object + persistence). */
  setPlan?: (goal: string | undefined, steps: string[], stepDetails?: { needs?: string; onFail?: string; produces?: string[]; verify?: string }[]) => BuddyPlan;
  completeStep?: (note?: string) => BuddyPlan | undefined;
  /** App-managed-steps mode: the HOST runs the checklist and ticks steps from observed evidence, so
   * `complete_step` is withdrawn — a stray call is refused (the model just does the current step). */
  appManagedSteps?: boolean;
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
  /** Save a draft. `updatedExisting` marks the case where this call targeted the draft already open
   * and so UPDATED it rather than adding a second one — the host's revision guard. */
  draftEmail?: (d: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] }) => Promise<{ id?: string; updatedExisting?: boolean }>;
  /** The reader's saved Gmail drafts, so one written earlier can be found and edited. */
  listDrafts?: (max?: number) => Promise<{ id: string; to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] }[]>;
  /** Change a saved draft IN PLACE — read-modify-write, since Gmail replaces the whole message on
   * update. Fields the patch doesn't name are carried through untouched. */
  editDraft?: (
    draftId: string,
    patch: {
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      body?: string;
      edits?: { find: string; replace: string }[];
      setLines?: { match: string; line: string; dedupe?: boolean }[];
    },
  ) => Promise<{ id: string; to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] }>;
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
  listEvents?: (opts: { max?: number; timeMin?: string; timeMax?: string; query?: string }) => Promise<CalendarEvent[]>;
  createEvent?: (ev: { summary: string; start: string; end: string; description?: string; location?: string }) => Promise<CalendarEvent>;
  /** Edit an existing event in place — only the given fields change. The description can be edited IN
   * PLACE (`setLines` upserts a labelled line, `editDescription` find/replaces) or merely added to
   * (`appendDescription`); in-place is what keeps a running list from growing duplicate entries. */
  updateEvent?: (
    eventId: string,
    patch: {
      summary?: string;
      start?: string;
      end?: string;
      description?: string;
      appendDescription?: string;
      editDescription?: { find: string; replace: string }[];
      setLines?: { match: string; line: string }[];
      location?: string;
    },
    calendarId?: string,
  ) => Promise<CalendarEvent>;
  listTasks?: (max?: number) => Promise<TaskItem[]>;
  createTask?: (t: { title: string; notes?: string; due?: string }) => Promise<TaskItem>;
  /** Create a PARENT to-do with nested SUB-TASKS (Google Tasks + a mirrored in-app plan). */
  addTaskGroup?: (group: { title: string; due?: string; subtasks: { title: string; due?: string }[] }) => Promise<{ title: string; count: number }>;
  /** Scheduled/periodic tasks — created/listed/cancelled over the shared store. */
  scheduleTask?: (call: Extract<BuddyToolCall, { tool: "schedule_task" }>) => Promise<{ id: string; title: string; describe: string; planTitle?: string; planUnavailable?: boolean }>;
  /** Change WHAT a scheduled task does. `found: false` when the id names nothing — a model that
   * guessed an id must be told so rather than believing it fixed something. */
  updateScheduledTask?: (
    call: Extract<BuddyToolCall, { tool: "update_scheduled_task" }>,
  ) => Promise<{ found: boolean; title?: string; stepCount?: number }>;
  listScheduled?: () => Promise<{ id: string; title: string; describe: string; enabled: boolean; lastRunIso?: string; lastRunNote?: string }[]>;
  /** The assistant's own record of what it did unattended — see action-history.ts. */
  recentActions?: (kind: string | undefined, limit: number) => Promise<string>;
  cancelScheduled?: (id: string) => Promise<boolean>;
  /** Task-plan execution (the orchestrator) — wired over the shared store. */
  markStepDone?: (planId: string, stepId: string) => Promise<{ planTitle: string; nextStep?: string; completed: boolean } | undefined>;
  /** Mark a WHOLE task plan complete (or reopen it) — the chat's "that's all done" check-off. */
  completeTask?: (planId: string, done: boolean) => Promise<{ planTitle: string; completed: boolean } | undefined>;
  /** Persist new conversation context onto a task plan (planId absent = the chat's active task). */
  saveTaskContext?: (planId: string | undefined, note: string, replan: boolean) => Promise<{ planTitle: string } | undefined>;
  updateTaskStep?: (
    planId: string,
    stepId: string,
    patch: { status?: string; notes?: string; title?: string; detail?: string; dueIso?: string; actor?: "ai_prep" | "user_action" },
  ) => Promise<{ planTitle: string } | undefined>;
  /** Edit the task's OWN fields (planId absent = the chat's active task). */
  updateTask?: (
    planId: string | undefined,
    patch: {
      title?: string;
      summary?: string;
      deadlineIso?: string;
      leadTimeDays?: number;
      estCost?: string;
      researchNotes?: string;
      clarifyingQuestions?: string[];
    },
  ) => Promise<{ planTitle: string } | undefined>;
  /** Create/edit a document ON the task — the write half of the documents a task carries. */
  updateTaskDoc?: (
    planId: string | undefined,
    edit: {
      stepId?: string;
      title: string;
      kind?: "draft" | "reference" | "checklist";
      body?: string;
      setLines?: { match: string; line: string; dedupe?: boolean }[];
      fence?: string;
    },
  ) => Promise<
    | {
        planTitle: string;
        title: string;
        kind: string;
        body: string;
        created: boolean;
        replaced: string[];
        added: string[];
        ambiguous: { match: string; lines: string[] }[];
        error?: string;
      }
    | undefined
  >;
  /** Add/replace the steps of an existing plan (defaults to the active task when planId omitted). */
  addTaskSteps?: (args: { planId?: string; steps: { id?: string; title: string; detail?: string; actor?: "ai_prep" | "user_action"; dueIso?: string }[]; replace?: boolean }) => Promise<{ planTitle: string; count: number; replaced: boolean } | undefined>;
  listTaskPlans?: () => Promise<{ id: string; title: string; status: string; nextStep?: string; deadlineIso?: string }[]>;
  getTaskPlan?: (id: string) => Promise<TaskPlan | undefined>;
  /** Find a picture on the web and hand back its BYTES, for the host to adopt as a chat reference.
   * Returns `ok:false` with a reason rather than throwing, so a blocked host reads as a failed
   * adoption and not as a broken tool. */
  adoptImageReference?: (find: { query?: string; url?: string }) => Promise<{ ok: boolean; title?: string; error?: string; base64?: string; mimeType?: string }>;
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
  | { kind: "toolResult"; round: number; call: BuddyToolCall; result: BuddyToolResultPayload }
  /**
   * A checklist step's work is finished and its text is a complete message.
   *
   * The host flushes streamed prose into its own bubble when a TOOL CALL follows it. A text-only
   * step has no tool call, so without this its letter would sit in the stream buffer and be
   * overwritten by the next step — the same way the last letter of a plan-free series went missing
   * once already. This is the boundary; there is nothing else to hang it on.
   */
  | { kind: "stepDone"; text: string };

/**
 * What the host says after judging the round a checklist step just produced.
 *
 * `continue` carries the directive for whatever comes next — the following step, a retry, or a nudge
 * back toward the step's actual tool. Anything else ends the turn: the plan is finished, or the step
 * is waiting on the reader, and in both cases the model should be writing to them rather than
 * working.
 */
export type AppManagedNext =
  | {
      kind: "continue";
      directive: string;
      /**
       * Did the checklist MOVE, or is this the same step being asked for again?
       *
       * The turn's tool results are only ever appended to, so the loop needs to know when one step's
       * evidence stops counting toward the next — otherwise step 2's "an image rendered" contract is
       * satisfied by step 1's picture, and three steps tick off one render. A nudge or a retry is the
       * same step still owing its work, and must keep whatever it has already produced.
       */
      advanced?: boolean;
    }
  | { kind: "stop" };

export interface BuddyTurnOutcome {
  /** Final assistant prose (empty ONLY when the round ended on a pending tool). */
  text: string;
  /** Turns appended THIS round, ready to extend the stored history. */
  transcript: ChatTurn[];
  /** An un-executed generate_image awaiting the reader's approval. */
  pendingTool?: BuddyToolCall;
  toolResults: { call: BuddyToolCall; result: BuddyToolResultPayload }[];
  /** Toolsets loaded by the end of the turn (seeded + anything pulled in). The host keeps these for
   * the session so the next turn doesn't pay the round-trip again. */
  loadedToolsets?: readonly string[];
  /** The turn stopped at a per-turn tool-round budget with the model still wanting to call tools (a
   * "keep going?" checkpoint — used for cloud models) rather than finishing. The host can offer a
   * Continue affordance; saying/clicking continue resumes from the persisted progress. */
  paused?: boolean;
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

/** Type-guard so the non-host branch narrows to the tools `runBuddyTool` can execute. */
function isHostTool(call: BuddyToolCall): call is Extract<BuddyToolCall, { tool: HostToolName }> {
  return (HOST_TOOLS as Set<string>).has(call.tool);
}

/**
 * Tools the automatic transient-error retry (below) may re-run: read-only lookups/searches whose
 * repeat has no side effects. Write tools (create_event, update_event, create_task, schedule_task,
 * continue_story, draft_email, remember, mcp_call, trading_script, …) must NEVER be auto-retried — a
 * "retryable" error can arrive AFTER the write actually landed (e.g. a timeout on the response), so a
 * retry duplicates the event/task/note — or, for update_event's appendDescription, appends the same
 * line twice. Their errors go back to the model as the tool result instead.
 */
const AUTO_RETRY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "search_web",
  "read_url",
  "search_books",
  "search_images",
  "random_books",
  "calculate",
  "wolfram",
  "stock_quote",
  "market_analysis",
  "schwab_quote",
  "schwab_options",
  "schwab_positions",
  "schwab_watchlists",
  "list_alerts",
  "mcp_tools",
  "gmail_search",
  "read_email",
  "read_attachment",
  // Reading drafts is safe to retry; edit_draft deliberately is NOT — a timeout can arrive after the
  // PUT landed, and re-running a body search/replace against already-edited text throws rather than
  // applying, which would read as a failure on a draft that was in fact changed.
  "list_drafts",
  "read_file",
  "read",
  "read_skill",
  "list_events",
  "list_tasks",
  "list_scheduled",
  "list_task_plans",
  "get_task_plan",
]);

export async function runBuddyTurn(opts: {
  llm: ChatCapable;
  system: string;
  /** Stable leading portion of `system` to cache (see ChatOptions.cachePrefix). */
  cachePrefix?: string;
  /** Prior turns + the new user message (caller appends it before calling). */
  history: ChatTurn[];
  /**
   * Total characters the model can take (system + conversation + tool results). The turn's messages
   * are re-bounded against this before EVERY call — see {@link trimTurnMessages} — because tool
   * results arrive mid-turn and are what actually overflows a window. Unset = no bound (sub-agents
   * and tests, which run a round or two on small inputs).
   */
  contextChars?: number;
  /** Toolsets already loaded for this session — see `toolsets.ts`. Absent = every tool available. */
  loadedToolsets?: readonly string[];
  /** The documentation for a toolset, supplied by the host (which knows the environment's flags). */
  toolsetDoc?: (id: string) => string;
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
  /**
   * APP-MANAGED CHECKLISTS, RUN INSIDE THE TURN.
   *
   * Called when a round produced no tool call and a checklist may still have work. The host judges
   * the step from the evidence handed over — observed tool results and the round's prose, never the
   * model's claim about itself — and answers with the next directive or with "stop".
   *
   * A callback rather than the workflow itself: the host owns the workflow, persists it, and already
   * has the collar (`evaluateStep`/`advanceWorkflow`). Passing the structure in would put two copies
   * of the run's state in play, and the one in here would be the stale one.
   */
  appManagedTick?: (evidence: { toolResults: BuddyTurnOutcome["toolResults"]; text: string }) => AppManagedNext;
  /** Native tool schemas (Ollama `tools`) for a tool-capable local model — passed to the provider so
   * it emits structured tool_calls. Cloud providers ignore it; the text catalog in `system` is the
   * universal fallback. Build with `ollamaToolSchemas`. */
  tools?: ToolSchema[];
  /** GRAMMAR-CONSTRAIN this turn's reply to a valid tool call (Ollama `format`) — set ONLY when a tool
   * call is required (an app-managed step whose contract demands a specific tool). Forces a stubborn
   * small model to emit the call instead of narrating. Build with `buildToolCallFormat`. Ignored by
   * cloud / non-Ollama providers. */
  /**
   * Grammar-constrain the reply to the tool the CURRENT step owes (Ollama `format`).
   *
   * A FUNCTION, resolved every round, because a checklist now runs every step inside one turn. As a
   * fixed object it was computed once from the turn's opening step and then stayed there while the
   * tick moved on — so from step two the sampler admitted only step ONE's tool. The model could not
   * emit the call it actually needed, could not emit plain text either, and on a reasoning model the
   * only unconstrained channel left was the thinking. Reported exactly that way: thinking that can't
   * escape into a tool call, and the same call attempted over and over — which is the one shape the
   * grammar still permitted.
   */
  toolFormat?: Record<string, unknown> | (() => Record<string, unknown> | undefined);
  /**
   * Pause the auto-run tool loop after this many rounds for a "keep going?" checkpoint, instead of
   * running to the (much larger) `MAX_BUDDY_TOOL_ROUNDS` backstop. Set it for PAID/cloud models so a
   * long task doesn't silently burn many API calls before checking in; leave it unset for local/free
   * models, which run to the backstop. The turn returns `paused: true` with a resumable progress
   * summary; the reader continues (a Continue button / "continue") and the next turn re-arms the budget.
   */
  pauseEvery?: number;
  /** This turn is a "story as you go" beat (the system prompt is in STORY MODE). It makes the
   * empty/tool-only wrap-up ask for the next BEAT (prose) instead of a "what I did" meta line, so a
   * recovered reply is still a usable beat the host can append to the book. */
  storyMode?: boolean;
  /**
   * This is an UNATTENDED creative run. Only {@link CREATIVE_IDLE_TOOLS} may execute; anything else is
   * refused here, in the loop, before it reaches a dep or the host.
   *
   * Enforced at the executor rather than by leaving tools out of the prompt, because those are
   * different guarantees: a prompt that omits a tool is a suggestion, and this turn runs with nobody
   * watching. The refusal is fed back as a tool result so the model adapts rather than stalling.
   */
  creativeIdle?: boolean;
  /**
   * LIVE CONTROL: this turn is driving the reader's machine and should keep working until the job is
   * done, rather than answering and stopping.
   *
   * A mode, not a nudge — like {@link creativeIdle}, it changes what the LOOP does, because a rule
   * that only lives in the prompt is a rule a small model drops three rounds in. It raises the round
   * backstop, ignores the cloud "keep going?" pause, and arms the stuck-on-repeat detector. What
   * stops a live run is the reader (a new message or Stop, both of which abort the signal), the job
   * finishing (a plain-text reply, as always), the repeat detector, or the backstop.
   *
   * The host must also supply {@link runHostTool}, or every command would still suspend for an
   * approval click and "continuous" would be a fiction.
   */
  liveControl?: boolean;
}): Promise<BuddyTurnOutcome> {
  const messages: ChatTurn[] = [{ role: "system", content: opts.system }, ...opts.history];
  const transcript: ChatTurn[] = [];
  const toolResults: BuddyTurnOutcome["toolResults"] = [];
  /**
   * HOW MUCH OF `toolResults` BELONGS TO THE STEP BEING JUDGED.
   *
   * `toolResults` is the TURN's record and is only ever appended to — it has to be, it is what the
   * turn returns. The checklist tick was handed the whole of it on every step, so step 2's "an image
   * rendered" contract was satisfied by step 1's picture and a three-image checklist could tick three
   * steps off one render. The host's own executor resets its evidence on every advance; this is the
   * same rule for the in-turn path, expressed as a watermark so the turn's record stays whole.
   */
  let stepEvidenceFrom = 0;
  let lastThinking = ""; // the latest round's reasoning, persisted onto the settled message
  let wrappedUp = false; // guard: only re-prompt for a plain-text wrap-up once
  // Guard: say "you ran out of room thinking" once per turn. A model that does it twice is not going
  // to be talked out of it, and each attempt costs another full generation.
  let ranOutThinking = false;
  // How many times this turn the model has been told its call was in its reasoning. Bounded because
  // a model that keeps doing it is not going to be talked out of it, and the wrap-up below is a
  // better ending than an unbounded loop of the same correction.
  let thoughtOnlyNudges = 0;
  let lastTruncated = false; // did the last reply get CUT OFF at the token budget? (→ auto-continue)
  // Per-turn tool-round budget: a small "keep going?" interval for cloud models, else the big backstop.
  //
  // LIVE CONTROL overrides both, deliberately. The mode exists to work continuously until the job is
  // done, and a "keep going?" checkpoint every few rounds is precisely the interruption the reader
  // turned it on to avoid — so `pauseEvery` is ignored here and the backstop is the much larger
  // MAX_LIVE_CONTROL_ROUNDS. On a paid model that means a long run costs real money without asking:
  // the toggle IS the consent, which is why it is a toggle rather than a default.
  //
  // WHAT THIS BOUND ACTUALLY COVERS, since it is easy to read it as more than it is: a HOST tool
  // (control_ui, screenshot, run_command) ENDS its turn — the host runs it and dispatches a fresh
  // one with the result. So the live loop is a chain of short turns, and the count below only ever
  // sees the tools that run in-worker (a search, a calculation). The budget for the live loop itself
  // is kept by the host, across that chain, in `liveRun`.
  const effectiveMax = opts.liveControl
    ? MAX_LIVE_CONTROL_ROUNDS
    : opts.pauseEvery && opts.pauseEvery > 0
      ? Math.min(opts.pauseEvery, MAX_BUDDY_TOOL_ROUNDS)
      : MAX_BUDDY_TOOL_ROUNDS;
  /** Fingerprints of each round's calls — the stuck-on-repeat detector's only state. */
  const roundSignatures: string[] = [];
  let pausedForBudget = false; // hit the budget with tools still pending → a resumable checkpoint, not a finish
  /** A keep_going has already carried a message this turn — so a series is running. */
  let keptGoingThisTurn = false;
  /** Each message a keep_going has carried this turn, in order — the series' position, which nothing
   * else in a plan-free run keeps. Feeds seriesProgressNote. */
  const sentThisTurn: string[] = [];
  /** The stall check has already spent its question on the current stall. Cleared by each keep_going. */
  let askedIfDone = false;
  /** A series message held back by the stall check — published once the turn settles, or handed to the
   * transcript if the series carries on. Never both, and never neither. */
  let stalledProse = "";
  // Anti-skip guard (turn-scoped): true right after a complete_step, cleared by any real work (a tool /
  // render). A second complete_step while it's still true is the model "jumping ahead" — ticking a step
  // it never did (e.g. checking off image 2's step without generating image 2) — and is refused.
  let lastWasCompleteStep = false;
  /** The prose of the round that bought the last check-off — what "new writing" is measured against. */
  let proseAtLastTick = "";
  /** Toolsets loaded so far THIS turn — grows as the model asks (or as it calls something it hasn't
   * asked for). The host seeds it with what the session already loaded, so a coding conversation pays
   * for the coding document once rather than every turn. */
  let loadedToolsets: readonly string[] = opts.loadedToolsets ?? [];
  /** Whether on-demand loading is in play at all. Absent `loadedToolsets` means the host hasn't opted
   * in, and every tool stays callable — the legacy behaviour, and what sub-agents and tests rely on. */
  const deferring = opts.loadedToolsets !== undefined;

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
    // Re-bound before every call: the loop below appends tool results, and a single large
    // one can exceed the whole window. Pins the system prompt and the request that started
    // the turn, which is what a plain drop-oldest policy would delete first.
    const sent = opts.contextChars
      ? trimTurnMessages(messages, opts.history.length, opts.contextChars)
      : messages;
    const settled = opts.llm.chat(sent, {
      /**
       * REASONING IS CAPTURED WHETHER OR NOT ANYONE IS WATCHING.
       *
       * This used to sit inside the `opts.onEvent` gate beside `onToken`, which conflated recording
       * with displaying. `lastThinking` is not a display concern: it feeds the settled message's
       * `thinking`, the round recap, and the reasoning-only recovery below — so a caller that passed
       * no `onEvent` silently got none of them, and the recovery in particular would have been dead
       * code for the sub-agent and delegate turns.
       *
       * Safe to always pass: providers branch on `onToken` to choose streaming over buffered, and
       * none of them branches on `onThinking`. `noteContent` only feeds the heartbeat, which is
       * itself gated on `onEvent`, so calling it here without a subscriber is a no-op.
       */
      onThinking: (text: string) => {
        noteContent();
        lastThinking = text;
        opts.onEvent?.({ kind: "thinking", text });
      },
      ...(opts.onEvent
        ? {
            onToken: jsonGatedTokenSink((text) => {
              noteContent();
              opts.onEvent?.({ kind: "token", text });
            }),
          }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.cachePrefix ? { cachePrefix: opts.cachePrefix } : {}),
      /**
       * ONE VALUE FOR THE TURN, AND IT HAS TO STAY THAT WAY ON THIS PROVIDER.
       *
       * A per-round budget was tried here: a round executing an already-decided series has nothing
       * left to decide, so it was sent `reasoningEffort: "none"`. The idea was sound and the
       * mechanism is not available. "none" reaches Ollama as `think: false`, and a thinking model
       * told not to think does not stop reasoning — it stops EMITTING <think> tags. `stripThink`
       * then finds nothing to strip and the monologue lands in the chat as an ordinary message:
       * "The user is asking me to continue, but I've already completed the task... I don't need
       * another keep_going." That is a reply the reader read.
       *
       * `ollamaThink` is binary besides — there is no "low" — so on a local model this knob offers
       * exactly two settings: think, or think in public. Neither is a smaller budget. Anything that
       * wants to cut deliberation here has to do it some other way.
       */
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      // Native tool schemas: a tool-capable local model emits structured tool_calls (the provider
      // serializes them back into the text protocol). Cloud providers ignore this field.
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      // Force a parseable tool call this turn when the step's contract requires one (provider gates it
      // to the Ollama path; it suppresses `tools` there since the two can't both apply).
      ...(((): { toolFormat?: Record<string, unknown> } => {
        const f = typeof opts.toolFormat === "function" ? opts.toolFormat() : opts.toolFormat;
        return f ? { toolFormat: f } : {};
      })()),
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
    // THIS round's reasoning, not whatever was left over. `lastThinking` is outer-scoped (it also
    // feeds the settled message), so a round that reasons silently would otherwise hand the previous
    // round's thoughts back as if they were about the call just made — stale intent attached to
    // fresh results, which is worse than none.
    const thinkingBefore = lastThinking;
    const reply = await chatOnce();
    const roundThinking = lastThinking === thinkingBefore ? "" : lastThinking;
    const calls = round < effectiveMax ? parseBuddyToolCalls(reply) : [];
    // Every finished outcome funnels through here, so it is also where the turn reports which
    // toolsets ended up loaded — the host keeps them for the session rather than re-paying next turn.
    const withThinking = (out: BuddyTurnOutcome): BuddyTurnOutcome => ({
      ...out,
      ...(deferring ? { loadedToolsets } : {}),
      ...(lastThinking.trim() ? { thinking: lastThinking.trim() } : {}),
    });
    if (calls.length === 0) {
      // Hit the per-turn budget with the model STILL trying to call a tool → this is a "keep going?"
      // checkpoint (cloud pause / backstop), not a natural finish. Flag it so the host offers Continue.
      if (round >= effectiveMax && looksLikeToolJson(reply)) pausedForBudget = true;
      // A reply that LOOKED like tool JSON but didn't parse into any known call must NOT be
      // dumped to the reader as prose (that's the raw-JSON-in-chat bug). Nudge the model to
      // re-issue it properly; otherwise it's a normal plain-text answer.
      if (round < effectiveMax && looksLikeToolJson(reply)) {
        // Keep the malformed attempt + the re-issue nudge in the MODEL's context ONLY — pushing
        // them to `transcript` persists them as chat history, which leaked the internal directive
        // into the conversation as a "user" message.
        messages.push({ role: "assistant", content: reply });
        // G8: a tool call that LOOKED valid but was cut off at the length limit (its content/args
        // argument ran past the token budget) won't parse — and re-issuing the SAME giant call just
        // truncates again. Steer to chunked writes instead of retrying the oversized argument.
        const nudge = lastTruncated
          ? "[That tool call was cut off at the length limit — its argument was too long to finish. " +
            "Do NOT resend the whole thing. Instead write the file in chunks: a first write_file with " +
            "the opening portion, then write_file(..., append:true) for each further chunk, or edit_file " +
            "with a small search/replace to change just one part.]"
          : "[That looked like a tool call but wasn't something I could run. Re-issue each tool call " +
            "as its own JSON object (one per line, no prose around them), or just answer in plain text.]";
        messages.push({ role: "user", content: nudge });
        continue;
      }
      let clean = stripToolCallJson(reply).trim();
      /**
       * THE CALL WAS IN THE REASONING. SAY SO, BEFORE FORBIDDING TOOL CALLS.
       *
       * Reported from real use: "it seemed to over and over again try to call the first tool of a
       * multi-step plan with no luck. then when the initial thinking ended, the second attempt worked
       * fairly quickly." That is this branch's neighbour doing damage. A reply that is entirely
       * reasoning comes back EMPTY — the provider strips thinking — so `clean` is empty, and the
       * wrap-up below reads that as "produced nothing" and answers with "reply in plain text. No tool
       * calls." The model was mid-way through acting and has just been told not to.
       *
       * Neither side can see what happened. The model's reasoning is in front of it, so a call it
       * wrote there is indistinguishable from one it made, and no result reads as a failed call — so
       * it writes it again, inside the same think. The turn then ends having done nothing, and the
       * next one works immediately because it starts from prose rather than from thought.
       *
       * Scoped deliberately to an EMPTY reply. A model that reasons about a tool and then answers in
       * prose has decided against it, and nudging there would force a call nobody asked for. Empty
       * plus a call in the reasoning is the unambiguous case: it meant to act, and nothing happened.
       */
      if (!calls.length && thoughtOnlyNudges < MAX_THOUGHT_ONLY_NUDGES && round < effectiveMax) {
        const inThought = !clean ? toolCallsInThinking(roundThinking) : [];
        /**
         * THE SECOND SHAPE: THE CALL WAS NEVER WRITTEN DOWN AT ALL.
         *
         * Above, the model wrote a real tool call into its reasoning and the reply came back empty.
         * Here it wrote the INTENT in English — "I need to call send_message 26 times (for A through
         * Z) in this turn" — and then emitted the letter as ordinary content. There is no JSON to
         * find, and prose is what ends a turn, so the reader got one letter and had to ask again.
         *
         * Only send_message qualifies. It is the one tool whose whole job is to deliver text the
         * model has already written, which is what makes prose a mistake here rather than a decision:
         * for any other tool, reasoning about it and then answering IS the decision not to call it.
         */
        const wroteItInstead = clean.length > 0 && meantToSendMessage(roundThinking);
        if (inThought.length > 0 || wroteItInstead) {
          thoughtOnlyNudges += 1;
          opts.onEvent?.({ kind: "activity", text: "Picking that back up…" });
          messages.push({ role: "assistant", content: reply });
          messages.push({
            role: "user",
            content: wroteItInstead
              ? "[That text became your ANSWER, which ends the turn — it was not sent as one of the " +
                'series. To send it as its own message and stay in the turn, call {"tool":"send_message",' +
                '"text":"…"} with it. Send the one you just wrote, then carry on.]'
              : `[Your ${inThought[0]!.tool} call was inside your reasoning. Nothing runs there — only ` +
                "your REPLY is executed, which is why no result came back. Send that same call again as " +
                "the reply itself: the JSON object on its own, outside your thinking.]",
          });
          continue;
        }
      }
      /**
       * IT SPENT THE WHOLE BUDGET THINKING AND NOTHING CAME OUT.
       *
       * Reported as: the model reasons, looks ready to commit, then says "wait" or "one small check",
       * and never finishes. Nothing is holding it in the loop — but nothing catches it falling out of
       * one either, and the app already knows exactly what happened.
       *
       * Thinking tokens count against the same generation budget as the reply. Ruminate long enough
       * and the provider stops at the cap with `done_reason: "length"`, the thinking is stripped, and
       * what returns is an EMPTY string. Two facts, both already tracked: `lastTruncated` is true and
       * `clean` is empty. Together they can only mean one thing.
       *
       * The auto-continue below cannot help, and says so in its own comment — it is gated on
       * MIN_CONTINUABLE_CHARS precisely to avoid asking a model to continue an answer it never
       * started, noting that when there is nothing there "the budget went somewhere else". This is
       * where it went. So the case was diagnosed and then deliberately left unhandled, and the turn
       * fell through to `nonEmptyAnswer`, which hands the reader "I didn't catch that — could you
       * rephrase?" after a minute of reasoning.
       *
       * The prompt does carry WHEN YOU ALREADY KNOW, ACT. That is read once, at the top, competing
       * with every other rule; this arrives at the moment it happens, about the reply just made.
       *
       * Cannot ask for less thinking, only for an answer: on this provider `reasoningEffort: "none"`
       * becomes `think: false`, and a thinking model told not to think reasons in plain content
       * instead — the monologue then lands in the chat as the reader's answer. Words are the only
       * lever here.
       */
      if (lastTruncated && !clean && !calls.length && !ranOutThinking && round < effectiveMax) {
        ranOutThinking = true;
        opts.onEvent?.({ kind: "activity", text: "Wrapping that up…" });
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "user",
          content:
            "[That reply hit its length limit while you were still thinking, so nothing came out at " +
            "all. You have already worked this out — give the answer now, in the reply itself and " +
            "briefly. If it needs a tool, make the call. Do not re-check anything.]",
        });
        continue;
      }
      // The model ended on a tool/blank with NO prose. Ask once for a plain-text wrap-up so the
      // reader never gets an empty bubble; if it's still empty, fall back to a short line.
      if (!clean && !wrappedUp) {
        wrappedUp = true;
        // Context-ONLY (never the persisted transcript): the empty/tool reply + this wrap directive
        // are internal control flow — persisting them leaked "[Now reply to the reader in plain
        // text…]" into the chat as a user message.
        messages.push({ role: "assistant", content: reply });
        /**
         * "NO TOOL CALLS" MEANT keep_going TOO, AND THAT KILLED IT.
         *
         * This directive fires whenever a reply carries no visible prose — which for a reasoning
         * model is routine, since its first pass can be all thinking. The reader's own transcript
         * caught the consequence in the model's words: "Since I am explicitly told 'No tool calls',
         * this instruction about keep_going is overridden for *this* turn. I must stop after
         * sending 'A'."
         *
         * It was reasoning correctly. The clause is here to stop the model reaching for ANOTHER
         * tool instead of answering, and keep_going is not that — it runs nothing, it only says the
         * turn is not finished. So it is named as the exception rather than left to be inferred.
         */
        const wrap = opts.storyMode
          ? "[Now write the next beat of the story as plain prose — continue the scene a little, refer to " +
            "characters by their established names, no commentary and no tool calls.]"
          : // NAMES BOTH WAYS OUT, like the series receipt does, and for the same reason.
            //
            // It used to read "No tool calls — except send_message, which you should still call if you
            // have more messages to send." That carve-out was inherited from keep_going, where a
            // blanket "no tool calls" had once killed a series outright. But this directive fires when
            // the model has ALREADY stopped calling — so naming the tool here is the app asking a
            // finished run to start again. Counting to -100, the model read it back and did exactly
            // that: "the specific constraint 'except send_message' allows me to break out of the
            // 'plain text only' rule for this task."
            //
            // The case the carve-out protected is covered now by the two recoveries above, which fire
            // first and handle a model whose work never reached the wire.
            "[Now reply to the reader in plain text — briefly say what you did or found. If the task " +
            "genuinely still has items left, carry on instead; otherwise this is the wrap-up.]";
        messages.push({ role: "user", content: wrap });
        continue;
      }
      /**
       * A CHECKLIST KEEPS THE TURN. THIS IS THE CHANGE THAT STOPS 26 LETTERS BEING 26 TURNS.
       *
       * App-managed steps ran one step per TURN: the host judged the settled turn, then dispatched a
       * fresh one whose opening user message was "Now do ONLY step 2 of 26 … Call its tool and stop".
       * Two things went wrong with that, and the reader saw both.
       *
       * A turn-opening directive with a timestamp is indistinguishable from the reader speaking. The
       * model said so: "The user's prompt in this specific turn [2026-08-13 13:16:43.860] is the
       * system telling me to do step 1" — it was spending its reasoning working out who was talking.
       * And "call its tool and stop" is an instruction to END THE TURN, handed to a step whose whole
       * deliverable is the letter A. There is no tool. So it wrote text, stopped, and waited.
       *
       * A step that needs nothing from the host has no reason to be its own turn. A host tool is
       * different and still suspends — the host genuinely has to run a render — but text does not.
       *
       * So when a round produces no tool call and a checklist still has work, the host judges the
       * step from what it observed and hands back the next directive, and the ROUND LOOP carries on.
       * The judging is unchanged (`evaluateStep` on observed evidence, never the model's claim); what
       * changes is that its answer arrives as this turn's next round instead of the next turn's
       * opening line.
       *
       * The turn still ends for every reason it should: the plan finishes, a step needs the reader,
       * a host tool suspends, or the round budget runs out — which on a cloud model is the "keep
       * going?" checkpoint, and is why this cannot run away unattended.
       */
      if (opts.appManagedTick && round < effectiveMax) {
        const next = opts.appManagedTick({ toolResults: toolResults.slice(stepEvidenceFrom), text: clean });
        if (next.kind === "continue") {
          // The step's work is this round's prose, and it is a message in its own right. Nothing
          // else flushes it: the host flushes streamed prose when a TOOL CALL follows it, and a text
          // step has none — the same reason the last letter of a series went missing once already.
          opts.onEvent?.({ kind: "stepDone", text: clean });
          transcript.push({ role: "assistant", content: clean });
          messages.push({ role: "assistant", content: reply });
          messages.push({ role: "user", content: next.directive });
          // Whatever satisfied THIS step is spent. A nudge is not an advance and keeps the window
          // open, so a model that narrated and is being asked again still gets credit for work it
          // already did — `next.kind` alone cannot tell the two apart, but the plan's position can.
          if (next.advanced) stepEvidenceFrom = toolResults.length;
          stalledProse = "";
          continue;
        }
      }
      /**
       * A SERIES THAT STALLS LOOKS EXACTLY LIKE A SERIES THAT FINISHED.
       *
       * Without a checklist, a run of messages survives only as long as the model attaches
       * keep_going to EVERY reply — twenty-six consecutive correct emissions for the alphabet, where
       * a single miss ends the turn and there is no way back into it. Nothing distinguishes "F, and
       * I forgot to ask for another round" from "F, and F was the last one", so the turn cannot tell
       * which it got and has been taking the second reading.
       *
       * So it asks, once per stall. This cannot fire on ordinary chat: it requires a keep_going to
       * have already carried a message THIS turn, which a normal answer never does.
       *
       * THE QUESTION MUST NOT EAT THE MESSAGE THAT PROMPTED IT. Reported as: "it never outputs Z
       * though it thinks it does" — and it had. Each message of a series becomes its own bubble only
       * because the host flushes streamed prose when a TOOL CALL follows it, and the last message of
       * a series has no keep_going after it by definition. So the final one arrives as the turn's
       * answer, this check swallowed it, and what the reader got instead was the model's reply to a
       * question they never saw: "yes, that's the whole alphabet". The model was right and the letter
       * was real; it just never reached the screen.
       *
       * So the prose is HELD, not published, and it is not put in the transcript here either — it
       * goes in exactly once, either merged into the answer below or flushed when the series resumes.
       */
      if (clean && keptGoingThisTurn && !askedIfDone && round < effectiveMax) {
        askedIfDone = true;
        stalledProse = clean;
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "user",
          content:
            "[Was that the last one? If you have more to send, send the NEXT one now with " +
            '{"tool":"keep_going"} in the same reply — nothing continues on its own. If you are ' +
            "finished, say so in one short line.]",
        });
        continue;
      }
      // The turn is settling and a message is still being held from the stall check above. It is the
      // reader's last real message of the series, so it leads. A bare "yes, that was the last one" is
      // an answer to a question they never saw and is dropped; anything else the model added is kept
      // after it, so no path can lose text.
      if (stalledProse) {
        clean = !clean || isStallConfirmation(clean) ? stalledProse : `${stalledProse}\n\n${clean}`;
        stalledProse = "";
      }
      // AUTO-CONTINUE: the server CUT THE ANSWER OFF at the token budget. Keep asking it to pick up
      // where it left off and stitch the parts, so a big document (a full worksheet, a long file)
      // isn't capped at one reply — the reader sees each part stream in with a "part N" status.
      let rawSoFar = reply;
      // A budget spent on REASONING is not an answer cut off mid-sentence — see
      // MIN_CONTINUABLE_CHARS. Entering the loop on a one-character reply asks the model to continue
      // something that was never started, and every pass pushes its own reply and the directive back
      // into the context: eight rounds of that is how a two-message chat reached 100% of the window.
      const worthContinuing = clean.length >= MIN_CONTINUABLE_CHARS;
      for (let part = 0; worthContinuing && lastTruncated && part < MAX_REPLY_CONTINUATIONS; part++) {
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
        // A pass that adds nothing will not add anything next time either, and each one costs a
        // model call and two more messages of context. The old loop ran all eight regardless.
        if (!more) break;
        clean = clean ? `${clean}\n${more}` : more;
      }
      // If we stopped only because of the per-turn safety cap (still truncated), say so plainly so a
      // genuinely huge document is never SILENTLY cut — the reader can just ask for the rest.
      // Only when a LONG answer really was cut short. A short reply that merely exhausted the budget
      // thinking is complete as far as the reader is concerned, and telling them it was paused
      // mid-thought would be inviting them to ask for a continuation that does not exist.
      if (lastTruncated && worthContinuing) {
        clean += '\n\n_(This is running very long — I paused here. Say "continue" and I\'ll pick up exactly where I left off.)_';
      }
      /**
       * ONE REPLY, SEVERAL MESSAGES — the marker path, and the cheapest way to run a series.
       *
       * A recitation does not need twenty-six rounds of tool calls to become twenty-six bubbles. The
       * model writes it once with `[[next]]` between the items and the split happens here, at the
       * point where an answer becomes chat. Every failure this migration chased lived in one of those
       * rounds, and this has none of them: no position to track, no result to misread, nothing to
       * forget to call.
       *
       * All but the LAST part are published through the same event a send_message uses, so the host
       * needs no new plumbing; the last stays the turn's answer and takes the ordinary path, which is
       * what keeps the thinking, the truncation notice and the empty-answer net attached to it.
       *
       * Self-gating: this only fires because the model emitted the marker. Nothing here reads the
       * reader's wording to decide whether a series was wanted — that guess is what once turned
       * "count from 15 to 25" into twenty-five messages.
       */
      const parts = splitSeriesMessages(clean);
      for (const part of parts.slice(0, -1)) {
        opts.onEvent?.({ kind: "stepDone", text: part });
        transcript.push({ role: "assistant", content: part });
      }
      clean = parts[parts.length - 1]!;
      transcript.push({ role: "assistant", content: clean });
      // Safety net: never hand the reader stray tool-call JSON or an empty string.
      return withThinking({
        text: nonEmptyAnswer(clean, toolResults.length > 0),
        transcript,
        toolResults,
        ...(pausedForBudget ? { paused: true } : {}),
      });
    }
    transcript.push({ role: "assistant", content: reply });
    messages.push({ role: "assistant", content: reply });

    // STUCK ON REPEAT, in-turn half. Nobody is watching a live run step by step, so the failure that
    // matters isn't a crash — it's the model repeating an action that changes nothing until the
    // backstop. Rounds that merely look alike are fine; it takes LIVE_REPEAT_LIMIT byte-identical ones.
    //
    // This catches the IN-WORKER tools only (see the note on effectiveMax: a host tool ends its turn,
    // so the clicking loop is never visible from in here). The host runs the same two pure helpers
    // over its own chain, which is where a repeated CLICK is caught. Both, because the failure is the
    // same shape on either side of the boundary and neither one sees the other's calls.
    //
    // It ends the turn with an ANSWER rather than an error, because the reader's question is "what
    // happened?" and "I repeated the same thing five times and it didn't change anything" answers it.
    if (opts.liveControl) {
      roundSignatures.push(roundSignature(calls));
      if (stuckOnRepeat(roundSignatures)) {
        const last = calls[0];
        return withThinking({
          text:
            `I stopped — I've repeated the same action ${LIVE_REPEAT_LIMIT} times without anything changing` +
            `${last ? ` (${describeBuddyToolActivity(last).replace(/…$/, "")})` : ""}. ` +
            "Something isn't responding the way I expect. Tell me what you see and I'll try a different way.",
          transcript,
          toolResults,
        });
      }
    }

    // Run every tool the model batched this round, in order. A host/UI tool (needs approval or a
    // main-thread run) stops the batch: if it's first, hand it up as a pendingTool (as before);
    // if auto-run tools already ran this round, defer it so their results aren't lost — the model
    // re-issues it next round.
    const feedbacks: string[] = [];
    let deferred = false;
    /**
     * WRITING IS WORK, WHEN WRITING IS THE STEP — AND IT IS NEW WRITING THAT COUNTS, NOT LONG.
     *
     * The anti-skip guard below clears on a tool result and on nothing else, because it was built
     * for a checklist of renders: "do the step's action FIRST (e.g. actually call generate_image)".
     * That assumption holds for every step whose deliverable is an artifact and fails completely for
     * one whose deliverable is prose. A checklist like "explain the rigging, then the squall, then
     * the lantern" does its entire job in assistant text — so the first step ticks, the second is
     * refused as "checked off too fast", and the run stalls with the work visibly done on screen.
     *
     * The first version of this asked for 80 characters, on the theory that a real answer is longer
     * than a hand-off ("Done.", "Now step 3."). It is, usually — and it fails completely on
     * "send me the alphabet, one letter per message", where the entire deliverable of a step is the
     * character A. Length was a proxy for the thing that actually matters, and a bad one.
     *
     * So the test is what it was always trying to approximate: prose counts if it is NEW and is not
     * a bare hand-off. Novelty catches the repeat — two check-offs inside a single reply see
     * identical prose by construction, so the round remains the unit — and the acknowledgement test
     * catches the model that writes a real answer, ticks, then says "Done." and ticks again, which
     * novelty alone would let through. "A" is neither a repeat nor an acknowledgement.
     */
    const roundProse = stripToolCallJson(reply).trim();
    if (roundProse && roundProse !== proseAtLastTick && !isBareAcknowledgement(roundProse)) {
      lastWasCompleteStep = false;
    }
    for (const call of calls) {
      // THE CREATIVE-RUN GATE. Before any dispatch branch, so nothing — sub-agents, host tools, the
      // auto-run executor — can route around it. Nobody is watching this turn, so the limit is
      // enforced here rather than trusted to the prompt.
      if (opts.creativeIdle && !allowedInCreativeIdle(call)) {
        const result: BuddyToolResultPayload = {
          error:
            // A STATEMENT OF WHAT IS TRUE, plus what IS open. The old wording ended "don't try to
            // work around it", which is an instruction rather than a fact — and it gave the model
            // the frame it then reasoned in ("maybe I have direct access without needing to load a
            // toolset first"). Naming the alternatives is what actually stops the workaround.
            `${call.tool} isn't available while you're exploring on your own — these runs are limited to ` +
            "looking things up and writing them up. What is open: searching the web, books and images, " +
            "reading pages, calculating, load_toolset, create_document / edit_document / read_document, " +
            "and remembering what you found.",
        };
        toolResults.push({ call, result });
        opts.onEvent?.({ kind: "toolResult", round, call, result });
        feedbacks.push(formatBuddyToolResult(call, result, { readFileChars: readFileWindow(opts.contextChars) }));
        continue;
      }
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
        feedbacks.push(formatBuddyToolResult(call, result, { readFileChars: readFileWindow(opts.contextChars) }));
        lastWasCompleteStep = false; // real work happened
        continue;
      }
      // ON-DEMAND TOOL DOCUMENTATION. Two entries to the same door:
      //
      //   load_toolset  — the model asked for the details, having read the index.
      //   anything else — the model called a tool whose details it never loaded. It gets the SAME
      //                   document back instead of an error, and re-issues its call. Forgetting to
      //                   load is therefore a round-trip, never a wrong action with invented
      //                   arguments — which is the failure every "look it up first" scheme depends on
      //                   the model not having, and small models reliably do.
      if (call.tool === "load_toolset" || (deferring && !isToolAvailable(call.tool, loadedToolsets))) {
        const id = call.tool === "load_toolset" ? call.name : toolsetForTool(call.tool)?.id;
        const already = id ? loadedToolsets.includes(id) : false;
        if (id && !already) loadedToolsets = [...loadedToolsets, id];
        const doc = id && opts.toolsetDoc ? opts.toolsetDoc(id) : "";
        const known = id ? TOOLSET_IDS.includes(id) : false;
        const result: BuddyToolResultPayload = doc
          ? {
              toolsetLoaded: {
                id: id!,
                doc,
                ...(call.tool === "load_toolset" ? {} : { retry: call.tool as string }),
              },
            }
          : {
              error: known
                ? `the "${id}" tools aren't available on this device.`
                : `there's no toolset called "${id ?? call.tool}" — the groups are: ${TOOLSET_IDS.join(", ")}.`,
            };
        toolResults.push({ call, result });
        opts.onEvent?.({ kind: "toolResult", round, call, result });
        feedbacks.push(formatBuddyToolResult(call, result, { readFileChars: readFileWindow(opts.contextChars) }));
        continue;
      }
      // Sweep a whole document. Handled HERE rather than in the auto-run executor because it needs
      // what only the turn has: the model itself. The loop is code-driven — the document is read in
      // chunks the model never has to hold, and only the findings come back. See document-extraction.
      if (call.tool === "extract_from_document") {
        opts.onEvent?.({ kind: "tool", round, call });
        const result = await runDocumentExtraction(call, opts, (done, total) =>
          opts.onEvent?.({ kind: "activity", text: `Reading section ${done} of ${total}…` }),
        );
        toolResults.push({ call, result });
        opts.onEvent?.({ kind: "toolResult", round, call, result });
        feedbacks.push(formatBuddyToolResult(call, result, { readFileChars: readFileWindow(opts.contextChars) }));
        lastWasCompleteStep = false; // real work happened
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
          feedbacks.push(formatBuddyToolResult(call, result, { readFileChars: readFileWindow(opts.contextChars) }));
          lastWasCompleteStep = false; // a render/command is real work — the next check-off is earned
          continue;
        }
        if (feedbacks.length === 0) {
          opts.onEvent?.({ kind: "tool", round, call });
          return withThinking({ text: "", transcript, pendingTool: call, toolResults });
        }
        deferred = true;
        break;
      }
      /**
       * ONE MESSAGE OF A SERIES. Handled here rather than in the dispatch table because it publishes
       * to the reader and touches the turn's own record of what it has sent — neither of which
       * `runBuddyTool` can reach.
       *
       * Note what does NOT happen here: `keptGoingThisTurn` is not set, so the stall check below
       * never fires for a series driven this way. That is the point of the change rather than an
       * oversight. The stall check exists because a `keep_going` series could not tell "I forgot to
       * ask for another round" from "that was the last one" — with the message and the continuation
       * being one act, a round with no call means the model is finished, which is what every
       * published harness takes it to mean.
       */
      if (call.tool === "send_message") {
        opts.onEvent?.({ kind: "tool", round, call });
        const text = call.text.trim();
        /**
         * SPLIT THE ARGUMENT TOO. A model that reaches for this tool AND writes markers inside it
         * published a bubble reading, literally, "[[next]] 49 [[next]] 50" — the marker on screen as
         * text, which is the one thing it must never be. Every path that puts text in front of the
         * reader resolves markers now, so no combination of the two can leak one.
         */
        const items = splitSeriesMessages(text);
        for (const item of items) {
          opts.onEvent?.({ kind: "stepDone", text: item });
          transcript.push({ role: "assistant", content: item });
          sentThisTurn.push(item);
        }
        const result: BuddyToolResultPayload = { sent: true };
        toolResults.push({ call, result });
        opts.onEvent?.({ kind: "toolResult", round, call, result });
        // The position rides back as this call's RESULT. Same note as the old series echo, but it is
        // now an answer to something the model asked for rather than app prose arriving in the
        // reader's voice, which is the half that was being disbelieved.
        feedbacks.push(seriesProgressNote(sentThisTurn));
        continue;
      }
      /**
       * "I HAVE MORE TO SEND." — the retired predecessor of `send_message`, kept only so a model that
       * emits it is understood rather than refused.
       *
       * It is no longer documented anywhere in the prompt or the native schemas. A tool that does
       * nothing made every message a two-part act (write the prose, then remember the token), and one
       * miss in twenty-six ended the task silently. Honouring it costs nothing and is strictly better
       * than erroring at a model that learned the old shape earlier in the same conversation.
       */
      if (call.tool === "keep_going") {
        opts.onEvent?.({ kind: "tool", round, call });
        if (roundProse) {
          // A series is running. Both flags feed the stall check in the no-calls branch — and
          // clearing askedIfDone here is what gives EVERY later stall its own nudge, rather than
          // spending the only one on the first stall of a twenty-six message run.
          keptGoingThisTurn = true;
          askedIfDone = false;
          sentThisTurn.push(roundProse);
          // The series answered the stall question by carrying on, so the message it was asked about
          // is a real message of the run rather than the end of it. It goes into the transcript now
          // — the one place it lands on this path, since the merge below only runs when a turn ends.
          if (stalledProse) {
            transcript.push({ role: "assistant", content: stalledProse });
            stalledProse = "";
          }
        }
        const result: BuddyToolResultPayload = roundProse
          ? { keptGoing: true }
          : { error: "nothing was sent — write the message FIRST, then keep_going in the same reply" };
        toolResults.push({ call, result });
        opts.onEvent?.({ kind: "toolResult", round, call, result });
        // The one place "[go on]" is worth more than three words: it is the only thing a plain series
        // ever gets told about where it is. A refused keep_going keeps the terse error — nothing was
        // sent, so there is no position to report.
        feedbacks.push(
          result.keptGoing
            ? seriesProgressNote(sentThisTurn)
            : formatBuddyToolResult(call, result, { readFileChars: readFileWindow(opts.contextChars) }),
        );
        continue;
      }
      // Anti-skip: a complete_step right after another check-off, with no real work in between, is the
      // model jumping ahead — ticking a step it never did. Refuse it (the step stays unfinished) and tell
      // it to do that step's action first. The FIRST check-off of a turn is always fine (the work was the
      // render that ended the previous turn); only back-to-back ticks are blocked.
      if (call.tool === "complete_step" && lastWasCompleteStep) {
        opts.onEvent?.({ kind: "tool", round, call });
        const result: BuddyToolResultPayload = { error: "checked off too fast — do this step's work first" };
        toolResults.push({ call, result });
        opts.onEvent?.({ kind: "toolResult", round, call, result });
        feedbacks.push(
          "[complete_step IGNORED — you just checked off a step with no work in between. Do the ▸ current " +
            "step's action FIRST, THEN check it off: call the tool it needs (e.g. generate_image, and let " +
            "its image render), or — if the step's whole job is to explain or describe something — WRITE " +
            "that answer out in full. Exactly one step's work per check-off; never tick two in a row.]",
        );
        continue; // leave lastWasCompleteStep true — a 3rd tick in a row is refused too
      }
      opts.onEvent?.({ kind: "tool", round, call });
      // Name the specific action in the status line ("Searching the web for …") so the reader sees
      // exactly what's happening while the (muted) tool runs — clarity the phone especially needs.
      opts.onEvent?.({ kind: "activity", text: describeBuddyToolActivity(call) });
      let result = await runBuddyTool(call, opts.deps);
      // One automatic retry for a transient (network/timeout/rate-limit) failure before the
      // error is shown to the model — turns a flaky blip into a silent recovery. Read-only
      // tools only (AUTO_RETRY_SAFE_TOOLS): re-running a write here could duplicate its effect.
      if (result.error && isRetryableError(result.error) && AUTO_RETRY_SAFE_TOOLS.has(call.tool)) {
        result = await runBuddyTool(call, opts.deps);
      }
      toolResults.push({ call, result });
      opts.onEvent?.({ kind: "toolResult", round, call, result });
      feedbacks.push(formatBuddyToolResult(call, result, { readFileChars: readFileWindow(opts.contextChars) }));
      // APP-MANAGED: compiling the checklist IS the whole turn.
      //
      // Left to run on, the model acts immediately on a plan the app hasn't yet given it a position
      // in — so it reaches for whichever subject it happens to be holding, which is routinely the
      // last one it wrote down rather than the first. The app can see THAT an image rendered but not
      // WHAT it depicts, so that render is unusable and gets thrown away. Stopping here is what makes
      // "now do ONLY step 1 of 3" the first thing that happens, instead of the second.
      if (opts.deps.appManagedSteps && call.tool === "set_plan" && !result.error) {
        /**
         * LEAVE THE RECORD BEHIND, OR THE NEXT TURN CANNOT TELL THE PLAN WAS EVER MADE.
         *
         * Reported from use: on the first turn after a multi-step plan, it loops inside its reasoning
         * trying the same tool call over and over, and only gets going on a later attempt.
         *
         * The model's REPLY is already in the transcript — that push happens before the dispatch loop.
         * What this return skipped is the tool RESULT, which every other call leaves behind and which
         * lands after the loop. So the step-1 turn opened on a history reading: the reader's request,
         * an assistant turn calling set_plan, and then a checklist directive arriving in the reader's
         * voice. The one thing missing was any confirmation the call had worked.
         *
         * A tool call with no result is a call that did not land — that is what the absence means
         * everywhere else in this same transcript, because everywhere else the result is there. So
         * the model has just called set_plan, seen nothing come back, and is being told about a
         * checklist. Trying the call again is a reasonable thing to do with that, and looping on it
         * is what the reader watched.
         *
         * Only the result is added here; the reply is already recorded above.
         */
        const planned = feedbacks.join("\n\n");
        if (planned.trim()) transcript.push({ role: "user", content: planned });

        return withThinking({ text: "", transcript, toolResults });
      }
      // Track for the anti-skip guard: only a successful check-off arms it; any other tool is "work".
      lastWasCompleteStep = call.tool === "complete_step" && !result.error;
      if (lastWasCompleteStep) proseAtLastTick = roundProse;
    }
    // The tool RESULTS are the durable record of what happened — they belong in the persisted
    // transcript. What gets appended after them is TURN-LOCAL steering: "re-issue the deferred host
    // tool", "write a progress line before your next call", and (on the final round) "Do NOT call
    // another tool now". Those only mean anything inside the round loop that produced them.
    //
    // Persisting them replayed a stale directive as a standing user instruction on EVERY later turn —
    // most visibly the tool-limit one, which left the model reasoning about why it had been forbidden
    // from calling tools in a conversation where no limit was in play. Context-ONLY, exactly like the
    // re-issue and wrap-up nudges above.
    const results = feedbacks.join("\n\n");
    // Whether this round was ONLY "I have more to send". Three separate decisions below turn on it,
    // and it has to be known before the steering line is built.
    const seriesOnly = calls.length > 0 && calls.every((c) => c.tool === "send_message" || c.tool === "keep_going");
    const steering =
      (deferred ? "\n\n[Re-issue the remaining host tool (image/command/plan/etc.) now if you still need it.]" : "") +
      // NOT DURING A SERIES. Every six rounds the model is asked to write a progress line before its
      // next tool call, so a long silent tool loop doesn't leave the reader watching nothing. A
      // message series is the opposite of silent — every round of it IS a message to the reader — so
      // the nudge buys nothing and costs the thing they asked for: "Just finished R, now sending S."
      // landed in the same bubble as S, which is not one letter per message.
      (seriesOnly ? "" : progressNudge(round)) +
      toolLimitNudge(round, effectiveMax);
    // The recap rides `messages` beside `steering` and NOT the transcript — context for the loop it
    // belongs to, gone when the turn settles. That split is why carrying reasoning here is safe: in
    // the transcript it would be a thought replayed on every future turn.
    /**
     * NOT ON A ROUND THAT WAS ONLY "I HAVE MORE TO SEND".
     *
     * The recap exists to reunite an intent with the FACTS that arrived after it — a search came
     * back, a file was read, and the reasoning that asked for them is gone. A keep_going round
     * returns no facts; its whole result is "[go on]". So there is nothing to reconcile, and what
     * gets pushed instead is a user-role message narrating the model's own inner monologue, once per
     * message of the series.
     *
     * Twenty-six of those and the model stops trusting the conversation. Its reasoning, sending the
     * alphabet, read back verbatim:
     *
     *   Wait, looking at the previous turn in the prompt (Turn 10/11):
     *   User: "... I need to send E next..." -> Model sent E.
     *   Is it possible that "E" was actually F?
     *   ... The simulation in Turn 12 claims history is up to F.
     *
     * It is auditing the transcript against itself, and calling it a simulation, because the
     * transcript contains what look like the READER stating what the model was thinking. The text is
     * bracketed and addressed to the model as its own, but role beats prose: these arrive as `user`.
     * The turn then spent its whole budget on forensics and returned the empty-answer fallback, so
     * the series died at F.
     */
    const recap = seriesOnly ? "" : roundThinkingRecap(roundThinking);
    if (results.trim()) transcript.push({ role: "user", content: results });
    if (results || steering || recap)
      messages.push({ role: "user", content: [recap, results].filter(Boolean).join("\n\n") + steering });
  }
}

/**
 * Read a whole document and return only what was asked for.
 *
 * Declines rather than degrades in two cases, both of which say WHY. Without a file reader it cannot
 * run at all; and for a document small enough to simply read, chunked extraction is pure overhead —
 * a slower, lossier way to reach an answer the model could have read for itself — so it says so and
 * points at `read`, instead of quietly doing the expensive thing.
 */
async function runDocumentExtraction(
  call: { path: string; question: string },
  opts: { llm: ChatCapable; deps: BuddyDeps; contextChars?: number; signal?: AbortSignal },
  onProgress: (done: number, total: number) => void,
): Promise<BuddyToolResultPayload> {
  if (!opts.deps.readFile) {
    return { error: "reading local files isn't enabled (turn on file pulling in Settings, on desktop)." };
  }
  let text: string;
  try {
    text = await opts.deps.readFile(call.path);
  } catch (err) {
    return { error: `couldn't read ${call.path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const window = readFileWindow(opts.contextChars);
  if (text.length <= Math.max(MIN_CHUNKED_DOCUMENT_CHARS, window)) {
    return {
      error:
        `${call.path} is small enough to read directly (${text.length} characters) — use ` +
        `{"tool":"read","source":"file","ref":"${call.path}"} instead. Sweeping it in sections would be slower ` +
        "and would give you findings where you could have had the text.",
    };
  }
  const state = await extractFromDocument({
    text,
    question: call.question,
    // One chunk has to leave room for the question, the already-found block and the reply.
    chunkChars: Math.max(2_000, Math.floor(window * 0.7)),
    model: {
      chat: (messages, o) => opts.llm.chat(messages, { ...(o?.maxTokens ? { maxTokens: o.maxTokens } : {}), ...(o?.signal ? { signal: o.signal } : {}) }),
    },
    onProgress,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { documentExtraction: { question: call.question, ...state, chunks: chunkDocument(text, Math.max(2_000, Math.floor(window * 0.7))).length } };
}

/** Execute one auto-run buddy tool (everything but generate_image). Exported for
 * the slash-command path, which runs tools directly without an LLM round. */
export async function runBuddyTool(
  // control_ui belongs with the HOST tools it sits beside: it reaches out of the app and onto the
  // reader's desktop (it runs a PowerShell command), so it can no more run in here than run_command can.
  call: Exclude<BuddyToolCall, { tool: "load_toolset" | "extract_from_document" | "generate_image" | "generate_video" | "generate_long_video" | "stitch_videos" | "find_files" | "run_command" | "write_file" | "edit_file" | "screenshot" | "control_ui" | "plan_task" | "prep_order" | "tv_chart" | "browser_eval" | "delegate" | "spawn_agents" | "send_email" | "delegate_coding_task" | "spawn_coding_agents" | "set_cell" | "add_formula_column" | "read_data" }>,
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
      case "open_content":
        // open_content is normalized into the open_library_book / open_web_text / open_pasted_text /
        // open_code shapes by parseBuddyToolCall, so it should never reach the executor directly.
        return { error: "couldn't open that — try again" };
      case "read":
        // read is normalized into the read_url / read_file / read_email / read_attachment shapes by
        // parseBuddyToolCall, so it should never reach the executor directly.
        return { error: "couldn't read that — try again" };
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
      case "create_document":
        if (!deps.createDocument) return { error: "creating documents isn't available right now" };
        return { document: await deps.createDocument(call) };
      case "edit_document":
        if (!deps.editDocument) return { error: "editing documents isn't available right now" };
        return {
          documentEdit: await deps.editDocument({
            ...(call.edits?.length ? { edits: call.edits } : {}),
            ...(call.setLines?.length ? { setLines: call.setLines } : {}),
          }),
        };
      case "read_document":
        if (!deps.readDocument) return { error: "reading the document isn't available right now" };
        return { documentText: await deps.readDocument(call.section) };
      case "start_story":
        if (!deps.startStory) return { error: "story mode isn't available right now" };
        {
          const opened = await deps.startStory(call);
          return { opened, story: { beats: opened.chapters, illustrated: true } };
        }
      case "continue_story": {
        if (!deps.continueStory) return { error: "no story is open — start one with start_story" };
        const { beats, illustrated, ...opened } = await deps.continueStory(call);
        return { opened, story: { beats, illustrated } };
      }
      case "render_scene": {
        if (!deps.renderScene) return { error: "no story is open to illustrate" };
        const r = await deps.renderScene(call);
        return { story: { rendered: r.rendered, from: r.from, to: r.to } };
      }
      case "set_story_cadence": {
        if (!deps.setStoryCadence) return { error: "no story is open" };
        const cadence = await deps.setStoryCadence(call);
        return { story: { cadence } };
      }
      case "remove_library_book":
        return await deps.removeLibraryBook(call);
      case "set_visual_style":
        return { applied: await deps.setVisualStyle(call) };
      case "remember": {
        if (!deps.remember) return { error: "memory isn't available right now" };
        // An appearance fact filed as a preference is INERT — the Soul is what portraits, stories
        // and reference conditioning read — so that one misroute is corrected. See rememberRouteFor.
        const about = rememberRouteFor(call.note, call.about);
        return {
          memory: {
            action: "remembered",
            note: call.note,
            about,
            count: await deps.remember(call.note, about === "reader" ? undefined : about),
          },
        };
      }
      case "forget":
        if (!deps.forget) return { error: "memory isn't available right now" };
        return {
          memory: { action: "forgot", note: call.match, about: call.about ?? "reader", count: await deps.forget(call.match, call.about) },
        };
      case "recent_actions":
        if (!deps.recentActions) return { error: "the action record isn't available right now" };
        return { actionHistory: await deps.recentActions(call.kind, call.limit ?? 20) };
      // Unreachable from a turn — the round loop intercepts keep_going before dispatch, because the
      // one thing it must check (did this round write anything?) is only visible from there. It is
      // here so the switch stays exhaustive for the slash-command path, which shares this table.
      case "keep_going":
        return { error: "keep_going only means anything inside a turn" };
      // Same story: the round loop intercepts this one before dispatch, because publishing to the
      // reader and recording what the turn has sent are both outside what this table can reach.
      case "send_message":
        return { error: "send_message only means anything inside a turn" };
      case "set_plan": {
        if (!deps.setPlan) return { error: "the working checklist isn't available here" };
        const plan = deps.setPlan(call.goal, call.steps, call.stepDetails);
        // A plan longer than the cap is TRIMMED by the parser. Saying so is the whole difference
        // between a model working a list it knows is partial and one that thinks it planned the
        // alphabet and is quietly running the first twelve letters.
        return call.steps.length >= MAX_PLAN_STEPS
          ? {
              plan,
              note:
                `Only the first ${MAX_PLAN_STEPS} steps were kept — that is the limit. If the job needs more, ` +
                "do these, then set_plan again for the rest.",
            }
          : { plan };
      }
      case "complete_step": {
        if (deps.appManagedSteps)
          return { error: "the app is running this checklist and ticks steps itself — don't mark progress; just do the current step you were given" };
        if (!deps.completeStep) return { error: "no checklist is set — call set_plan first" };
        const updated = deps.completeStep(call.note);
        return updated ? { plan: updated } : { error: "there's no unfinished checklist step — call set_plan first" };
      }
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
          return { email: { sent: false, to: call.to, subject: call.subject, ...(r.id ? { id: r.id } : {}), ...(r.updatedExisting ? { updatedExisting: true } : {}) } };
        } catch (err) {
          return { email: { sent: false, to: call.to, subject: call.subject, error: err instanceof Error ? err.message : String(err) } };
        }
      }
      case "list_drafts":
        if (!deps.listDrafts) return { error: "Google isn't connected (connect it in Settings)." };
        return { drafts: await deps.listDrafts(call.max) };
      case "edit_draft": {
        if (!deps.editDraft) return { error: "Google isn't connected (connect it in Settings)." };
        try {
          const d = await deps.editDraft(call.draftId, {
            ...(call.to ? { to: call.to } : {}),
            ...(call.cc ? { cc: call.cc } : {}),
            ...(call.bcc ? { bcc: call.bcc } : {}),
            ...(call.subject ? { subject: call.subject } : {}),
            ...(call.body ? { body: call.body } : {}),
            ...(call.edits?.length ? { edits: call.edits } : {}),
            ...(call.setLines?.length ? { setLines: call.setLines } : {}),
          });
          return { draftEdited: d };
        } catch (err) {
          return { draftEdited: { id: call.draftId, to: [], subject: "", body: "", error: err instanceof Error ? err.message : String(err) } };
        }
      }
      case "read_attachment":
        if (!deps.readAttachment) return { error: "Google isn't connected (connect it in Settings)." };
        return { attachment: await deps.readAttachment(call.messageId, call.attachmentId) };
      case "read_file":
        if (!deps.readFile) return { error: "reading local files isn't enabled (turn on file pulling in Settings, on desktop)." };
        return { fileText: await deps.readFile(call.path) };
      case "use_image_reference": {
        if (!deps.adoptImageReference) return { error: "picture search isn't set up on this device" };
        return { referenceAdopted: await deps.adoptImageReference({ ...(call.url ? { url: call.url } : {}), ...(call.query ? { query: call.query } : {}) }) };
      }
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
            ...(call.query ? { query: call.query } : {}),
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
      case "update_event":
        if (!deps.updateEvent) return { error: "Google isn't connected (connect it in Settings)." };
        return {
          eventUpdated: await deps.updateEvent(
            call.eventId,
            {
              ...(call.summary ? { summary: call.summary } : {}),
              ...(call.start ? { start: call.start } : {}),
              ...(call.end ? { end: call.end } : {}),
              ...(call.description ? { description: call.description } : {}),
              ...(call.appendDescription ? { appendDescription: call.appendDescription } : {}),
              ...(call.editDescription?.length ? { editDescription: call.editDescription } : {}),
              ...(call.setLines?.length ? { setLines: call.setLines } : {}),
              ...(call.location ? { location: call.location } : {}),
            },
            call.calendarId,
          ),
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
      case "complete_task": {
        if (!deps.completeTask) return { error: "task plans aren't available" };
        const r = await deps.completeTask(call.planId, call.done !== false);
        return r ? { taskAction: { planTitle: r.planTitle, completed: r.completed } } : {};
      }
      case "save_task_context": {
        if (!deps.saveTaskContext) return { error: "task plans aren't available" };
        const r = await deps.saveTaskContext(call.planId, call.note, call.replan === true);
        return r ? { taskAction: { planTitle: r.planTitle } } : {};
      }
      case "update_task_step": {
        if (!deps.updateTaskStep) return { error: "task plans aren't available" };
        const r = await deps.updateTaskStep(call.planId, call.stepId, {
          ...(call.status ? { status: call.status } : {}),
          ...(call.notes ? { notes: call.notes } : {}),
          ...(call.title ? { title: call.title } : {}),
          ...(call.detail !== undefined ? { detail: call.detail } : {}),
          ...(call.dueIso !== undefined ? { dueIso: call.dueIso } : {}),
          ...(call.actor ? { actor: call.actor } : {}),
        });
        return r ? { taskAction: { planTitle: r.planTitle } } : {};
      }
      case "update_task": {
        if (!deps.updateTask) return { error: "task plans aren't available" };
        const r = await deps.updateTask(call.planId, {
          ...(call.title ? { title: call.title } : {}),
          ...(call.summary !== undefined ? { summary: call.summary } : {}),
          ...(call.deadlineIso !== undefined ? { deadlineIso: call.deadlineIso } : {}),
          ...(call.leadTimeDays !== undefined ? { leadTimeDays: call.leadTimeDays } : {}),
          ...(call.estCost !== undefined ? { estCost: call.estCost } : {}),
          ...(call.researchNotes !== undefined ? { researchNotes: call.researchNotes } : {}),
          ...(call.clarifyingQuestions ? { clarifyingQuestions: call.clarifyingQuestions } : {}),
        });
        return r ? { taskAction: { planTitle: r.planTitle } } : {};
      }
      case "update_task_doc": {
        if (!deps.updateTaskDoc) return { error: "task plans aren't available" };
        const r = await deps.updateTaskDoc(call.planId, {
          title: call.title,
          ...(call.stepId ? { stepId: call.stepId } : {}),
          ...(call.kind ? { kind: call.kind } : {}),
          ...(call.body !== undefined ? { body: call.body } : {}),
          ...(call.setLines?.length ? { setLines: call.setLines } : {}),
          ...(call.fence ? { fence: call.fence } : {}),
        });
        return r ? { taskDoc: r } : {};
      }
      case "add_task_steps": {
        if (!deps.addTaskSteps) return { error: "task plans aren't available" };
        const r = await deps.addTaskSteps({ steps: call.steps, ...(call.planId ? { planId: call.planId } : {}), ...(call.replace ? { replace: true } : {}) });
        return r ? { stepsAdded: r } : {};
      }
      case "schedule_task":
        if (!deps.scheduleTask) return { error: "scheduled tasks aren't available right now" };
        return { scheduled: await deps.scheduleTask(call) };
      case "date_math":
        // Computed in-process: pure arithmetic with no I/O, so it needs no dep and can't be
        // unavailable — which matters, because the whole point is that it is always there when a
        // date has to become a number.
        return { dateMath: dateMath(call, new Date()) };
      case "update_scheduled_task":
        if (!deps.updateScheduledTask) return { error: "scheduled tasks aren't available right now" };
        return { scheduledUpdated: await deps.updateScheduledTask(call) };
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
