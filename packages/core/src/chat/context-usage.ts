import type { ChatTurn } from "../providers/llm/chat.js";

/**
 * Context-usage accounting for the chat panels: how much of the model's window
 * each part of the request is consuming (book vs. bible vs. chat history vs. the
 * reader's own message vs. instructions). Powers the usage donut so a reader can
 * see WHY a small-context local model is dropping things, and what to compact.
 *
 * Token counts are an estimate — the real tokenizer differs per model and isn't
 * available client-side — so everything is labelled "approx" in the UI. ~4 chars
 * per token is the long-standing English-prose rule of thumb and is close enough
 * to make the proportions and the "are we near the limit?" call meaningful.
 */

/** Average characters per token for English prose (estimate; see file note). */
export const CHARS_PER_TOKEN = 4;

/**
 * How much of the request's capacity has to be LOST before compacting on loss alone.
 *
 * A tenth is roughly an exchange, not a trimmed sentence. The fraction test is the primary trigger
 * and fires before any loss at all; this is the backstop for the case it cannot see coming — a single
 * message so large that one turn goes from comfortable to over budget.
 */
const SIGNIFICANT_LOSS = 0.1;

export function approxTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * WHAT A COMPACTION MAY SPEND, AND WHAT IT MAY READ.
 *
 * The summary call was a flat `maxTokens: 1024` with no thinking bound and an input capped by
 * `slice(-120_000)`. Three separate problems in one line:
 *
 *  - 1024 is the whole allowance on a THINKING model, where reasoning and reply come out of the same
 *    budget. Deliberate for a few hundred tokens about how to structure a brief and there is nothing
 *    left to write it with — the call returns an empty string and compaction fails, on a chat that is
 *    over budget precisely because it needed compacting.
 *  - A flat budget ignores how much is being compressed. Twenty exchanges and two hundred get the
 *    same room.
 *  - `slice(-120_000)` keeps the TAIL. The tail is the part still in the conversation; the HEAD is
 *    what compaction exists to rescue, and it was the part being thrown away.
 *
 * The output is bounded at both ends for a reason that is easy to miss: the brief is injected into
 * every later prompt. A summary that is too big is not a better summary, it is a permanent tax on the
 * window it was meant to relieve. PURE.
 */
export interface CompactionBudget {
  /** Generation cap for the summary call — reply AND any reasoning, on a local model. */
  maxTokens: number;
  /** Bound on reasoning, so deliberation cannot consume the whole generation. */
  thinkingBudgetChars: number;
  /** Most transcript characters to feed in. */
  inputCap: number;
}

/** Never so terse it cannot carry decisions, names and open questions. */
const MIN_SUMMARY_TOKENS = 400;
/** The brief rides in EVERY later prompt: past this it costs more than it saves. */
const MAX_SUMMARY_TOKENS = 1_500;
/** Roughly 1 summary token per this many transcript characters — about a 40:1 compression. */
const COMPRESSION = 40;
/** Reasoning allowance, on top of the summary itself. Enough to plan a brief, not to draft one. */
const SUMMARY_THINKING_CHARS = 2_000;

export function compactionBudget(transcriptChars: number, inputCeilingTokens?: number): CompactionBudget {
  const wanted = Math.round(transcriptChars / COMPRESSION);
  const summary = Math.min(MAX_SUMMARY_TOKENS, Math.max(MIN_SUMMARY_TOKENS, wanted));
  return {
    // The generation has to cover the reasoning as well, or the bound below is the thing that starves
    // the summary rather than the thing that protects it.
    maxTokens: summary + Math.ceil(SUMMARY_THINKING_CHARS / CHARS_PER_TOKEN),
    thinkingBudgetChars: SUMMARY_THINKING_CHARS,
    // Read as much as the model can actually hold, leaving room for the summary it has to write.
    // Without a known ceiling, the old fixed cap stands.
    inputCap: inputCeilingTokens
      ? Math.max(20_000, (inputCeilingTokens - summary) * CHARS_PER_TOKEN)
      : 120_000,
  };
}

/**
 * Fit a transcript to `maxChars` by cutting its MIDDLE, keeping both ends.
 *
 * The head is where a conversation's decisions, names and constraints are established, and it is the
 * only copy — everything after compaction is derived from this. The tail is what the reader just
 * said. Dropping either loses the run; the middle is the part a brief can most afford to lose, and
 * the cut is announced so the model does not read the join as continuous. PURE.
 */
export function boundTranscript(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[… a stretch of the middle of this conversation is not shown …]\n\n";
  const room = Math.max(0, maxChars - marker.length);
  // The OPENING gets the larger share: it carries what was decided, which the tail assumes.
  const head = Math.ceil(room * 0.55);
  return text.slice(0, head) + marker + text.slice(text.length - (room - head));
}

/** A labelled slice of the request, with its size in characters. */
export interface ContextSegment {
  key: string;
  label: string;
  chars: number;
}

