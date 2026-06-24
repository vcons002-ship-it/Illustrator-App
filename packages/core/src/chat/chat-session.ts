import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import type { ImageSearchHit, WebSearchHit } from "../providers/image/image-search.js";
import type { AnalyzeResult, AnalyzeSpec } from "../data/analyze.js";
import type { BookPassage } from "./book-passage-search.js";
import {
  MAX_TOOL_ROUNDS,
  formatToolResult,
  parseToolCall,
  type ToolCall,
  type ToolResultPayload,
} from "./chat-tools.js";

/** Safety cap on auto-continue passes (mirrors runBuddyTurn) — bounds a runaway/looping model, NOT
 * the content: at ~30k tokens/pass it's hundreds of thousands of tokens, and hitting it ends with a
 * "say continue" note rather than a silent cut. */
const MAX_REPLY_CONTINUATIONS = 8;
/** First-token heartbeat cadence — kept well under the phone silence watchdog (120s). */
const HEARTBEAT_MS = 10_000;

/**
 * One user-message round of the chat, including the tool loop — worker-agnostic
 * and fully testable with a scripted ChatCapable. Search tools execute inline
 * (auto-run, bounded by MAX_TOOL_ROUNDS); `generate_image` deliberately does NOT:
 * it stops the loop and surfaces as `pendingTool` for explicit user approval —
 * the prompt-injection guard for the one tool that costs real GPU time/money.
 */

export interface ChatToolDeps {
  searchWeb?: (query: string) => Promise<WebSearchHit[]>;
  searchImages?: (query: string) => Promise<ImageSearchHit[]>;
  /** Fetch a URL's readable text so the model can read/learn from a page. */
  readUrl?: (url: string) => Promise<{ title?: string; text: string }>;
  /** Find passages elsewhere in the book (sync — it's a local text scan). */
  searchBook?: (query: string) => BookPassage[];
  /** Full detail for a named bible entry (sync — reads the in-memory bible). */
  lookupBible?: (query: string) => string;
  /** Long-term reader memory (see reader-memory.ts); returns the kept count. */
  remember?: (note: string) => Promise<number>;
  forget?: (match: string) => Promise<number>;
  /** Skills — durable playbooks (skills.ts). readSkill returns the body ("" if none). */
  readSkill?: (name: string) => Promise<string>;
  saveSkill?: (name: string, description: string, body: string) => Promise<number>;
  forgetSkill?: (match: string) => Promise<number>;
  /** Grounded analysis over the uploaded spreadsheet/CSV (sync — pure over the table). */
  analyzeData?: (spec: AnalyzeSpec) => AnalyzeResult;
}

export type ChatTurnEvent =
  | { kind: "token"; text: string }
  /** A thinking model is reasoning (no visible answer yet); `text` is the live reasoning. */
  | { kind: "thinking"; text: string }
  /** A transient "working" heartbeat so a turn streaming MUTED content (tool-call JSON) or thinking
   * silently never looks frozen. Cleared by the first visible token / the settled answer. */
  | { kind: "activity"; text: string }
  | { kind: "tool"; round: number; call: ToolCall }
  | { kind: "toolResult"; round: number; call: ToolCall; result: ToolResultPayload };

/**
 * Wrap a token sink so a reply that LOOKS like a tool call (starts with "{" or a
 * code fence) never streams into the visible bubble — tool JSON used to type
 * itself out in the panel and then "vanish" into a search. Prose flows through
 * live once the first non-JSON character proves the reply is an answer; a held
 * JSON reply that turns out to be prose still arrives via the final text.
 */
