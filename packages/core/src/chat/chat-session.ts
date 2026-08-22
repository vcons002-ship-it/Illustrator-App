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
import { looksLikeToolJson, stripToolCallJson } from "./buddy-tools.js";

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
/**
 * The fenced block `text` leaves OPEN, or "" when it ends outside one.
 *
 * Used to hand the auto-continue's sink the state its predecessor ended in: part two of a file is
 * still inside the block part one opened, and a gate that thinks otherwise reads the ``` closing that
 * block as a tool call and mutes the rest.
 *
 * `start` is the fence already open when `text` begins, so a reply split across several continuations
 * can be folded one part at a time.
 */
export function openFenceOf(text: string, start = ""): string {
  let fence = start;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (fence) {
      if (new RegExp("^`{" + fence.length + ",}$").test(l)) fence = "";
      continue;
    }
    const m = /^(`{3,})[ \t]*[A-Za-z][\w+#-]*$/.exec(l);
    if (m) fence = m[1]!;
  }
  return fence;
}

/**
 * THE FILE A REPLY WAS STILL WRITING WHEN IT RAN OUT — its language tag and everything written so far.
 *
 * A reply that ends inside an unclosed fence is a file the model was pasting into the chat, which the
 * prompt tells it not to do and which it does anyway when the thing it is transcribing is long. The
 * continuation loop then spends its whole allowance carrying that paste forward — and its directive
 * says "no tool calls", so the one tool that would fix it is forbidden for as long as the loop runs.
 *
 * At the end of that there is a large, half-written file whose only copy is a chat bubble, and a
 * model that has been taught never to rewrite a big file from memory. Asked to continue, it does the
 * sensible thing and goes looking for the file on disk. There isn't one. Reported as: "how could the
 * chat lose the text it just wrote and go look for a file?"
 *
 * Returning the body is what lets the host put it where the model will look.
 */
export function openBlockOf(text: string): { tag: string; body: string } | undefined {
  const lines = text.split("\n");
  let fence = "";
  let tag = "";
  let from = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (fence) {
      if (new RegExp("^`{" + fence.length + ",}$").test(l)) {
        fence = "";
        from = -1;
      }
      continue;
    }
    const m = /^(`{3,})[ \t]*([A-Za-z][\w+#-]*)$/.exec(l);
    if (m) {
      fence = m[1]!;
      tag = m[2]!;
      from = i + 1;
    }
  }
  return fence && from >= 0 ? { tag, body: lines.slice(from).join("\n") } : undefined;
}

export function jsonGatedTokenSink(
  emit: (text: string) => void,
  /**
   * RESUMING a reply rather than starting one — the auto-continue after a length cut.
   *
   * The hold below asks "does this reply OPEN like a tool call?", which is a question about the first
   * characters of an answer. A continuation's first characters are the middle of one: pick up inside
   * an HTML file and it very often resumes on `{`, or on the ``` that closes the block. Asked the
   * opening question about a fragment, the gate muted the entire continuation — so the reply stopped
   * growing at exactly the point the budget ran out, which is the moment it most looks like a hang.
   *
   * `fence` carries too: part two of a file is still inside the block part one opened.
   */
  resume?: { fence?: string },
): (delta: string) => void {
  let buffer = "";
  let mode: "hold" | "live" | "mute" = resume ? "live" : "hold";
  /**
   * INSIDE A FENCED BLOCK, NOTHING IS A TOOL CALL — and not knowing that is what went dark.
   *
   * Reported as: "it got stuck partway through its response and never continued… maybe it was
   * working but there was absolutely no way to tell." The reply froze mid-code-block with a cursor
   * under it, so the reader stopped a turn that was writing the file perfectly well, and then had to
   * ask for it again.
   *
   * `mute` is TERMINAL, and two things every code block contains were tripping it:
   *
   *   1. ITS OWN CLOSING FENCE. A bare ``` is how a tool call opens, so the boundary test below
   *      matched the line that CLOSES a deliverable — the block streamed, and then everything after
   *      it, including a second and much larger file, went to a muted sink for the rest of the
   *      generation.
   *   2. A LINE THAT STARTS WITH `{`. Ordinary in source — an object in an array literal, an Allman
   *      brace — and indistinguishable from a tool call to a test that never asked whether we were
   *      inside a block.
   *
   * Both were one missing piece of state. The earlier fix here taught the gate that ```html opens a
   * deliverable rather than a call; it just never remembered that it had, so every test kept running
   * as though the text were still prose. Between an opening fence and its close, the answer to "is
   * this a tool call?" is no, without looking: a tool call cannot be nested inside a file.
   *
   * Held as the backtick RUN, not a boolean, so a ````-fenced block (what a model writes when the
   * file itself contains ```) is closed by ```` and not by the ``` on the line before it.
   */
  let fence = resume?.fence ?? "";
  return (delta) => {
    if (mode === "mute") return;
    buffer += delta;
    if (mode === "hold") {
      const lead = buffer.trimStart();
      if (!lead) return; // only whitespace so far
      // A reply that OPENS with a bare object is all tool JSON — show nothing.
      if (lead.startsWith("{")) {
        mode = "mute";
        return;
      }
      if (lead.startsWith("`")) {
        // WAIT FOR THE WHOLE FENCE LINE. A language tag makes it a file the reader asked for; its
        // absence makes it a tool call; and one backtick says neither. Deciding on the first
        // character is what muted every code block that opened a reply.
        if (/^`{1,}[A-Za-z0-9+#-]*$/.test(lead)) return;
        if (!/^`{3,}[ \t]*[A-Za-z][\w+#-]*[ \t]*(?:\n|$)/.test(lead) || /^`{3,}[ \t]*json\b/.test(lead)) {
          mode = "mute";
          return;
        }
      }
      mode = "live";
    }
    /**
     * Live prose. Mute as soon as a tool call BEGINS — either a `{` / code fence at the start of a
     * line (a call appended after a briefing) OR an inline `{"tool"|"name"|"function":…}` object the
     * model ran straight onto the end of a sentence with no newline. Emit the prose up to it, then
     * mute the rest so the raw JSON never streams into the bubble.
     *
     * A LANGUAGE-TAGGED FENCE IS NOT A TOOL CALL, and treating it as one hid every file the
     * assistant ever wrote. A tool call is a bare object or a bare/```json fence; a deliverable
     * announces its language. So ```html, ```python, ```css stream, and ``` / ```json still hold.
     * Being wrong in the permissive direction costs a moment of raw JSON on screen that the settle
     * then replaces; being wrong the other way costs the file.
     *
     * The loop alternates between the two regions — outside a block, where those tests apply, and
     * inside one, where none of them do — because a single delta can cross the boundary in either
     * direction, and a reply is commonly prose, file, prose, file.
     */
    for (;;) {
      if (fence) {
        // INSIDE a deliverable: everything streams, and the only thing worth finding is the line
        // that closes it. A run at least as long as the opener, alone on its line.
        const close = new RegExp("\\n[ \\t]*`{" + fence.length + ",}[ \\t]*\\n").exec(buffer);
        if (close) {
          const end = close.index + close[0].length;
          emit(buffer.slice(0, end));
          buffer = buffer.slice(end);
          fence = "";
          continue; // back outside — the rest of this delta is prose again, and gets tested as prose
        }
        // No close yet. Stream it all bar a trailing partial that could BECOME one: the newline it
        // has to be anchored to arrives in an earlier delta than its backticks.
        const partial = /\n[ \t]*`*[ \t]*$/.exec(buffer);
        if (partial) {
          if (partial.index > 0) emit(buffer.slice(0, partial.index));
          buffer = buffer.slice(partial.index);
        } else {
          emit(buffer);
          buffer = "";
        }
        return;
      }
      /**
       * AN UNFINISHED FENCE LINE CANNOT BE CLASSIFIED YET, and deciding early is what muted the file.
       *
       * "\n```" IS a bare fence — a tool call — right up until the next character makes it "```html",
       * a deliverable. The boundary test below runs before the hold, so it reached its verdict at the
       * third backtick, every time, and `mute` is terminal. Hold the partial line instead and look
       * again on the next delta, by which point the language tag either exists or does not.
       */
      const partialFence = /\n[ \t]*`{1,}[A-Za-z0-9+#-]*$/.exec(buffer);
      if (partialFence) {
        if (partialFence.index > 0) emit(buffer.slice(0, partialFence.index));
        buffer = buffer.slice(partialFence.index);
        return;
      }
      // The line that OPENS a deliverable. Matched here rather than left to fall through the tests
      // below, because opening one is a STATE CHANGE: it is what tells every test after it to stand
      // down until the block closes.
      const opener = /(?:^|\n)[ \t]*(`{3,})[ \t]*[A-Za-z][\w+#-]*[ \t]*\n/.exec(buffer);
      // `(?!`)` pins the run to its full length. Without it the engine backtracks a ````md opener
      // down to three backticks, finds a backtick where a language tag should be, and calls a
      // deliverable a tool call — the same misread as before, one backtick deeper.
      const lineStart = /\n[ \t]*(?:\{|`{3,}(?!`)(?![ \t]*[A-Za-z][\w+#-]*[ \t]*(?:\n|$))|`{3,}(?!`)[ \t]*json\b)/.exec(buffer);
      const inlineTool = /\{\s*"(?:tool|name|function)"\s*:/.exec(buffer);
      const boundaryIdx = Math.min(
        lineStart ? lineStart.index : Number.POSITIVE_INFINITY,
        inlineTool ? inlineTool.index : Number.POSITIVE_INFINITY,
      );
      if (opener && opener.index < boundaryIdx) {
        const end = opener.index + opener[0].length;
        emit(buffer.slice(0, end));
        buffer = buffer.slice(end);
        fence = opener[1]!;
        continue; // inside now — the rest of this delta is file content, not a call
      }
      if (boundaryIdx !== Number.POSITIVE_INFINITY) {
        if (boundaryIdx > 0) emit(buffer.slice(0, boundaryIdx));
        buffer = "";
        mode = "mute";
        return;
      }
      /**
       * Otherwise stream eagerly, but HOLD a trailing partial that could be the START of a tool call:
       * a "\n   " (start of "\n{…}"), a dangling unclosed "{…" (the model has begun an inline object
       * whose first key hasn't arrived yet), or an unfinished FENCE LINE.
       *
       * The fence half was missing, and its absence made the boundary test above unreachable for any
       * fence at all. Three backticks and a language tag arrive over several deltas; the old hold
       * released as soon as the first backtick landed, so by the time "```json" was complete the "\n"
       * it had to be anchored to was several emits in the past. A fenced tool call appended after prose
       * therefore streamed straight into the bubble — the exact thing this gate exists to stop — and
       * the fence could not be classified either way.
       *
       * Holding until the fence LINE is complete means the decision is always made on the whole thing:
       * language tag present or not, which is what separates a file from a tool call.
       */
      const tail = /\n[ \t]*(?:`{1,}[A-Za-z0-9+#-]*)?$|\{[^{}]*$/.exec(buffer);
      if (tail) {
        if (tail.index > 0) emit(buffer.slice(0, tail.index));
        buffer = buffer.slice(tail.index);
      } else {
        emit(buffer);
        buffer = "";
      }
      return;
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
/**
 * The conversation's guaranteed share of the input allowance, however big the system prompt gets.
 *
 * A flat floor was the wrong shape. It was 2,000 characters — about one exchange — and on a real
 * setup the system prompt (role, tools, identity notes, memories, skills) came to ~66,000 characters,
 * more than the whole input allowance on its own. "Whatever is left over" was therefore nothing, the
 * floor was all the conversation ever got, and the assistant answered "the first message I see in
 * this chat is your current question" while the screen showed a long conversation above it.
 *
 * Leftovers cannot be the only rule when the thing taking them has no ceiling. The conversation is
 * the task; the enrichment around it is not. So it gets a floor proportional to the window: a fifth,
 * which on a 32k-token model is ~16,000 characters — a few thousand words of actual conversation.
 */
export const MIN_HISTORY_SHARE = 0.2;
/** Absolute backstop for a tiny window, where a fifth of very little is still nothing. */
export const MIN_HISTORY_CHARS = 2_000;

/**
 * What is left of a turn's input allowance for the CONVERSATION, once the system prompt has taken
 * what it needs.
 *
 * The budget used to be a fixed fraction — 30% of input to history, 70% reserved for the book. That
 * is roughly right for the in-book reader, where a book section really is most of the prompt. It is
 * badly wrong for the landing-page chat, which has NO book: 70% of the allowance was held back for a
 * section that does not exist, and on an 8k-window local model the conversation was capped at ~4,400
 * characters. That is two or three exchanges — so the assistant genuinely could not see what had just
 * been said, which is not a subtle degradation but the thing people report as "it forgets".
 *
 * Measuring beats guessing: the system prompt is built before the history is trimmed in every path,
 * so its real size is known, and whatever it did not use belongs to the conversation. But leftovers
 * alone are not enough — a system prompt with no ceiling can leave none — so the conversation also
 * has a guaranteed share (see {@link MIN_HISTORY_SHARE}), and takes whichever is larger. PURE.
 */
export function historyBudget(inputChars: number, systemChars: number): number {
  const leftover = inputChars - systemChars;
  const guaranteed = Math.floor(Math.max(0, inputChars) * MIN_HISTORY_SHARE);
  return Math.max(MIN_HISTORY_CHARS, guaranteed, leftover);
}

/**
 * Left where the CONVERSATION was cut, as opposed to {@link TRIMMED_MARKER}, which is for one turn's
 * own messages. Different wording because it is a different claim: earlier exchanges are gone from
 * this view, and the model must not read the oldest surviving turn as the start of the conversation.
 */
export const HISTORY_TRIMMED_MARKER =
  "[Earlier exchanges in this conversation are no longer in view — they were trimmed to fit the " +
  "context window. If the reader refers to something you cannot see, say so and ask, or re-read the " +
  "file that holds it; do not assume the conversation began here.]";

/**
 * A CUT NOBODY WAS TOLD ABOUT. This dropped the oldest exchanges and left nothing behind — no
 * marker, no count, no log — so a model handed a conversation that began in the middle had every
 * reason to believe that was the whole of it, and the prompt elsewhere positively instructs it to
 * answer questions about the conversation from the transcript it can see.
 *
 * The reader's report is what that looks like from outside: hours of work on a file, then "I don't
 * have the earlier context". Nothing was broken and nothing said so. A marker makes the same
 * incident a sentence instead of a forensic exercise, and gives the model the one thing it needs to
 * answer honestly — that its view is partial.
 *
 * Note it is a wall, not a sieve: the walk stops at the first message that will not fit, so ONE
 * large old message takes everything before it too. That is deliberate (a contiguous tail is the
 * only kind a conversation reads correctly) and it is exactly why a big deliverable evicts itself.
 */
/**
 * THE OPENING LINE OF A COMPACTION BRIEF — the one history turn that must never be trimmed away.
 *
 * A brief is the whole of the conversation before it, compressed. It is also, necessarily, the
 * OLDEST turn in the history, and this function drops oldest-first — so the very first thing thrown
 * out of a compacted chat was the compaction. The app spent up to two minutes of local generation
 * rescuing the head of the conversation and then discarded the rescue before the next reply, which
 * is worse than never having compacted: the history it summarised is gone too.
 */
export const COMPACTION_BRIEF_MARKER = "[Summary of our conversation so far — continue from this context]";

/** Whether a turn is a compaction brief (see {@link COMPACTION_BRIEF_MARKER}). */
export function isCompactionBrief(turn: ChatTurn): boolean {
  return turn.role === "user" && turn.content.startsWith(COMPACTION_BRIEF_MARKER);
}

export function trimChatHistory(history: ChatTurn[], maxChars: number): ChatTurn[] {
  let used = 0;
  let start = history.length;
  while (start > 0) {
    const next = used + history[start - 1]!.content.length;
    if (next > maxChars && start < history.length) break;
    used = next;
    start--;
  }
  if (start === 0) return history;
  /**
   * THE REPLY IT JUST MADE IS NEVER DROPPED WHOLE — cut its middle instead.
   *
   * Reported as: "how could the chat lose the text it just wrote and go look for a file? I don't
   * understand why it seems like it didn't even look at its chat history."
   *
   * It looked; there was nothing there. This walk keeps the newest message unconditionally (the
   * reader's new one) and then breaks on the FIRST message that doesn't fit — and a reply that just
   * wrote most of a file is, on its own, bigger than the whole history budget. So the model was
   * handed a trimmed marker and the word "continue", and the marker's own advice is "re-read the file
   * that holds it". It went looking for the file. It was doing exactly as it was told.
   *
   * All-or-nothing is the flaw, not the size of the budget: the single most relevant thing in the
   * conversation is the thing most likely to be too big for it. {@link trimTurnMessages} already
   * learned this — "the newest result is kept even when it alone exceeds the budget, truncated in the
   * middle" — and this function is where the same rule was missing.
   *
   * Only the message immediately before the new one is rescued this way. Older exchanges dropping out
   * is ordinary and is what the marker is for; losing the turn being answered is not.
   */
  if (start === history.length - 1 && start > 0) {
    const prev = history[start - 1]!;
    const room = Math.max(0, maxChars - used);
    if (room > TRUNCATED_RESULT_MARKER.length) {
      return [
        { role: "user", content: HISTORY_TRIMMED_MARKER },
        { ...prev, content: cutMiddle(prev.content, room) },
        ...history.slice(start),
      ];
    }
  }
  return [...briefPrefix(history.slice(0, start), maxChars - used), ...history.slice(start)];
}

/**
 * The head of a trimmed history: the cut marker, plus the compaction brief if one was among the
 * turns being dropped — cut in the middle rather than lost, on the same principle as the rescue
 * above. What room is left after the surviving tail is what the brief gets; if there is none it goes,
 * because a brief with no conversation after it is not worth the window either.
 */
function briefPrefix(dropped: readonly ChatTurn[], room: number): ChatTurn[] {
  const marker: ChatTurn = { role: "user", content: HISTORY_TRIMMED_MARKER };
  const brief = dropped.find(isCompactionBrief);
  if (!brief) return [marker];
  const budget = room - HISTORY_TRIMMED_MARKER.length;
  if (budget <= COMPACTION_BRIEF_MARKER.length + TRUNCATED_RESULT_MARKER.length) return [marker];
  return [{ ...brief, content: cutMiddle(brief.content, budget) }, marker];
}

/** Marker left where messages were dropped, so the model knows its view is partial rather than
 * believing the conversation simply began there. */
export const TRIMMED_MARKER = "[Earlier messages in this turn were trimmed to fit the context window.]";

/** Marker inside a single oversized tool result. */
export const TRUNCATED_RESULT_MARKER = "\n\n[… this result was cut to fit the context window …]\n\n";

/**
 * Bound the messages of a turn IN PROGRESS, keeping the system prompt and the request that started
 * the turn no matter what else goes.
 *
 * The pre-turn `trimChatHistory` bounds what the conversation contributes, and then the tool loop
 * appends without limit: one `read_file` can add 60,000 characters, which on an 8k-window local model
 * is FOUR TIMES the entire input allowance. What happens next is the bug people actually see. The
 * prompt overflows, and a local server truncates from the FRONT — dropping the system prompt and the
 * oldest messages, which is precisely where the task instruction and the reader's explicit request
 * live. The assistant reads a large file and immediately no longer knows what it was doing, because
 * literally it no longer has it.
 *
 * So the trimming happens here, where what matters can be protected:
 *
 *  - The SYSTEM prompt is pinned. It is who the assistant is and what it can do.
 *  - The message that STARTED the turn is pinned. Everything in the turn is in service of it, and
 *    dropping-oldest — the obvious policy — deletes exactly that first.
 *  - What goes is the middle: older conversation, then older tool results, oldest first.
 *  - The newest result is kept even when it alone exceeds the budget, truncated in the middle with a
 *    marker. Dropping it entirely would answer "read this file" with nothing, which is a different
 *    failure and no better.
 *
 * `pinnedIndex` is the position of the turn's originating message (the caller's history length — its
 * last entry is the new user message). PURE.
 */
export function trimTurnMessages(messages: ChatTurn[], pinnedIndex: number, maxChars: number): ChatTurn[] {
  if (!(maxChars > 0) || messages.length === 0) return messages;
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= maxChars) return messages;

  const pinned = new Set<number>([0]);
  if (pinnedIndex > 0 && pinnedIndex < messages.length) pinned.add(pinnedIndex);
  // The marker itself costs context, so it comes out of the budget rather than being added on top —
  // a bound that is quietly exceeded by its own bookkeeping is not a bound.
  const budget = Math.max(0, maxChars - TRIMMED_MARKER.length);
  let pinnedChars = 0;
  for (const i of pinned) pinnedChars += messages[i]!.content.length;

  /**
   * Room for everything that is NOT pinned.
   *
   * Normally that is what the pinned content leaves. But the pinned content can exceed the budget on
   * its own — a system prompt of role, tools, identity notes, memories and skills routinely runs to
   * tens of thousands of characters — and when it does, throwing the conversation away CANNOT bring
   * the prompt under the limit. It is pure loss: the overflow is still there and the conversation is
   * gone. That is not a hypothetical; it deleted every message of even a three-turn chat and left the
   * model reading the "earlier messages were trimmed" marker, which it then reported to the reader as
   * the conversation having evaporated.
   *
   * So when trimming cannot help, it doesn't happen at the conversation's expense: a guaranteed share
   * survives, and the prompt is over budget either way.
   */
  const room = Math.max(budget - pinnedChars, Math.floor(budget * MIN_HISTORY_SHARE));

  // A contiguous tail, newest first — a coherent recent conversation beats a denser scattered one.
  const keep = new Set(pinned);
  let used = 0;
  let lastFits = true;
  for (let i = messages.length - 1; i > 0; i--) {
    if (keep.has(i)) continue;
    const len = messages[i]!.content.length;
    if (used + len > room) {
      // The newest message alone doesn't fit: keep it, cut its middle.
      if (i === messages.length - 1) lastFits = false;
      break;
    }
    used += len;
    keep.add(i);
  }

  const out: ChatTurn[] = [];
  let dropped = false;
  let saidSo = false; // one marker is enough — the model needs to know THAT it was trimmed, not where
  for (let i = 0; i < messages.length; i++) {
    const isLast = i === messages.length - 1;
    if (!keep.has(i) && !(isLast && !lastFits)) {
      dropped = true;
      continue;
    }
    if (dropped && !saidSo) {
      out.push({ role: "user", content: TRIMMED_MARKER });
      saidSo = true;
    }
    dropped = false;
    const msg = messages[i]!;
    out.push(isLast && !lastFits ? { ...msg, content: cutMiddle(msg.content, Math.max(0, room - used)) } : msg);
  }
  return out;
}

/** Keep a value's head and tail, cutting the middle — the ends of a file or a search result carry
 * more than its centre, and the model is told the cut happened. PURE. */
function cutMiddle(text: string, budget: number): string {
  if (budget <= TRUNCATED_RESULT_MARKER.length || text.length <= budget) return text;
  const room = budget - TRUNCATED_RESULT_MARKER.length;
  const head = Math.ceil(room * 0.6);
  return text.slice(0, head) + TRUNCATED_RESULT_MARKER + text.slice(text.length - (room - head));
}

export async function runChatTurn(opts: {
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
    // Re-bound before every call: the loop below appends tool results, and a single large
    // one can exceed the whole window. Pins the system prompt and the request that started
    // the turn, which is what a plain drop-oldest policy would delete first.
    const sent = opts.contextChars
      ? trimTurnMessages(messages, opts.history.length, opts.contextChars)
      : messages;
    const settled = opts.llm.chat(sent, {
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
      // At the tool-round cap the model may STILL be emitting a tool call — parseToolCall was
      // skipped above, so without this the raw JSON would be shown verbatim as the answer
      // (mirrors runBuddyTurn's strip + fallback path).
      let answer = reply;
      if (round >= MAX_TOOL_ROUNDS && looksLikeToolJson(reply)) {
        answer =
          stripToolCallJson(reply).trim() ||
          "I hit the tool limit for this message before I could finish — see the results above, or ask again and I'll continue.";
      }
      // AUTO-CONTINUE a CUT-OFF answer and stitch the parts so a long document isn't capped at one
      // reply (mirrors runBuddyTurn). Pure prose only — a final answer never carries a tool call.
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
      call.tool === "generate_video" ||
      call.tool === "generate_long_video" ||
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
  call: Exclude<ToolCall, { tool: "generate_image" | "generate_video" | "generate_long_video" | "export_book" | "export_data" | "set_cell" | "add_formula_column" }>,
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

/** A stamp already on a turn — so re-building history can never nest one inside another. */
// The trailing space is OPTIONAL. Requiring it missed the case that mattered most: a reply that is
// the stamp and NOTHING else, which is what the model produced when it mistook the prefix for a turn
// delimiter. The stricter pattern left that unrecognised and unstripped.
// Seconds are OPTIONAL in the pattern and always WRITTEN. Two different jobs: what gets written is
// the new format, but what gets matched has to include every stamp already sitting in a stored
// history — a reader's chat outlives a format change, and a stamp that stops being recognised stops
// being stripped, which puts a bare `[2026-08-03 10:05]` back in front of an old message and back
// into the model's mouth as something to imitate.
const TURN_STAMP = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?\]\s*/;

/**
 * Strip a stamp off the front of a message.
 *
 * The counterpart that makes stamping safe to apply to the ASSISTANT'S OWN turns. A model shown its
 * prior replies with a `[…]` prefix will eventually write one itself — and a stamp the model wrote is
 * a guess, which would then be stored, re-read, and treated as the authoritative time. Stripping
 * before stamping means the app's clock always wins and a mimicked prefix costs nothing. That is the
 * difference between a convention the model must be told to follow and one it cannot break. PURE.
 */
/**
 * The assistant's own time, written where it cannot be mistaken for the start of a turn.
 *
 * Its replies DO need dating — a scheduled run or a piece of unattended work has no reader message
 * beside it to be dated by, and "when did I last do this" is exactly the question that arises then.
 * But a leading `[…]` on every message is a turn DELIMITER, and the model produced one instead of an
 * answer (see the note on TURN_STAMP). A trailing marker cannot be produced *instead of* content: to
 * write it the model has to have written the reply first. If it imitates this one, the cost is a line
 * at the end that gets stripped, not a turn that says nothing.
 */
const ASSISTANT_STAMP = /\n?\[sent \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?\]\s*$/;

/**
 * `YYYY-MM-DD HH:MM:SS.mmm` in local time — the one place the stamp format is decided.
 *
 * Minutes couldn't order the things that happen inside one, and seconds can't either: this app
 * writes several turns programmatically in a burst — a scheduled run, an auto-advancing checklist,
 * a story beat and its render — and those land far closer together than a second. "What did you do,
 * and in what order" is exactly what these stamps are read for.
 *
 * MILLISECONDS, not tenths or hundredths, because `at` IS a millisecond value. Rounding to a coarser
 * unit means two different timestamps can print identically — the same collision, one decimal place
 * further down — and a stamp that can't distinguish two events is the thing being fixed. Printing
 * the number in full also makes the stamp a faithful rendering of what was stored rather than a
 * lossy view of it, which matters the moment anyone compares one against a stored `at`. PURE.
 */
export function stampClock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`
  );
}

export function stampAssistantContent(content: string, at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return content;
  const body = content.replace(ASSISTANT_STAMP, "");
  if (!body.trim()) return content;
  return `${body}\n[sent ${stampClock(at)}]`;
}

/** Remove either stamp the app adds — the reader's leading one, or the assistant's trailing one. */
export function stripTurnStamp(content: string): string {
  return content.replace(TURN_STAMP, "").replace(ASSISTANT_STAMP, "");
}

/**
 * Whether a reply is NOTHING BUT a timestamp the model wrote.
 *
 * Observed on a 3B local model: the reasoning block held a complete, correct plan and the reply was
 * "[2026-08-02 10:05]" and nothing else — the model continuing the transcript pattern instead of
 * answering. Stored and shown, that is an empty bubble the reader has to interpret; named, it is a
 * turn that produced nothing, which is a thing the app already knows how to say. PURE.
 */
export function isOnlyTurnStamp(content: string): boolean {
  const body = content.trim();
  return body.length > 0 && stripTurnStamp(body).trim().length === 0;
}

/**
 * Put the time a message was sent in front of it, for the model to read.
 *
 * A conversation handed to a model is a flat list with no clock in it: "yesterday", "this morning"
 * and "three weeks ago" all look like the line above. That is fine for one sitting and wrong for an
 * assistant that keeps a chat for months, resumes it from a phone, and is woken by scheduled runs —
 * it re-raises settled things as news and treats stale answers as current. Today's date is already
 * at the top of the prompt, so these line up directly against it.
 *
 * Idempotent, because history is rebuilt from storage on every turn. PURE.
 */
export function stampTurnContent(content: string, at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return content;
  if (TURN_STAMP.test(content)) return content;
  return `[${stampClock(at)}] ${content}`;
}

/**
 * Whether this turn's opening text is the APP talking, not the reader.
 *
 * The clock above exists for the reader's messages, where it answers a real question — how long ago
 * was this said. A step directive is not a message and has no such question: it is the app handing
 * over the next instruction, and stamping it made it read as one more thing the reader typed at a
 * specific moment. The model said so, in reasoning the reader never saw: "The user's prompt in this
 * specific turn [2026-08-13 13:16:43.860] is the system telling me to do step 1" — it had worked out
 * the truth and was spending its budget arguing with the format.
 *
 * Every app-authored injection in this codebase is wrapped in square brackets and nothing the reader
 * types is, which is why the shape is the test rather than a flag threaded through six call sites.
 * A reader who does type a bracketed line loses a timestamp and nothing else. PURE.
 */
export function isAppDirective(content: string): boolean {
  const t = content.trim();
  return t.startsWith("[") && t.endsWith("]");
}
