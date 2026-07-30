import type {
  BookPassage,
  BookSearchHit,
  BookSource,
  BookSummary,
  BuddyPersona,
  BuddyPlan,
  BuddyToolCall,
  BuddyToolResultPayload,
  CalendarEvent,
  CreatedFileRef,
  StockQuote,
  Indicators,
  PageText,
  BusCommand,
  BibleEntityKind,
  CharacterPatch,
  CreaturePatch,
  EnvironmentPatch,
  ChatTurn,
  ContextUsage,
  ImageResult,
  AnalyzeChart,
  DataTable,
  ImageSearchHit,
  ImportStats,
  PolishMode,
  TaskCandidate,
  TaskPlan,
  TaskSource,
  ToolCall,
  SoulEssence,
  SoulKind,
  SoulNote,
  VideoModelFiles,
  VideoRenderParams,
  VisualBible,
  WebSearchHit,
} from "@visual-reader/core";
import type { ProvidersDiagnostics, ReaderSettings } from "@visual-reader/ui";
import type { EngineVram } from "./remote-sync.js";

/**
 * Message protocol between the main thread and the engine Web Worker. The engine
 * (Visual Bible extraction + image rendering) runs entirely in the worker so it
 * never blocks the reading UI — this is the spec's "background worker generating"
 * model. Image bytes are transferred (zero-copy) rather than cloned.
 */