export function jsonGatedTokenSink(emit: (text: string) => void): (delta: string) => void {
  let buffer = "";
  let mode: "hold" | "live" | "mute" = "hold";
  return (delta) => {
    if (mode === "mute") return;
    buffer += delta;
    if (mode === "hold") {
      const lead = buffer.trimStart();
      if (!lead) return; // only whitespace so far
      // A reply that OPENS like a tool call / code fence is all tool JSON — show nothing.
      if (lead.startsWith("{") || lead.startsWith("`")) {
        mode = "mute";
        return;
      }
      mode = "live";
    }
    // Live prose. Mute as soon as a tool call BEGINS — either a `{` / code fence at the start of a
    // line (a call appended after a briefing) OR an inline `{"tool"|"name"|"function":…}` object the
    // model ran straight onto the end of a sentence with no newline. Emit the prose up to it, then
    // mute the rest so the raw JSON never streams into the bubble.
    const lineStart = /\n[ \t]*(?:\{|```)/.exec(buffer);
    const inlineTool = /\{\s*"(?:tool|name|function)"\s*:/.exec(buffer);
    const boundaryIdx = Math.min(
      lineStart ? lineStart.index : Number.POSITIVE_INFINITY,
      inlineTool ? inlineTool.index : Number.POSITIVE_INFINITY,
    );
    if (boundaryIdx !== Number.POSITIVE_INFINITY) {
      if (boundaryIdx > 0) emit(buffer.slice(0, boundaryIdx));
      buffer = "";
      mode = "mute";
      return;
    }
    // Otherwise stream eagerly, but HOLD a trailing partial that could be the START of a tool call:
    // a "\n   " (start of "\n{…}") OR a dangling unclosed "{…" (the model has begun an inline object
    // whose first key hasn't arrived yet) — so we don't emit a "{" that's about to become tool JSON.
    const tail = /\n[ \t]*$|\{[^{}]*$/.exec(buffer);
    if (tail) {
      if (tail.index > 0) emit(buffer.slice(0, tail.index));
      buffer = buffer.slice(tail.index);
    } else {
      emit(buffer);
      buffer = "";
    }
  };
}

export interface ChatTurnOutcome {
  /** Final assistant prose (may be empty when the round ended on a pending tool). */
  text: string;
  /** Turns appended THIS round (assistant tool JSON + tool-result feedback + final
   * prose), ready to extend the stored history. */
  transcript: ChatTurn[];
  /** An un-executed generate_image awaiting the reader's approval. */
  pendingTool?: ToolCall;
  /** Search tools that ran, with their data (for inline rendering in the panel). */
  toolResults: { call: ToolCall; result: ToolResultPayload }[];
}

/**
 * Cap the MODEL-FACING history by characters, dropping the oldest whole turns.
 * The stored history can hold hundreds of messages; what each provider can
 * usefully take differs by orders of magnitude (local 8k-context models vs
 * 200k-token cloud models), so the host passes a per-provider budget. The
 * newest turn is always kept, however large.
 */
export function trimChatHistory(history: ChatTurn[], maxChars: number): ChatTurn[] {
  let used = 0;
  let start = history.length;
  while (start > 0) {
    const next = used + history[start - 1]!.content.length;
    if (next > maxChars && start < history.length) break;
    used = next;
    start--;
  }
  return start === 0 ? history : history.slice(start);
}

export async function runChatTurn(opts: {
  llm: ChatCapable;
  system: string;
  /** Stable leading portion of `system` to cache (see ChatOptions.cachePrefix). */
  cachePrefix?: string;
  /** Prior turns + the new user message (caller appends it before calling). */
  history: ChatTurn[];
  tools: ChatToolDeps;
  /** Response budget (tokens); unset = the provider's default. */
  maxTokens?: number;
  onEvent?: (e: ChatTurnEvent) => void;
  signal?: AbortSignal;
  /** Thinking level for local reasoning models (passed straight to the provider's chat). */
  reasoningEffort?: "none" | "low" | "medium" | "high";
}): Promise<ChatTurnOutcome> {
  const messages: ChatTurn[] = [{ role: "system", content: opts.system }, ...opts.history];
  const transcript: ChatTurn[] = [];
  const toolResults: ChatTurnOutcome["toolResults"] = [];
  let lastTruncated = false; // did the last reply get CUT OFF at the budget? (→ auto-continue)

  const chatOnce = (): Promise<string> => {
    lastTruncated = false;
    // First-token heartbeat (see runBuddyTurn): a big local model can take a long time before the
    // FIRST token, and the linked phone's silence watchdog only resets on a stream event — so tick a
    // transient activity event with elapsed seconds until content shows up. Feeds the watchdog only;
    // never caps the reply.
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
      // Fresh gate per round: a tool-JSON round streams nothing; the prose round streams live.
      ...(opts.onEvent
        ? {
            onToken: jsonGatedTokenSink((text) => {
              noteContent();
              opts.onEvent?.({ kind: "token", text });
            }),
            onThinking: (text: string) => {
              noteContent();
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
    // Heartbeat so a muted/thinking round never looks frozen (see runBuddyTurn).
    opts.onEvent?.({ kind: "activity", text: round === 0 ? "Thinking…" : "Working on it…" });
    const reply = await chatOnce();
    const call = round < MAX_TOOL_ROUNDS ? parseToolCall(reply) : undefined;
    if (!call) {
      // AUTO-CONTINUE a CUT-OFF answer and stitch the parts so a long document isn't capped at one
      // reply (mirrors runBuddyTurn). Pure prose only — a final answer never carries a tool call.
      let answer = reply;
      let rawSoFar = reply;
      for (let part = 0; lastTruncated && part < MAX_REPLY_CONTINUATIONS; part++) {
        opts.onEvent?.({ kind: "activity", text: `Writing the answer… (part ${part + 2})` });
        messages.push({ role: "assistant", content: rawSoFar });
        messages.push({
          role: "user",
          content:
            "[You hit the length limit mid-answer. Continue EXACTLY where you left off — no repetition, " +
            "no preamble and no tool calls — until the answer is complete.]",
        });
        rawSoFar = await chatOnce();
        if (rawSoFar.trim()) answer = answer ? `${answer}\n${rawSoFar.trim()}` : rawSoFar.trim();
      }
      if (lastTruncated) {
        answer += '\n\n_(This is running very long — I paused here. Say "continue" and I\'ll pick up where I left off.)_';
      }
      transcript.push({ role: "assistant", content: answer });
      return { text: answer, transcript, toolResults };
    }
    opts.onEvent?.({ kind: "tool", round, call });
    transcript.push({ role: "assistant", content: reply });
    messages.push({ role: "assistant", content: reply });

    if (
      call.tool === "generate_image" ||
      call.tool === "export_book" ||
      call.tool === "export_data" ||
      call.tool === "set_cell" ||
      call.tool === "add_formula_column"
    ) {
      // Stops the loop: the host takes over — generate_image needs render approval;
      // export_book/export_data save files; set_cell/add_formula_column mutate the
      // open spreadsheet, which lives in the main thread's book state.
      return { text: "", transcript, pendingTool: call, toolResults };
    }
    const result = await runChatTool(call, opts.tools);
    toolResults.push({ call, result });
    opts.onEvent?.({ kind: "toolResult", round, call, result });
    const feedback = formatToolResult(call, result);
    transcript.push({ role: "user", content: feedback });
    messages.push({ role: "user", content: feedback });
  }
}

/** Execute one auto-run tool (everything but generate_image). Exported for the
 * slash-command path, which runs tools directly without an LLM round. */
export async function runChatTool(
  call: Exclude<ToolCall, { tool: "generate_image" | "export_book" | "export_data" | "set_cell" | "add_formula_column" }>,
  tools: ChatToolDeps,
): Promise<ToolResultPayload> {
  try {
    if (call.tool === "analyze_data") {
      if (!tools.analyzeData) return { error: "no spreadsheet/CSV data is loaded to analyze" };
      const { chart: _chart, tool: _tool, ...spec } = call;
      const res = tools.analyzeData(spec);
      return { analysis: { table: res.table, summary: res.summary, ...(call.chart ? { chart: call.chart } : {}) } };
    }
    if (call.tool === "remember") {
      if (!tools.remember) return { error: "memory isn't available right now" };
      return { memory: { action: "remembered", note: call.note, count: await tools.remember(call.note) } };
    }
    if (call.tool === "forget") {
      if (!tools.forget) return { error: "memory isn't available right now" };
      return { memory: { action: "forgot", note: call.match, count: await tools.forget(call.match) } };
    }
    if (call.tool === "read_skill") {
      if (!tools.readSkill) return { error: "skills aren't available right now" };
      const body = await tools.readSkill(call.name);
      return { skill: body ? { action: "read", name: call.name, body } : { action: "missing", name: call.name } };
    }
    if (call.tool === "save_skill") {
      if (!tools.saveSkill) return { error: "skills aren't available right now" };
      return { skill: { action: "saved", name: call.name, count: await tools.saveSkill(call.name, call.description, call.body) } };
    }
    if (call.tool === "forget_skill") {
      if (!tools.forgetSkill) return { error: "skills aren't available right now" };
      return { skill: { action: "forgot", name: call.match, count: await tools.forgetSkill(call.match) } };
    }
    if (call.tool === "read_url") {
      if (!tools.readUrl) return { error: "reading web pages isn't available right now" };
      return { page: await tools.readUrl(call.url) };
    }
    if (call.tool === "search_web") {
      if (!tools.searchWeb) return { error: "web search isn't available right now" };
      return { hits: await tools.searchWeb(call.query) };
    }
    if (call.tool === "search_book") {
      if (!tools.searchBook) return { error: "book search isn't available right now" };
      return { passages: tools.searchBook(call.query) };
    }
    if (call.tool === "lookup_bible") {
      if (!tools.lookupBible) return { error: "no visual bible is available yet" };
      return { bibleDetail: tools.lookupBible(call.query) };
    }
    if (!tools.searchImages) return { error: "image search isn't available right now" };
    return { imageHits: await tools.searchImages(call.query) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
