/**
 * Technical-mode reading support — pure text-anchoring helpers that place the
 * bible's knowledge NEXT TO the prose that produced it. Technical books don't
 * get generated art; instead the reader column marks key concepts where they
 * first appear (with the extraction's plain-language explanation) and anchors
 * each retrieved figure to the paragraph it illustrates, so support scrolls
 * WITH its source text instead of living in a detached sticky pane.
 */

export interface ConceptIntro {
  term: string;
  definition: string;
  /** Paragraph (within the page) where the term first appears in the book. */
  paragraphIndex: number;
}

/** Glossary terms that aren't reader-facing concepts (grounding citations). */
function isConceptTerm(term: string): boolean {
  return term.length >= 3 && term.length <= 80 && !/^references \(/i.test(term);
}

/** Case-insensitive whole-word search (a trailing plural "s" counts); -1 when absent. */
function wordIndexOf(haystackLower: string, needleLower: string): number {
  let from = 0;
  for (;;) {
    const i = haystackLower.indexOf(needleLower, from);
    if (i === -1) return -1;
    const before = i === 0 ? "" : haystackLower[i - 1]!;
    let end = i + needleLower.length;
    if (haystackLower[end] === "s") end++; // "chain" still introduces "chains"
    const after = haystackLower[end] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return i;
    from = i + 1;
  }
}

/**
 * Where each glossary concept is FIRST mentioned in the book → per-page intro
 * cards. One pass over the paragraphs; each term claims its first hit only, so
 * a concept introduces itself exactly once however often it recurs.
 */
export function conceptIntroductions(
  pages: readonly { paragraphs: readonly { text: string }[] }[],
  glossary: readonly { term: string; definition: string }[],
): Map<number, ConceptIntro[]> {
  const result = new Map<number, ConceptIntro[]>();
  const pending = new Map<string, { term: string; definition: string }>();
  for (const g of glossary) {
    const term = g.term.trim();
    if (isConceptTerm(term) && g.definition.trim()) pending.set(term.toLowerCase(), { term, definition: g.definition });
  }
  for (let p = 0; p < pages.length && pending.size > 0; p++) {
    const paragraphs = pages[p]!.paragraphs;
    for (let i = 0; i < paragraphs.length && pending.size > 0; i++) {
      const lower = paragraphs[i]!.text.toLowerCase();
      for (const [key, entry] of pending) {
        if (wordIndexOf(lower, key) === -1) continue;
        pending.delete(key);
        const list = result.get(p) ?? [];
        list.push({ term: entry.term, definition: entry.definition, paragraphIndex: i });
        result.set(p, list);
      }
    }
  }
  for (const list of result.values()) list.sort((a, b) => a.paragraphIndex - b.paragraphIndex);
  return result;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "over", "under", "that", "this",
  "these", "those", "their", "between", "diagram", "chart", "figure", "image",
  "view", "showing", "shows", "process", "step", "steps",
]);

/**
 * The paragraph a figure belongs next to: highest overlap between the figure
 * subject's significant words and the paragraph text. Falls back to 0 (top of
 * the page) when nothing matches — the figure still shows, just unanchored.
 */
export function bestParagraphIndex(paragraphs: readonly string[], subject: string): number {
  const tokens = subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
  if (tokens.length === 0) return 0;
  let best = 0;
  let bestScore = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const lower = paragraphs[i]!.toLowerCase();
    let score = 0;
    for (const t of tokens) if (lower.includes(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export interface TextSegment {
  text: string;
  /** Set when this segment is a glossary-term match (render highlighted). */
  term?: string;
}

/**
 * Split a paragraph into plain/highlighted segments for <mark>-style rendering
 * of the bible's concepts. Whole-word, case-insensitive, longest term wins at a
 * given position; the original casing of the text is preserved.
 */
export function segmentByTerms(text: string, terms: readonly string[]): TextSegment[] {
  const usable = terms.filter(isConceptTerm);
  if (usable.length === 0 || !text) return [{ text }];
  // Longest-first alternation so "Krebs cycle" beats "cycle" at the same spot.
  const pattern = usable
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`(?<![a-z0-9])(?:${pattern})s?(?![a-z0-9])`, "gi");
  const segments: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index;
    if (i > last) segments.push({ text: text.slice(last, i) });
    segments.push({ text: m[0], term: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments.length > 0 ? segments : [{ text }];
}

/** Pull the searched concept back out of a figure caption / skip note. */
export function subjectFromCaption(caption: string): string | undefined {
  const m = /[“"]([^”"]+)[”"]/.exec(caption);
  return m?.[1];
}