export type MainToWorker =
  /**
   * `corsProxy` is set when the host has a CORS-exempt native fetch (the Tauri
   * desktop shell): the worker then routes its CORS-blocked paths (keyless web
   * search, open-this-URL page fetches) through `corsFetch` round-trips below.
   */
  | { type: "init"; settings: ReaderSettings; corsProxy?: boolean }
  /**
   * Render-tuning change only (style/quality/aspect/sampler…): update the LIVE engine's
   * tier so future renders use it — without disposing the engine, aborting in-flight
   * work, or re-opening the book (which `init`+`open` do for identity changes).
   */
  | { type: "tune"; settings: ReaderSettings }
  /** The current set of files the assistant has written to the workspace this session, so the worker can
   * inject a terse non-trimmable reminder into the buddy prompt (the model stays aware of what it made). */
  | { type: "fileLedger"; files: CreatedFileRef[] }
  /** The workspace's AGENTS.md / CONVENTIONS.md text (read by the host each turn), injected into the
   * buddy prompt as durable project conventions. Empty string when there's no such file. */
  | { type: "projectGuide"; text: string }
  /** The document the reader is currently viewing (e.g. one they uploaded/opened), so the buddy can
   * discuss + revise it. `doc` absent ⇒ clear the active document. create_document sets it itself. */
  | { type: "activeDocument"; doc?: { title: string; content: string } }
  | { type: "open"; book: BookSource }
  /** Patch the open book's edited data table(s) in place (no re-init), so the chat's
   * analyze_data sees edits made in the grid. Lightweight sibling of "open". */
  | { type: "updateBookData"; data?: DataTable; dataSheets?: { name: string; table: DataTable }[] }
  /** Exit the current book to the landing page: dispose the engine, drop the book. */
  | { type: "close" }
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "pauseBible" }
  | { type: "resumeBible" }
  | { type: "pauseImages" }
  | { type: "resumeImages" }
  | { type: "regenerateStoryboard" }
  /** Story header controls (no model round): set the auto-illustrate cadence, illustrate the latest
   * beat on demand, or switch the writing workflow mid-story. */
  | { type: "storySetCadence"; mode: "per-response" | "every-n" | "manual"; n?: number }
  | { type: "storyRenderLatest" }
  | { type: "storySetMode"; mode: "direct" | "roleplay" }
  | { type: "rebuildPrompts" }
  | { type: "regenerateAllImages" }
  | { type: "regenerateImage"; unitIndex: number }
  /** Fill gaps (missing prompts + failed/un-rendered units) without discarding finished images. */
  | { type: "completeBook" }
  | { type: "updateCharacter"; characterId: string; patch: CharacterPatch }
  | { type: "updateCreature"; creatureId: string; patch: CreaturePatch }
  | { type: "updateEnvironment"; environmentId: string; patch: EnvironmentPatch }
  /** Delete a bible entry (character / creature / place); remembered so re-extraction can't undo it. */
  | { type: "removeBibleEntry"; kind: BibleEntityKind; id: string }
  /** Put a deleted bible entry back, exactly as it was. */
  | { type: "restoreBibleEntry"; kind: BibleEntityKind; id: string }
  | { type: "addCharacterReference"; characterId: string; image: { bytes: ArrayBuffer; mimeType: string } }
  | { type: "removeCharacterReference"; characterId: string; refId: string }
  /** Fetch a reference image's bytes for a UI thumbnail (answered by `characterReference`). */
  | { type: "getCharacterReference"; refId: string; requestId: number }
  | { type: "exportBible" }
  | { type: "importBible"; json: string }
  | { type: "carryOverBible"; fromBookId: string }
  /** Repaint from this unit to the end with current settings; earlier units kept. */
  | { type: "paintForward"; fromUnit: number }
  /**
   * Freeform playground: render ONE image straight from the given text with the current
   * provider/style/quality — no bible, no LLM, no cache. Answered by `testRendered`.
   */
  | {
      type: "testRender";
      requestId: number;
      text: string;
      /** img2img base photo (the photo-transform path) + strength 0..1. */
      initImage?: { bytes: ArrayBuffer; mimeType: string };
      denoise?: number;
      /** Output dimensions — the photo path passes the source photo's aspect. */
      size?: { width: number; height: number };
    }
  /**
   * Reading-companion chat: one user message. `history` is the prior transcript
   * (model-facing turns), `position` the reader's place (for spoiler-safe context).
   * Streams `chatToken`/`chatTool`/`chatToolResult`, finishes with `chatDone`/`chatError`.
   */
  | {
      type: "chat";
      requestId: number;
      history: ChatTurn[];
      userText: string;
      position: { pageIndex: number; paragraphIndex: number };
      allowSpoilers: boolean;
    }
  /** Ask the chat's vision model to describe a captured screenshot (answered by
   * `imageAssessed`). Bytes travel zero-copy. */
  | { type: "assessImage"; requestId: number; image: { bytes: ArrayBuffer; mimeType: string }; question?: string }
  /** Run a user-APPROVED generate_image tool call (answered by `chatToolResult`). */
  | { type: "chatTool"; requestId: number; call: ToolCall }
  /** Run a user-APPROVED generate_video call: the host resolved the SOURCE image bytes + the model files
   * (the worker has no access to the chat's images / library); answered by `chatToolResult` (video field). */
  | {
      type: "chatVideo";
      requestId: number;
      call: Extract<BuddyToolCall, { tool: "generate_video" }>;
      /** The source frame for image-to-video; omitted for text-to-video. */
      image?: { bytes: ArrayBuffer; mimeType: string };
      /** END-frame conditioning (first+last frame, Wan only): the clip arrives at this image. */
      endImage?: { bytes: ArrayBuffer; mimeType: string };
      models: VideoModelFiles;
      /** The reader's Settings render-param overrides (size/length/sampler choices). */
      params?: VideoRenderParams;
      /** Long-form batch clip 2..N: keep the video model resident (skip the pre-render VRAM hand-off). */
      warmBatch?: boolean;
      /** Long-form batch, every clip BUT the last: keep the video model resident AFTER the render (skip
       * the post-render /free), so the next clip finds it warm. The last clip leaves this unset and frees. */
      keepResident?: boolean;
    }
  /** Send a user-APPROVED send_email tool call (answered by `buddyEmailSent`). */
  | {
      type: "buddySendEmail";
      requestId: number;
      call: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] };
    }
  | { type: "chatCancel"; requestId: number }
  /** Force-load the local chat model now (it gets evicted to free the GPU during image renders). */
  | { type: "warmLlm" }
  /** Run write-capable CODING agents in parallel, each in its own worktree dir (answered by
   * `codingAgentsDone`). During the run the worker emits `agentTool` requests for the host to
   * execute each agent's commands/writes in its `dir`. */
  | {
      type: "runCodingAgents";
      requestId: number;
      runId: string;
      agents: { title: string; instructions: string; dir: string }[];
    }
  | { type: "codingAgentCancel"; requestId: number }
  /** Auto-resolve git merge conflicts with the main model (answered by `conflictsResolved`). */
  | {
      type: "resolveConflicts";
      requestId: number;
      agentTitle: string;
      files: { file: string; base: string; ours: string; theirs: string }[];
    }
  /** The host's result for one agent's host-tool request (answers a worker `agentTool`). */
  | { type: "agentToolResult"; callId: number; result: BuddyToolResultPayload }
  /** Compact a chat: summarize these model-facing turns (answered by `summarized`). */
  | { type: "summarize"; requestId: number; turns: ChatTurn[] }
  /** Rebuild one derived Soul Essence from its complete authoritative note list. */
  | { type: "soulEssenceRefresh"; requestId: number; kind: SoulKind }
  /** Finish Google OAuth: exchange the consent code (worker has the CORS proxy + store). */
  | { type: "googleConnect"; requestId: number; code: string; redirectUri: string; codeVerifier: string }
  /** Plan a task: research it, produce a structured TaskPlan, and persist it (worker has
   * the CORS proxy + Google deps + store). `sourceText` is the typed ask or the source
   * email/event content the host already read. */
  | { type: "planTask"; requestId: number; source: TaskSource; sourceText: string; planId?: string; allowFiles?: boolean }
  /** Idle scan: surface actionable email/calendar items as task candidates (Phase 2). */
  | { type: "scanInbox"; requestId: number }
  /** Mirror the user's existing Google Tasks INTO the app's task list (those not already present). */
  | { type: "importGoogleTasks"; requestId: number }
  /** Create a bare Google Task (parent) for a freshly-surfaced scan stub, so it shows up in Google
   * Tasks right away; planning later pushes its sub-tasks + the plan under this parent. */
  | { type: "createGoogleTask"; requestId: number; title: string; notes?: string; due?: string }
  /** Create a Google Calendar event (manual "+ Add event" on the in-app calendar). */
  | { type: "createEvent"; requestId: number; summary: string; start: string; end: string; description?: string; location?: string }
  /** Edit an existing Google Calendar event from the Calendar panel (only the given fields change;
   * `appendDescription` adds to the event's current text rather than replacing it). */
  | {
      type: "updateEvent";
      requestId: number;
      eventId: string;
      calendarId?: string;
      patch: { summary?: string; start?: string; end?: string; description?: string; appendDescription?: string; location?: string };
    }
  /** Load events across all the user's Google calendars in a window (the calendar view). */
  | { type: "loadCalendar"; requestId: number; timeMin: string; timeMax: string }
  | { type: "stockQuote"; requestId: number; symbol: string }
  | { type: "marketIndicators"; requestId: number; symbol: string; interval?: string; range?: string }
  /** Fetch a URL's readable text + on-page links for the in-app browser panel. */
  | { type: "readPage"; requestId: number; url: string }
  /** Remote bus: list pending "VR:" Google-Task commands; write an answer back + complete one. */
  | { type: "remoteBusList"; requestId: number }
  | { type: "remoteBusReply"; requestId: number; id: string; answer: string }
  /** Exchange a Schwab OAuth consent code for tokens (manual-paste connect). */
  | { type: "schwabConnect"; requestId: number; code: string; redirectUri: string }
  /** Place a composed order against the connected Schwab account (host review action). */
  | { type: "schwabPlaceOrder"; requestId: number; order: Record<string, unknown> }
  /** Faithful document polish (two stages); answered by `polished` (+ `polishToken`
   * deltas while producing). Cancel via `chatCancel` (shares the abort map). */
  | {
      type: "polish";
      requestId: number;
      stage: "understand" | "produce";
      mode?: PolishMode;
      freeText: string;
      source: string;
      confirmedPlan?: string;
    }
  /** Reply to a worker `corsFetch` (the native fetch's outcome, body base64). */
  | {
      type: "corsFetchResult";
      fetchId: number;
      ok: boolean;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      bodyBase64?: string;
      error?: string;
    }
  /** Reply to a worker `mcpStdio` (the spawned server's stdout lines, or an error). */
  | { type: "mcpStdioResult"; callId: number; ok: boolean; lines?: string[]; error?: string }
  /** Reply to a worker `hostFile` (local-file search/read + PDF text extraction — main thread
   * owns the Tauri bridge + pdfjs). */
  | { type: "hostFileResult"; callId: number; ok: boolean; files?: { name: string; path: string }[]; text?: string; imageBase64?: string; mimeType?: string; name?: string; error?: string }
  /** Ack for a worker `llmVram` (the stop/ensure ran on the main thread). */
  | { type: "llmVramResult"; callId: number }
  /**
   * Landing-page buddy: one user message BEFORE any book is open. `library` is the
   * reader's book list (for open_library_book); `persona` picks the entertainment
   * vs. technical voice. Streams `buddyToken`/`buddyTool`/`buddyToolResult` (and
   * `buddyOpened` when a tool opens a book), finishes with `buddyDone`/`buddyError`.
   * Cancelled by the shared `chatCancel` (request ids come from one counter).
   */
  | {
      type: "buddyChat";
      requestId: number;
      history: ChatTurn[];
      userText: string;
      persona: BuddyPersona;
      library: BookSummary[];
      /** The session's chosen working folder (desktop), so the prompt tells the model
       * where its run_command/find_files operate. Absent = the default workspace. */
      workingDir?: string;
      /** When this session is executing a task plan: its id, so the prompt loads the
       * plan context + enables the step tools. */
      taskPlanId?: string;
      /** A code file is open in the reader's editable code window — its workspace filename (+ title
       * and language), so the prompt tells the model to edit/run THAT file in place. */
      currentCodeFile?: { name: string; title: string; language?: string };
      /** The chat's current lightweight working checklist (set_plan/complete_step), injected into the
       * prompt so the model resumes from the first unfinished step. In app-managed-steps mode this is
       * the host's live workflow rendered as a plan (only the current step shows). */
      plan?: BuddyPlan;
      /** App-managed-steps mode is ON for this turn (the host decides — setting + weak-model auto-on):
       * the prompt shows only the current step and complete_step is withdrawn (the host advances). */
      appManagedSteps?: boolean;
      /** This turn is an UNATTENDED creative run: the tool loop refuses everything outside
       * CREATIVE_IDLE_TOOLS, and the prompt drops the workspace/desktop capabilities entirely. */
      creativeIdle?: boolean;
      /** This conversation is the dedicated Creative window. It remains true for reader-authored
       * turns there, while `creativeIdle` only marks the unattended run itself. */
      creativeSession?: boolean;
    };

