/**
 * How fast the last reply was generated — measured, because the model cannot measure it itself.
 *
 * Asked to time its own output, a model has no way to answer: it can read when the reader's message
 * was sent, but its OWN stamp is written after the reply exists, so the number it needs doesn't
 * exist yet while it is writing. Left to work it out from timestamps it will either invent a figure
 * or loop trying — which is what a "token generation speed test" turns into.
 *
 * The app is the only party that can know: it started the request and it counts the tokens as they
 * stream. So it measures, and hands the finished number to the NEXT turn as an ordinary fact.
 */

/** One measured reply: how much came out, and how long it took. */
export interface GenerationRate {
  /** Characters streamed (a token count isn't available across every provider). */
  chars: number;
  /** Wall time from request to last token. */
  ms: number;
  /** Approximate tokens — chars/4, the same rough ratio the context meter uses. */
  approxTokens: number;
  /** Approximate tokens per second, or 0 when the sample is too short to mean anything. */
  tokensPerSecond: number;
}

/** Below this the sample is noise — a two-word reply that "took" 40 ms says nothing about speed. */
const MIN_SAMPLE_MS = 250;

/** Measure a completed reply. PURE. */
export function measureGeneration(chars: number, ms: number): GenerationRate | undefined {
  if (!Number.isFinite(chars) || !Number.isFinite(ms) || chars <= 0 || ms <= 0) return undefined;
  const approxTokens = Math.max(1, Math.round(chars / 4));
  // Rounded to one decimal: the estimate is built on a chars/4 approximation, and more digits would
  // claim a precision the input doesn't have.
  const tokensPerSecond = ms >= MIN_SAMPLE_MS ? Math.round((approxTokens / (ms / 1000)) * 10) / 10 : 0;
  return { chars, ms, approxTokens, tokensPerSecond };
}

/**
 * The line the model reads. Says APPROXIMATELY, and says where the number came from, because a model
 * handed a bare figure will quote it as exact — and this is characters divided by four. PURE.
 */
export function generationRateNote(rate: GenerationRate | undefined): string {
  if (!rate) return "";
  const secs = Math.round(rate.ms / 100) / 10;
  const speed =
    rate.tokensPerSecond > 0
      ? `≈${rate.tokensPerSecond} tokens/sec`
      : "too short to time meaningfully";
  return (
    `YOUR LAST REPLY took ${secs}s and ran to ${rate.chars} characters (≈${rate.approxTokens} tokens, ${speed}). ` +
    "The app measured this — you cannot time your own reply, because your timestamp is written after " +
    "the reply exists. If asked how fast you generate, quote this rather than trying to work it out " +
    "from message timestamps, and say it is approximate (tokens are estimated from characters).\n\n"
  );
}
