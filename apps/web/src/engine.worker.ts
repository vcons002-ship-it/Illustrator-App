/// <reference lib="webworker" />
import {
  DirectTransport,
  Engine,
  GutenbergSearch,
  IMAGE_STYLES,
  IndexedDbStore,
  base64ToBytes,
  bytesToBase64,
  chatContextSections,
  chatSystemCachePrefix,
  lookupBible,
  measureContextUsage,
  searchBookPassages,
  trimChatHistory,
  CHARS_PER_TOKEN,
  CHAT_CONTEXT_BUDGET_CHARS,
  LocalServerLLMProvider,
  analyzeData,
  createDataTable,
  recalcTable,
  tableToText,
  stooqQuoteUrl,
  parseStooqQuote,
  yahooChartUrl,
  parseYahooChart,
  computeIndicators,
  exchangeSchwabCode,
  saveSchwabTokens,
  loadSchwabTokens,
  getFreshSchwabToken,
  schwabQuote,
  schwabOptionChain,
  schwabPositions,
  buildBuddySystemPrompt,
  buildProducePrompt,
  buildUnderstandPrompt,
  chapterText,
  fetchPageText,
  forgetNote,
  forgetSkill,
  getImageStyle,
  loadMemory,
  loadSkills,
  memoryPromptBlock,
  readSkillBody,
  saveSkill,
  skillsIndexBlock,
  parseBuddySlashCommand,
  parseUnderstanding,
  parseChatSlashCommand,
  rememberNote,
  queryWolfram,
  exchangeGoogleCode,
  saveGoogleTokens,
  getGoogleEmail,
  loadGoogleTokens,
  getFreshAccessToken,
  gmailSearch,
  gmailReadEmail,
  listEvents,
  createEvent,
  listTasks,
  createTask,
  runTaskPlanning,
  upsertTaskPlan,
  loadTaskPlans,
  normalizeScheduledTask,
  upsertScheduledTask,
  loadScheduledTasks,
  deleteScheduledTask,
  describeSchedule,
  normalizePriceAlert,
  upsertPriceAlert,
  loadPriceAlerts,
  deletePriceAlert,
  describeAlert,
  updateTaskStep,
  advanceStep,
  nextReadyStep,
  tasksIndexBlock,
  patchTask,
  loadIgnored,
  buildScanPrompt,
  parseCandidates,
  dedupeCandidates,
  listAllEvents,
  runBuddyTool,
  runChatTool,
  profileDimensions,
  qualityProfile,
  resolveModelRequest,
  resolveStyleRequest,
  runBuddyTurn,
  runChatTurn,
  supportsChat,
  supportsVision,
  toRenderUnits,
  ComfyUIBackend,
  Automatic1111Backend,
  type BookSource,
  type BuddyDeps,
  type BuddyOpenedInfo,
  type ChatToolDeps,
  type FigureSearch,
  type ImageProvider,
  type LLMProvider,
  type TierConfig,
  type ToolCall,
  type VisualBible,
} from "@visual-reader/core";
import { bookFromText } from "@visual-reader/epub";
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
/** The ORIGINAL (un-grouped) open book + its live bible, for the chat's context. */
let currentBook: BookSource | undefined;
let currentBible: VisualBible | undefined;
/** The book's built providers, reused by chat when no chat override applies. */
let bookProviders:
  | { llm: LLMProvider; image: ImageProvider; tier: TierConfig; imageSearch: FigureSearch; llmMock: boolean; imageMock: boolean }
  | undefined;
/** In-flight chat rounds, aborted by `chatCancel`. */
const chatAborts = new Map<number, AbortController>();

/** Store for long-term reader memory (shares the buddy's lazy IndexedDB handle). */
function memoryStore(): IndexedDbStore {
  buddyStore ??= new IndexedDbStore();
  return buddyStore;
}

/** The screenshot tool's vision pass: have the chat's vision-capable model look at
 * a captured screen and describe it. Runs on the main thread's request via a
 * worker message because the providers (with keys) live here. */