export type WorkerToMain =
  /** Route one HTTP request through the host's CORS-exempt native fetch
   * (desktop Rust shell). Answered by `corsFetchResult` with the same fetchId. */
  | {
      type: "corsFetch";
      fetchId: number;
      request: { url: string; method: string; headers: Record<string, string>; bodyBase64?: string };
    }
  /** Run a stdio MCP server (spawn the command, pipe JSON-RPC lines). Desktop only; answered
   * by `mcpStdioResult` with the same callId. */
  | { type: "mcpStdio"; callId: number; command: string; args: string[]; input: string[] }
  /** Local-file op the worker can't do itself (Tauri bridge + pdfjs live on the main thread):
   * search the disk, read a file's text, or extract text from attachment PDF bytes. Answered by
   * `hostFileResult` with the same callId. */
  | { type: "hostFile"; callId: number; op: "search" | "read" | "pdftext" | "imageBytes"; query?: string; path?: string; bytesBase64?: string }
  /** Free or relaunch the bundled chat LLM's VRAM (Tauri lives on the main thread) so a burst of
   * local image renders gets the whole GPU. Answered by `llmVramResult` with the same callId. */
  | { type: "llmVram"; callId: number; action: "stop" | "ensure" }
  | { type: "status"; message: string }
  | { type: "providers"; diagnostics: ProvidersDiagnostics }
  /** Live GPU VRAM from the local ComfyUI engine (poll of /system_stats), for the status-bar
   * indicator. `vram` absent ⇒ no local engine / unreachable ⇒ the indicator is hidden. */
  | { type: "vram"; vram?: EngineVram }
  | { type: "generating"; value: boolean }
  | { type: "paused"; bible: boolean; images: boolean }
  /** Structured workflow progress (chapters read / prompts written), for the status bar. */
  | { type: "workflow"; bibleDone: number; bibleTotal: number; promptsDone: number; promptsTotal: number }
  | { type: "opened"; bible: VisualBible }
  | { type: "update"; pageIndex: number; result: ImageResult }
  | { type: "bibleStatus"; text: string }
  | { type: "export"; json: string }
  | { type: "imported"; ok: boolean; stats?: ImportStats; error?: string }
  /** Reply to `getCharacterReference`; `image` is absent when the ref doesn't exist. */
  | { type: "characterReference"; requestId: number; image?: { bytes: ArrayBuffer; mimeType: string } }
  /** Reply to `testRender`: the rendered bytes + the exact prompt used, or the error. */
  | {
      type: "testRendered";
      requestId: number;
      ok: boolean;
      image?: { bytes: ArrayBuffer; mimeType: string };
      prompt?: string;
      error?: string;
    }
  /** Render progress 0..1 for a test/photo render (engines that report it). */
  | { type: "testProgress"; requestId: number; fraction: number }
  /** A vision model's text observation of a screenshot (or an error). */
  | { type: "imageAssessed"; requestId: number; text?: string; error?: string }
  | { type: "buddyEmailSent"; requestId: number; id?: string; error?: string }
  /** A coding agent (in the worker) asks the host to execute one host tool in its worktree `cwd`;
   * the host answers with `agentToolResult`. */
  | { type: "agentTool"; callId: number; runId: string; agentIdx: number; call: BuddyToolCall; cwd: string }
  /** All coding agents finished: each agent's concise text result (host then merges + reports). */
  | { type: "codingAgentsDone"; requestId: number; results: { title: string; result: string }[]; error?: string }
  /** Auto-resolved merge conflicts: the merged content per file (host validates + commits). */
  | { type: "conflictsResolved"; requestId: number; files: { file: string; content: string }[]; error?: string }
  | { type: "error"; message: string }
  /** Incremental assistant text (streaming providers only). */
  | { type: "chatToken"; requestId: number; text: string }
  /** A thinking model's live reasoning text (streamed into a dimmed "thinking" area). */
  | { type: "chatThinking"; requestId: number; text: string }
  /** Live status while the model works invisibly (a thinking model reasoning). */
  | { type: "chatActivity"; requestId: number; text: string }
  /** The model called a tool (so the panel can show "searching…"). */
  | { type: "chatTool"; requestId: number; round: number; call: ToolCall }
  /** A tool finished: search hits for inline rendering, or generated image bytes. */
  | {
      type: "chatToolResult";
      requestId: number;
      call: ToolCall;
      hits?: WebSearchHit[];
      imageHits?: ImageSearchHit[];
      image?: { bytes: ArrayBuffer; mimeType: string };
      /** An image-to-video render's output clip (mp4 / animated webp). */
      video?: { bytes: ArrayBuffer; mimeType: string };
      /** search_book passages (slash commands render these in the panel). */
      passages?: BookPassage[];
      /** lookup_bible detail (slash commands render this in the panel). */
      bibleDetail?: string;
      memory?: { action: "remembered" | "forgot"; note: string; about?: "reader" | "self" | "user"; count: number };
      /** A grounded analyze_data result table (rendered inline in the chat). */
      analysis?: { table: DataTable; summary: string; chart?: AnalyzeChart };
      error?: string;
    }
  /** Chat round complete: final prose + the turns to append to the stored history. */
  | {
      type: "chatDone";
      requestId: number;
      text: string;
      transcript: ChatTurn[];
      pendingTool?: ToolCall;
    }
  | { type: "chatError"; requestId: number; message: string }
  /** Context-usage breakdown for the chat/buddy panel donut (posted before the turn). */
  | { type: "chatContextUsage"; requestId: number; usage: ContextUsage }
  /** Incremental buddy text (streaming providers only). */
  | { type: "buddyToken"; requestId: number; text: string }
  /** A thinking model's live reasoning text (streamed into a dimmed "thinking" area). */
  | { type: "buddyThinking"; requestId: number; text: string }
  /** Live status while the model works invisibly (a thinking model reasoning). */
  | { type: "buddyActivity"; requestId: number; text: string }
  | { type: "buddyTool"; requestId: number; round: number; call: BuddyToolCall }
  | {
      type: "buddyToolResult";
      requestId: number;
      call: BuddyToolCall;
      hits?: WebSearchHit[];
      books?: BookSearchHit[];
      imageHits?: ImageSearchHit[];
      applied?: { style?: string; pagesPerImage?: number | "chapter"; illustrateAfter?: "chapter" | "book" };
      removed?: string;
      calc?: { expression: string; result: string };
      wolfram?: { query: string; answer: string };
      memory?: { action: "remembered" | "forgot"; note: string; about?: "reader" | "self" | "user"; count: number };
      /** open_image outcome — the picture's bytes (base64) so the main thread shows it inline in chat. */
      openedImage?: { name: string; mimeType: string; base64: string; observation?: string };
      error?: string;
    }
  /** A buddy tool resolved a full BookSource — the main thread opens it (and
   * starts generation when `visuals` was requested). Arrives mid-turn. */
  | { type: "buddyOpened"; requestId: number; book: BookSource; visuals: boolean }
  /** Story "as you go": a `continue_story` beat grew the OPEN story IN the worker (the engine
   * appended a span without re-opening). The host applies the grown book (setBook + putBook,
   * NOT a re-open, which would dispose the engine + undo the append) and scrolls to the new
   * beat. `firstNewUnit` is the new beat's render-unit index; `illustrate` whether it auto-rendered. */
  | { type: "storyBeat"; requestId: number; book: BookSource; firstNewUnit: number; illustrate: boolean }
  /** Story config changed (e.g. set_story_cadence) WITHOUT a new beat — the host persists the
   * grown book's `storyConfig` so role-play + cadence survive a reopen. No scroll. */
  | { type: "storyConfig"; requestId: number; book: BookSource }
  /** create_document made a real document: the host saves the Markdown source to the workspace,
   * shows a downloadable file card (PDF / Word / Markdown) + a side reader, and caches it (so a
   * linked phone can fetch the bytes). `content` is the Markdown; `path` the workspace-relative file. */
  | {
      type: "documentCreated";
      requestId: number;
      id: string;
      title: string;
      content: string;
      path: string;
      format?: "pdf" | "docx" | "md" | "html";
    }
  /** The buddy updated its lightweight working checklist (set_plan/complete_step) mid-turn — the host
   * renders + persists it as the canonical per-session plan. */
  | { type: "buddyPlan"; requestId: number; plan: BuddyPlan }
  /** remove_library_book deleted a book — the main thread refreshes its library list. */
  | { type: "buddyLibraryChanged"; requestId: number }
  /** A scheduled task was created/cancelled by the chat — the host refreshes its list. */
  | { type: "buddyScheduledChanged"; requestId: number }
  /** A price alert was created/cancelled by the chat — the host refreshes its list. */
  | { type: "buddyAlertsChanged"; requestId: number }
  /** The buddy distilled a reusable skill from a recurring task — the host OFFERS it to the
   * reader to keep (never saved silently). Arrives just before buddyDone. */
  | { type: "buddySkillProposed"; requestId: number; skill: { name: string; description: string; body: string } }
  /** set_visual_style resolved against the catalog — the main thread (settings
   * owner) commits it. Arrives mid-turn, before the tool result. */
  | {
      type: "buddySettings";
      requestId: number;
      style?: { id: string; label: string };
      pagesPerImage?: number | "chapter";
      illustrateAfter?: "chapter" | "book";
      /** A generic validated settings patch from update_setting + a chip summary. */
      patch?: Partial<ReaderSettings>;
      summary?: string;
    }
  | {
      type: "buddyDone";
      requestId: number;
      text: string;
      transcript: ChatTurn[];
      /** An un-executed generate_image awaiting the reader's approval. */
      pendingTool?: BuddyToolCall;
      /** The turn's reasoning, persisted onto the settled message. */
      thinking?: string;
      /** The turn paused at a cloud "keep going?" budget checkpoint (work remains) — the host offers
       * a Continue affordance instead of treating it as a finished answer. */
      paused?: boolean;
    }
  | { type: "buddyError"; requestId: number; message: string }
  /** Reply to `summarize`: the compact brief, or why it failed. */
  | { type: "summarized"; requestId: number; ok: boolean; text?: string; error?: string }
  /** Reply to `soulEssenceRefresh`. */
  | { type: "soulEssenceRefreshed"; requestId: number; ok: boolean; essence?: SoulEssence; error?: string }
  /** A current derived essence was persisted (automatic or manual), with its exact source revision. */
  | { type: "soulEssenceUpdated"; kind: SoulKind; notes: SoulNote[]; essence: SoulEssence }
  | { type: "googleConnected"; requestId: number; ok: boolean; email?: string; error?: string }
  | { type: "planProgress"; requestId: number; phase: "research" | "plan"; note?: string }
  | { type: "planned"; requestId: number; ok: boolean; plan?: TaskPlan; error?: string }
  | { type: "scanned"; requestId: number; ok: boolean; candidates?: TaskCandidate[]; error?: string }
  | { type: "googleTasksImported"; requestId: number; ok: boolean; imported?: number; edited?: number; mirrored?: number; error?: string }
  | { type: "googleTaskCreated"; requestId: number; ok: boolean; id?: string; error?: string }
  | { type: "eventCreated"; requestId: number; ok: boolean; id?: string; error?: string }
  | { type: "eventUpdated"; requestId: number; ok: boolean; id?: string; error?: string }
  | { type: "calendarLoaded"; requestId: number; ok: boolean; events?: CalendarEvent[]; error?: string }
  | { type: "stockQuoted"; requestId: number; ok: boolean; quote?: StockQuote; error?: string }
  | { type: "marketIndicatorsResult"; requestId: number; ok: boolean; indicators?: Indicators; error?: string }
  | { type: "pageRead"; requestId: number; ok: boolean; page?: PageText; error?: string }
  | { type: "remoteBusListed"; requestId: number; ok: boolean; commands?: BusCommand[]; error?: string }
  | { type: "remoteBusReplied"; requestId: number; ok: boolean; error?: string }
  | { type: "schwabConnected"; requestId: number; ok: boolean; error?: string }
  | { type: "schwabOrderPlaced"; requestId: number; ok: boolean; status?: number; error?: string }
  /** Streaming delta while the polish "produce" stage runs. */
  | { type: "polishToken"; requestId: number; text: string }
  /** Reply to `polish`: the understood plan (+ optional question), or the produced text. */
  | {
      type: "polished";
      requestId: number;
      stage: "understand" | "produce";
      ok: boolean;
      plan?: string;
      question?: string;
      text?: string;
      error?: string;
    };
