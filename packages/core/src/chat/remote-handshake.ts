/**
 * When a linked phone has actually been answered, and how hard to keep asking.
 *
 * A phone owns no conversation of its own: the desktop owns it and hands it over on request. So the
 * handshake IS the chat — get it wrong and the phone shows an empty conversation that isn't empty,
 * which is indistinguishable from having lost everything.
 *
 * Both rules here were wrong in the same direction — they stopped early on weak evidence.
 */

/** The frame the desktop's snapshot always contains: the conversation itself. */
const SNAPSHOT_CHAT_FRAME = "vrsync:chat";

/**
 * Whether a frame from the desktop proves the SNAPSHOT arrived — not merely that the desktop is
 * talking.
 *
 * Any state push used to count. But the desktop pushes on its own initiative too: a live-turn tick
 * while it works, a library change, a settings echo. One of those landing first proved it was awake
 * and said nothing about whether it had heard the request — so the phone stopped asking, and the
 * conversation it was waiting for was never sent. PURE.
 */
export function isSnapshotAnswer(frameType: string): boolean {
  return frameType === SNAPSHOT_CHAT_FRAME;
}

/** First gap before re-asking (ms). */
export const HELLO_RETRY_START_MS = 2_000;
/**
 * Longest gap between re-asks (ms). It never stops: a desktop can be asleep, mid-restart, or on a
 * laptop somebody hasn't opened yet, and none of those are reasons to give up on a conversation that
 * still exists. One frame a minute is a rounding error; a phone permanently showing an empty chat is
 * not.
 */
export const HELLO_RETRY_MAX_MS = 60_000;

/**
 * The next gap before re-asking for the snapshot, doubling up to the ceiling.
 *
 * The old rule stopped after fifteen tries — thirty seconds. A desktop slower than that to attach
 * left the phone empty permanently, with nothing on screen saying it was still waiting. Backing off
 * bounds the cost without inventing a deadline for someone else's laptop. PURE.
 */
export function nextHelloDelay(previous: number): number {
  if (!(previous > 0)) return HELLO_RETRY_START_MS;
  return Math.min(previous * 2, HELLO_RETRY_MAX_MS);
}
