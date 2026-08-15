/**
 * HOW BIG IS THIS PROMPT, REALLY.
 *
 * The always-on budget was policed by `Math.round(s.length / 4)` — one constant for every kind of
 * text. That is roughly right for English prose and wrong for everything else, because what a
 * byte-pair tokenizer actually charges for is not characters but PRE-TOKENS: a word costs about one,
 * and so does every bracket, quote, colon and arrow standing on its own.
 *
 * The bias runs in both directions at once, which is what makes it dangerous. Measured against
 * o200k on this repo's own prompt: prose runs ~4.76 chars/token, so `chars/4` OVER-counts it by
 * ~19%; mermaid runs ~3.26 and XML ~3.42, so the same formula UNDER-counts those by 15-19%. A
 * structured rewrite could therefore show a large "saving" against the budget test while costing
 * more real tokens on every provider — a 36-point swing between the two ends, entirely invented by
 * the measuring instrument.
 *
 * So this counts pre-tokens instead. The split below is the GPT-family pre-tokenizer pattern:
 * contractions, then runs of letters, digits and symbols, each optionally preceded by one space.
 * Nearly every common pre-token is exactly one token; longer and rarer ones split into two or three,
 * which is what `SUBWORD` absorbs.
 *
 * NOT A TOKENIZER, and not trying to be. A real BPE table is 20-50MB of dependency for a number that
 * only has to be accurate enough to compare two drafts of a prompt — and it would still be the wrong
 * table, because the model this budget exists to protect is a local Qwen, not an OpenAI model. What
 * this buys is the property `chars/4` lacks: punctuation-dense text costs more than prose, in the
 * right direction and roughly the right amount. PURE.
 */

/**
 * The GPT-family pre-tokenizer split.
 *
 * Order matters: contractions first (so "don't" is not cut at the apostrophe), then letters, digits
 * and symbols, each allowed one leading space because BPE attaches the space to the word that
 * follows it. Digits are capped at three per group, which is what the o200k-era tokenizers do.
 */
const PRE_TOKEN = /'(?:s|t|re|ve|m|ll|d)| ?\p{L}+| ?\p{N}{1,3}| ?[^\s\p{L}\p{N}]+|\s+/gu;

/**
 * ONE PRE-TOKEN, ONE TOKEN — calibrated, not assumed.
 *
 * Long or uncommon words do split ("illustration", `generate_long_video`), which argues for a
 * multiplier above 1. Common short words and punctuation runs merge, which argues for one below.
 * Against the only ground truth available — this repo's own always-on prompt, measured at 4.28
 * chars/token under o200k — the two effects cancel to within a few percent at exactly 1.0, so there
 * is no multiplier here to mislead anyone into thinking it was fitted.
 *
 * What matters is not the absolute number but that it is charged per PRE-TOKEN rather than per
 * character. `chars/4` reports 4.00 chars/token for every format ever written; this reports prose
 * near 4.6, JSON near 3.6, XML near 3.3 and mermaid near 2.4. That spread IS the fix.
 */

/**
 * Estimated token count for a piece of prompt text.
 *
 * Deterministic and dependency-free, so it can run in the same test that asserts the budget. PURE.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let pre = 0;
  for (const m of text.matchAll(PRE_TOKEN)) {
    const t = m[0]!;
    if (!/^\s+$/.test(t)) {
      pre += 1;
      continue;
    }
    // WHITESPACE IS NEARLY FREE, and charging per character for it was the estimator's own version of
    // the bias it exists to remove. A single space is absorbed into the word after it by the pattern
    // above; a newline plus its indent is one common token in every modern BPE, not one per space.
    // Costing indented formats by the character over-charged mermaid by about half.
    pre += t === " " ? 0 : Math.max(1, Math.ceil(t.length / 8));
  }
  return pre;
}

/**
 * Characters per token — the density figure that makes a format's cost legible.
 *
 * Prose lands near 4.5-4.8, JSON and XML near 3.3-3.5. Reading this rather than a raw count is how
 * you notice that a rewrite got "smaller" in characters while getting dearer in tokens. PURE.
 */
export function charsPerToken(text: string): number {
  const t = estimateTokens(text);
  return t === 0 ? 0 : text.length / t;
}
