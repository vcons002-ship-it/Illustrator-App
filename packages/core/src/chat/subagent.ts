/**
 * SUBAGENT DELEGATION — the buddy can hand a focused subtask to a short-lived **sub-agent**
 * that runs its own bounded tool loop in isolation and returns a concise result, instead of
 * cluttering the main conversation. The sub-agent is intentionally **read-only** (research +
 * compute only — no settings changes, image generation, commands, or writes), so delegating is
 * always safe. This is the pure instruction the host hands the sub-turn; the host runs it by
 * re-entering the normal buddy turn with an isolated history.
 */

/** The instruction that turns an ordinary buddy turn into a focused, read-only sub-agent. */
export function buildDelegatePrompt(task: string): string {
  return (
    "You are a focused SUB-AGENT spawned to complete ONE subtask and report back. Use only " +
    "READ-ONLY research/compute tools (search_web, read_url, calculate, wolfram, market/stock " +
    "lookups, mcp_tools/mcp_call). Do NOT change settings, generate images, run commands, open " +
    "books, place orders, or modify anything. Work efficiently and return a CONCISE, self-contained " +
    `result the main assistant can use directly.\n\nSUBTASK: ${task.trim()}`
  );
}
