/**
 * Trim the identity RECITAL off the front of visible reasoning.
 *
 * The souls ride in every system prompt, and models routinely open their reasoning by restating them
 * — "I'm <name>, warm and dry-witted, and the reader prefers…" — before getting to the actual thought.
 * It's doing its job (that's what the block is FOR), but for a reader watching the thinking bubble
 * it's the same paragraph every single turn, pushing the part they actually want out of view.
 *
 * So this is a DISPLAY filter, not a change to what the model does. It works off the real soul notes
 * rather than guessed keywords: a leading sentence only counts as recital when it's substantially
 * made of the identity text that was fed in. That keeps ordinary reasoning safe — "I should check
 * what they said about the marsh survey" can't match notes it shares no vocabulary with.
 *
 * Three hard limits, because eating real reasoning is far worse than showing a stale paragraph:
 *  - it only ever removes a PREFIX, and stops at the first sentence that isn't recital;
 *  - it gives up after {@link MAX_STRIPPED_UNITS} sentences — a whole essay of "recital" is a sign
 *    the test is wrong, not that the model recited for six paragraphs;
 *  - with no identity to match against, it does nothing at all.
 * PURE.
 */

/** How many leading sentences may be dropped before this stops trusting itself. */
export const MAX_STRIPPED_UNITS = 6;
/** Share of a sentence's meaningful words that must come from the identity text to call it recital. */
const RECITAL_OVERLAP = 0.6;
/** Below this many meaningful words a sentence is too short to judge by overlap ("I'm Sage." would
 * match almost anything), so it's only dropped when it's a verbatim quote or names the blocks. */
const MIN_WORDS_FOR_OVERLAP = 4;
/** Common words carry no signal about whether a sentence is reciting an identity. */
const STOPWORDS = new Set([
  "about", "also", "and", "are", "because", "been", "being", "both", "but", "can", "could", "does",
  "doesn", "for", "from", "had", "has", "have", "her", "here", "hers", "him", "his", "how", "into",
  "its", "just", "like", "make", "more", "most", "much", "must", "not", "now", "one", "only", "other",
  "our", "out", "over", "own", "same", "she", "should", "some", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "though", "through", "very", "was", "were",
  "what", "when", "where", "which", "while", "who", "will", "with", "would", "you", "your",
]);
/**
 * Phrases that NAME the prompt blocks. A sentence containing one is talking ABOUT its identity rather
 * than thinking with it, so it's recital regardless of word overlap — this is what catches "Per my
 * identity notes, I should keep the tone dry", which shares little vocabulary with the notes.
 */
const BLOCK_PHRASES = [
  "who you are",
  "who the reader is",
  "identity note",
  "soul note",
  "my persona",
  "my identity",
  "my own identity",
  "the reader's identity",
  "durable identity",
];

/** The identity text a turn was given: both souls' notes and their character names. */
export interface IdentityContext {
  notes: readonly string[];
  names: readonly string[];
}

function meaningfulWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Cut text into sentences, KEEPING the whitespace that follows each one so the pieces re-join into
 * exactly the original string. Written as a scan rather than a lookbehind split — Safari didn't take
 * lookbehind until fairly recently and a linked phone may well be an older one.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const isBreak = ch === "\n" || ((ch === "." || ch === "!" || ch === "?") && /\s/.test(text[i + 1] ?? " "));
    if (!isBreak) continue;
    let end = i + 1;
    while (end < text.length && /\s/.test(text[end]!)) end++; // trailing whitespace rides with the sentence
    out.push(text.slice(start, end));
    start = end;
    i = end - 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** True when a sentence is restating the identity it was given rather than reasoning with it. */
export function isIdentityRecital(sentence: string, identity: IdentityContext): boolean {
  const trimmed = sentence.trim();
  if (!trimmed) return true; // blank lines between recital sentences shouldn't end the run
  const lower = normalize(trimmed);
  if (BLOCK_PHRASES.some((p) => lower.includes(p))) return true;
  // A verbatim quote of a note — the most common form, and unambiguous. Both directions: the model
  // quotes a whole note inside a longer sentence, or lifts a clause OUT of a longer note ("The reader
  // is a keen gardener." from "…gardener and dislikes spoilers"). The second needs a length floor so
  // an incidental few words that happen to appear in a note can't trigger it.
  const bare = lower.replace(/[.,;:!?]+$/, "");
  for (const note of identity.notes) {
    const n = normalize(note);
    if (n.length >= 12 && lower.includes(n)) return true;
    if (bare.length >= 20 && n.includes(bare)) return true;
  }
  const words = meaningfulWords(trimmed);
  if (words.length < MIN_WORDS_FOR_OVERLAP) return false;
  const corpus = new Set(identity.notes.flatMap(meaningfulWords));
  for (const name of identity.names) for (const w of meaningfulWords(name)) corpus.add(w);
  if (corpus.size === 0) return false;
  const hits = words.filter((w) => corpus.has(w)).length;
  return hits / words.length >= RECITAL_OVERLAP;
}

/**
 * The reasoning worth showing: the same text with any leading identity recital removed.
 *
 * Returns "" when the whole thing was recital — there is genuinely no reasoning to show, and the
 * caller hides an empty bubble. Returns the text UNCHANGED when there's no identity to match, when
 * nothing leading looks like recital, or when the prefix ran past {@link MAX_STRIPPED_UNITS}.
 */
export function stripIdentityRecital(thinking: string, identity: IdentityContext): string {
  if (!thinking.trim()) return thinking;
  if (identity.notes.length === 0 && identity.names.length === 0) return thinking;
  const sentences = splitSentences(thinking);
  let cut = 0;
  while (cut < sentences.length && isIdentityRecital(sentences[cut]!, identity)) cut++;
  if (cut === 0) return thinking;
  // Too much of it read as recital to believe the test — show the reasoning as it came, whether or
  // not anything followed. A model reciting for six sentences is far less likely than a bad match.
  if (cut > MAX_STRIPPED_UNITS) return thinking;
  return sentences.slice(cut).join("").replace(/^\s+/, "");
}
