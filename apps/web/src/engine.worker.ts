/// <reference lib="webworker" />
import { Engine, IndexedDbStore } from "@visual-reader/core";
// Import buildProviders via the React-free subpath: pulling it from the package
// index would drag the React UI components into the worker, which can crash the
// worker on load (no `window`/DOM) under dev's cross-origin isolation.
import { buildProviders } from "@visual-reader/ui/providers";
import type { ReaderSettings } from "@visual-reader/ui";
import type { MainToWorker, WorkerToMain } from "./worker-protocol.js";

/**
 * Engine host. Runs the Visual Bible extraction, render pipeline, and JIT buffer
 * off the main thread. Persists to IndexedDB (available in workers), and
 * transfers rendered image bytes back to the UI zero-copy.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let settings: ReaderSettings | undefined;
let engine: Engine | undefined;
/** A "start" that arrived before the engine existed; applied once it's ready. */
let pendingStart = false;

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

/** Begin generation now if the engine is up, else remember to start on open. */
function beginGeneration(): void {
  if (engine) {
    engine.startGeneration();
    post({ type: "generating", value: true });
  } else {
    pendingStart = true;
  }
}

ctx.onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      settings = msg.settings;
      // Report which providers are live vs. a silent mock fallback (and why), so
      // the UI can show it before a book is even opened.
      try {
        const { diagnostics } = buildProviders(settings);
        post({ type: "providers", diagnostics });
      } catch (err) {
        post({
          type: "error",
          message: `Provider setup failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      break;
    case "open":
      void handleOpen(msg.book);
      break;
    case "start":
      beginGeneration();
      break;
    case "goto":
      engine?.goToPage(msg.pageIndex);
      break;
    case "idle":
      engine?.setIdleAllowed(msg.allowed);
      break;
    case "prerenderAll":
      engine?.prerenderAll();
      post({ type: "generating", value: true });
      break;
  }
};

async function handleOpen(book: import("@visual-reader/core").BookSource): Promise<void> {
  if (!settings) {
    post({ type: "error", message: "Worker received open before init" });
    return;
  }
  try {
    post({ type: "status", message: "" });
    post({ type: "generating", value: false });
    pendingStart = false; // fresh open; the hook re-sends "start" if it should resume
    const { llm, image, tier, diagnostics } = buildProviders(settings, {
      onLocalStatus: (message) => post({ type: "status", message: message || "Building the Visual Bible…" }),
    });
    post({ type: "providers", diagnostics });
    engine = new Engine({
      llm,
      image,
      tier,
      store: new IndexedDbStore(),
      onUpdate: (pageIndex, result) => {
        const transfer = result.image ? [result.image.bytes] : [];
        post({ type: "update", pageIndex, result }, transfer);
      },
      onBibleProgress: (done, total) => {
        // Clear the status line once extraction is done (or nothing to do); else
        // show which chapter is being analyzed. Rendering runs alongside this.
        post({
          type: "status",
          message:
            total <= 0 || done >= total
              ? ""
              : `Building the Visual Bible… chapter ${done + 1}/${total} (illustrating as chapters finish)`,
        });
      },
      // The bible builds in the background; relay each growth so the UI's
      // character/spoiler context (and the panel) stay current.
      onBibleUpdate: (bible) => post({ type: "opened", bible }),
    });
    // Loads the book + restores cached bible/images, but does NOT generate. The
    // user triggers generation via the "start" message ("Begin generating book").
    await engine.openBook(book);
    engine.goToPage(0);
    // Resume generation if "start" was requested while this open was in flight.
    if (pendingStart) beginGeneration();
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
