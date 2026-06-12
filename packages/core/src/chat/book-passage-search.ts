/**
 * Keyword search over the book's own text, for the in-book chat's `search_book`
 * tool. The chat only keeps a small recent window of the book in its context (so
 * a simple request like "draw an apple" doesn't pay to re-read the whole book
 * every turn); when the reader asks about something elsewhere in the book, the
 * model calls this to pull the relevant passages on demand.
 *
 * Paragraph-level scoring — cheap, no index — runs only on an explicit tool call.
 */

export interface BookPassage {
  chapterIndex: number;
  chapterTitle?: string;
  /** The matching paragraph (truncated). */
  text: string;
}

/** Common words that shouldn't drive a match (kept tiny; real terms carry it). */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "who", "whom", "when", "where", "why",
  "how", "does", "did", "was", "were", "are", "into", "from", "your", "you", "his", "her",
  "their", "they", "them", "about", "have", "has", "had", "but", "not", "all", "any",
]);

export function searchBookPassages(
  chapters: readonly { index: number; title?: string; text: string }[],
  query: string,
  count = 3,
  maxChars = 700,
): BookPassage[] {
  // Unicode-aware split: an ASCII-only class would mangle accented/non-Latin
  // queries ("café" → "caf", a CJK query → nothing). Keep the >2 length filter
  // for Latin noise words but let short non-Latin tokens (CJK words) through.
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && (t.length > 2 || /\P{ASCII}/u.test(t)));
  if (terms.length === 0) return [];
  const scored: { score: number; passage: BookPassage }[] = [];
  for (const ch of chapters) {
    for (const para of ch.text.split(/\n{2,}/)) {
      const lower = para.toLowerCase();
      let score = 0;
      const seen = new Set<string>();
      for (const t of terms) {
        let idx = lower.indexOf(t);
        if (idx === -1) continue;
        seen.add(t);
        while (idx !== -1) {
          score += 1;
          idx = lower.indexOf(t, idx + t.length);
        }
      }
      // Distinct-term coverage dominates raw frequency: a paragraph hitting two
      // of the query's words beats one that repeats a single word.
      if (score > 0) {
        scored.push({
          score: seen.size * 100 + score,
          passage: {
            chapterIndex: ch.index,
            ...(ch.title ? { chapterTitle: ch.title } : {}),
            text: para.trim().replace(/\s+/g, " ").slice(0, maxChars),
          },
        });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((s) => s.passage);
}
