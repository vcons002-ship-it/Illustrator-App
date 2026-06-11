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

/** Broadcast the current (independent) bible/image pause state + clear status lines. */
function postPaused(): void {
  const biblePaused = engine?.isBiblePaused() ?? false;
  const imagesPaused = engine?.isImagePaused() ?? false;
  post({ type: "paused", bible: biblePaused, images: imagesPaused });
  // Stop the climbing "Building…" ticker and show a STABLE paused line so the user
  // can see the pause took effect (the engine has aborted the in-flight chapter).
  // Only when the bible is mid-build — a complete bible keeps its "complete" line.
  if (biblePaused && bibleRunTotal > 0 && bibleRunDone < bibleRunTotal) {
    bibleActive = false;
    bibleTokens = 0;
    stopBibleTimer();
    post({ type: "bibleStatus", text: `Visual Bible paused · ${bibleRunDone}/${bibleRunTotal} chapters` });
  }
  // Transient line names image-generation state (the bible owns the persistent line).
  if (!bibleActive) post({ type: "status", message: imagesPaused ? "Image generation paused" : "" });
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
/** Text-LLM label (e.g. "Claude Haiku 4.5"), shown in the persistent bible line. */
let llmLabel = "";
/** When the whole bible run started + the done count then, for an ETA. */
let bibleRunStartMs = 0;
let bibleRunStartDone = 0;

/** Human "~Xm left" / "~Xs left" from a millisecond estimate. */
function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return ms < 60000 ? `~${Math.round(ms / 1000)}s left` : `~${Math.round(ms / 60000)}m left`;
}

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
  // Live character count (from each chapter's committed bible) so the cast visibly
  // grows as the book is read.
  const chars = bibleCharacters > 0 ? ` · ${bibleCharacters} character${bibleCharacters === 1 ? "" : "s"}` : "";
  // The persistent bible line carries chapters/%/pages + the cast so far + this
  // chapter's elapsed + an overall ETA (average time per processed chapter so far).
  post({ type: "bibleStatus", text: `${bibleBase}${chars} · ${secs}s · ${detail}${bibleEta()}` });
}

/** "· ~Xm left" from the average time per chapter processed this run, or "". */
function bibleEta(): string {
  const processed = bibleRunDone - bibleRunStartDone;
  if (processed <= 0 || bibleRunStartMs === 0) return "";
  const avg = (Date.now() - bibleRunStartMs) / processed;
  const left = formatEta(avg * (bibleRunTotal - bibleRunDone));
  return left ? ` · ${left}` : "";
}
let bibleRunDone = 0;
let bibleRunTotal = 0;
/** Characters in the bible so far (updated on every bible commit), for the live line. */
let bibleCharacters = 0;

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
  bibleRunDone = done;
  bibleRunTotal = total;
  workflow.bibleDone = done;
  workflow.bibleTotal = total;
  postWorkflow();
  if (total <= 0 || done >= total) {
    // Completed (or nothing to do): keep a PERSISTENT "complete" line — including
    // the model used — instead of clearing it, so the storyboard/LLM stay visible.
    bibleActive = false;
    bibleTokens = 0;
    bibleRunStartMs = 0;
    stopBibleTimer();
    const model = llmLabel ? ` · ${llmLabel}` : "";
    post({
      type: "bibleStatus",
      text: total > 0 ? `Visual Bible complete · ${total}/${total} chapters${model}` : "",
    });
    return;
  }
  if (bibleRunStartMs === 0) {
    bibleRunStartMs = Date.now(); // start the ETA clock at the first pending chapter
    bibleRunStartDone = done;
  }
  bibleActive = true;
  const percent = Math.round((done / total) * 100);
  const pagesDone = storyPageCounts.slice(0, done).reduce((a, b) => a + b, 0);
  const pages = storyPagesTotal > 0 ? ` · pages ${pagesDone}/${storyPagesTotal}` : "";
  // Say what the mode actually does: chapter mode paints as it reads; book mode
  // holds every image until the whole book is analysed (best art).
  const when =
    (settings?.illustrateAfter ?? "book") === "chapter"
      ? "(illustrating as chapters finish)"
      : "(images start after the whole book is read)";
  bibleBase = `Building the Visual Bible… ${done}/${total} chapters · ${percent}%${pages} ${when}`;
  bibleTokens = 0;
  bibleStartMs = Date.now();
  stopBibleTimer();
  bibleTimer = setInterval(renderBibleStatus, 1000);
  renderBibleStatus();
}

/**
 * Prompt progress. Prompts are folded into each chapter's extraction, so this now
 * arrives DURING the bible build (per chapter) as well as from the final gap-fill
 * sweep. Mid-extraction it only advances the workflow bar — the live bible line
 * keeps its ticker; once extraction is done, it owns the persistent line.
 */
function setPromptProgress(done: number, total: number): void {
  if (total <= 0) return;
  workflow.promptsDone = done;
  workflow.promptsTotal = total;
  postWorkflow();
  if (bibleActive) return; // extraction still running — its live line stays up
  stopBibleTimer();
  const model = llmLabel ? ` · ${llmLabel}` : "";
  post({
    type: "bibleStatus",
    text:
      done >= total
        ? `Illustration prompts ready · ${total}/${total}${model}`
        : `Writing illustration prompts… ${done}/${total}`,
  });
}

