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

import type { BookSource, BookSummary, BuddyPersona, BuddyPlan, BuddyToolCall, BuddyToolResultPayload, CalendarEvent, ContextUsage, MemoryNote, ScheduledTask, Skill, SoulEssence, SoulImage, SoulKind, SoulNote, StoredChatMessage, TaskPlan, TaskRecurrence, VisualBible } from "@visual-reader/core";
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
  | { action: "createEvent"; ev: { summary: string; start: string; end: string; description?: string; location?: string } }
  // Edit an existing calendar event from the phone's Calendar panel — applied on the desktop, which
  // owns the Google connection (`appendDescription` adds to the event's text rather than replacing it).
  | {
      action: "updateEvent";
      eventId: string;
      patch: { summary?: string; start?: string; end?: string; description?: string; appendDescription?: string; location?: string };
      calendarId?: string;
    };

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

/** Live state for a user-requested Soul Essence distillation. The text model may need several
 * bounded passes for a large Soul, so this is mirrored to the phone instead of leaving Generate
 * looking inert while the desktop does the work. */
export type SoulEssenceJobPhase =
  | "queued"
  | "loading"
  | "analyzing"
  | "merging"
  | "validating"
  | "saving";

export interface SoulEssenceJobProgress {
  phase: SoulEssenceJobPhase;
  message: string;
  /** One-based completed/current model pass. */
  pass?: number;
  /** Best current estimate; it can grow when a merge round is discovered. */
  total?: number;
  /** Approximate generated-token count across all passes. */
  tokens?: number;
  /** Epoch milliseconds, owned by the desktop worker for a stable elapsed timer. */
  startedAt: number;
}

/** Phone-owned correlation token. It includes a per-page nonce so a reload cannot reuse an ID that
 * the desktop still associates with an older, finishing generation. */
export type SoulEssenceRelayRequestId = string;

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
  /** Closed (hidden from the switcher) but kept — mirrored so the phone hides/reopens the same ones. */
  closed?: boolean;
  /** A scheduled task's own workspace. Mirrored for the same reason `closed` is: without it the
   * phone rebuilds its session list from a flag it never received and lists them as ordinary chats,
   * so the one place these are deliberately kept out of would show every one of them. */
  hidden?: boolean;
  /**
   * The chat's own workspace folder, absolute — mirrored so the PHONE can name it.
   *
   * The phone resolves no folder of its own (it has no filesystem, and its turns run on the desktop),
   * so the two functions that fill in the folder both refuse to run there. That left its bar saying
   * "Default workspace" no matter what — including while the desktop was running commands inside the
   * chat's folder on the other end of the link. The reader was told their files were somewhere they
   * were not, on the device they were actually reading it on.
   */
  chatDir?: string;
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
  /** What the MODEL is given: bounded by ATTACH_DOC_MAX_CHARS so one upload can't fill the window. */
  text?: string;
  /**
   * What goes to DISK — the whole file, present only when it is longer than `text`.
   *
   * The two had been the same value, so a file large enough to be trimmed for the prompt would have
   * been saved trimmed too, and the copy in the workspace — the one the reader and the assistant go
   * back to — would have been quietly missing its tail. Dropped first if the relay frame won't fit;
   * losing the end of a very long document beats losing the send.
   */
  full?: string;
}

/**
 * The LIGHT half of what the desktop is showing — sent first when a phone asks (`vrcmd:hello`).
 *
 * Deliberately excludes the two heavyweights, the CHAT (whose history carries up to
 * CHAT_MIRROR_IMAGE_BUDGET ≈ 3 MB of inline images) and the open BOOK + bible (a whole novel's text):
 * every frame rides ONE WebSocket message, and a tunnel silently DROPS an oversized one. Bundling
 * everything together used to push the snapshot past that ceiling, so the phone got nothing at all and
 * sat on an empty "Chat 1" until some later change pushed a small enough incremental frame. Those two
 * now follow as their own `vrsync:chat` / `vrsync:book` frames (see `snapshotFrames`), so one heavy
 * section can't blank the whole phone. Everything left here is metadata-sized.
 */
