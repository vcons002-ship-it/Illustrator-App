import type { BuddyPlan, CreatedFileRef, StoredChatMessage, Workflow } from "@visual-reader/core";

/** Read every part of a chat before making it runnable. A failed read is NOT an empty chat. */
export async function readWorkspaceHistory(id: string, readers: {
  history: (id: string) => Promise<StoredChatMessage[] | undefined>;
  plan: (id: string) => Promise<BuddyPlan | undefined>;
  workflow: (id: string) => Promise<Workflow | undefined>;
  files: (id: string) => Promise<CreatedFileRef[]>;
}) {
  const [messages, plan, workflow, files] = await Promise.all([
    readers.history(id), readers.plan(id), readers.workflow(id), readers.files(id),
  ]);
  if (messages !== undefined && !Array.isArray(messages)) throw new Error("Saved chat history is invalid");
  return { messages: messages ?? [], plan, workflow, files };
}

/** A failed restore stays blocked until retried or left; never overwrite unread history. */
export function createWorkspaceHistoryGuard() {
  let generation = 0;
  let pending: number | undefined;
  return {
    begin(): number { pending = ++generation; return pending; },
    current(ticket: number): boolean { return pending === ticket; },
    finish(ticket: number): void { if (pending === ticket) pending = undefined; },
    invalidate(): void { generation++; pending = undefined; },
    get blocked(): boolean { return pending !== undefined; },
  };
}

/** Commit a complete snapshot only if the user is still opening this workspace. */
export async function restoreWorkspaceHistory(options: {
  id: string;
  ticket: number;
  guard: ReturnType<typeof createWorkspaceHistoryGuard>;
  readers: Parameters<typeof readWorkspaceHistory>[1];
  isCurrent: () => boolean;
  apply: (snapshot: Awaited<ReturnType<typeof readWorkspaceHistory>>) => void;
}): Promise<boolean> {
  // A rejected read deliberately leaves the guard closed for a retry, never an empty fallback.
  const snapshot = await readWorkspaceHistory(options.id, options.readers);
  if (!options.guard.current(options.ticket)) return false;
  if (!options.isCurrent()) {
    options.guard.finish(options.ticket);
    return false;
  }
  options.apply(snapshot);
  options.guard.finish(options.ticket);
  return true;
}
