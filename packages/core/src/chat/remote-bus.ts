import type { TaskItem } from "../providers/google.js";

/**
 * REMOTE BUS — drive the desktop assistant from your phone with **no server**, using Google
 * Tasks as an async channel. From your phone you add a to-do whose title starts with `VR:`
 * (e.g. "VR: summarise my unread email"); the desktop app, while open, picks it up on its next
 * poll, runs it through the buddy, writes the answer back into the task (notes), and marks it
 * done — so you read the result on your phone. Pure helpers live here; the worker does the
 * Google I/O (list/patch) and the host runs the periodic poll. Fits the app's no-backend,
 * bring-your-own-Google privacy model (the data only ever lives in the user's own Google
 * account + their machine).
 */

/** The marker a task title must start with to be treated as an assistant command. */
export const REMOTE_BUS_PREFIX = "VR:";
/** Prefix on the written-back answer (so a glance on the phone shows it's the reply). */
const ANSWER_MARK = "🤖";
/** Google Tasks notes hold ~8 KB; keep a margin. */
export const MAX_BUS_REPLY_CHARS = 7000;

export interface BusCommand {
  id: string;
  text: string;
}

/** Is this Google Task an unanswered assistant command? (`listTasks` already drops completed.) */
export function isBusCommand(task: TaskItem): boolean {
  return (
    !!task.id &&
    task.status !== "completed" &&
    task.title.trimStart().toLowerCase().startsWith(REMOTE_BUS_PREFIX.toLowerCase())
  );
}

/** The instruction text — the title minus the `VR:` prefix. */
export function commandText(task: TaskItem): string {
  return task.title.trimStart().slice(REMOTE_BUS_PREFIX.length).trim();
}

/** The pending commands in a task list, as `{ id, text }` (skips empty instructions). */
export function busCommands(tasks: readonly TaskItem[]): BusCommand[] {
  const out: BusCommand[] = [];
  for (const t of tasks) {
    if (!isBusCommand(t) || !t.id) continue;
    const text = commandText(t);
    if (text) out.push({ id: t.id, text });
  }
  return out;
}

/** The note written back into the task (capped); the phone reads this as the answer. */
export function formatBusReply(answer: string): string {
  const body = answer.trim().slice(0, MAX_BUS_REPLY_CHARS);
  return `${ANSWER_MARK} ${body || "(done — see the VisualReader desktop app)"}`;
}