async function handleAssessImage(
  requestId: number,
  image: { bytes: ArrayBuffer; mimeType: string },
  question?: string,
): Promise<void> {
  try {
    const { llm } = chatProviders();
    if (!supportsVision(llm)) {
      throw new Error(
        `Your chat model (“${llm.id}”) can't see images. Use Gemini, OpenAI, or Claude, or a local VISION ` +
          "model (Ollama llama3.2-vision / llava, or LM Studio) — set the chat text provider in Settings.",
      );
    }
    const prompt =
      "You are looking at a screenshot of the reader's computer screen. " +
      (question
        ? `Answer this specifically and concisely: ${question}`
        : "Describe what's on screen and whether anything looks broken or like an error.") +
      " Be concrete about what you can and cannot see.";
    const text = await llm.describeImage({ bytes: image.bytes, mimeType: image.mimeType, prompt });
    post({ type: "imageAssessed", requestId, text });
  } catch (err) {
    post({ type: "imageAssessed", requestId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The chats' `read_url` tool: fetch a page's readable text into the conversation
 * (desktop routes CORS-blocked sites through the native fetch). Bounded fetch. */
function readUrlText(signal: AbortSignal): (url: string) => Promise<{ title?: string; text: string }> {
  return async (url) => {
    const cf = corsFetch();
    const page = await fetchPageText(url, {
      maxChars: 16_000,
      signal,
      ...(cf ? { transport: new DirectTransport(cf) } : {}),
    });
    return { ...(page.title ? { title: page.title } : {}), text: page.text };
  };
}

/**
 * Give an interactive chat turn priority on a SHARED local model. A background
 * bible build holds the local server/GPU for a whole 12k-token extraction at a
 * time, so the chat's next round queues behind it — which reads as the chat
 * hanging on "Thinking…". Pausing the bible build aborts the in-flight chapter
 * promptly (it re-extracts on resume, in order); the build resumes the moment
 * the turn finishes. Cloud chat models don't contend, so they never pause it.
 */
async function withChatPriority<T>(llmId: string, fn: () => Promise<T>): Promise<T> {
  const eng = engine;
  const yieldBible =
    (llmId === "local-server" || llmId === "webllm") &&
    eng !== undefined &&
    bibleActive &&
    !eng.isBiblePaused();
  if (yieldBible) eng.setBiblePaused(true);
  try {
    return await fn();
  } finally {
    // Resume only the engine WE paused — the book may have been closed mid-turn.
    if (yieldBible && engine === eng) eng.setBiblePaused(false);
  }
}

/** Throttled passthrough of a thinking model's live reasoning text (latest wins). */
function thinkingNotifier(post: (text: string) => void): (text: string) => void {
  let lastAt = 0;
  let latest = "";
  return (text) => {
    latest = text;
    const now = Date.now();
    if (now - lastAt < 250) return;
    lastAt = now;
    post(latest);
  };
}

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

// --- CORS-exempt fetch via the host -----------------------------------------
// Workers can't reach the Tauri bridge (`window.__TAURI__` doesn't exist here),
// so when init says the host has a native fetch (desktop shell), CORS-blocked
// paths round-trip each request through the main thread: `corsFetch` out,
// `corsFetchResult` back, correlated by fetchId. Only the keyless web search
// and page fetches use this — provider APIs are CORS-open and keep the
// webview's native fetch (and its streaming).

/** Whether the host offered a CORS-exempt native fetch (init.corsProxy). */
let corsProxyAvailable = false;
type CorsFetchReply = Extract<MainToWorker, { type: "corsFetchResult" }>;
const corsFetchPending = new Map<number, (reply: CorsFetchReply) => void>();
let nextCorsFetchId = 1;
/** Statuses a Response object may not carry a body for. */
const NO_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

const corsProxyFetch: typeof fetch = async (input, init) => {
  const req = new Request(input as RequestInfo, init);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let bodyBase64: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.clone().arrayBuffer();
    if (body.byteLength > 0) bodyBase64 = bytesToBase64(body);
  }
  const reply = await new Promise<CorsFetchReply>((resolve, reject) => {
    const fetchId = nextCorsFetchId++;
    // A dead main thread must not hang the chat turn forever.
    const timeout = setTimeout(() => {
      if (corsFetchPending.delete(fetchId)) {
        reject(new TypeError("The desktop fetch proxy timed out."));
      }
    }, 90_000);
    corsFetchPending.set(fetchId, (r) => {
      clearTimeout(timeout);
      resolve(r);
    });
    post({
      type: "corsFetch",
      fetchId,
      request: { url: req.url, method: req.method, headers, ...(bodyBase64 ? { bodyBase64 } : {}) },
    });
  });
  if (reply.error || reply.status === 0) {
    throw new TypeError(reply.error ?? "The desktop fetch proxy failed.");
  }
  const bytes = reply.bodyBase64 ? base64ToBytes(reply.bodyBase64) : new ArrayBuffer(0);
  // The native fetch already decoded the body to identity bytes; drop the
  // hop-by-hop/length headers so `Response` doesn't claim the (now wrong)
  // content-length or a content-encoding the bytes no longer carry (L7).
  const replyHeaders = { ...reply.headers };
  for (const k of Object.keys(replyHeaders)) {
    const lk = k.toLowerCase();
    if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding") {
      delete replyHeaders[k];
    }
  }
  return new Response(NO_BODY_STATUS.has(reply.status) ? null : bytes, {
    status: reply.status,
    statusText: reply.statusText,
    headers: replyHeaders,
  });
};

/** The CORS-exempt fetch when the host has one (else undefined → page CORS rules). */
function corsFetch(): typeof fetch | undefined {
  return corsProxyAvailable ? corsProxyFetch : undefined;
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

/** True while `handleOpen` is mid-flight (the engine object exists but its book
 * isn't loaded yet). A `start` that arrives in this window must NOT call
 * startGeneration() — `openBook` resets generationStarted afterwards, swallowing
 * it — so it defers via pendingStart, which handleOpen replays once open resolves. */
let opening = false;

/** Begin generation now if the engine is up AND idle, else remember to start. */
function beginGeneration(): void {
  if (engine && !opening) {
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

/**
 * Last forwarded whole-percent render progress per page. ComfyUI reports every
 * diffusion step; forwarding each one posts a message (and a main-thread React
 * render) per step for the whole generation run. The UI only ever shows whole
 * percents, so steps that don't change the rounded percent are dropped here.
 */
const lastProgressPct = new Map<number, number>();

/** Last time a prompt-writing token count was posted (throttled to 2/s). */
let lastPromptTokenPostMs = 0;

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
      corsProxyAvailable = msg.corsProxy === true;
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
    case "tune":
      // Tuning-only change: swap the live engine's tier (future renders use it) without
      // disposing anything — in-flight extraction/renders continue uninterrupted. The
      // providers themselves are unchanged for tune-eligible fields, so the freshly
      // built ones are discarded; only the tier they computed is applied.
      settings = msg.settings;
      if (engine) {
        try {
          engine.updateTier(buildProviders(settings).tier);
        } catch (err) {
          post({
            type: "error",
            message: `Settings update failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      break;
    case "open":
      void handleOpen(msg.book);
      break;
    case "updateBookData":
      // Grid edits: patch the cached book's table(s) so analyze_data uses the new
      // values immediately (no costly re-open / bible rebuild).
      if (currentBook) {
        currentBook = {
          ...currentBook,
          ...(msg.data ? { data: msg.data } : {}),
          ...(msg.dataSheets ? { dataSheets: msg.dataSheets } : {}),
        };
      }
      break;
    case "close":
      handleClose();
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
    case "completeBook":
      void engine?.completeBook();
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
    case "testRender":
      void handleTestRender(msg.requestId, msg.text, msg.initImage, msg.denoise, msg.size);
      break;
    case "chat":
      void handleChat(msg);
      break;
    case "buddyChat":
      void handleBuddyChat(msg);
      break;
    case "summarize":
      void handleSummarize(msg);
      break;
    case "googleConnect":
      void handleGoogleConnect(msg);
      break;
    case "planTask":
      void handlePlanTask(msg);
      break;
    case "scanInbox":
      void handleScanInbox(msg);
      break;
    case "loadCalendar":
      void handleLoadCalendar(msg);
      break;
    case "stockQuote":
      void handleStockQuote(msg);
      break;
    case "marketIndicators":
      void handleMarketIndicators(msg);
      break;
    case "schwabConnect":
      void handleSchwabConnect(msg);
      break;
    case "polish":
      void handlePolish(msg);
      break;
    case "chatTool":
      void handleChatTool(msg.requestId, msg.call);
      break;
    case "assessImage":
      void handleAssessImage(msg.requestId, msg.image, msg.question);
      break;
    case "chatCancel":
      chatAborts.get(msg.requestId)?.abort();
      chatAborts.delete(msg.requestId);
      break;
    case "corsFetchResult": {
      const resolve = corsFetchPending.get(msg.fetchId);
      corsFetchPending.delete(msg.fetchId);
      resolve?.(msg);
      break;
    }
  }
};

/**
 * Freeform playground render: text → one image with the CURRENT provider, style,
 * quality, aspect and sampler settings — no bible, no LLM, no cache. A fast way to
 * try out models/styles/LoRAs without opening a book.
 */
async function handleTestRender(
  requestId: number,
  text: string,
  initImage?: { bytes: ArrayBuffer; mimeType: string },
  denoise?: number,
  size?: { width: number; height: number },
): Promise<void> {
  try {
    if (!settings) throw new Error("Settings not initialised yet.");
    const { image, tier } = buildProviders(settings);
    const out = await renderFromText(image, tier, text, {
      ...(initImage ? { initImage } : {}),
      ...(denoise !== undefined ? { denoise } : {}),
      ...(size ? { width: size.width, height: size.height } : {}),
      onProgress: (fraction) => post({ type: "testProgress", requestId, fraction }),
    });
    post(
      {
        type: "testRendered",
        requestId,
        ok: true,
        image: { bytes: out.bytes, mimeType: out.mimeType },
        prompt: out.prompt,
      },
      [out.bytes],
    );
    warmChatModel(); // reload the local LLM the render may have evicted
  } catch (err) {
    post({
      type: "testRendered",
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Render ONE image straight from text with a built provider/tier (shared by the
 * playground and the chat's generate_image tool). `stepsOverride` wins over the
 * tier's step settings (the chat lets the user ask for a step count inline). */
async function renderFromText(
  image: ImageProvider,
  tier: TierConfig,
  text: string,
  opts: {
    stepsOverride?: number;
    /** img2img base photo + strength (the photo-transform path; local engine only). */
    initImage?: { bytes: ArrayBuffer; mimeType: string };
    denoise?: number;
    /** Output dimensions (the photo path passes the source photo's aspect). */
    width?: number;
    height?: number;
    /** Render progress sink (0..1) for engines that report it (ComfyUI). */
    onProgress?: (fraction: number) => void;
  } = {},
): Promise<{ bytes: ArrayBuffer; mimeType: string; prompt: string }> {
  const stepsOverride = opts.stepsOverride;
  const style = getImageStyle(tier.style);
  // A photo transform's instruction IS the prompt — don't force the global art style
  // on top (an "anime" style otherwise overrides "make this photorealistic"). The art
  // style still applies to plain text renders.
  const applyStyle = !opts.initImage;
  const prompt = applyStyle && style.promptSuffix ? `${text.trim()}\n\nStyle: ${style.promptSuffix}` : text.trim();
  const level = tier.renderQuality;
  const dims =
    opts.width && opts.height
      ? { width: opts.width, height: opts.height }
      : level
        ? profileDimensions(level, tier.aspectRatio)
        : undefined;
  const isLocal = tier.tier === "local";
  const styleLora = !isLocal || !applyStyle
    ? undefined
    : tier.disableStyleLora
      ? undefined
      : tier.styleLoraOverride
        ? { name: tier.styleLoraOverride, strength: 0.8 }
        : style.local?.lora;
  const steps = stepsOverride ?? (isLocal ? tier.localSteps : undefined);
  const out = await image.generate({
    prompt,
    anchors: [],
    quality: tier.quality,
    ...(level ? { renderQuality: level, steps: stepsOverride ?? qualityProfile(level).steps } : {}),
    ...(dims ? { width: dims.width, height: dims.height } : {}),
    ...(styleLora ? { styleLora } : {}),
    ...(tier.imageModelFamily ? { modelFamily: tier.imageModelFamily } : {}),
    ...(isLocal && tier.localTextEncoder ? { textEncoder: tier.localTextEncoder } : {}),
    ...(isLocal && tier.localVae ? { vae: tier.localVae } : {}),
    ...(isLocal && steps ? { stepsOverride: steps } : {}),
    ...(isLocal && tier.localCfg !== undefined ? { cfgOverride: tier.localCfg } : {}),
    ...(isLocal && tier.localSampler ? { localSampler: tier.localSampler } : {}),
    ...(isLocal && tier.localScheduler ? { localScheduler: tier.localScheduler } : {}),
    ...(opts.initImage ? { initImage: opts.initImage } : {}),
    ...(opts.denoise !== undefined ? { denoise: opts.denoise } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  return { bytes: out.bytes, mimeType: out.mimeType, prompt };
}

/**
 * Reload the local chat model into VRAM after an image render — image generation
 * (ComfyUI/local) evicts the LLM under GPU memory pressure, so the NEXT chat turn
 * would otherwise wait on a cold reload (felt like a hang). Fire-and-forget: a
 * 1-token request warms it while the reader looks at the rendered image. Cloud
 * chat models don't load locally, so they're skipped.
 */
function warmChatModel(): void {
  try {
    const { llm } = chatProviders();
    if (!supportsChat(llm) || (llm.id !== "local-server" && llm.id !== "webllm")) return;
    void llm.chat([{ role: "user", content: "ok" }], { maxTokens: 1 }).catch(() => {});
  } catch {
    /* no chat provider yet / not initialised — nothing to warm */
  }
}

// --- Reading-companion chat -------------------------------------------------

/**
 * Settings as the CHAT sees them: the chat's own provider choices (default: local
 * text + local image — free and private) override the book's. "default" follows
 * the book's providers unchanged.
 */
function chatSettingsOf(s: ReaderSettings): ReaderSettings {
  const text = s.chatTextProvider ?? "local";
  const image = s.chatImageProvider ?? "local";
  return {
    ...s,
    ...(text !== "default" ? { textProvider: text } : {}),
    // The chat-only local model applies to whichever local backend is active.
    ...(text === "local" && s.chatLocalModel
      ? { localServerTextModel: s.chatLocalModel, localTextModel: s.chatLocalModel }
      : {}),
    ...(image !== "default" ? { imageProvider: image } : {}),
  };
}

/**
 * The chat's providers: built from the chat overrides, falling back PER SLOT to the
 * book's provider when an override resolves to the mock but the book's is real —
 * "default to local" must not mean placeholder answers when local isn't set up.
 */
function chatProviders(): { llm: LLMProvider; image: ImageProvider; tier: TierConfig; imageSearch: FigureSearch } {
  if (!settings) throw new Error("Settings not initialised yet.");
  const cf = corsFetch();
  const built = buildProviders(chatSettingsOf(settings), cf ? { corsFetch: cf } : {});
  const llm =
    built.diagnostics.llm.mock && bookProviders && !bookProviders.llmMock
      ? bookProviders.llm
      : built.llm;
  const image =
    built.diagnostics.image.mock && bookProviders && !bookProviders.imageMock
      ? bookProviders.image
      : built.image;
  const tier =
    built.diagnostics.image.mock && bookProviders && !bookProviders.imageMock
      ? bookProviders.tier
      : built.tier;
  return { llm, image, tier, imageSearch: built.imageSearch };
}

/**
 * Context budgets by provider class. Cloud chat models have six-figure token
 * windows — capping their book context at the local-friendly default threw away
 * 90% of what they could read. Local/on-device models keep the small budgets.
 */
const CLOUD_LLM_IDS = new Set(["claude", "gemini", "openai"]);
/** Approximate context windows (tokens) for the donut's "X / Y" readout — cloud
 * models don't report it; these are the families' standard sizes. */
const CLOUD_MAX_TOKENS: Record<string, number> = { claude: 200_000, gemini: 1_000_000, openai: 128_000 };

interface ContextBudgets {
  book: number;
  history: number;
  /** Response budget (tokens) — replies were capping at the provider default
   * (1024) and cutting off mid-message on longer answers. */
  reply: number;
  /** The model's context window in tokens, when known. */
  maxTokens?: number;
}

/**
 * What Ollama LOADS when nothing says otherwise (its built-in default is
 * VRAM-dynamic but ~4096 for typical machines). Models report a huge
 * ARCHITECTURAL max (llama-3.2 = 131072, Qwen 1M variants = 1048576) that is NOT
 * what's loaded — budgeting to it overflows/truncates a default setup (and once
 * 500'd the server). So the arch max is only trusted DOWN to this assumption;
 * an explicit signal (the Settings override, or a Modelfile `num_ctx` — recent
 * library models ship one, e.g. qwen3 = 40960) is trusted as-is.
 */
const OLLAMA_DEFAULT_LOADED_TOKENS = 4096;
/** Sanity clamp for trusted windows (Qwen's 1M variants are today's ceiling). */
const MAX_TRUSTED_CONTEXT_TOKENS = 1_048_576;
/** Even with a giant window, bound the input we build — prefill on a local GPU
 * is slow, and the lazy book/bible tools fetch the rest on demand anyway. */
const MAX_LOCAL_INPUT_CHARS = 480_000;

/**
 * Split the model's context window into book + history char budgets. Cloud models
 * get generous fixed budgets. Local models are sized to their RESOLVED window
 * (override > Modelfile num_ctx > arch max capped at the Ollama default), 45% of
 * it for input — the rest holds the system prompt and the reply — split 70/30
 * book/history. Unknown window → the conservative 8k-class defaults.
 */
function contextBudgets(llmId: string, ctxTokens?: number): ContextBudgets {
  if (CLOUD_LLM_IDS.has(llmId)) {
    // The book section is now a RECENT window only (the model pulls the rest on
    // demand via search_book), so it stays small even on huge cloud contexts —
    // a simple request no longer pays to re-read the whole book every turn.
    return {
      book: 24_000,
      history: 60_000,
      reply: 4096,
      ...(CLOUD_MAX_TOKENS[llmId] ? { maxTokens: CLOUD_MAX_TOKENS[llmId] } : {}),
    };
  }
  if (ctxTokens && ctxTokens > 0) {
    const usable = Math.min(ctxTokens, MAX_TRUSTED_CONTEXT_TOKENS);
    const inputChars = Math.min(Math.floor(usable * CHARS_PER_TOKEN * 0.45), MAX_LOCAL_INPUT_CHARS);
    return {
      book: Math.floor(inputChars * 0.7),
      history: Math.floor(inputChars * 0.3),
      // ~25% of the window for the reply (the input formula reserves it), with a
      // floor so tiny windows still answer and a cap so huge ones don't ramble.
      reply: Math.min(4096, Math.max(512, Math.floor(usable * 0.25))),
      maxTokens: usable,
    };
  }
  return { book: CHAT_CONTEXT_BUDGET_CHARS, history: 8_000, reply: 1024 };
}

/**
 * The chat LLM's RESOLVED context window in tokens. Trust order:
 *  1. the Settings override (`localContextTokens`) — the user knows what their
 *     server loads (OLLAMA_CONTEXT_LENGTH isn't visible through any API);
 *  2. the model's Modelfile `num_ctx` from Ollama /api/show — what Ollama loads;
 *  3. the architectural max, capped at Ollama's typical default (4096) — a model
 *     that COULD do 131k/1M is still loaded small unless something says otherwise.
 * Cloud is fixed; LM Studio/WebLLM have no query API (override still applies).
 */
let localCtxCache: { key: string; ctx: number | undefined; at: number } | undefined;
async function localContextTokens(llmId: string): Promise<number | undefined> {
  if (!settings || CLOUD_LLM_IDS.has(llmId)) return undefined;
  const override = settings.localContextTokens;
  if (override && override > 0) return Math.min(override, MAX_TRUSTED_CONTEXT_TOKENS);
  if (llmId !== "local-server") return undefined; // only Ollama can be queried
  const cs = chatSettingsOf(settings);
  const url = cs.localServerTextUrl ?? settings.localServerTextUrl;
  const model = cs.localServerTextModel ?? settings.localServerTextModel;
  if (!url || !model) return undefined;
  const key = `${url}::${model}`;
  if (localCtxCache && localCtxCache.key === key && Date.now() - localCtxCache.at < 300_000) {
    return localCtxCache.ctx;
  }
  const cf = corsFetch();
  const info = await LocalServerLLMProvider.contextLength(
    url,
    model,
    cf ? new DirectTransport(cf) : undefined,
  );
  const ctx =
    info?.loaded ?? (info?.max ? Math.min(info.max, OLLAMA_DEFAULT_LOADED_TOKENS) : undefined);
  localCtxCache = { key, ctx, at: Date.now() };
  return ctx;
}

/** The local image engine's installed model names, cached briefly (each chat
 * turn would otherwise hit the engine's HTTP API just to build the prompt). */
let installedNamesCache: { at: number; names: string[] } | undefined;
async function cachedInstalledModels(s: ReaderSettings): Promise<string[]> {
  if (installedNamesCache && Date.now() - installedNamesCache.at < 60_000) {
    return installedNamesCache.names;
  }
  const names = await installedModelNames(s);
  installedNamesCache = { at: Date.now(), names };
  return names;
}

/**
 * One line telling the chat model what the app will ALREADY do on a render —
 * provider, default model, style, cadence, and the installed local models (so
 * "generate with flux 2" can name something that actually resolves). Stops the
 * model from re-specifying defaults or inventing model names.
 */
async function renderDefaultsNote(): Promise<string> {
  if (!settings) return "";
  const style = getImageStyle(settings.imageStyle);
  const local = chatSettingsOf(settings).imageProvider === "local" || settings.imageProvider === "local";
  const installed = local ? await cachedInstalledModels(settings) : [];
  const parts = [
    `art style "${style.label}"`,
    ...(settings.imageProvider === "local" && settings.localModel
      ? [`default local image model "${settings.localModel}"`]
      : []),
    `${settings.pagesPerImage ?? 3} page(s) per illustration`,
    `illustrating after ${settings.illustrateAfter ?? "book"}`,
  ];
  return (
    `CURRENT APP SETTINGS (applied to every render automatically): ${parts.join(", ")}.` +
    (installed.length ? ` INSTALLED LOCAL IMAGE MODELS: ${installed.join(", ")}.` : "") +
    ' These defaults are used unless the reader explicitly asks for something different — only then pass "model"/"style" fields, naming a model close to an installed name above.'
  );
}

/** Map the reader's page/paragraph position to (chapterIndex, char offset) in the
 * SAME chapter-text segmentation the chat context is built from. */
function chatPosition(
  book: BookSource,
  pos: { pageIndex: number; paragraphIndex: number },
): { chapterIndex: number; charOffsetInChapter: number } {
  const page = book.pages[pos.pageIndex];
  const chapterId = page?.chapterId;
  const chapterIndex = book.chapters.find((c) => c.id === chapterId)?.index ?? 0;
  let offset = 0;
  for (const p of book.pages) {
    if (p === page) break;
    if (p.chapterId === chapterId) {
      // +2 mirrors the "\n\n" joiner in chapterText.
      offset += p.paragraphs.reduce((a, q) => a + q.text.length + 2, 0);
    }
  }
  const upTo = Math.min(pos.paragraphIndex, page?.paragraphs.length ?? 0);
  for (let i = 0; i < upTo; i++) offset += page!.paragraphs[i]!.text.length + 2;
  return { chapterIndex, charOffsetInChapter: offset };
}

async function handleChat(msg: Extract<MainToWorker, { type: "chat" }>): Promise<void> {
  const ac = new AbortController();
  chatAborts.set(msg.requestId, ac);
  try {
    if (!currentBook) throw new Error("Open a book first — the chat discusses the current book.");
    const { llm, imageSearch } = chatProviders();
    const book = currentBook;
    const chapters = [...chapterText(book)]
      .map(([index, text]) => ({
        index,
        title: book.chapters.find((c) => c.index === index)?.title ?? "",
        text,
      }))
      .sort((a, b) => a.index - b.index);
    const pos = chatPosition(book, msg.position);
    const fullView = (book.contentMode ?? "fiction") === "technical" || msg.allowSpoilers;
    // Spoiler-gated chapters the search_book tool may reach: everything up to the
    // reader's position (current chapter cut at the offset) unless spoilers are on.
    const searchableChapters = fullView
      ? chapters
      : chapters
          .filter((c) => c.index <= pos.chapterIndex)
          .map((c) =>
            c.index === pos.chapterIndex
              ? { ...c, text: c.text.slice(0, Math.max(0, pos.charOffsetInChapter)) }
              : c,
          );
    const tools: ChatToolDeps = {
      searchWeb: (q) => imageSearch.searchWeb(q),
      searchImages: (q) => imageSearch.search(q),
      searchBook: (q) => searchBookPassages(searchableChapters, q),
      readUrl: readUrlText(ac.signal),
      remember: async (n) => (await rememberNote(memoryStore(), n)).length,
      forget: async (m) => (await forgetNote(memoryStore(), m)).length,
      ...(book.data ? { analyzeData: (spec) => analyzeData(book.data!, spec) } : {}),
      ...(currentBible
        ? {
            lookupBible: (q: string) =>
              lookupBible(currentBible!, q, {
                fullView,
                chapterIndex: pos.chapterIndex,
                contentMode: book.contentMode ?? "fiction",
              }),
          }
        : {}),
    };
    // Slash command: run the tool DIRECTLY — no LLM round (instant, deterministic,
    // free). /draw flows through the regular pendingTool approval bubble.
    const slash = parseChatSlashCommand(msg.userText);
    if (slash) {
      if ("error" in slash) throw new Error(slash.error);
      if (
        slash.call.tool === "generate_image" ||
        slash.call.tool === "export_book" ||
        slash.call.tool === "export_data" ||
        slash.call.tool === "set_cell" ||
        slash.call.tool === "add_formula_column"
      ) {
        post({ type: "chatDone", requestId: msg.requestId, text: "", transcript: [], pendingTool: slash.call });
        return;
      }
      const result = await runChatTool(slash.call, tools);
      post({
        type: "chatToolResult",
        requestId: msg.requestId,
        call: slash.call,
        ...(result.hits ? { hits: result.hits } : {}),
        ...(result.imageHits ? { imageHits: result.imageHits } : {}),
        ...(result.passages ? { passages: result.passages } : {}),
        ...(result.bibleDetail !== undefined ? { bibleDetail: result.bibleDetail } : {}),
        ...(result.memory ? { memory: result.memory } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      post({ type: "chatDone", requestId: msg.requestId, text: "", transcript: [] });
      return;
    }
    if (!supportsChat(llm)) {
      throw new Error(`The "${llm.id}" text provider doesn't support chat yet.`);
    }
    const note = await renderDefaultsNote();
    const budgets = contextBudgets(llm.id, await localContextTokens(llm.id));
    const sections = chatContextSections({
      bookTitle: book.title,
      contentMode: book.contentMode ?? "fiction",
      chapters,
      ...(currentBible ? { bible: currentBible } : {}),
      position: pos,
      allowSpoilers: msg.allowSpoilers,
      ...(settings?.allowMature ? { allowMature: true } : {}),
      ...(book.data ? { dataTable: book.data } : {}),
      budgetChars: budgets.book,
    });
    const sec = (key: string) => sections.find((s) => s.key === key)?.text ?? "";
    const memory = memoryPromptBlock(await loadMemory(memoryStore()));
    const skills = skillsIndexBlock(await loadSkills(memoryStore()));
    const system =
      sections
        .map((s) => s.text)
        .filter(Boolean)
        .join("\n\n") +
      (memory ? `\n\n${memory}` : "") +
      (skills ? `\n\n${skills}` : "") +
      (note ? `\n\n${note}` : "");
    const history = trimChatHistory(
      [...msg.history, { role: "user", content: msg.userText }],
      budgets.history,
    );
    // Where the context is going, for the usage donut — posted before the turn.
    post({
      type: "chatContextUsage",
      requestId: msg.requestId,
      usage: measureContextUsage(
        [
          { key: "book", label: "Book text", text: sec("book") },
          { key: "bible", label: "Visual bible", text: sec("bible") },
          {
            key: "instructions",
            label: "Instructions & tools",
            text: [sec("role"), sec("tools"), sec("guard"), memory, note].filter(Boolean).join("\n\n"),
          },
          { key: "history", label: "Chat history", text: history.slice(0, -1).map((t) => t.content).join("\n") },
          { key: "message", label: "Your message", text: msg.userText },
        ],
        { budgetChars: budgets.book, ...(budgets.maxTokens ? { maxTokens: budgets.maxTokens } : {}) },
      ),
    });
    const thinking = thinkingNotifier((text) =>
      post({ type: "chatThinking", requestId: msg.requestId, text }),
    );
    const outcome = await withChatPriority(llm.id, () => runChatTurn({
      llm,
      system,
      // Stable prefix (role + tools + guard) the volatile bible/book tail trails —
      // cached across turns by Claude; rides llama.cpp KV-cache reuse for free.
      cachePrefix: chatSystemCachePrefix(sections),
      history,
      maxTokens: budgets.reply,
      tools: {
        searchWeb: (q) => imageSearch.searchWeb(q),
        searchImages: (q) => imageSearch.search(q),
        searchBook: (q) => searchBookPassages(searchableChapters, q),
        readUrl: readUrlText(ac.signal),
        remember: async (n) => (await rememberNote(memoryStore(), n)).length,
        forget: async (m) => (await forgetNote(memoryStore(), m)).length,
        readSkill: async (name) => readSkillBody(await loadSkills(memoryStore()), name),
        saveSkill: async (name, description, body) => (await saveSkill(memoryStore(), { name, description, body })).length,
        forgetSkill: async (m) => (await forgetSkill(memoryStore(), m)).length,
        ...(book.data ? { analyzeData: (spec) => analyzeData(book.data!, spec) } : {}),
        ...(currentBible
          ? {
              lookupBible: (q: string) =>
                lookupBible(currentBible!, q, {
                  fullView,
                  chapterIndex: pos.chapterIndex,
                  contentMode: book.contentMode ?? "fiction",
                }),
            }
          : {}),
      },
      onEvent: (e) => {
        if (e.kind === "token") post({ type: "chatToken", requestId: msg.requestId, text: e.text });
        else if (e.kind === "thinking") thinking(e.text);
        else if (e.kind === "tool") post({ type: "chatTool", requestId: msg.requestId, round: e.round, call: e.call });
        else
          post({
            type: "chatToolResult",
            requestId: msg.requestId,
            call: e.call,
            ...(e.result.hits ? { hits: e.result.hits } : {}),
            ...(e.result.imageHits ? { imageHits: e.result.imageHits } : {}),
            ...(e.result.memory ? { memory: e.result.memory } : {}),
            ...(e.result.analysis ? { analysis: e.result.analysis } : {}),
            ...(e.result.error ? { error: e.result.error } : {}),
          });
      },
      signal: ac.signal,
    }));
    post({
      type: "chatDone",
      requestId: msg.requestId,
      text: outcome.text,
      transcript: outcome.transcript,
      ...(outcome.pendingTool ? { pendingTool: outcome.pendingTool } : {}),
    });
  } catch (err) {
    post({
      type: "chatError",
      requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    chatAborts.delete(msg.requestId);
  }
}

/**
 * Compact a chat: summarize the model-facing transcript into a brief that
 * replaces the history (the App swaps the messages for one summary message).
 * Frees the context window while keeping continuity — the chat equivalent of
 * the reader's own notes.
 */
/** Finish Google OAuth: exchange the consent code for tokens (using the desktop CORS
 * proxy, which dodges the token endpoint's lack of browser CORS), persist them, and
 * confirm by fetching the account email. */
async function handleGoogleConnect(msg: Extract<MainToWorker, { type: "googleConnect" }>): Promise<void> {
  try {
    const clientId = settings?.keys?.googleClientId;
    const clientSecret = settings?.keys?.googleClientSecret;
    if (!clientId || !clientSecret) throw new Error("Add your Google client ID and secret in Settings first.");
    const cf = corsFetch();
    const transport = new DirectTransport(cf);
    const tokens = await exchangeGoogleCode({
      transport,
      clientId,
      clientSecret,
      code: msg.code,
      redirectUri: msg.redirectUri,
      codeVerifier: msg.codeVerifier,
    });
    await saveGoogleTokens(memoryStore(), tokens);
    const email = await getGoogleEmail(transport, tokens.accessToken).catch(() => "");
    post({ type: "googleConnected", requestId: msg.requestId, ok: true, ...(email ? { email } : {}) });
  } catch (err) {
    post({
      type: "googleConnected",
      requestId: msg.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Plan a task: bounded research (web + Gmail/Calendar) then a structured plan, persisted.
 * Reuses the buddy research tools + the CORS proxy; cancellable via the shared chatAborts. */
async function handlePlanTask(msg: Extract<MainToWorker, { type: "planTask" }>): Promise<void> {
  const ac = new AbortController();
  chatAborts.set(msg.requestId, ac);
  try {
    const { llm, imageSearch } = chatProviders();
    if (!supportsChat(llm)) throw new Error(`The "${llm.id}" text provider doesn't support chat yet.`);
    const store = memoryStore();
    const googleId = settings?.keys?.googleClientId;
    const googleSecret = settings?.keys?.googleClientSecret;
    const googleConnected = !!(googleId && googleSecret && (await loadGoogleTokens(store)));
    const transport = new DirectTransport(corsFetch());
    const tok = () => getFreshAccessToken(store, { clientId: googleId!, clientSecret: googleSecret!, transport });
    const notUsed = (): never => {
      throw new Error("not available during planning");
    };
    const research: BuddyDeps = {
      searchWeb: (q) => imageSearch.searchWeb(q),
      readUrl: readUrlText(ac.signal),
      ...(googleConnected
        ? {
            gmailSearch: async (q: string, max?: number) => gmailSearch(transport, await tok(), q, max),
            readEmail: async (id: string) => gmailReadEmail(transport, await tok(), id),
            listEvents: async (o: { max?: number; timeMin?: string; timeMax?: string }) =>
              listEvents(transport, await tok(), o),
          }
        : {}),
      openLibraryBook: notUsed,
      openWebText: notUsed,
      openPastedText: notUsed,
      removeLibraryBook: notUsed,
      setVisualStyle: notUsed,
    };
    const plan = await runTaskPlanning({
      llm,
      research,
      source: msg.source,
      sourceText: msg.sourceText,
      todayIso: new Date().toISOString().slice(0, 10),
      signal: ac.signal,
      onPhase: (phase, note) =>
        post({ type: "planProgress", requestId: msg.requestId, phase, ...(note ? { note } : {}) }),
    });
    if (!plan) throw new Error("Couldn't produce a usable plan — try rephrasing the task.");
    await upsertTaskPlan(store, plan);
    post({ type: "planned", requestId: msg.requestId, ok: true, plan });
  } catch (err) {
    post({
      type: "planned",
      requestId: msg.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    chatAborts.delete(msg.requestId);
  }
}

/** Idle scan: classify recent Gmail + upcoming Calendar into actionable task candidates,
 * deduped against existing plans + the ignore list. Best-effort, one-shot. */
async function handleScanInbox(msg: Extract<MainToWorker, { type: "scanInbox" }>): Promise<void> {
  try {
    const { llm } = chatProviders();
    const store = memoryStore();
    const googleId = settings?.keys?.googleClientId;
    const googleSecret = settings?.keys?.googleClientSecret;
    if (!supportsChat(llm) || !googleId || !googleSecret || !(await loadGoogleTokens(store))) {
      post({ type: "scanned", requestId: msg.requestId, ok: true, candidates: [] });
      return;
    }
    const transport = new DirectTransport(corsFetch());
    const token = await getFreshAccessToken(store, { clientId: googleId, clientSecret: googleSecret, transport });
    const [emails, events] = await Promise.all([
      gmailSearch(transport, token, "newer_than:2d -category:promotions -category:social", 15).catch(() => []),
      listEvents(transport, token, { max: 10 }).catch(() => []),
    ]);
    if (emails.length === 0 && events.length === 0) {
      post({ type: "scanned", requestId: msg.requestId, ok: true, candidates: [] });
      return;
    }
    const reply = await llm.chat(buildScanPrompt(emails, events), { maxTokens: 1024 });
    const candidates = dedupeCandidates(
      parseCandidates(reply, emails, events),
      await loadTaskPlans(store),
      await loadIgnored(store),
    );
    post({ type: "scanned", requestId: msg.requestId, ok: true, candidates });
  } catch (err) {
    post({ type: "scanned", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Load events across all the user's Google calendars in a window (the calendar grid). */
async function handleLoadCalendar(msg: Extract<MainToWorker, { type: "loadCalendar" }>): Promise<void> {
  try {
    const store = memoryStore();
    const googleId = settings?.keys?.googleClientId;
    const googleSecret = settings?.keys?.googleClientSecret;
    if (!googleId || !googleSecret || !(await loadGoogleTokens(store))) {
      post({ type: "calendarLoaded", requestId: msg.requestId, ok: true, events: [] });
      return;
    }
    const transport = new DirectTransport(corsFetch());
    const token = await getFreshAccessToken(store, { clientId: googleId, clientSecret: googleSecret, transport });
    const events = await listAllEvents(transport, token, { timeMin: msg.timeMin, timeMax: msg.timeMax });
    post({ type: "calendarLoaded", requestId: msg.requestId, ok: true, events });
  } catch (err) {
    post({ type: "calendarLoaded", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleStockQuote(msg: Extract<MainToWorker, { type: "stockQuote" }>): Promise<void> {
  try {
    const cf = corsFetch();
    // Stooq's CSV is cross-origin; the keyless quote needs the CORS-exempt transport
    // (desktop/extension). On plain web we return no quote (the chart still embeds).
    if (!cf) {
      post({ type: "stockQuoted", requestId: msg.requestId, ok: true });
      return;
    }
    const res = await new DirectTransport(cf).send({ url: stooqQuoteUrl(msg.symbol), method: "GET" });
    const quote = parseStooqQuote(await res.text(), msg.symbol);
    post({ type: "stockQuoted", requestId: msg.requestId, ok: true, ...(quote ? { quote } : {}) });
  } catch (err) {
    post({ type: "stockQuoted", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleMarketIndicators(msg: Extract<MainToWorker, { type: "marketIndicators" }>): Promise<void> {
  try {
    const cf = corsFetch();
    if (!cf) {
      post({ type: "marketIndicatorsResult", requestId: msg.requestId, ok: true });
      return;
    }
    const res = await new DirectTransport(cf).send({
      url: yahooChartUrl(msg.symbol, { interval: msg.interval || "5m", range: msg.range || "1d" }),
      method: "GET",
    });
    const indicators = computeIndicators(msg.symbol, parseYahooChart(await res.json()));
    post({ type: "marketIndicatorsResult", requestId: msg.requestId, ok: true, ...(indicators ? { indicators } : {}) });
  } catch (err) {
    post({ type: "marketIndicatorsResult", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSchwabConnect(msg: Extract<MainToWorker, { type: "schwabConnect" }>): Promise<void> {
  try {
    const clientId = settings?.keys?.schwabClientId;
    const clientSecret = settings?.keys?.schwabClientSecret;
    if (!clientId || !clientSecret) throw new Error("Add your Schwab app key + secret first.");
    const transport = new DirectTransport(corsFetch());
    const tokens = await exchangeSchwabCode({ transport, clientId, clientSecret, code: msg.code, redirectUri: msg.redirectUri });
    await saveSchwabTokens(memoryStore(), tokens);
    post({ type: "schwabConnected", requestId: msg.requestId, ok: true });
  } catch (err) {
    post({ type: "schwabConnected", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSummarize(msg: Extract<MainToWorker, { type: "summarize" }>): Promise<void> {
  try {
    const { llm } = chatProviders();
    if (!supportsChat(llm)) {
      throw new Error(`The "${llm.id}" text provider doesn't support chat yet.`);
    }
    const transcript = msg.turns.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n\n");
    const text = await llm.chat(
      [
        {
          role: "system",
          content:
            "Compress this conversation transcript into a brief that lets the SAME assistant continue " +
            "seamlessly. Preserve: decisions made, facts established, names/numbers/links, the reader's " +
            "stated preferences, anything opened or generated, and open questions. Terse bullet points; " +
            "no preamble, no meta-commentary.",
        },
        { role: "user", content: transcript.slice(-120_000) },
      ],
      { maxTokens: 1024 },
    );
    const trimmed = text.trim();
    if (!trimmed) throw new Error("the model returned an empty summary");
    post({ type: "summarized", requestId: msg.requestId, ok: true, text: trimmed });
  } catch (err) {
    post({
      type: "summarized",
      requestId: msg.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Faithful document polish (two stages). Mirrors handleSummarize: a one-shot
 * `chat()` over the provider-neutral seam, available with no book open. "understand"
 * restates the plan (+ optional clarifying question); "produce" streams the reworked
 * text. The shared `chatAborts` map makes the existing `chatCancel` message cancel it.
 */
async function handlePolish(msg: Extract<MainToWorker, { type: "polish" }>): Promise<void> {
  const ac = new AbortController();
  chatAborts.set(msg.requestId, ac);
  try {
    const { llm } = chatProviders();
    if (!supportsChat(llm)) {
      throw new Error(`The "${llm.id}" text provider doesn't support chat yet.`);
    }
    const base = { freeText: msg.freeText, source: msg.source, ...(msg.mode ? { mode: msg.mode } : {}) };
    if (msg.stage === "understand") {
      const raw = await llm.chat(buildUnderstandPrompt(base), { maxTokens: 512, signal: ac.signal });
      const { plan, question } = parseUnderstanding(raw);
      post({ type: "polished", requestId: msg.requestId, stage: "understand", ok: true, plan, question });
      return;
    }
    const text = await llm.chat(
      buildProducePrompt({ ...base, confirmedPlan: msg.confirmedPlan ?? "" }),
      {
        maxTokens: 4096,
        signal: ac.signal,
        onToken: (delta) => post({ type: "polishToken", requestId: msg.requestId, text: delta }),
      },
    );
    const trimmed = text.trim();
    if (!trimmed) throw new Error("the model returned an empty result");
    post({ type: "polished", requestId: msg.requestId, stage: "produce", ok: true, text: trimmed });
  } catch (err) {
    post({
      type: "polished",
      requestId: msg.requestId,
      stage: msg.stage,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    chatAborts.delete(msg.requestId);
  }
}

// --- Landing-page buddy -------------------------------------------------------

/** Lazy singletons: the buddy's library access + book discovery backends. */
let buddyStore: IndexedDbStore | undefined;
let buddyBookSearch: GutenbergSearch | undefined;

/**
 * One buddy round. Unlike `handleChat` this runs WITHOUT an open book: it uses
 * the chat provider overrides directly, reads the library from IndexedDB, and
 * when a tool opens something it posts the resolved BookSource to the main
 * thread — which drives the normal open path (init/open/start), exactly as if
 * the reader had picked the book by hand.
 */
/** The reader's current local date/time + UTC offset (e.g. "Sunday, June 15, 2026,
 * 4:58 PM (UTC-04:00)") — fed to the buddy prompt so "today"/"this week"/"by when"
 * and the ISO ranges it builds are anchored to their own clock. */
function currentDateTimeLabel(): string {
  const now = new Date();
  const label = now.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const offMin = now.getTimezoneOffset(); // minutes BEHIND UTC (positive west of UTC)
  const sign = offMin <= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${label} (UTC${sign}${hh}:${mm})`;
}

async function handleBuddyChat(msg: Extract<MainToWorker, { type: "buddyChat" }>): Promise<void> {
  const ac = new AbortController();
  chatAborts.set(msg.requestId, ac);
  try {
    const { llm, imageSearch } = chatProviders();
    buddyStore ??= new IndexedDbStore();
    buddyBookSearch ??= new GutenbergSearch();
    const store = buddyStore;
    const books = buddyBookSearch;
    const opened = (book: BookSource, visuals: boolean): BuddyOpenedInfo => {
      post({ type: "buddyOpened", requestId: msg.requestId, book, visuals });
      return { title: book.title, chapters: book.chapters.length, pages: book.pages.length, visuals };
    };
    // Google (Gmail/Calendar/Tasks): wired only when a client is configured AND tokens
    // are stored. Every call gets a fresh access token (auto-refreshed) over the CORS
    // proxy; the same transport carries the refresh and the API call.
    const googleId = settings?.keys?.googleClientId;
    const googleSecret = settings?.keys?.googleClientSecret;
    const googleConnected = !!(googleId && googleSecret && (await loadGoogleTokens(store)));
    const googleDeps: Partial<BuddyDeps> = googleConnected
      ? (() => {
          const transport = new DirectTransport(corsFetch());
          const tok = () => getFreshAccessToken(store, { clientId: googleId!, clientSecret: googleSecret!, transport });
          return {
            gmailSearch: async (q: string, max?: number) => gmailSearch(transport, await tok(), q, max),
            readEmail: async (id: string) => gmailReadEmail(transport, await tok(), id),
            listEvents: async (o: { max?: number; timeMin?: string; timeMax?: string }) =>
              listEvents(transport, await tok(), o),
            createEvent: async (ev) => createEvent(transport, await tok(), ev),
            listTasks: async (max?: number) => listTasks(transport, await tok(), max),
            createTask: async (t) => createTask(transport, await tok(), t),
          };
        })()
      : {};
    const deps: BuddyDeps = {
      ...googleDeps,
      searchWeb: (q) => imageSearch.searchWeb(q),
      searchBooks: (q) => books.search(q),
      searchImages: (q) => imageSearch.search(q),
      readUrl: readUrlText(ac.signal),
      ...(settings?.keys?.wolfram
        ? {
            wolfram: (query: string) => {
              const cf = corsFetch();
              return queryWolfram({
                appId: settings!.keys.wolfram!,
                query,
                signal: ac.signal,
                ...(cf ? { transport: new DirectTransport(cf) } : {}),
              });
            },
          }
        : {}),
      // Keyless stock quotes (Stooq CSV) over the CORS-exempt transport; undefined on
      // plain web (no proxy) so the model falls back to search_web.
      stockQuote: async (symbol: string) => {
        const cf = corsFetch();
        if (!cf) return undefined;
        const res = await new DirectTransport(cf).send({ url: stooqQuoteUrl(symbol), method: "GET" });
        return parseStooqQuote(await res.text(), symbol);
      },
      // Keyless technical indicators from Yahoo's chart JSON (over the CORS-exempt
      // transport; undefined on plain web).
      marketIndicators: async (symbol: string, interval?: string, range?: string) => {
        const cf = corsFetch();
        if (!cf) return undefined;
        const res = await new DirectTransport(cf).send({
          url: yahooChartUrl(symbol, { interval: interval || "5m", range: range || "1d" }),
          method: "GET",
        });
        return computeIndicators(symbol, parseYahooChart(await res.json()));
      },
      // Schwab Trader API (real quotes, option chains + Greeks, positions) — wired only
      // when the user connected their own Schwab app. A fresh access token per call.
      ...(await (async (): Promise<Partial<BuddyDeps>> => {
        const sid = settings?.keys?.schwabClientId;
        const ssec = settings?.keys?.schwabClientSecret;
        if (!sid || !ssec || !(await loadSchwabTokens(store))) return {};
        const transport = new DirectTransport(corsFetch());
        const tok = () => getFreshSchwabToken(store, { clientId: sid, clientSecret: ssec, transport });
        return {
          schwabQuote: async (symbol: string) => schwabQuote(transport, await tok(), symbol),
          schwabOptions: async (symbol: string, opts) => schwabOptionChain(transport, await tok(), symbol, opts ?? {}),
          schwabPositions: async () => schwabPositions(transport, await tok()),
        };
      })()),
      randomBooks: () => books.random(),
      remember: async (n) => (await rememberNote(store, n)).length,
      forget: async (m) => (await forgetNote(store, m)).length,
      readSkill: async (name) => readSkillBody(await loadSkills(store), name),
      saveSkill: async (name, description, body) => (await saveSkill(store, { name, description, body })).length,
      forgetSkill: async (m) => (await forgetSkill(store, m)).length,
      // Task-plan execution: advance/update steps + read plans over the shared store,
      // writing a completed step back to Google Tasks (best-effort) when connected.
      markStepDone: async (planId, stepId) => {
        const plan = (await loadTaskPlans(store)).find((p) => p.id === planId);
        if (!plan) return undefined;
        const step = plan.steps.find((s) => s.id === stepId);
        const { plan: next, ready } = advanceStep(plan);
        await upsertTaskPlan(store, next);
        if (step?.googleTaskId && googleConnected) {
          try {
            const t = new DirectTransport(corsFetch());
            const at = await getFreshAccessToken(store, { clientId: googleId!, clientSecret: googleSecret!, transport: t });
            await patchTask(t, at, step.googleTaskId, { status: "completed" });
          } catch {
            /* best-effort write-back */
          }
        }
        return { planTitle: next.title, ...(ready ? { nextStep: ready.title } : {}), completed: next.status === "completed" };
      },
      updateTaskStep: async (planId, stepId, patch) => {
        const plan = (await loadTaskPlans(store)).find((p) => p.id === planId);
        if (!plan) return undefined;
        await updateTaskStep(store, planId, stepId, {
          ...(patch.status ? { status: patch.status as never } : {}),
          ...(patch.notes ? { researchNotes: patch.notes } : {}),
        });
        return { planTitle: plan.title };
      },
      listTaskPlans: async () =>
        (await loadTaskPlans(store))
          .filter((p) => p.status !== "archived")
          .map((p) => {
            const next = nextReadyStep(p);
            return {
              id: p.id,
              title: p.title,
              status: p.status,
              ...(next ? { nextStep: next.title } : {}),
              ...(p.deadlineIso ? { deadlineIso: p.deadlineIso } : {}),
            };
          }),
      getTaskPlan: async (id) => (await loadTaskPlans(store)).find((p) => p.id === id),
      // Scheduled/periodic tasks over the shared store (the host's while-open loop fires
      // the due ones into the chat).
      scheduleTask: async (call) => {
        const task = normalizeScheduledTask({
          title: call.title,
          prompt: call.prompt,
          rule: call.rule,
          ...(call.time ? { time: call.time } : {}),
          ...(call.weekday !== undefined ? { weekday: call.weekday } : {}),
          ...(call.dayOfMonth !== undefined ? { dayOfMonth: call.dayOfMonth } : {}),
        });
        await upsertScheduledTask(store, task);
        post({ type: "buddyScheduledChanged", requestId: msg.requestId });
        return { id: task.id, title: task.title, describe: describeSchedule(task) };
      },
      listScheduled: async () =>
        (await loadScheduledTasks(store)).map((t) => ({ id: t.id, title: t.title, describe: describeSchedule(t), enabled: t.enabled })),
      cancelScheduled: async (id) => {
        await deleteScheduledTask(store, id);
        post({ type: "buddyScheduledChanged", requestId: msg.requestId });
        return true;
      },
      // In-app price alerts over the shared store (the host's runner checks + fires them).
      setPriceAlert: async (call) => {
        const alert = normalizePriceAlert({ symbol: call.symbol, type: call.type, ...(call.value !== undefined ? { value: call.value } : {}), ...(call.note ? { note: call.note } : {}) });
        if (!alert) return undefined;
        await upsertPriceAlert(store, alert);
        post({ type: "buddyAlertsChanged", requestId: msg.requestId });
        return { id: alert.id, describe: describeAlert(alert) };
      },
      listAlerts: async () => (await loadPriceAlerts(store)).map((a) => ({ id: a.id, describe: describeAlert(a), enabled: a.enabled })),
      cancelAlert: async (id) => {
        await deletePriceAlert(store, id);
        post({ type: "buddyAlertsChanged", requestId: msg.requestId });
        return true;
      },
      openLibraryBook: async (call) => {
        const book = await store.getBook(call.id);
        if (!book) throw new Error("that id isn't in the library");
        return opened(book, call.visuals);
      },
      openWebText: async (call) => {
        // The desktop shell's native fetch (when present) reaches CORS-blocked
        // sites (news front pages…); browsers stay subject to page CORS.
        const cf = corsFetch();
        const page = await fetchPageText(call.url, {
          signal: ac.signal,
          ...(cf ? { transport: new DirectTransport(cf) } : {}),
        });
        const title = call.title ?? page.title ?? call.url;
        return opened(bookFromText(title, page.text, call.mode, "Chat buddy"), call.visuals);
      },
      openPastedText: async (call) =>
        opened(bookFromText(call.title, call.text, call.mode, "Pasted in chat"), call.visuals),
      createSpreadsheet: async (call) => {
        // Build the typed table from the spec, then open it as a TECHNICAL data book
        // (the pipe-text is what the pipeline reads; `data` powers the grid + chat tools).
        const table = recalcTable(createDataTable(call.columns, call.rows ?? []));
        const text = tableToText(table, table.rows.length) || call.title;
        const book = bookFromText(call.title || "Spreadsheet", text, "technical", "Generated in chat");
        return opened({ ...book, data: table }, false);
      },
      removeLibraryBook: async (call) => {
        const book = await store.getBook(call.id);
        if (!book) return {};
        await store.removeBook(call.id);
        post({ type: "buddyLibraryChanged", requestId: msg.requestId });
        return { removed: book.title };
      },
      setVisualStyle: async (call) => {
        // Resolve against the real catalog so only known styles ever apply; the
        // main thread owns settings, so it gets the resolved values to commit.
        const styleId = call.style ? resolveStyleRequest(call.style) : undefined;
        if (call.style && !styleId) {
          throw new Error(
            `no art style matches "${call.style}" — available: ${IMAGE_STYLES.map((s) => s.label).join(", ")}`,
          );
        }
        const style = styleId ? getImageStyle(styleId) : undefined;
        // Apply to the WORKER's settings immediately: an open later in this
        // same buddy turn must render with the new style — the main thread's
        // committed copy arrives only after a React re-render (and its init
        // would otherwise race the open with stale settings).
        if (settings) {
          settings = {
            ...settings,
            ...(style ? { imageStyle: style.id } : {}),
            ...(call.pagesPerImage !== undefined ? { pagesPerImage: call.pagesPerImage } : {}),
            ...(call.illustrateAfter !== undefined ? { illustrateAfter: call.illustrateAfter } : {}),
          };
        }
        post({
          type: "buddySettings",
          requestId: msg.requestId,
          ...(style ? { style: { id: style.id, label: style.label } } : {}),
          ...(call.pagesPerImage !== undefined ? { pagesPerImage: call.pagesPerImage } : {}),
          ...(call.illustrateAfter !== undefined ? { illustrateAfter: call.illustrateAfter } : {}),
        });
        return {
          ...(style ? { style: style.label } : {}),
          ...(call.pagesPerImage !== undefined ? { pagesPerImage: call.pagesPerImage } : {}),
          ...(call.illustrateAfter !== undefined ? { illustrateAfter: call.illustrateAfter } : {}),
        };
      },
      // A natural-language settings change (validated in core). Apply it to the
      // worker's copy so an open later in this same turn uses it, and hand the patch
      // to the main thread (the settings owner) to commit + persist + re-init/tune.
      applySetting: async ({ key, value, label, valueLabel }) => {
        if (settings) settings = { ...settings, [key]: value };
        post({
          type: "buddySettings",
          requestId: msg.requestId,
          patch: { [key]: value } as Partial<ReaderSettings>,
          summary: `${label}: ${valueLabel}`,
        });
      },
    };
    // Slash command: run the tool DIRECTLY — no LLM round (instant, deterministic,
    // free). /draw flows through the regular pendingTool approval bubble.
    const slash = parseBuddySlashCommand(msg.userText, msg.library);
    if (slash) {
      if ("error" in slash) throw new Error(slash.error);
      // generate_image (and find_files / run_command, which the parser never emits for
      // a slash) stop for the host instead of auto-running.
      if (
        slash.call.tool === "generate_image" ||
        slash.call.tool === "find_files" ||
        slash.call.tool === "run_command" ||
        slash.call.tool === "screenshot" ||
        slash.call.tool === "plan_task"
      ) {
        post({ type: "buddyDone", requestId: msg.requestId, text: "", transcript: [], pendingTool: slash.call });
        return;
      }
      const result = await runBuddyTool(slash.call, deps);
      post({
        type: "buddyToolResult",
        requestId: msg.requestId,
        call: slash.call,
        ...(result.hits ? { hits: result.hits } : {}),
        ...(result.books ? { books: result.books } : {}),
        ...(result.imageHits ? { imageHits: result.imageHits } : {}),
        ...(result.applied ? { applied: result.applied } : {}),
        ...(result.removed ? { removed: result.removed } : {}),
        ...(result.calc ? { calc: result.calc } : {}),
        ...(result.wolfram ? { wolfram: result.wolfram } : {}),
        ...(result.memory ? { memory: result.memory } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      post({ type: "buddyDone", requestId: msg.requestId, text: "", transcript: [] });
      return;
    }
    if (!supportsChat(llm)) {
      throw new Error(`The "${llm.id}" text provider doesn't support chat yet.`);
    }
    const note = await renderDefaultsNote();
    const budgets = contextBudgets(llm.id, await localContextTokens(llm.id));
    const memory = memoryPromptBlock(await loadMemory(store));
    const skills = skillsIndexBlock(await loadSkills(store));
    // When this session is executing a task plan, load its context for the prompt.
    const activePlan = msg.taskPlanId ? (await loadTaskPlans(store)).find((p) => p.id === msg.taskPlanId) : undefined;
    const setup =
      buildBuddySystemPrompt({
        persona: msg.persona,
        library: msg.library,
        // Anchor "today"/"this week"/"by when" answers + ISO date math to the reader's
        // own clock (the worker runs in their browser, so this is their local time/zone).
        now: currentDateTimeLabel(),
        ...(activePlan ? { activeTask: tasksIndexBlock(activePlan) } : {}),
        ...(settings?.allowMature ? { allowMature: true } : {}),
        // Desktop only: the find_files tool needs the native filesystem bridge,
        // signalled by the same init flag as the CORS-exempt fetch.
        ...(corsProxyAvailable ? { canSearchFiles: true } : {}),
        // Desktop + explicit opt-in: the run_command tool executes shell commands.
        ...(corsProxyAvailable && settings?.allowCommands ? { canRunCommands: true } : {}),
        // Wolfram|Alpha grounding when an AppID is configured.
        ...(settings?.keys?.wolfram ? { canWolfram: true } : {}),
        // GitHub repo work rides run_command (desktop + commands), authenticated by a
        // stored token OR the user's own local `gh auth login`.
        ...(corsProxyAvailable && settings?.allowCommands && (settings?.keys?.github || settings?.githubLocalAuth)
          ? { canGithub: true }
          : {}),
        // The chosen working folder only matters when commands/file-search can run.
        ...(corsProxyAvailable && settings?.allowCommands && msg.workingDir ? { workingDir: msg.workingDir } : {}),
        // Gmail/Calendar/Tasks tools when Google is connected.
        ...(googleConnected ? { canGoogle: true } : {}),
        // Auto-approval: create reminders without per-item confirm when opted in.
        ...(googleConnected && settings?.allowTaskAutomation ? { canAutomateTasks: true } : {}),
        // Schwab tools when the user connected their own Schwab app.
        ...(settings?.keys?.schwabClientId && settings?.keys?.schwabClientSecret && (await loadSchwabTokens(store))
          ? { canSchwab: true }
          : {}),
      }) +
      (memory ? `\n\n${memory}` : "") +
      (skills ? `\n\n${skills}` : "") +
      (note ? `\n\n${note}` : "");
    const history = trimChatHistory(
      [...msg.history, { role: "user", content: msg.userText }],
      budgets.history,
    );
    post({
      type: "chatContextUsage",
      requestId: msg.requestId,
      usage: measureContextUsage(
        [
          { key: "instructions", label: "Assistant setup & tools", text: setup },
          { key: "history", label: "Chat history", text: history.slice(0, -1).map((t) => t.content).join("\n") },
          { key: "message", label: "Your message", text: msg.userText },
        ],
        { budgetChars: budgets.book, ...(budgets.maxTokens ? { maxTokens: budgets.maxTokens } : {}) },
      ),
    });
    const thinking = thinkingNotifier((text) =>
      post({ type: "buddyThinking", requestId: msg.requestId, text }),
    );
    const outcome = await withChatPriority(llm.id, () => runBuddyTurn({
      llm,
      system: setup,
      // The buddy prompt (persona + tool defs + library) is stable across a
      // conversation — nothing changes turn-to-turn but the history — so the whole
      // system is the cache prefix (an explicit library edit just rewrites it once).
      cachePrefix: setup,
      history,
      maxTokens: budgets.reply,
      deps,
      onEvent: (e) => {
        if (e.kind === "token") post({ type: "buddyToken", requestId: msg.requestId, text: e.text });
        else if (e.kind === "thinking") thinking(e.text);
        else if (e.kind === "tool") post({ type: "buddyTool", requestId: msg.requestId, round: e.round, call: e.call });
        else
          post({
            type: "buddyToolResult",
            requestId: msg.requestId,
            call: e.call,
            ...(e.result.hits ? { hits: e.result.hits } : {}),
            ...(e.result.books ? { books: e.result.books } : {}),
            ...(e.result.imageHits ? { imageHits: e.result.imageHits } : {}),
            ...(e.result.applied ? { applied: e.result.applied } : {}),
            ...(e.result.removed ? { removed: e.result.removed } : {}),
            ...(e.result.calc ? { calc: e.result.calc } : {}),
            ...(e.result.wolfram ? { wolfram: e.result.wolfram } : {}),
            ...(e.result.memory ? { memory: e.result.memory } : {}),
            ...(e.result.error ? { error: e.result.error } : {}),
          });
      },
      signal: ac.signal,
    }));
    post({
      type: "buddyDone",
      requestId: msg.requestId,
      text: outcome.text,
      transcript: outcome.transcript,
      ...(outcome.pendingTool ? { pendingTool: outcome.pendingTool } : {}),
    });
  } catch (err) {
    post({
      type: "buddyError",
      requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    chatAborts.delete(msg.requestId);
  }
}

/**
 * A user-APPROVED generate_image tool call. In-chat render overrides apply here:
 * a named model resolves against the engine's INSTALLED models (a model that
 * isn't downloaded silently keeps the current one), a named style against the
 * style catalog, and a step count rides the render directly.
 */
async function handleChatTool(requestId: number, call: ToolCall): Promise<void> {
  try {
    if (call.tool !== "generate_image") throw new Error("Only generate_image needs approval.");
    if (!settings) throw new Error("Settings not initialised yet.");
    let cs = chatSettingsOf(settings);
    // A request the reader explicitly made must never silently fall back to the
    // defaults — fail loudly WITH the available options, so the model (which
    // sees the error as tool feedback) can retry with a name that resolves.
    const styleId = call.style ? resolveStyleRequest(call.style) : undefined;
    if (call.style && !styleId) {
      throw new Error(
        `no art style matches "${call.style}" — available: ${IMAGE_STYLES.map((s) => s.label).join(", ")}`,
      );
    }
    if (styleId) cs = { ...cs, imageStyle: styleId };
    if (call.model && cs.imageProvider === "local") {
      const installed = await installedModelNames(cs);
      const resolved = resolveModelRequest(call.model, installed);
      if (!resolved) {
        throw new Error(
          `no installed image model matches "${call.model}"` +
            (installed.length
              ? ` — installed: ${installed.join(", ")}`
              : " — the local engine lists no models (is it running and connected in Settings?)"),
        );
      }
      cs = { ...cs, localModel: resolved };
    }
    const cfTool = corsFetch();
    const built = buildProviders(cs, cfTool ? { corsFetch: cfTool } : {});
    // Same per-slot fallback as chat text: a mock chat-image slot (local engine not
    // connected) falls back to the book's real provider rather than placeholder art.
    const useBook = built.diagnostics.image.mock && bookProviders && !bookProviders.imageMock;
    const image = useBook ? bookProviders!.image : built.image;
    // The fallback must not also swallow an in-chat style request: the book tier
    // carries the SETTINGS style, so re-apply the resolved override on top of it.
    const baseTier = useBook ? bookProviders!.tier : built.tier;
    const tier = styleId ? { ...baseTier, style: styleId } : baseTier;
    const out = await renderFromText(image, tier, call.prompt, {
      ...(call.steps ? { stepsOverride: call.steps } : {}),
      onProgress: (fraction) => post({ type: "testProgress", requestId, fraction }),
    });
    post(
      {
        type: "chatToolResult",
        requestId,
        call,
        image: { bytes: out.bytes, mimeType: out.mimeType },
      },
      [out.bytes],
    );
    warmChatModel(); // reload the local LLM the render may have evicted
  } catch (err) {
    post({
      type: "chatToolResult",
      requestId,
      call,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The local engine's installed model names (checkpoints + diffusion models), or []. */
async function installedModelNames(s: ReaderSettings): Promise<string[]> {
  const baseUrl = s.engineBaseUrl ?? s.localServerUrl;
  if (!baseUrl) return [];
  try {
    const backend =
      s.localBackend === "a1111"
        ? new Automatic1111Backend({ baseUrl })
        : new ComfyUIBackend({ baseUrl });
    // Bounded: this runs per chat turn (for the settings note) — a wedged local
    // engine must not hang the whole chat. A miss just omits the installed list.
    const names = await Promise.race([
      backend.listModels().then((m) => m.map((x) => x.id)),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 2500)),
    ]);
    return names;
  } catch {
    return [];
  }
}

/**
 * Exit the current book back to the landing page: dispose the engine (stops its
 * bible loop + renders), and clear the retained book/bible/providers so nothing
 * keeps running or leaks into the next book. The main thread clears its own view.
 */
function handleClose(): void {
  engine?.dispose();
  engine = undefined;
  currentBook = undefined;
  currentBible = undefined;
  bookProviders = undefined;
  pendingStart = false;
  opening = false;
  bibleActive = false;
  bibleRunStartMs = 0;
  bibleCharacters = 0;
  stopBibleTimer();
  workflow.bibleDone = 0;
  workflow.bibleTotal = 0;
  workflow.promptsDone = 0;
  workflow.promptsTotal = 0;
  postWorkflow();
  post({ type: "generating", value: false });
  post({ type: "paused", bible: false, images: false });
  post({ type: "status", message: "" });
  post({ type: "bibleStatus", text: "" });
}

async function handleOpen(book: import("@visual-reader/core").BookSource): Promise<void> {
  if (!settings) {
    post({ type: "error", message: "Worker received open before init" });
    return;
  }
  opening = true;
  try {
    // A NEW engine is built per book — stop the previous one FIRST, or its bible loop
    // and renders keep running and its callbacks mingle the old book's characters and
    // status lines into the new book's UI.
    engine?.dispose();
    post({ type: "status", message: "" });
    post({ type: "generating", value: false });
    post({ type: "paused", bible: false, images: false });
    pendingStart = false; // fresh open; the hook re-sends "start" if it should resume
    lastProgressPct.clear(); // page indices are book-relative
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
    const openCf = corsFetch();
    const { llm, image, tier, diagnostics, imageSearch, webSearch } = buildProviders(settings, {
      ...(openCf ? { corsFetch: openCf } : {}),
      onLocalStatus: (message) => post({ type: "status", message: message || "Building the Visual Bible…" }),
      onLocalActivity: (activity) => {
        // Live token count during on-device generation. Bible tokens enrich the
        // bible status line; prompt-writing tokens show only when the bible isn't
        // claiming the line (so the two never fight over it).
        if (activity.phase === "bible") {
          // Record only — the 1s bible ticker renders the line. Posting here too
          // sent a message (and a full UI re-render) per streamed token.
          bibleTokens = activity.tokens;
        } else if (!bibleActive && activity.tokens > 0) {
          const now = Date.now();
          if (now - lastPromptTokenPostMs >= 500) {
            lastPromptTokenPostMs = now;
            post({ type: "status", message: `Writing the illustration prompt… ${activity.tokens} tokens` });
          }
        }
      },
    });
    llmLabel = diagnostics.llm.label;
    post({ type: "providers", diagnostics });
    // Retain the ORIGINAL book + the live providers for the chat (it reuses them
    // when no chat override applies, and reads the same chapter segmentation).
    currentBook = book;
    currentBible = undefined;
    bookProviders = {
      llm,
      image,
      tier,
      imageSearch,
      llmMock: diagnostics.llm.mock,
      imageMock: diagnostics.image.mock,
    };
    engine = new Engine({
      llm,
      image,
      tier,
      ...(imageSearch ? { imageSearch } : {}),
      ...(webSearch ? { webSearch } : {}),
      store: new IndexedDbStore(),
      onUpdate: (pageIndex, result) => {
        // Per-step progress: forward only when the whole percent moves (that's all
        // the UI displays) — otherwise every diffusion step crosses the boundary.
        if (result.status === "rendering" && result.progress !== undefined) {
          const pct = Math.round(result.progress * 100);
          if (lastProgressPct.get(pageIndex) === pct) return;
          lastProgressPct.set(pageIndex, pct);
        } else {
          lastProgressPct.delete(pageIndex);
        }
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
        currentBible = bible; // the chat reads the live bible
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
    // Open is complete — now a deferred start can actually run (and `beginGeneration`
    // below sees `opening === false`). Replaying covers a `start` that arrived during
    // the open (e.g. the buddy's "open and illustrate it") as well as a settings re-open.
    opening = false;
    if (pendingStart) {
      pendingStart = false;
      beginGeneration();
    }
  } catch (err) {
    opening = false;
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
