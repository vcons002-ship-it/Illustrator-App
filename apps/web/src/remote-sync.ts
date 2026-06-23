/**
 * APP-STATE MIRROR — the messages a linked phone and its desktop exchange so the phone shows the
 * SAME content the desktop has (its library, the open book, that book's visual bible, and the
 * render-affecting settings), turning the phone into a live second screen rather than an empty
 * editor. These ride the same LAN relay as the engine messages (see `useEngineWorker`), but are
 * routed to the app-sync handler — told apart from engine messages by the `vrsync:`/`vrcmd:`
 * prefix (`isAppSyncMessage` in core). The desktop is the source of truth; the phone renders what
 * it's sent and issues high-level commands (open a library book, ask for a fresh snapshot). The
 * engine itself stays shared — illustrate/analyse/chat the phone triggers run on the desktop and
 * stream back over the same relay, so no model or data ever needs to live on the phone.
 */

import type { BookSource, BookSummary, BuddyPersona, BuddyToolCall, BuddyToolResultPayload, CalendarEvent, ContextUsage, StoredChatMessage, TaskPlan, TaskRecurrence, VisualBible } from "@visual-reader/core";
import type { InstalledModel, ReaderSettings } from "@visual-reader/ui";

/**
 * A Tasks/Calendar action the phone asks the desktop to perform. The desktop owns the planner data
 * (Google + the task store), so the phone never mutates locally — it relays the intent, the desktop
 * runs its existing handler, and the result flows back via the `vrsync:planner` mirror.
 */
export type PlannerCommand =
  | { action: "createTask"; title: string; dueIso?: string; recurrence?: TaskRecurrence; planNow: boolean }
  | { action: "scanNow" }
  | { action: "planPending" }
  | { action: "planTask"; id: string }
  | { action: "openTask"; id: string }
  | { action: "advanceStep"; planId: string; stepId: string }
  | { action: "toggleStep"; planId: string; stepId: string; done: boolean }
  | { action: "ignoreTask"; id: string }
  | { action: "addDetails"; planId: string; text: string }
  | { action: "deleteTask"; id: string }
  | { action: "restoreTask"; id: string }
  | { action: "deleteForever"; id: string }
  | { action: "calShift"; delta: number | "today" }
  | { action: "createEvent"; ev: { summary: string; start: string; end: string; description?: string; location?: string } };

/**
 * Tasks + calendar state mirrored to the phone so its Tasks/Calendar panels show the desktop's
 * LIVE content (they're Google/desktop-backed — the phone has no planner data of its own, so
 * without this they render empty). `calendarMonth` rides as an ISO string (JSON can't carry a
 * Date); the phone rebuilds a Date. Task-plan deadlines are re-derived on the phone from `tasks`.
 */
export interface PlannerMirror {
  tasks: TaskPlan[];
  calendarEvents: CalendarEvent[];
  /** First day of the month the desktop's calendar is showing (ISO). */
  calendarMonth: string;
  calendarLoading: boolean;
  calendarError?: string;
  googleConnected: boolean;
}

/**
 * The desktop engine's installed inventory, mirrored to the phone so its model/encoder/VAE/LoRA
 * pickers have the SAME options the desktop has. The phone has no engine of its own to enumerate,
 * so without this the pickers are empty and the phone is stuck with "whatever is set on desktop".
 */
export interface EngineInventory {
  installedModels: InstalledModel[];
  installedTextEncoders: string[];
  installedVaes: string[];
  installedLoras: string[];
  loraFamilies: Record<string, string>;
  textModels: InstalledModel[];
  engineStatus: string;
}

/** One landing-page chat session in the mirror (id + its working folder + a display label). Mirrors
 * the desktop's BuddySession; the phone has no chat data of its own, so it renders these. */
export interface ChatSessionInfo {
  id: string;
  workingDir: string;
  label?: string;
}

/**
 * The desktop's landing-page chat (the "buddy"), mirrored so the phone shows the SAME conversations —
 * the session list, which one is active, and that session's full history — instead of an empty,
 * separate chat of its own. The desktop owns the chat: the phone relays high-level intents
 * (switch/new/delete/rename a session, send a message, set persona, clear) via `vrcmd:chat*`, the
 * desktop runs them on its existing handlers (and its models), and the result flows back here.
 * `busy` lets the phone show a "working…" state while a phone-triggered turn runs on the desktop.
 */
export interface ChatMirror {
  sessions: ChatSessionInfo[];
  activeId: string;
  /** Full history of the ACTIVE session (the only one the phone displays at a time). */
  messages: StoredChatMessage[];
  persona: BuddyPersona;
  busy: boolean;
}

/**
 * The LIVE state of an in-flight buddy turn, mirrored so the phone shows the SAME real-time view the
 * desktop does: the streaming answer as it's typed, the model's reasoning/activity line, the running
 * tool log, a pending tool waiting for approval, the parallel coding-agent approval queue, and the
 * context-usage donut. Pushed separately from `ChatMirror` (and throttled) because it updates many
 * times per second while a turn runs, whereas the conversation history changes only per message.
 */
export interface ChatLive {
  /** The assistant's answer streamed so far (cumulative). */
  streaming: string;
  /** A thinking model's live reasoning (shown dimmed). */
  thinking: string;
  /** A short status line while the model works invisibly. */
  activity: string;
  /** The tools taken this turn, newest last (the visible "process" log). */
  steps: string[];
  /** A tool the model proposed that's waiting for the reader's approval (the approval modal). */
  pendingTool?: BuddyToolCall;
  /** Per-step approval queue for parallel coding agents (when Autonomous workspace is OFF). */
  agentApprovals: { id: number; title: string; call: BuddyToolCall }[];
  /** Where this turn's context budget is going (the usage donut). */
  usage?: ContextUsage;
}

