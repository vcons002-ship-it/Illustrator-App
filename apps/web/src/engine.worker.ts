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
  }
};

async function handleOpen(book: import("@visual-reader/core").BookSource): Promise<void> {
  if (!settings) {
    post({ type: "error", message: "Worker received open before init" });
    return;
  }
  try {
    post({ type: "status", message: "Building the Visual Bible…" });
    const { llm, image, tier } = buildProviders(settings);
    engine = new Engine({
      llm,
      image,
      tier,
      store: new IndexedDbStore(),
      onUpdate: (pageIndex, result) => {
        const transfer = result.image ? [result.image.bytes] : [];
        post({ type: "update", pageIndex, result }, transfer);
      },
    });
    await engine.openBook(book);
    const bible = engine.getBible();
    if (bible) post({ type: "opened", bible });
    engine.setIdleAllowed(true);
    engine.goToPage(0);
    post({ type: "status", message: "" });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
