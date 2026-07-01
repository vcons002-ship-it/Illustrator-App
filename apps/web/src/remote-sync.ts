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

import type { BookSource, BookSummary, BuddyPersona, BuddyPlan, BuddyToolCall, BuddyToolResultPayload, CalendarEvent, ContextUsage, MemoryNote, Skill, StoredChatMessage, TaskPlan, TaskRecurrence, VisualBible } from "@visual-reader/core";
import type { InstalledModel, ProvidersDiagnostics, ReaderSettings } from "@visual-reader/ui";

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
  | { action: "completeTask"; planId: string; complete: boolean }
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
export interface EngineVram {
  /** Total VRAM across the engine's GPU(s), in MB. */
  totalMb: number;
  /** VRAM currently in use (total − free), in MB. */
  usedMb: number;
  /** A short device label (the GPU name, or "N GPUs" when aggregated). */
  device?: string;
}

export interface EngineInventory {
  installedModels: InstalledModel[];
  installedTextEncoders: string[];
  installedVaes: string[];
  installedLoras: string[];
  loraFamilies: Record<string, string>;
  textModels: InstalledModel[];
  engineStatus: string;
  /** Which providers are live vs. silent mock fallbacks — mirrored so the phone shows the SAME
   * "Text: …" / "Image: …" model tags the desktop does (its own engine never runs). */
  providers?: ProvidersDiagnostics;
  /** The selected Ollama chat model's context window from /api/show: `loaded` = the Modelfile
   * num_ctx Ollama actually loads with; `max` = the architecture's ceiling. Lets the UI show the
   * real default + max instead of a blank "uses Ollama default" field. Desktop-fetched, mirrored. */
  textModelContext?: { loaded?: number; max?: number };
  /** 0..100 while a phone-triggered ffmpeg download runs on the desktop (see vrcmd:downloadFfmpeg);
   * undefined once idle again. Mirrors the desktop's own `downloadProgress.ffmpeg` so the phone's
   * Settings row shows the same live percentage / "✓ Installed" state. */
  ffmpegProgress?: number;
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
  /** The chat's lightweight working checklist (set_plan/complete_step), so the phone shows the same
   * live plan + progress as the desktop. */
  plan?: BuddyPlan;
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
  /** The assistant's remembered notes (so the phone's Memory panel isn't empty). */
  memories: MemoryNote[];
  /** The assistant's saved skills/playbooks (so the phone's Skills panel isn't empty). */
  skills: Skill[];
  /** The live state of any in-flight turn (so a phone joining mid-turn sees streaming/approvals). */
  live: ChatLive;
  /** The currently-open book (undefined when the desktop is on the home screen). */
  book?: BookSource;
  /** The open book's analysis (illustrations/concept cards/charts are anchored from this). */
  bible?: VisualBible;
  /** The desktop engine's live GPU VRAM (so a freshly-connected phone shows the indicator at once;
   * thereafter `vrsync:vram` pushes keep it current without re-sending the whole snapshot). */
  vram?: EngineVram;
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
  | { type: "vrsync:memories"; memories: MemoryNote[] } // the assistant's remembered notes → phone Memory panel
  | { type: "vrsync:skills"; skills: Skill[] } // the assistant's saved skills/playbooks → phone Skills panel
  | { type: "vrsync:vram"; vram?: EngineVram } // desktop GPU VRAM tick → phone status-bar indicator (frequent, lightweight; not folded into the heavier inventory push)
  | { type: "vrsync:book"; book?: BookSource; bible?: VisualBible }
  // Progress/result of an update the PHONE triggered (vrcmd:update). `reload` ⇒ the desktop applied a
  // JS update and the phone should reload to pick up the new UI (then it reconnects via its token).
  | { type: "vrsync:updateStatus"; status: "working" | "uptodate" | "updated" | "needs-restart" | "error"; message: string; reload?: boolean }
  // Result of a desktop-runtime host tool the phone relayed (vrcmd:hostTool) — file search/read,
  // run_command, write_file, screenshot — run on the desktop, fed back to the phone's buddy turn.
  | { type: "vrsync:hostToolResult"; requestId: number; payload: BuddyToolResultPayload }
  // The bytes of a file card the mirror stripped (vrcmd:fetchFile), sent back so the phone can show /
  // download / open a large or older generated image on demand. CHUNKED so any-size file syncs in
  // pieces instead of being dropped for exceeding one tunnel frame: `total` chunks, `seq` 0..total-1,
  // each carrying part of the bytes (mime on seq 0). `total === 0` ⇒ the desktop couldn't find it.
  | { type: "vrsync:fileData"; reqId: number; seq: number; total: number; bytes?: ArrayBuffer; mime?: string };

/** Phone → desktop commands. */
export type CmdToDesktop =
  | { type: "vrcmd:hello" } // "I just connected — send me a full snapshot."
  | { type: "vrcmd:open"; bookId: string } // open this library book on the desktop
  | { type: "vrcmd:libraryDelete"; bookId: string } // phone deleted a library book → delete it on the desktop (it owns the library; a local-only delete is re-clobbered by vrsync:library)
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
  | { type: "vrcmd:chatDeleteMessage"; index: number } // delete one message from the active session on the desktop (it persists + re-mirrors)
  | { type: "vrcmd:memory"; notes: MemoryNote[] } // phone edited the Memory panel → save the whole list on the desktop (it owns the store + re-mirrors)
  | { type: "vrcmd:skillSave"; name: string; description: string; body: string } // phone saved a skill → save on the desktop (it owns the store + re-mirrors vrsync:skills)
  | { type: "vrcmd:skillDelete"; name: string } // phone deleted a skill → forget it on the desktop
  | { type: "vrcmd:chatRename"; id: string; label: string } // rename a session (empty ⇒ reset label)
  | { type: "vrcmd:chatPersona"; persona: BuddyPersona } // change the active session's persona
  | { type: "vrcmd:chatClear" } // clear the active session's history on the desktop
  | { type: "vrcmd:chatPlanClear" } // dismiss the working checklist (the desktop owns + re-mirrors it)
  | { type: "vrcmd:chatCancel" } // stop the in-flight turn on the desktop
  | { type: "vrcmd:chatApproveTool"; always: boolean } // approve the pending tool (always ⇒ grant for the session)
  | { type: "vrcmd:chatDismissTool" } // dismiss the pending tool without running it
  | { type: "vrcmd:chatAgentApprove"; id: number } // approve one queued coding-agent step
  | { type: "vrcmd:chatAgentDeny"; id: number } // deny one queued coding-agent step
  | { type: "vrcmd:update" } // phone asked the desktop to pull + rebuild + reload (software update)
  | { type: "vrcmd:restart" } // phone asked the desktop to fully relaunch (Settings → Restart app)
  | { type: "vrcmd:connectLocalServer"; backend: "a1111" | "comfyui"; url: string } // phone tapped Connect for a self-hosted engine → the DESKTOP probes/auto-starts it (it owns the network + filesystem); the resulting settings mirror back
  | { type: "vrcmd:downloadFfmpeg" } // phone tapped "Download ffmpeg" → the DESKTOP fetches it (it owns the filesystem); progress mirrors back via EngineInventory.ffmpegProgress
  | { type: "vrcmd:openLocalFile"; path: string } // open a PC file (PDF/EPUB/doc) FROM the desktop's disk as a book; the desktop reads + imports it, the open book mirrors back
  | { type: "vrcmd:hostTool"; requestId: number; call: BuddyToolCall; cwd?: string } // run a desktop-runtime tool (files/command/screenshot) on the desktop, in the phone's chosen working folder
  | { type: "vrcmd:fetchFile"; reqId: number; id: string }; // ask the desktop for the full bytes of a file card whose bytes the mirror stripped (lazy image fetch)

export type AppSyncMessage = SyncToPhone | CmdToDesktop;

/** A command the phone sends the desktop (vs. a state push the desktop sends the phone). */
export function isCmdToDesktop(msg: AppSyncMessage): msg is CmdToDesktop {
  return msg.type.startsWith("vrcmd:");
}
