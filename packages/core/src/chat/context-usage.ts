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
  opts: { budgetChars: number; maxTokens?: number; droppedChars?: number },
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
  if (!usage?.maxTokens || usage.maxTokens <= 0) return false;
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
  return usage.approxTokens >= usage.maxTokens * fraction;
}
