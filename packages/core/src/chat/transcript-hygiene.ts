import type { ChatTurn } from "../providers/llm/chat.js";
import { CREATIVE_IDLE_MARKER } from "./buddy-tools.js";

/**
 * Scrub TURN-LOCAL steering out of a saved transcript before it's replayed as history.
 *
 * The app briefly persisted its own internal directives into the stored `turns` of a message. Because
 * those turns are replayed verbatim on every later turn, a one-off instruction became a STANDING one:
 * most visibly "Do NOT call another tool now" (emitted when a turn exhausted its per-turn tool
 * budget), which then read as a user instruction in conversations where no limit was in play — the
 * model would spend its reasoning working out why it had been forbidden from calling tools.
 *
 * The source of new leakage is fixed, but conversations saved before that keep the text on disk. This
 * heals them on READ: it never rewrites storage and never touches a message's visible `text`, so the
 * reader's chat looks exactly the same — only what the MODEL is shown changes.
 *
 * Matching is anchored to the app's own phrasing, never a heuristic, so real conversation can't be
 * caught: a reader would have to open a message with one of these exact bracketed sentences.
 */

/**
 * Directives that were APPENDED to an otherwise-legitimate turn (the tool results came first). The
 * results are the durable record and must survive — only the tail is cut.
 */
const APPENDED_DIRECTIVES = [
  "[You've reached this turn's tool-call limit",
  "[You've run several steps without updating the reader.",
  "[Re-issue the remaining host tool",
] as const;

/**
 * Directives that were the WHOLE turn — the app-managed executor's per-step nudges. Nothing in them
 * is a record of anything, so the turn goes entirely. Prefix-matched: each interpolates the step's
 * own text, so they're never equal to a fixed string.
 */
const WHOLE_TURN_DIRECTIVES = [
  "[✓ Previous step done. Now do ONLY step",
  "[You haven't done the current step yet.",
  "[Your last attempt didn't satisfy this step",
] as const;

/**
 * The idle-creative brief. Unlike the directives above this is NOT noise — it's why a stretch of that
 * chat exists — so it's replaced rather than dropped. What must not survive is its instructions:
 * "nobody is waiting on you", "don't ask the reader anything", "you can ONLY search". Replayed into a
 * real conversation in the same chat, those read as the reader's own words and would make the model
 * refuse to ask questions of someone sitting right there.
 */
// Imported, not re-typed: a copy here would silently stop matching if the marker were ever renamed,
// and the failure is invisible — the brief simply starts leaking again.
const CREATIVE_BRIEF_MARKER = CREATIVE_IDLE_MARKER;
const CREATIVE_BRIEF_REPLACEMENT = "(I had some free time, so I went off and explored something on my own.)";

/** Is this entire turn nothing but an internal step directive? PURE. */
function isWholeTurnDirective(content: string): boolean {
  const t = content.trimStart();
  return WHOLE_TURN_DIRECTIVES.some((d) => t.startsWith(d));
}

/** The content with any appended directive tail removed (unchanged when there is none). PURE. */
function withoutAppendedDirective(content: string): string {
  let cut = -1;
  for (const d of APPENDED_DIRECTIVES) {
    const i = content.indexOf(d);
    // Only ever cut at a directive the app APPENDED (it always follows a blank line, or is the whole
    // content) — so the same words quoted mid-sentence by a reader are left alone.
    if (i < 0) continue;
    const atStart = i === 0;
    const afterBlankLine = i >= 2 && content.slice(i - 2, i) === "\n\n";
    if (!atStart && !afterBlankLine) continue;
    const at = atStart ? i : i - 2;
    if (cut < 0 || at < cut) cut = at;
  }
  return cut < 0 ? content : content.slice(0, cut);
}

/**
 * Remove persisted internal directives from a saved transcript. Only `user` turns are considered —
 * that's the role the app injected them under. Returns the SAME array reference when nothing needed
 * changing (stable for a memo). PURE.
 */
export function stripPersistedDirectives(turns: ChatTurn[]): ChatTurn[] {
  let changed = false;
  const out: ChatTurn[] = [];
  for (const turn of turns) {
    if (turn.role !== "user" || !turn.content.includes("[")) {
      out.push(turn);
      continue;
    }
    if (isWholeTurnDirective(turn.content)) {
      changed = true; // drop it entirely
      continue;
    }
    if (turn.content.trimStart().startsWith(CREATIVE_BRIEF_MARKER)) {
      // Kept, but reduced to the fact of it: the model should still know why it went exploring.
      changed = true;
      out.push({ ...turn, content: CREATIVE_BRIEF_REPLACEMENT });
      continue;
    }
    const cleaned = withoutAppendedDirective(turn.content);
    if (cleaned === turn.content) {
      out.push(turn);
      continue;
    }
    changed = true;
    // A turn that was ONLY the directive leaves nothing worth replaying.
    if (cleaned.trim()) out.push({ ...turn, content: cleaned.trimEnd() });
  }
  return changed ? out : turns;
}
