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
  | { type: "updateCharacter"; characterId: string; patch: CharacterPatch }
  | { type: "setCharacterReference"; characterId: string; image?: { bytes: ArrayBuffer; mimeType: string } }
  | { type: "exportBible" }
  | { type: "importBible"; json: string }
  | { type: "carryOverBible"; fromBookId: string }
  | { type: "goto"; pageIndex: number }
  | { type: "idle"; allowed: boolean }
  | { type: "prerenderAll" };

export type WorkerToMain =
  | { type: "status"; message: string }
  | { type: "providers"; diagnostics: ProvidersDiagnostics }
  | { type: "generating"; value: boolean }
  | { type: "paused"; bible: boolean; images: boolean }
  | { type: "opened"; bible: VisualBible }
  | { type: "update"; pageIndex: number; result: ImageResult }
  | { type: "bibleStatus"; text: string }
  | { type: "export"; json: string }
  | { type: "imported"; ok: boolean; stats?: ImportStats; error?: string }
  | { type: "error"; message: string };
