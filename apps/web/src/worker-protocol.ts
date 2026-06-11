import type {
  BookSource,
  CharacterPatch,
  ChatTurn,
  ImageResult,
  ImageSearchHit,
  ImportStats,
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
  | { type: "init"; settings: ReaderSettings }
  /**
   * Render-tuning change only (style/quality/aspect/sampler…): update the LIVE engine's
   * tier so future renders use it — without disposing the engine, aborting in-flight
   * work, or re-opening the book (which `init`+`open` do for identity changes).
   */
  | { type: "tune"; settings: ReaderSettings }
  | { type: "open"; book: BookSource }
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
  | { type: "testRender"; requestId: number; text: string }
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
  /** Run a user-APPROVED generate_image tool call (answered by `chatToolResult`). */
  | { type: "chatTool"; requestId: number; call: ToolCall }
  | { type: "chatCancel"; requestId: number };

export type WorkerToMain =
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
  | { type: "error"; message: string }
  /** Incremental assistant text (streaming providers only). */
  | { type: "chatToken"; requestId: number; text: string }
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
  | { type: "chatError"; requestId: number; message: string };