export interface MirrorSnapshot {
  /** A friendly desktop name for the phone's "Linked to …" header. */
  host?: string;
  library: BookSummary[];
  settings: ReaderSettings;
  /** The desktop engine's installed models/components (so the phone's pickers aren't empty). */
  inventory: EngineInventory;
  /** The desktop's tasks + calendar (so the phone's planner panels aren't empty). */
  planner: PlannerMirror;
  /** The assistant's remembered notes (so the phone's Memory panel isn't empty). */
  memories: MemoryNote[];
  /** The assistant's saved skills/playbooks (so the phone's Skills panel isn't empty). */
  skills: Skill[];
  /** The desktop's scheduled/periodic tasks (so the phone's ⏰ Scheduled panel isn't empty — the
   * phone has no scheduler of its own; the desktop owns and fires them). */
  scheduled: ScheduledTask[];
  /** The live state of any in-flight turn (so a phone joining mid-turn sees streaming/approvals). */
  live: ChatLive;
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
  // The two identity souls → the phone's Soul panels. The derived essence is compact enough to ride
  // with the notes; reference PHOTOS are base64, so they stay on the computer that owns them.
  // `photos` is a COUNT, never the bytes. Reference photos are base64 and mirroring them would put
  // megabytes into every snapshot — but the phone still needs to know they exist, or its Soul panel
  // shows an empty photo section on a Soul that has three.
  | { type: "vrsync:soul"; kind: SoulKind; name: string; notes: SoulNote[]; essence?: SoulEssence; photos?: number }
  // Result of an explicit Essence rebuild requested on the PHONE. The desktop owns both the Soul
  // store and the text model, so the phone cannot correctly run this operation in its own worker.
  | { type: "vrsync:soulEssenceProgress"; requestId: SoulEssenceRelayRequestId; kind: SoulKind; progress: SoulEssenceJobProgress }
  | { type: "vrsync:soulEssenceResult"; requestId: SoulEssenceRelayRequestId; kind: SoulKind; essence?: SoulEssence; error?: string }
  | { type: "vrsync:scheduled"; scheduled: ScheduledTask[] } // the desktop's scheduled tasks → phone ⏰ Scheduled panel
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
  // Phone added a book to the library (an "Add to library" on a chat file card) → store it on the
  // DESKTOP, for the same reason as the delete above. A phone-local add landed in a store nothing
  // reads: the list it appeared in came from the desktop, and vrcmd:open then named an id the desktop
  // had never seen, so the entry couldn't be opened from either side.
  | { type: "vrcmd:libraryAdd"; book: BookSource }
  | { type: "vrcmd:home" } // leave the open book (back to the desktop's home screen)
  | { type: "vrcmd:settings"; settings: ReaderSettings } // phone edited settings → apply on the desktop (it renders)
  | { type: "vrcmd:planner"; command: PlannerCommand } // phone Tasks/Calendar action → run on the desktop
  // Phone ⏰ Scheduled action → apply on the desktop (it owns the schedule store AND the runner, so a
  // phone-local write would be invisible to the thing that actually fires them, then clobbered by the
  // next vrsync:scheduled push).
  | {
      type: "vrcmd:scheduled";
      command:
        | { action: "toggle"; id: string; enabled: boolean }
        | { action: "delete"; id: string }
        // Move an action onto a task (or off one, with planId absent) — it decides which chat the
        // action runs in, so the phone needs it as much as the desktop.
        | { action: "bind"; id: string; planId?: string }
        // Change WHEN an action runs. The phone shows the desktop's schedule and has no runner of its
        // own, so editing a cadence locally changed nothing the desktop would ever act on.
        | { action: "reschedule"; id: string; rule?: "daily" | "weekly" | "monthly" | "once"; time?: string; weekday?: number; dayOfMonth?: number }
        // Fire it on demand. The desktop owns the runner and the chats an action runs in, so a phone
        // can only ask.
        | { action: "runNow"; id: string }
        /** Change WHAT the action does. `stepText` is the checklist as edited text (one step per
         * line) rather than parsed steps, so the phone relays exactly what was typed and the desktop
         * — which owns the store — does the parsing, one implementation instead of two. */
        | { action: "edit"; id: string; title: string; prompt: string; stepText: string }
        /** Open the action's own workspace ON THE DESKTOP and switch to it. The phone can't mint the
         * session — the desktop owns them — but it can ask, exactly as it does for every other chat
         * switch (vrcmd:chatSwitch); the mirror then shows the phone the same window. */
        | { action: "openWorkspace"; id: string }
        /** Ask the assistant to author this action's checklist, in its own workspace. */
        | { action: "planSteps"; id: string };
    }
  // Landing-page chat actions the phone relays — the desktop owns the chat (it has the models + the
  // working folder), so the phone never runs a turn locally: it relays the intent, the desktop runs
  // its existing buddy handler, and the result flows back via the `vrsync:chat` mirror.
  | { type: "vrcmd:chatSend"; text: string; attachments?: ChatSendAttachment[] } // phone typed a message (+ files) → run the turn on the desktop
  | {
      type: "vrcmd:storyStart";
      command: string;
      bubble: string;
      label: string;
      /** Trusted UI mapping; deliberately separate from the slash-command JSON. */
      storySoulCast?: { self: string; user: string };
    } // atomically create/bind a clean desktop story chat, then dispatch /story
  | { type: "vrcmd:chatSwitch"; id: string } // make this session active on the desktop
  | { type: "vrcmd:chatClose"; id: string } // close (hide, KEEP history) — not a delete
  | { type: "vrcmd:chatReopen"; id: string } // bring a closed session back into the switcher
  | { type: "vrcmd:chatNew" } // start a fresh chat session on the desktop
  | { type: "vrcmd:chatDelete"; id: string } // delete a session on the desktop
  | { type: "vrcmd:chatDeleteMessage"; index: number } // delete one message from the active session on the desktop (it persists + re-mirrors)
  | { type: "vrcmd:memory"; notes: MemoryNote[] } // phone edited the Memory panel → save the whole list on the desktop (it owns the store + re-mirrors)
  | { type: "vrcmd:skillSave"; name: string; description: string; body: string } // phone saved a skill → save on the desktop (it owns the store + re-mirrors vrsync:skills)
  | { type: "vrcmd:skillDelete"; name: string } // phone deleted a skill → forget it on the desktop
  // Phone edited a Soul panel → save on the desktop (it owns the store the assistant actually reads,
  // so a phone-local write would change nothing and be clobbered by the next vrsync:soul).
  | { type: "vrcmd:soulSave"; kind: SoulKind; notes: SoulNote[] }
  | { type: "vrcmd:soulName"; kind: SoulKind; name: string }
  // Phone added a reference photo → APPEND it on the desktop. Append, not replace: the phone has
  // never held the existing photos (only their count), so a full-list save from there would wipe
  // every photo it couldn't see. Downscaled before sending so one image fits a relay frame.
  | { type: "vrcmd:soulPhotoAdd"; kind: SoulKind; image: SoulImage }
  // Phone pruned a misfiled line from a generated Essence → save it on the desktop, which owns the
  // store the assistant reads (a phone-local write changes nothing and is clobbered by vrsync:soul).
  | { type: "vrcmd:soulEssenceEdit"; kind: SoulKind; essence: SoulEssence }
  | { type: "vrcmd:soulEssenceRefresh"; requestId: SoulEssenceRelayRequestId; kind: SoulKind }
  | { type: "vrcmd:soulEssenceCancel"; requestId: SoulEssenceRelayRequestId; kind: SoulKind }
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
  // Phone tapped "Set up reference photos" → the DESKTOP installs the IP-Adapter nodes + models (it
  // owns the engine folder AND is the machine that renders), and the download progress mirrors back
  // the same way every other model download does.
  | { type: "vrcmd:installIpAdapter" }
  | { type: "vrcmd:openLocalFile"; path: string } // open a PC file (PDF/EPUB/doc) FROM the desktop's disk as a book; the desktop reads + imports it, the open book mirrors back
  | { type: "vrcmd:hostTool"; requestId: number; call: BuddyToolCall; cwd?: string } // run a desktop-runtime tool (files/command/screenshot) on the desktop, in the phone's chosen working folder
  | { type: "vrcmd:fetchFile"; reqId: number; id: string }; // ask the desktop for the full bytes of a file card whose bytes the mirror stripped (lazy image fetch)

export type AppSyncMessage = SyncToPhone | CmdToDesktop;

/** A command the phone sends the desktop (vs. a state push the desktop sends the phone). */
export function isCmdToDesktop(msg: AppSyncMessage): msg is CmdToDesktop {
  return msg.type.startsWith("vrcmd:");
}
