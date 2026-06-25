import type { VisualBible } from "../types/bible.js";

/**
 * "The story so far" — a bounded, chapter-by-chapter digest built from the storyboard summaries the
 * analysis pass already writes. The in-book chat otherwise sees only the CURRENT chapter's summary,
 * so the buddy can't discuss the whole plot/timeline; image prompts have no cross-chapter arc. This
 * rolls the per-chapter summaries up cheaply (no extra LLM call — they already exist), tiered by
 * recency so it stays within a token target at any book length: recent chapters keep their full
 * summary, older chapters compress to their one-line keyMoment, and the oldest are trimmed first.
 */

/** ~7k tokens at 4 chars/token — the chat slice's share of the context window. */
export const STORY_DIGEST_BUDGET_CHARS = 28_000;
const RECENT_FULL = 8;
const MAX_RECENT_SUMMARY = 600;
const MAX_OLD_LINE = 180;

export interface StoryDigestOptions {
  /** Only include chapters at or before this index (spoiler gating); omit for the whole book. */
  upToChapter?: number;
  /** Hard cap on the digest body (chars). */
  budgetChars?: number;
  /** Keep this many most-recent chapters' full summary; older chapters compress to one line. */
  recentFull?: number;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, "")}…`;
}

function scenesUpTo(bible: VisualBible | undefined, upTo: number) {
  return [...(bible?.storyboard ?? [])]
    .filter((s) => s.chapterIndex <= upTo && ((s.summary ?? "").trim() || (s.keyMoment ?? "").trim()))
    .sort((a, b) => a.chapterIndex - b.chapterIndex);
}

/** The full "story so far" digest (labelled block) for the chat. "" when there's nothing yet. */
export function storyDigest(bible: VisualBible | undefined, opts: StoryDigestOptions = {}): string {
  const budget = opts.budgetChars ?? STORY_DIGEST_BUDGET_CHARS;
  const recentFull = opts.recentFull ?? RECENT_FULL;
  const scenes = scenesUpTo(bible, opts.upToChapter ?? Number.POSITIVE_INFINITY);
  if (scenes.length === 0) return "";
  const lastIdx = scenes.length - 1;
  let lines = scenes
    .map((s, i) => {
      const recent = i > lastIdx - recentFull;
      const body = recent
        ? truncate((s.summary ?? "").trim() || (s.keyMoment ?? "").trim(), MAX_RECENT_SUMMARY)
        : truncate((s.keyMoment ?? "").trim() || (s.summary ?? "").trim(), MAX_OLD_LINE);
      return body ? `Ch ${s.chapterIndex + 1}: ${body}` : "";
    })
    .filter(Boolean);
  // Trim OLDEST first so recent detail survives the budget.
  while (lines.length > 1 && lines.join("\n").length > budget) lines = lines.slice(1);
  let body = lines.join("\n");
  if (body.length > budget) body = `${body.slice(0, budget)}…`;
  return body ? `THE STORY SO FAR (chapter-by-chapter, for continuity + plot questions):\n${body}` : "";
}

/** A terse recent-arc line (the last few chapters' key moments) for image-prompt continuity. */
export function recentArcLine(bible: VisualBible | undefined, opts: { upToChapter?: number; maxChars?: number } = {}): string {
  const max = opts.maxChars ?? 800;
  const scenes = scenesUpTo(bible, opts.upToChapter ?? Number.POSITIVE_INFINITY);
  if (scenes.length <= 1) return ""; // nothing "prior" on the first chapter
  const parts = scenes
    .slice(-4, -1) // the chapters BEFORE the current one
    .map((s) => truncate((s.keyMoment ?? "").trim() || (s.summary ?? "").trim(), 160))
    .filter(Boolean);
  let text = parts.join(" ");
  if (!text) return "";
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return text;
}