/** Structured chapter/prompt progress for the always-visible workflow bar. */
const workflow = { bibleDone: 0, bibleTotal: 0, promptsDone: 0, promptsTotal: 0 };
function postWorkflow(): void {
  post({ type: "workflow", ...workflow });
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
      postPaused();
      break;
    case "resume":
      engine?.resumeGeneration();
      postPaused();
      break;
    case "pauseBible":
      engine?.setBiblePaused(true);
      postPaused();
      break;
    case "resumeBible":
      engine?.setBiblePaused(false);
      postPaused();
      break;
    case "pauseImages":
      engine?.setImagePaused(true);
      postPaused();
      break;
    case "resumeImages":
      engine?.setImagePaused(false);
      postPaused();
      break;
    case "regenerateStoryboard":
      void engine?.regenerateStoryboard();
      postPaused();
      break;
    case "rebuildPrompts":
      void engine?.rebuildPrompts();
      break;
    case "regenerateAllImages":
      void engine?.regenerateAllImages();
      post({ type: "generating", value: true });
      postPaused();
      break;
    case "regenerateImage":
      void engine?.regenerateCurrentImage(msg.unitIndex);
      post({ type: "generating", value: true });
      postPaused();
      break;
    case "updateCharacter":
      // Save-only: persists the edit and broadcasts the updated bible; existing
      // images are left as-is until the user re-renders.
      void engine?.updateCharacter(msg.characterId, msg.patch);
      break;
    case "addCharacterReference":
      // User-uploaded IP-Adapter reference (multi-view; the engine enforces the cap).
      void engine?.addCharacterReference(msg.characterId, msg.image);
      break;
    case "removeCharacterReference":
      void engine?.removeCharacterReference(msg.characterId, msg.refId);
      break;
    case "getCharacterReference":
      void (async () => {
        const image = await engine?.getCharacterReference(msg.refId);
        // Transfer the bytes (thumbnail-sized payloads, but zero-copy is free).
        post(
          { type: "characterReference", requestId: msg.requestId, ...(image ? { image } : {}) },
          image ? [image.bytes] : [],
        );
      })();
      break;
    case "exportBible":
      if (engine) post({ type: "export", json: engine.exportBible() });
      break;
    case "importBible":
      void engine?.importBible(msg.json).then((r) =>
        post({ type: "imported", ok: r.ok, ...(r.stats ? { stats: r.stats } : {}), ...(r.error ? { error: r.error } : {}) }),
      );
      break;
    case "carryOverBible":
      void engine?.carryOverBibleFrom(msg.fromBookId).then((r) =>
        post({
          type: "status",
          message: r.ok ? "Carried over the previous book's Visual Bible." : (r.error ?? "Carry-over failed."),
        }),
      );
      break;
    case "paintForward":
      void engine?.paintForward(msg.fromUnit);
      post({ type: "generating", value: true });
      postPaused();
      break;
  }
};

async function handleOpen(book: import("@visual-reader/core").BookSource): Promise<void> {
  if (!settings) {
    post({ type: "error", message: "Worker received open before init" });
    return;
  }
  try {
    // A NEW engine is built per book — stop the previous one FIRST, or its bible loop
    // and renders keep running and its callbacks mingle the old book's characters and
    // status lines into the new book's UI.
    engine?.dispose();
    post({ type: "status", message: "" });
    post({ type: "generating", value: false });
    post({ type: "paused", bible: false, images: false });
    pendingStart = false; // fresh open; the hook re-sends "start" if it should resume
    bibleActive = false;
    bibleRunStartMs = 0;
    bibleCharacters = 0; // fresh book; the restored bible's onBibleUpdate re-fills it
    stopBibleTimer();
    workflow.bibleDone = 0;
    workflow.bibleTotal = 0;
    workflow.promptsDone = 0;
    workflow.promptsTotal = 0;
    postWorkflow();
    post({ type: "bibleStatus", text: "" }); // reset the persistent line for the new book
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
    llmLabel = diagnostics.llm.label;
    post({ type: "providers", diagnostics });
    engine = new Engine({
      llm,
      image,
      tier,
      store: new IndexedDbStore(),
      onUpdate: (pageIndex, result) => {
        const transfer = result.image ? [result.image.bytes] : [];
        post({ type: "update", pageIndex, result }, transfer);
        // While the bible owns the status line, leave it alone. Otherwise name the
        // current image phase so the user can see what's happening.
        if (bibleActive) return;
        if (result.status === "rendering" && result.progress !== undefined) {
          // Diffusion is underway (ComfyUI reports per-step progress).
          post({ type: "status", message: `Rendering an illustration… ${Math.round(result.progress * 100)}%` });
        } else if (result.status === "ready" || result.status === "error" || result.status === "queued") {
          // Finished, failed, or cancelled (paused) → clear the transient line.
          post({ type: "status", message: "" });
        }
      },
      onBibleProgress: (done, total) => setBibleChapter(done, total),
      onPromptProgress: (done, total) => setPromptProgress(done, total),
      // The bible builds in the background; relay each growth so the UI's
      // character/spoiler context (and the panel) stay current — and refresh the
      // live status line so the character count grows in real time.
      onBibleUpdate: (bible) => {
        bibleCharacters = bible.characters.length;
        post({ type: "opened", bible });
        renderBibleStatus();
      },
      onBibleNote: (message) => post({ type: "status", message }),
      illustrateAfter: settings.illustrateAfter ?? "book",
    });
    // Re-segment into render units (one image per page, or per chapter) so the
    // engine renders at the chosen granularity. The UI maps the reader's position
    // to the same units via toRenderUnits, so the two never drift.
    const renderBook = toRenderUnits(book, settings.pagesPerImage ?? 3).book;
    // Loads the book + restores cached bible/images, but does NOT generate. The
    // user triggers generation via the "start" message ("Begin generating book").
    await engine.openBook(renderBook);
    // Resume generation if "start" was requested while this open was in flight.
    if (pendingStart) beginGeneration();
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
