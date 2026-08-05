import type { ChatTurn } from "../providers/llm/chat.js";

/**
 * A line the APP writes into the chat, and the model-facing turn that makes it durable.
 *
 * The app posts its own lines mid-turn, from the tool-result handler: a picture adopted as a
 * reference, a photo opened inline. They were `text` and nothing else — and a stored `tool` message
 * with no `turns` of its own contributes NOTHING when the history is rebuilt (see `chatTurnsOf`).
 * So the reader saw the line and the model never did: on the next send the conversation came back
 * without it, and from the model's side the thing had simply never happened. It would then answer
 * "did you use my photo?" from nothing, and a model guessing about its own tools guesses yes.
 *
 * A reply is durable because it carries the turns it stands for. These carry theirs now too — same
 * mechanism, no new one.
 *
 * The model-facing half is deliberately the FACT and nothing else. What to DO about a reference is
 * restated every turn by {@link buildImageReferenceBlock}, which is where a standing instruction
 * belongs: a note replayed out of history is the record of one moment, and dressing one up as an
 * instruction is exactly how a one-off directive became a standing order last time (the whole
 * reason `transcript-hygiene` exists). PURE — no I/O, no formatting beyond the two strings.
 */
export interface BuddyNote {
  /** What the reader sees in the chat. */
  text: string;
  /** What the stored message contributes to the rebuilt, model-facing conversation. */
  turns: ChatTurn[];
}

/**
 * An app-observed fact, in the bracketed form the buddy already reads tool feedback in. `user` is
 * the role the app speaks under — the same one every tool result rides home on — so the model reads
 * it as something that happened rather than as its own claim about what happened.
 */
const observed = (fact: string): ChatTurn[] => [{ role: "user", content: `[${fact}]` }];

/**
 * A picture registered as a reference for this chat's renders — adopted from a search, opened from
 * the computer, or attached. The count is the app's own (the reference set is capped), and it is the
 * part the model has no other way to know.
 */
export function referenceAdoptedNote(label: string, count: number): BuddyNote {
  return {
    text: `🖼 “${label}” is now a reference for pictures I make in this chat (${count} in use).`,
    turns: observed(`"${label}" is now a reference picture for images in this chat (${count} in use)`),
  };
}

/**
 * A picture that reached the chat but could not be registered. Worth persisting for the same reason
 * the success is: without it the next turn has no idea the attempt was made, let alone that it
 * failed, and "I've got your picture" is the confident wrong answer.
 */
export function referenceFailedNote(error?: string): BuddyNote {
  return {
    text: `⚠ Couldn't use that picture as a reference${error ? `: ${error}` : "."}`,
    turns: observed(
      `that picture could NOT be used as a reference${error ? `: ${error}` : ""} — there is no reference in place, so don't answer as if there were`,
    ),
  };
}

/**
 * What the reader is told when a turn stops at its tool-round budget with work still to do.
 *
 * `turns: []` deliberately — display-only. This is the app's own plumbing, not a record of anything
 * that happened, and a budget checkpoint replayed out of history is the kind of turn-local machinery
 * `transcript-hygiene` exists to undo.
 */
export const pausedTurnNote = (): BuddyNote => ({
  text: "⏸ Paused — that's this turn's tool budget. Say “continue” and I'll pick up where I left off.",
  turns: [],
});

/**
 * Does a settled turn need this note posted on its own?
 *
 * A pause is the one exit that ends a turn with work left and NOTHING scheduled to pick it up, so
 * the reader's way back in must not be conditional on anything. It was: the Continue affordance rode
 * on the settled reply, which is exactly the message an app-managed TOOL step suppresses. A search
 * step's contract is `tool_ok`, so on a cloud model (ten tool rounds) a research step would search,
 * read, search, read, hit the budget, and die with no button and no message — searching being the
 * one kind of work that burns rounds without suspending the turn for an approval.
 *
 * So: paused and the reply won't be shown → post it standalone. PURE.
 */
export function needsPausedTurnNote(paused: boolean, hasText: boolean, suppressProse: boolean): boolean {
  return paused && (!hasText || suppressProse);
}

/**
 * WHAT AN INTERRUPTED RUN DID, kept so the work isn't lost with the turn.
 *
 * Reported as: three web searches sitting visibly in the chat, and the model answering "I haven't
 * done any historical music searches in this session". It was right. A turn's tool calls reach later
 * turns only through the transcript stored on the SETTLE message, and a run that is interrupted
 * never settles — it took the error path, which stored `turns: []`. So the bubbles stayed on screen
 * and the record behind them was discarded: the reader can see the work and the model cannot, which
 * is the worst of both.
 *
 * Two halves, and the second is why this isn't just "save the transcript". A half-finished run whose
 * results are replayed without comment reads as a FINISHED one — the model sees three searches and
 * no reason to think anything is outstanding, so it answers from partial work instead of resuming
 * it. The note says plainly that the run stopped early, so what survives is evidence rather than a
 * conclusion.
 *
 * `records` are the calls that actually completed, already formatted by the caller (the host owns
 * `formatBuddyToolResult`). PURE.
 */
export function interruptedRunNote(records: readonly string[], reason: string): BuddyNote {
  const n = records.length;
  const did = n === 0 ? "It hadn't finished anything yet." : `It got as far as ${n} tool call${n === 1 ? "" : "s"}:`;
  return {
    text: `⚠ ${reason}`,
    turns: [
      ...records.map((content) => ({ role: "user" as const, content })),
      {
        role: "user" as const,
        content:
          `[That run STOPPED before it finished — ${reason}. ${did} Treat the results above as ` +
          "evidence of what was done, NOT as a finished job: anything it was part-way through is " +
          "still outstanding. Say what you have and what's left rather than answering as if it completed.]",
      },
    ],
  };
}

/** A picture file opened INTO the chat (`open_image`), shown inline where the reader can see it. */
export function openedImageNote(name: string): BuddyNote {
  return {
    text: `🖼 ${name}`,
    turns: observed(`the picture "${name}" is shown inline in the chat`),
  };
}
