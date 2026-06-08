/// <reference lib="webworker" />
import { Engine, IndexedDbStore } from "@visual-reader/core";
import { buildProviders, type ReaderSettings } from "@visual-reader/ui";
import type { MainToWorker, WorkerToMain } from "./worker-protocol.js";

/**
 * Engine host. Runs the Visual Bible extraction, render pipeline, and JIT buffer
 * off the main thread. Persists to IndexedDB (available in workers), and
 * transfers rendered image bytes back to the UI zero-copy.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let settings: ReaderSettings | undefined;
let engine: Engine | undefined;

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
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
      } catch {
        /* diagnostics are best-effort */
      }
      break;
    case "open":
      void handleOpen(msg.book);
      break;
    case "goto":
      engine?.goToPage(msg.pageIndex);
      break;
    case "idle":
      engine?.setIdleAllowed(msg.allowed);
      break;
    case "prerenderAll":
      engine?.prerenderAll();
      break;
  }
};

async function handleOpen(book: import("@visual-reader/core").BookSource): Promise<void> {
  if (!settings) {
    post({ type: "error", message: "Worker received open before init" });
    return;
  }
  try {
    post({ type: "status", message: "Building the Visual Bible…" });
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
    // Returns quickly — the bible builds in the background and pages render as
    // soon as their chapter is ready, so the first image no longer waits for the
    // whole book.
    await engine.openBook(book);
    engine.setIdleAllowed(true);
    engine.goToPage(0);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