/** One attachment the phone carries to the desktop on a relayed send (already extracted on the
 * phone: an image's bytes for the desktop's vision model, or a document's pulled text). */
export interface ChatSendAttachment {
  name: string;
  kind: "image" | "doc";
  image?: { bytes: ArrayBuffer; mimeType: string };
  text?: string;
}

/** A full snapshot of what the desktop is showing — sent when a phone first asks (`vrcmd:hello`). */
export interface MirrorSnapshot {
  /** A friendly desktop name for the phone's "Linked to …" header. */
  host?: string;
  library: BookSummary[];
  settings: ReaderSettings;
  /** The desktop engine's installed models/components (so the phone's pickers aren't empty). */
  inventory: EngineInventory;
  /** The desktop's tasks + calendar (so the phone's planner panels aren't empty). */
  planner: PlannerMirror;
  /** The desktop's landing-page chat (sessions + active history) so the phone's chat isn't empty. */
  chat: ChatMirror;
  /** The live state of any in-flight turn (so a phone joining mid-turn sees streaming/approvals). */
  live: ChatLive;
  /** The currently-open book (undefined when the desktop is on the home screen). */
  book?: BookSource;
  /** The open book's analysis (illustrations/concept cards/charts are anchored from this). */
  bible?: VisualBible;
}

/** Desktop → phone state pushes (source of truth). */
export type SyncToPhone =
  | ({ type: "vrsync:state" } & MirrorSnapshot)
  | { type: "vrsync:library"; library: BookSummary[] }
  | { type: "vrsync:settings"; settings: ReaderSettings }
  | ({ type: "vrsync:inventory" } & EngineInventory)
  | ({ type: "vrsync:planner" } & PlannerMirror)
  | ({ type: "vrsync:chat" } & ChatMirror)
  | ({ type: "vrsync:chatLive" } & ChatLive)
  | { type: "vrsync:book"; book?: BookSource; bible?: VisualBible }
  // Progress/result of an update the PHONE triggered (vrcmd:update). `reload` ⇒ the desktop applied a
  // JS update and the phone should reload to pick up the new UI (then it reconnects via its token).
  | { type: "vrsync:updateStatus"; status: "working" | "uptodate" | "updated" | "needs-restart" | "error"; message: string; reload?: boolean }
  // Result of a desktop-runtime host tool the phone relayed (vrcmd:hostTool) — file search/read,
  // run_command, write_file, screenshot — run on the desktop, fed back to the phone's buddy turn.
  | { type: "vrsync:hostToolResult"; requestId: number; payload: BuddyToolResultPayload };

/** Phone → desktop commands. */
export type CmdToDesktop =
  | { type: "vrcmd:hello" } // "I just connected — send me a full snapshot."
  | { type: "vrcmd:open"; bookId: string } // open this library book on the desktop
  | { type: "vrcmd:home" } // leave the open book (back to the desktop's home screen)
  | { type: "vrcmd:settings"; settings: ReaderSettings } // phone edited settings → apply on the desktop (it renders)
  | { type: "vrcmd:planner"; command: PlannerCommand } // phone Tasks/Calendar action → run on the desktop
  // Landing-page chat actions the phone relays — the desktop owns the chat (it has the models + the
  // working folder), so the phone never runs a turn locally: it relays the intent, the desktop runs
  // its existing buddy handler, and the result flows back via the `vrsync:chat` mirror.
  | { type: "vrcmd:chatSend"; text: string; attachments?: ChatSendAttachment[] } // phone typed a message (+ files) → run the turn on the desktop
  | { type: "vrcmd:chatSwitch"; id: string } // make this session active on the desktop
  | { type: "vrcmd:chatNew" } // start a fresh chat session on the desktop
  | { type: "vrcmd:chatDelete"; id: string } // delete a session on the desktop
  | { type: "vrcmd:chatRename"; id: string; label: string } // rename a session (empty ⇒ reset label)
  | { type: "vrcmd:chatPersona"; persona: BuddyPersona } // change the active session's persona
  | { type: "vrcmd:chatClear" } // clear the active session's history on the desktop
  | { type: "vrcmd:chatCancel" } // stop the in-flight turn on the desktop
  | { type: "vrcmd:chatApproveTool"; always: boolean } // approve the pending tool (always ⇒ grant for the session)
  | { type: "vrcmd:chatDismissTool" } // dismiss the pending tool without running it
  | { type: "vrcmd:chatAgentApprove"; id: number } // approve one queued coding-agent step
  | { type: "vrcmd:chatAgentDeny"; id: number } // deny one queued coding-agent step
  | { type: "vrcmd:update" } // phone asked the desktop to pull + rebuild + reload (software update)
  | { type: "vrcmd:restart" } // phone asked the desktop to fully relaunch (Settings → Restart app)
  | { type: "vrcmd:openLocalFile"; path: string } // open a file FROM the desktop's disk into the reader (the desktop reads + imports it; the open book mirrors back)
  | { type: "vrcmd:hostTool"; requestId: number; call: BuddyToolCall; cwd?: string }; // run a desktop-runtime tool (files/command/screenshot) on the desktop, in the phone's chosen working folder

export type AppSyncMessage = SyncToPhone | CmdToDesktop;

/** A command the phone sends the desktop (vs. a state push the desktop sends the phone). */
export function isCmdToDesktop(msg: AppSyncMessage): msg is CmdToDesktop {
  return msg.type.startsWith("vrcmd:");
}
