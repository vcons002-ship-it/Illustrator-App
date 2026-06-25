/**
 * "Story as you go" treats the model's plain prose reply as the next beat of the book (there is no
 * continue_story tool — see Phase E). This pure predicate decides whether a finished buddy turn's
 * reply should be appended to the open story, so the rule is unit-testable away from the worker.
 *
 * Append only when ALL hold:
 *  - a story is open AND the current book is a story book (so the beat has somewhere to land), and
 *  - the reply has real prose (an empty/blank reply is nothing to append), and
 *  - no story tool ran THIS turn — the opening `start_story` (or a safety-net `continue_story`)
 *    already grew the book, so appending the same text again would double it.
 */
export function shouldAppendBeat(
  outcome: { text: string; toolResults: { call: { tool: string } }[] },
  ctx: { storyOpen: boolean; isStoryBook: boolean },
): boolean {
  if (!ctx.storyOpen || !ctx.isStoryBook) return false;
  if (!outcome.text.trim()) return false;
  const storyToolRan = outcome.toolResults.some(
    (t) => t.call.tool === "start_story" || t.call.tool === "continue_story",
  );
  return !storyToolRan;
}
