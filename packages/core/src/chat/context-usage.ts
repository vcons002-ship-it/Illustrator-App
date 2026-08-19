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

export function approxTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
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
   * ALREADY LOSING CONVERSATION IS THE STRONGEST POSSIBLE SIGNAL, and it used to be invisible here.
   *
   * The fraction test alone asks "are we NEARLY full?" of a figure measured on the history that
   * survived trimming — which is, by construction, never over budget. So on a small window the app
   * trimmed quietly turn after turn and the donut sat at 44%, and this returned false every time. The
   * one mechanism that preserves meaning rather than discarding it was gated on a number that the
   * discarding kept low.
   *
   * If anything was dropped, summarising is not "soon" — it is overdue.
   */
  if (usage.droppedChars && usage.droppedChars > 0) return true;
  // Against the ceiling the request can REACH, not the whole window — see `inputTokens`. Measured
  // against the window this comparison was unreachable on a local model and did nothing.
  return usage.approxTokens >= ceiling * fraction;
}
