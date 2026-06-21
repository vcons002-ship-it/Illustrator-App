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

/**
 * Turn an ordinary buddy turn into a WRITE-capable CODING sub-agent, scoped to its own git
 * worktree at `dir`. Unlike {@link buildDelegatePrompt} it MAY write + run commands (in `dir`),
 * but it must NOT fan out further or touch anything outside its worktree, so parallel agents stay
 * independent and the app can merge each one's branch cleanly.
 */
export function buildCodingAgentPrompt(task: { title: string; instructions: string }, dir: string): string {
  return (
    "You are a focused CODING SUB-AGENT working IN PARALLEL with other agents. You have your OWN " +
    `isolated git worktree at:\n  ${dir}\n` +
    "Everything you do happens THERE — write_file and run_command are already scoped to this folder " +
    "(use workspace-relative paths). Rules:\n" +
    "- Do ONLY your assigned subtask; stay within your worktree; do NOT touch unrelated files.\n" +
    "- Build it, then VERIFY with run_command (run the build/tests/script) and fix until it works.\n" +
    "- Do NOT spawn more agents, change app settings, send email, or do git branch/merge work — the " +
    "app handles committing and merging your worktree back.\n" +
    "- When done, reply with a CONCISE summary of what you changed (files + what each does) so the " +
    "manager can review and merge it.\n\n" +
    `SUBTASK: ${task.title.trim()}\n${task.instructions.trim()}`
  );
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once — a tiny concurrency pool used to
 * fan independent sub-agents (or any latency-tolerant unit of work) out in parallel without
 * unbounded load. Preserves input ORDER in the result. A failing item resolves to whatever `fn`'s
 * rejection is mapped to by the caller (callers wrap their own try/catch). PURE (no I/O of its own).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const cap = Math.max(1, Math.floor(limit) || 1);
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => worker()));
  return results;
}

