import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import type { ImageSearchHit, WebSearchHit } from "../providers/image/image-search.js";
import type { BookPassage } from "./book-passage-search.js";
import {
  MAX_TOOL_ROUNDS,
  formatToolResult,
  parseToolCall,
  type ToolCall,
  type ToolResultPayload,
} from "./chat-tools.js";

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
}

export type ChatTurnEvent =
  | { kind: "token"; text: string }
  /** A thinking model is reasoning (no visible answer yet); `text` is the live reasoning. */
  | { kind: "thinking"; text: string }
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
    if (mode === "live") return emit(delta);
    if (mode === "mute") return;
    buffer += delta;
    const lead = buffer.trimStart();
    if (!lead) return;
    if (lead.startsWith("{") || lead.startsWith("`")) {
      mode = "mute";
      return;
    }
    mode = "live";
    emit(buffer);
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
  /** Prior turns + the new user message (caller appends it before calling). */
  history: ChatTurn[];
  tools: ChatToolDeps;
  /** Response budget (tokens); unset = the provider's default. */
  maxTokens?: number;
  onEvent?: (e: ChatTurnEvent) => void;
  signal?: AbortSignal;
}): Promise<ChatTurnOutcome> {
  const messages: ChatTurn[] = [{ role: "system", content: opts.system }, ...opts.history];
  const transcript: ChatTurn[] = [];
  const toolResults: ChatTurnOutcome["toolResults"] = [];

  for (let round = 0; ; round++) {
    const reply = await opts.llm.chat(messages, {
      // Fresh gate per round: a tool-JSON round streams nothing; the prose round streams live.
      ...(opts.onEvent
        ? {
            onToken: jsonGatedTokenSink((text) => opts.onEvent?.({ kind: "token", text })),
            onThinking: (text: string) => opts.onEvent?.({ kind: "thinking", text }),
          }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    });
    const call = round < MAX_TOOL_ROUNDS ? parseToolCall(reply) : undefined;
    if (!call) {
      transcript.push({ role: "assistant", content: reply });
      return { text: reply, transcript, toolResults };
    }
    opts.onEvent?.({ kind: "tool", round, call });
    transcript.push({ role: "assistant", content: reply });
    messages.push({ role: "assistant", content: reply });

    if (call.tool === "generate_image" || call.tool === "export_book") {
      // Stops the loop: the host takes over — generate_image needs render approval;
      // export_book is a main-thread action (gathers the rendered images + saves).
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
  call: Exclude<ToolCall, { tool: "generate_image" | "export_book" }>,
  tools: ChatToolDeps,
): Promise<ToolResultPayload> {
  try {
    if (call.tool === "remember") {
      if (!tools.remember) return { error: "memory isn't available right now" };
      return { memory: { action: "remembered", note: call.note, count: await tools.remember(call.note) } };
    }
    if (call.tool === "forget") {
      if (!tools.forget) return { error: "memory isn't available right now" };
      return { memory: { action: "forgot", note: call.match, count: await tools.forget(call.match) } };
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
