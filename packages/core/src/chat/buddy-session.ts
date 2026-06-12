import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import type { WebSearchHit } from "../providers/image/image-search.js";
import type { BookSearchHit } from "../providers/book-search.js";
import {
  MAX_BUDDY_TOOL_ROUNDS,
  formatBuddyToolResult,
  parseBuddyToolCall,
  type BuddyOpenedInfo,
  type BuddyToolCall,
  type BuddyToolResultPayload,
} from "./buddy-tools.js";

/**
 * One user-message round of the landing-page buddy, including the tool loop —
 * worker-agnostic and fully testable with a scripted ChatCapable (the same shape
 * as chat-session.ts). ALL buddy tools auto-run: searches are free, and opening a
 * book only loads it (generation still needs the reader's Start unless they
 * explicitly asked for visuals — the host enforces that via the `visuals` flag).
 */

export interface BuddyDeps {
  searchWeb?: (query: string) => Promise<WebSearchHit[]>;
  searchBooks?: (query: string) => Promise<BookSearchHit[]>;
  /** Open a library book by id; the host posts the BookSource to the UI itself. */
  openLibraryBook: (call: Extract<BuddyToolCall, { tool: "open_library_book" }>) => Promise<BuddyOpenedInfo>;
  /** Fetch a URL's text, build a BookSource, and open it (host-side). */
  openWebText: (call: Extract<BuddyToolCall, { tool: "open_web_text" }>) => Promise<BuddyOpenedInfo>;
}

export type BuddyTurnEvent =
  | { kind: "token"; text: string }
  | { kind: "tool"; round: number; call: BuddyToolCall }
  | { kind: "toolResult"; round: number; call: BuddyToolCall; result: BuddyToolResultPayload };

export interface BuddyTurnOutcome {
  /** Final assistant prose. */
  text: string;
  /** Turns appended THIS round, ready to extend the stored history. */
  transcript: ChatTurn[];
  toolResults: { call: BuddyToolCall; result: BuddyToolResultPayload }[];
}

export async function runBuddyTurn(opts: {
  llm: ChatCapable;
  system: string;
  /** Prior turns + the new user message (caller appends it before calling). */
  history: ChatTurn[];
  deps: BuddyDeps;
  onEvent?: (e: BuddyTurnEvent) => void;
  signal?: AbortSignal;
}): Promise<BuddyTurnOutcome> {
  const messages: ChatTurn[] = [{ role: "system", content: opts.system }, ...opts.history];
  const transcript: ChatTurn[] = [];
  const toolResults: BuddyTurnOutcome["toolResults"] = [];

  for (let round = 0; ; round++) {
    const reply = await opts.llm.chat(messages, {
      ...(opts.onEvent ? { onToken: (text: string) => opts.onEvent?.({ kind: "token", text }) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const call = round < MAX_BUDDY_TOOL_ROUNDS ? parseBuddyToolCall(reply) : undefined;
    if (!call) {
      transcript.push({ role: "assistant", content: reply });
      return { text: reply, transcript, toolResults };
    }
    opts.onEvent?.({ kind: "tool", round, call });
    transcript.push({ role: "assistant", content: reply });
    messages.push({ role: "assistant", content: reply });

    const result = await runBuddyTool(call, opts.deps);
    toolResults.push({ call, result });
    opts.onEvent?.({ kind: "toolResult", round, call, result });
    const feedback = formatBuddyToolResult(call, result);
    transcript.push({ role: "user", content: feedback });
    messages.push({ role: "user", content: feedback });
  }
}

async function runBuddyTool(call: BuddyToolCall, deps: BuddyDeps): Promise<BuddyToolResultPayload> {
  try {
    switch (call.tool) {
      case "search_web":
        if (!deps.searchWeb) return { error: "web search isn't available right now" };
        return { hits: await deps.searchWeb(call.query) };
      case "search_books":
        if (!deps.searchBooks) return { error: "book search isn't available right now" };
        return { books: await deps.searchBooks(call.query) };
      case "open_library_book":
        return { opened: await deps.openLibraryBook(call) };
      case "open_web_text":
        return { opened: await deps.openWebText(call) };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