export interface ContextUsage {
  /** Non-empty segments, largest first. */
  segments: ContextSegment[];
  totalChars: number;
  approxTokens: number;
  /** The model's context window in tokens, when known (local models report it). */
  maxTokens?: number;
  /**
   * THE MOST THE REQUEST CAN ACTUALLY OCCUPY — which is NOT the window.
   *
   * A large share of the window is reserved for the REPLY (40% on a local model), so the input can
   * never reach the window at all: on a 50k-token window the ceiling is 27k, and a completely full
   * chat reads as "54% of window". A reader watching that number sees a chat half empty while the app
   * is discarding turns to keep it there, which is exactly how it was reported — "why would it
   * compact here at 54% context?" It compacted because 54% WAS full.
   *
   * The same mistake sat in {@link shouldAutoCompact}: 0.8 of the window is 40k tokens on that setup,
   * and the numerator is capped at 27k, so the threshold could not be crossed on a local model no
   * matter how full the conversation got.
   */
  inputTokens?: number;
  /** The book/history char budget the worker targeted for this provider. */
  budgetChars: number;
  /**
   * CONVERSATION THAT DID NOT FIT AND WAS CUT before the request was built — not part of the
   * segments above, because those describe what was SENT.
   *
   * Without this the two numbers a reader and the app rely on are both measured after the loss. The
   * donut reads "44% of window" while earlier turns are being thrown away, and — the part that
   * mattered — {@link shouldAutoCompact} reads the same figure, so the mechanism whose whole job is
   * to summarise a conversation BEFORE trimming destroys it could never fire: trimming holds the
   * usage down, and the usage is what was supposed to trigger the alternative to trimming.
   */
  droppedChars?: number;
}

/** Build a usage breakdown from labelled parts; empties dropped, largest first. */
export function measureContextUsage(
  parts: readonly { key: string; label: string; text: string }[],
  opts: { budgetChars: number; maxTokens?: number; droppedChars?: number; inputTokens?: number },
): ContextUsage {
  const segments = parts
    .map((p) => ({ key: p.key, label: p.label, chars: p.text.length }))
    .filter((s) => s.chars > 0)
    .sort((a, b) => b.chars - a.chars);
  const totalChars = segments.reduce((a, s) => a + s.chars, 0);
  return {
    segments,
    totalChars,
    approxTokens: approxTokens(totalChars),
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    budgetChars: opts.budgetChars,
    ...(opts.droppedChars ? { droppedChars: opts.droppedChars } : {}),
    ...(opts.inputTokens ? { inputTokens: opts.inputTokens } : {}),
  };
}

/** The history + the new user message as one "chat" measurement part. Separating
 * the live message from prior turns lets the donut show "your message" distinctly. */
export function chatTurnsChars(history: readonly ChatTurn[]): number {
  return history.reduce((a, t) => a + t.content.length, 0);
}

/**
 * Whether the chat is close enough to the model's window that it should AUTO-COMPACT (summarize the
 * older turns, keep the recent ones) before the next turn trims early decisions out of context. Needs a
 * known window, a non-trivial conversation, and usage past `fraction` of the window. PURE. */
export function shouldAutoCompact(
  usage: ContextUsage | undefined,
  messageCount: number,
  opts?: { fraction?: number; minMessages?: number },
): boolean {
  const fraction = opts?.fraction ?? 0.8;
  const minMessages = opts?.minMessages ?? 8;
  const ceiling = usage?.inputTokens ?? usage?.maxTokens;
  if (!usage || !ceiling || ceiling <= 0) return false;
  if (messageCount < minMessages) return false;
  /**
   * LOSING CONVERSATION IS A SIGNAL — but "any loss at all" was far too sharp a reading of it, and
   * the correction matters more than the original fix did.
   *
   * Two changes shipped together. `inputTokens` made the fraction test below WORK: it had been
   * measured against the whole window, which the request can never reach, so on a local model it had
   * never once fired. That alone is the mechanism, and it fires at 80% of what the request can hold —
   * BEFORE anything is lost, which is the whole point of compacting.
   *
   * This test fired on the first dropped CHARACTER, on top of that, and auto-compaction is not a
   * gentle thing: it replaces the entire history with a summary and keeps six recent messages. So a
   * chat that had never been compacted in its life was suddenly being summarised most turns.
   *
   * Reported as souls blurring into each other, reference photos losing their subject, and physical
   * descriptions going missing — which is precisely what a summary does to two similar characters and
   * a list of specifics. The reader had also asked, one screenshot earlier, why it was compacting at
   * 54%, and the honest answer turned out to be "because I told it to".
   *
   * So the threshold is real loss, not a nick: an exchange's worth, not a trimmed sentence. Below
   * that, the fraction test above has already had its chance and trimming is doing its ordinary job.
   */
  const lostALot = (usage.droppedChars ?? 0) >= ceiling * CHARS_PER_TOKEN * SIGNIFICANT_LOSS;
  if (lostALot) return true;
  // Against the ceiling the request can REACH, not the whole window — see `inputTokens`. Measured
  // against the window this comparison was unreachable on a local model and did nothing.
  return usage.approxTokens >= ceiling * fraction;
}
