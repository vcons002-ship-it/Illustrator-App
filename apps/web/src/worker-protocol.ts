import type {
  BookPassage,
  BookSearchHit,
  BookSource,
  BookSummary,
  BuddyPersona,
  BuddyToolCall,
  CharacterPatch,
  ChatTurn,
  ContextUsage,
  ImageResult,
  AnalyzeChart,
  DataTable,
  ImageSearchHit,
  ImportStats,
  PolishMode,
  ToolCall,
  VisualBible,
  WebSearchHit,
} from "@visual-reader/core";
import type { ProvidersDiagnostics, ReaderSettings } from "@visual-reader/ui";

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
  | { type: "open"; book: BookSource }
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
  | { type: "rebuildPrompts" }
  | { type: "regenerateAllImages" }
  | { type: "regenerateImage"; unitIndex: number }
  /** Fill gaps (missing prompts + failed/un-rendered units) without discarding finished images. */
  | { type: "completeBook" }
  | { type: "updateCharacter"; characterId: string; patch: CharacterPatch }
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
  | { type: "chatCancel"; requestId: number }
  /** Compact a chat: summarize these model-facing turns (answered by `summarized`). */
  | { type: "summarize"; requestId: number; turns: ChatTurn[] }
  /** Finish Google OAuth: exchange the consent code (worker has the CORS proxy + store). */
  | { type: "googleConnect"; requestId: number; code: string; redirectUri: string; codeVerifier: string }
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
    };

export type WorkerToMain =
  /** Route one HTTP request through the host's CORS-exempt native fetch
   * (desktop Rust shell). Answered by `corsFetchResult` with the same fetchId. */
  | {
      type: "corsFetch";
      fetchId: number;
      request: { url: string; method: string; headers: Record<string, string>; bodyBase64?: string };
    }
  | { type: "status"; message: string }
  | { type: "providers"; diagnostics: ProvidersDiagnostics }
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
      /** search_book passages (slash commands render these in the panel). */
      passages?: BookPassage[];
      /** lookup_bible detail (slash commands render this in the panel). */
      bibleDetail?: string;
      memory?: { action: "remembered" | "forgot"; note: string; count: number };
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
      memory?: { action: "remembered" | "forgot"; note: string; count: number };
      error?: string;
    }
  /** A buddy tool resolved a full BookSource — the main thread opens it (and
   * starts generation when `visuals` was requested). Arrives mid-turn. */
  | { type: "buddyOpened"; requestId: number; book: BookSource; visuals: boolean }
  /** remove_library_book deleted a book — the main thread refreshes its library list. */
  | { type: "buddyLibraryChanged"; requestId: number }
  /** set_visual_style resolved against the catalog — the main thread (settings
   * owner) commits it. Arrives mid-turn, before the tool result. */
  | {
      type: "buddySettings";
      requestId: number;
      style?: { id: string; label: string };
      pagesPerImage?: number | "chapter";
      illustrateAfter?: "chapter" | "book";
    }
  | {
      type: "buddyDone";
      requestId: number;
      text: string;
      transcript: ChatTurn[];
      /** An un-executed generate_image awaiting the reader's approval. */
      pendingTool?: BuddyToolCall;
    }
  | { type: "buddyError"; requestId: number; message: string }
  /** Reply to `summarize`: the compact brief, or why it failed. */
  | { type: "summarized"; requestId: number; ok: boolean; text?: string; error?: string }
  | { type: "googleConnected"; requestId: number; ok: boolean; email?: string; error?: string }
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
