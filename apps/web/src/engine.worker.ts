/// <reference lib="webworker" />
import { Engine, IndexedDbStore, toRenderUnits } from "@visual-reader/core";
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

// --- Live Visual Bible status ---------------------------------------------
// A single chapter's extraction is one (slow) LLM call, so without sub-step
// feedback it looks frozen. We show the chapter, an elapsed-seconds ticker, and
// the streamed token count so progress (or a stall) is always visible.
let bibleActive = false;
let bibleBase = "";
let bibleTokens = 0;
let bibleStartMs = 0;
let bibleTimer: ReturnType<typeof setInterval> | undefined;
/** Pages in each STORY chapter, ordered by chapter — for "pages analysed" + %. */
let storyPageCounts: number[] = [];
let storyPagesTotal = 0;

/** Precompute story-chapter page counts from the ORIGINAL (un-grouped) book. */
function setStoryPageCounts(book: import("@visual-reader/core").BookSource): void {
  const storyChapters = book.chapters.filter((c) => c.isStory !== false);
  storyPageCounts = storyChapters.map(
    (c) => book.pages.filter((p) => p.chapterId === c.id).length,
  );
  storyPagesTotal = storyPageCounts.reduce((a, b) => a + b, 0);
}

function renderBibleStatus(): void {
  if (!bibleActive) return;
  const secs = Math.round((Date.now() - bibleStartMs) / 1000);
  const detail = bibleTokens > 0 ? `${bibleTokens} tokens` : "analyzing";
  post({ type: "status", message: `${bibleBase} · ${secs}s · ${detail}` });
}

function stopBibleTimer(): void {
  if (bibleTimer !== undefined) {
    clearInterval(bibleTimer);
    bibleTimer = undefined;
  }
}

/**
 * `done`/`total` are STORY chapters. We also derive pages-analysed (sum of the
 * first `done` story chapters' page counts) and a percentage, so the reader sees
 * "Building the Visual Bible… 3/12 chapters · 24% · pages 40/210".
 */
function setBibleChapter(done: number, total: number): void {
  if (total <= 0 || done >= total) {
    bibleActive = false;
    bibleTokens = 0;
    stopBibleTimer();
    post({ type: "status", message: "" });
    return;
  }
  bibleActive = true;
  const percent = Math.round((done / total) * 100);
  const pagesDone = storyPageCounts.slice(0, done).reduce((a, b) => a + b, 0);
  const pages = storyPagesTotal > 0 ? ` · pages ${pagesDone}/${storyPagesTotal}` : "";
  bibleBase =
    `Building the Visual Bible… ${done}/${total} chapters · ${percent}%${pages} ` +
    `(illustrating as chapters finish)`;
  bibleTokens = 0;
  bibleStartMs = Date.now();
  stopBibleTimer();
  bibleTimer = setInterval(renderBibleStatus, 1000);
  renderBibleStatus();
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
    case "pause":
      engine?.pauseGeneration();
      post({ type: "paused", value: true });
      break;
    case "resume":
      engine?.resumeGeneration();
      post({ type: "paused", value: false });
      break;
    case "regenerateStoryboard":
      void engine?.regenerateStoryboard();
      post({ type: "paused", value: false });
      break;
    case "regenerateAllImages":
      void engine?.regenerateAllImages();
      post({ type: "generating", value: true });
      post({ type: "paused", value: false });
      break;
    case "regenerateImage":
      void engine?.regenerateCurrentImage(msg.unitIndex);
      post({ type: "generating", value: true });
      post({ type: "paused", value: false });
      break;
    case "updateCharacter":
      // Save-only: persists the edit and broadcasts the updated bible; existing
      // images are left as-is until the user re-renders.
      void engine?.updateCharacter(msg.characterId, msg.patch);
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
      post({ type: "paused", value: false });
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
    post({ type: "paused", value: false });
    pendingStart = false; // fresh open; the hook re-sends "start" if it should resume
    bibleActive = false;
    stopBibleTimer();
    setStoryPageCounts(book); // progress is reported against story pages/chapters
    const { llm, image, tier, diagnostics } = buildProviders(settings, {
      onLocalStatus: (message) => post({ type: "status", message: message || "Building the Visual Bible…" }),
      onLocalActivity: (activity) => {
        // Live token count during on-device generation. Bible tokens enrich the
        // bible status line; prompt-writing tokens show only when the bible isn't
        // claiming the line (so the two never fight over it).
        if (activity.phase === "bible") {
          bibleTokens = activity.tokens;
          renderBibleStatus();
        } else if (!bibleActive && activity.tokens > 0) {
          post({ type: "status", message: `Writing the illustration prompt… ${activity.tokens} tokens` });
        }
      },
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
        // Image generation has begun/finished → the prompt is written; clear the
        // transient "writing prompt" line (unless the bible owns the status line).
        if (
          !bibleActive &&
          (result.status === "ready" ||
            (result.status === "rendering" && result.progress !== undefined))
        ) {
          post({ type: "status", message: "" });
        }
      },
      onBibleProgress: (done, total) => setBibleChapter(done, total),
      // The bible builds in the background; relay each growth so the UI's
      // character/spoiler context (and the panel) stay current.
      onBibleUpdate: (bible) => post({ type: "opened", bible }),
      illustrateAfter: settings.illustrateAfter ?? "book",
    });
    // Re-segment into render units (one image per page, or per chapter) so the
    // engine renders at the chosen granularity. The UI maps the reader's position
    // to the same units via toRenderUnits, so the two never drift.
    const renderBook = toRenderUnits(book, settings.pagesPerImage ?? 3).book;
    // Loads the book + restores cached bible/images, but does NOT generate. The
    // user triggers generation via the "start" message ("Begin generating book").
    await engine.openBook(renderBook);
    engine.goToPage(0);
    // Resume generation if "start" was requested while this open was in flight.
    if (pendingStart) beginGeneration();
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
