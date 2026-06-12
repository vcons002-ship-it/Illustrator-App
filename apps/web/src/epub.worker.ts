/// <reference lib="webworker" />
import { parseEpub } from "@visual-reader/epub";

/**
 * EPUB parsing off the main thread: unzip + HTML→text + segmentation over a
 * multi-MB file is one synchronous block, which froze the page for the whole
 * import (PDF already parses in pdf.js's worker; this gives EPUB the same).
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<{ bytes: ArrayBuffer; id: string }>) => {
  try {
    const book = parseEpub(new Uint8Array(event.data.bytes), event.data.id);
    ctx.postMessage({ ok: true, book });
  } catch (err) {
    ctx.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
