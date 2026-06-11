import type {
  BookSource,
  CharacterPatch,
  ImageResult,
  ImportStats,
  VisualBible,
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
  | { type: "paintForward"; fromUnit: number };

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
  | { type: "error"; message: string };
