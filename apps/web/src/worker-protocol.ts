import type { BookSource, ImageResult, VisualBible } from "@visual-reader/core";
import type { ReaderSettings } from "@visual-reader/ui";

/**
 * Message protocol between the main thread and the engine Web Worker. The engine
 * (Visual Bible extraction + image rendering) runs entirely in the worker so it
 * never blocks the reading UI — this is the spec's "background worker generating"
 * model. Image bytes are transferred (zero-copy) rather than cloned.
 */

export type MainToWorker =
  | { type: "init"; settings: ReaderSettings }
  | { type: "open"; book: BookSource }
  | { type: "goto"; pageIndex: number }
  | { type: "idle"; allowed: boolean };

export type WorkerToMain =
  | { type: "status"; message: string }
  | { type: "opened"; bible: VisualBible }
  | { type: "update"; pageIndex: number; result: ImageResult }
  | { type: "error"; message: string };
