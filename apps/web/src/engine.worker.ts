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
  imageModelVramCostGb,
  serverModelVramCostGb,
  createDataTable,
  recalcTable,
  tableToText,
  yahooQuoteUrl,
  parseYahooQuote,
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
  schwabWatchlists,
  schwabAccountNumbers,
  placeSchwabOrder,
  buildBuddySystemPrompt,
  buildDelegatePrompt,
  buildCodingAgentPrompt,
  buildConflictResolvePrompt,
  mapWithConcurrency,
  buildProducePrompt,
  buildUnderstandPrompt,
  chapterText,
  fetchPageText,
  forgetNote,
  forgetSkill,
  getImageStyle,
  loadMemory,
  loadSkills,
  seedStarterSkills,
  memoryPromptBlock,
  saveSkill,
  runSkillProposal,
  worthLearning,
  isDuplicateSkill,
  touchSkill,
  loadTaskHistory,
  recordTask,
  taskRecurred,
  busCommands,
  formatBusReply,
  parseMcpServers,
  mcpListTools,
  mcpCallTool,
  buildStdioExchange,
  pickStdioResult,
  parseToolsList,
  parseToolCallText,
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
  gmailGetAttachment,
  extractAttachmentText,
  listEvents,
  createEvent,
  createDraft,
  sendEmail,
  listTasks,
  listSubtasks,
  listTaskTree,
  createTask,
  createTaskGroup,
  reconcileGoogleSubtasks,
  formatPlanForGoogleNotes,
  attachSourceEmailLink,
  planFromGoogleTask,
  importableGoogleTasks,
  googleNotesUserEdit,
  hasGoogleSkipMarker,
  runTaskPlanning,
  normalizeTaskPlan,
  nextOccurrence,
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
  applyStepEdits,
  advanceStep,
  nextReadyStep,
  tasksIndexBlock,
  patchTask,
  googleTaskExists,
  loadIgnored,
  buildScanPrompt,
  buildFocusQuery,
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
  advanceStoryScene,
  presentFromScene,
  emptyStoryScene,
  createEmptyBible,
  emptyAppearance,
  deterministicSeed,
  ComfyUIBackend,
  Automatic1111Backend,
  type BookSource,
  type StoryScene,
  type StoryRoleplay,
  type StoryPresent,
  type BuddyDeps,
  type BuddyOpenedInfo,
  type BuddyToolCall,
  type BuddyToolResultPayload,
  type ChatToolDeps,
  type FigureSearch,
  type ImageProvider,
  type LLMProvider,
  type TierConfig,
  isNonFiction,
  type ToolCall,
  type VisualBible,
} from "@visual-reader/core";
import { bookFromText, bookFromHtml, bookFromCode, storyBook } from "@visual-reader/epub";
// Import buildProviders via the React-free subpath: pulling it from the package
// index would drag the React UI components into the worker, which can crash the
// worker on load (no `window`/DOM) under dev's cross-origin isolation.
import { buildProviders } from "@visual-reader/ui/providers";
import type { ReaderSettings } from "@visual-reader/ui";
import type { TaskPlan, TaskStep } from "@visual-reader/core";
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

/**
 * Story "as you go" session — the OPEN story (one at a time). `beats` is every beat's prose
 * (the source of `storyBook`); `scene` is the live active-scene accumulator the bible hook
 * advances; `cadence` gates auto-illustration. Rebuilt from the book on a reopen so a
 * resumed story keeps accumulating with correct carry-forward.
 */
interface StorySessionState {
  bookId: string;
  title: string;
  author?: string;
  beats: string[];
  scene: StoryScene;
  roleplay?: StoryRoleplay;
  cadence: { mode: "per-response" | "every-n" | "manual"; n: number };
  beatsSinceImage: number;
}
let story: StorySessionState | undefined;
let storyCounter = 0;

/** Character-id slug — MUST match `mergeExtraction`'s (`char-<slug>`) so a pre-seeded cast
 * entry and the same name later extracted from prose resolve to ONE bible entry. */
function storySlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Bible character names whose name/alias appears in a beat's text (the active-scene "mentioned"
 * signal — the same name match the render's text scan uses, so the tracker never misses one). */
function bibleNamesInText(text: string, bible: VisualBible): string[] {
  const hay = text.toLowerCase();
  return bible.characters
    .filter((c) => [c.name, ...c.aliases].some((n) => n.length > 0 && hay.includes(n.toLowerCase())))
    .map((c) => c.name);
}

/**
 * The engine's per-beat active-scene hook: advance the tracked scene from this beat's
 * extraction (named cast + location) and return the render present-set override. Only fires
 * for the open story; a no-op for ordinary books.
 */
function storyPresentFor(chapterIndex: number, bible: VisualBible): StoryPresent | undefined {
  if (!story || currentBook?.kind !== "story" || story.bookId !== currentBook.id) return undefined;
  const text = story.beats[chapterIndex] ?? "";
  const scene = bible.storyboard.find((s) => s.chapterIndex === chapterIndex);
  story.scene = advanceStoryScene(
    story.scene,
    bible,
    { mentionedNames: bibleNamesInText(text, bible), ...(scene?.location ? { location: scene.location } : {}) },
    story.roleplay,
  );
  return presentFromScene(story.scene);
}

/** Each story chapter's prose (one beat per chapter), in order — to rebuild `beats` on reopen. */
function beatsFromBook(book: BookSource): string[] {
  const byChapter = new Map<string, string[]>();
  for (const page of book.pages) {
    const list = byChapter.get(page.chapterId) ?? [];
    list.push(...page.paragraphs.map((p) => p.text));
    byChapter.set(page.chapterId, list);
  }
  return book.chapters.map((c) => (byChapter.get(c.id) ?? []).join("\n\n"));
}

/** The book-persisted view of the live session (role-play + cadence), so a reopen resumes them. */
function storyConfigOf(s: StorySessionState): NonNullable<BookSource["storyConfig"]> {
  return { ...(s.roleplay ? { roleplay: s.roleplay } : {}), cadence: s.cadence };
}

/** Rebuild the story session from a reopened story book (fresh worker / library reopen). The
 * active-scene `scene` is replayed from the beats against the restored bible — using the
 * PERSISTED role-play (so a played cast is seeded) — and role-play + cadence are restored from
 * the book's `storyConfig`, so a resumed story keeps its contract, not the defaults. */
function rebuildStoryFromBook(book: BookSource, bible: VisualBible | undefined): StorySessionState {
  const beats = beatsFromBook(book);
  const roleplay = book.storyConfig?.roleplay;
  const cadence = book.storyConfig?.cadence ?? { mode: "per-response" as const, n: 3 };
  let scene = emptyStoryScene();
  if (bible) {
    beats.forEach((text, k) => {
      const s = bible.storyboard.find((x) => x.chapterIndex === k);
      scene = advanceStoryScene(
        scene,
        bible,
        { mentionedNames: bibleNamesInText(text, bible), ...(s?.location ? { location: s.location } : {}) },
        roleplay,
      );
    });
  }
  return {
    bookId: book.id,
    title: book.title,
    ...(book.author ? { author: book.author } : {}),
    beats,
    scene,
    ...(roleplay ? { roleplay } : {}),
    cadence: { mode: cadence.mode, n: cadence.n ?? 3 },
    beatsSinceImage: 0,
  };
}

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

/** A user-APPROVED send_email tool call — actually send the mail from the connected Google
 * account. Gated host-side (the approval card), so this only runs after the reader confirms. */
async function handleSendEmail(
  requestId: number,
  call: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] },
): Promise<void> {
  try {
    const googleId = settings?.keys?.googleClientId;
    const googleSecret = settings?.keys?.googleClientSecret;
    const store = memoryStore();
    if (!googleId || !googleSecret || !(await loadGoogleTokens(store))) {
      throw new Error("Google isn't connected (connect it in Settings).");
    }
    const transport = new DirectTransport(corsFetch());
    const token = await getFreshAccessToken(store, { clientId: googleId, clientSecret: googleSecret, transport });
    const r = await sendEmail(transport, token, call);
    post({ type: "buddyEmailSent", requestId, ...(r.id ? { id: r.id } : {}) });
  } catch (err) {
    post({ type: "buddyEmailSent", requestId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The chats' `read_url` tool: fetch a page's readable text into the conversation
 * (desktop routes CORS-blocked sites through the native fetch). Bounded fetch. */
function readUrlText(signal: AbortSignal): (url: string) => Promise<{ title?: string; text: string }> {
  return async (url) => {
    const cf = corsFetch();
    // Cap the readable text pulled into chat. Big enough for a full long article (a 16K cap
    // could stop inside a large page's header/nav before the body); still bounded so a
    // mis-aimed URL can't blow the chat context.
    const page = await fetchPageText(url, {
      maxChars: 50_000,
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
  // If we freed the bundled LLM for an image burst, relaunch it before this chat turn needs it.
  await restoreChatLlm();
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

// Run a stdio MCP server via the desktop shell (worker → main → Rust round-trip): the worker
// can't spawn a process, so it asks the main thread, which invokes the Tauri command.
const mcpStdioPending = new Map<number, (r: { ok: boolean; lines?: string[]; error?: string }) => void>();
let nextMcpStdioCallId = 1;
function mcpStdioExchange(command: string, args: string[], input: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const callId = nextMcpStdioCallId++;
    const timeout = setTimeout(() => {
      if (mcpStdioPending.delete(callId)) reject(new Error("the MCP server timed out"));
    }, 35_000);
    mcpStdioPending.set(callId, (r) => {
      clearTimeout(timeout);
      if (r.ok && r.lines) resolve(r.lines);
      else reject(new Error(r.error ?? "the MCP server failed"));
    });
    post({ type: "mcpStdio", callId, command, args, input });
  });
}

// Local-file ops via the main thread (worker → main round-trip): the worker can't reach the
// Tauri bridge or pdfjs, so it asks the main thread to search/read a file or extract PDF text.
type HostFileReply = { ok: boolean; files?: { name: string; path: string }[]; text?: string; imageBase64?: string; mimeType?: string; name?: string; error?: string };
const hostFilePending = new Map<number, (r: HostFileReply) => void>();
let nextHostFileId = 1;
function hostFile(req: { op: "search" | "read" | "pdftext" | "imageBytes"; query?: string; path?: string; bytesBase64?: string }): Promise<HostFileReply> {
  return new Promise((resolve) => {
    const callId = nextHostFileId++;
    const timeout = setTimeout(() => {
      if (hostFilePending.delete(callId)) resolve({ ok: false, error: "the file operation timed out" });
    }, 30_000);
    hostFilePending.set(callId, (r) => {
      clearTimeout(timeout);
      resolve(r);
    });
    post({ type: "hostFile", callId, ...req });
  });
}

// Coding-agent host-tool execution (worker → main round-trip): a write-capable agent runs its LLM
// loop here, but its run_command/write_file must execute on the main thread in the agent's worktree.
// The host answers with `agentToolResult` (autonomously, or after a per-step approval in Phase 2).
const agentToolPending = new Map<number, (r: BuddyToolResultPayload) => void>();
let nextAgentToolId = 1;
function runHostToolViaMain(
  runId: string,
  agentIdx: number,
  call: BuddyToolCall,
  cwd: string,
): Promise<BuddyToolResultPayload> {
  return new Promise((resolve) => {
    const callId = nextAgentToolId++;
    const timeout = setTimeout(
      () => {
        if (agentToolPending.delete(callId)) resolve({ error: "the agent's tool step timed out or was denied" });
      },
      5 * 60_000,
    );
    agentToolPending.set(callId, (r) => {
      clearTimeout(timeout);
      resolve(r);
    });
    post({ type: "agentTool", callId, runId, agentIdx, call, cwd });
  });
}

// Free/relaunch the bundled chat LLM's VRAM via the main thread (Tauri lives there). Used to give
// a burst of local image renders the whole GPU; the model is relaunched after the burst settles.
const llmVramPending = new Map<number, () => void>();
let nextLlmVramId = 1;
/** True while we've stopped the bundled chat LLM to free VRAM/RAM for image renders — so any later
 * LLM use (a chat turn, opening a book) knows to relaunch it first. */
let chatLlmFreed = false;
function llmVramOp(action: "stop" | "ensure"): Promise<void> {
  return new Promise((resolve) => {
    const callId = nextLlmVramId++;
    const to = setTimeout(() => {
      if (llmVramPending.delete(callId)) resolve();
    }, 30_000);
    llmVramPending.set(callId, () => {
      clearTimeout(to);
      resolve();
    });
    post({ type: "llmVram", callId, action });
  });
}

/** Whether it's SAFE + worth freeing the chat LLM for a render. Covers the local-server backends
 * that hold their own memory: the BUNDLED llama-server (which we kill + relaunch) and a local
 * "server" model like Ollama (which we tell to evict via keep_alive:0, then it reloads lazily).
 * Only when images render on the same local GPU, and only when the Visual Bible isn't MID-BUILD
 * (the one book-path step that needs the text LLM). A book can be open and fully analysed — then
 * the model is just squatting ~10–20GB of GPU/RAM during the render (the reported Qwen-Image
 * thrash), so we free it and restore it after (warmChatModel). chat/buddy turns restore it first
 * via withChatPriority; opening/analysing a book restores it via handleOpen. */
function canFreeChatLlm(): boolean {
  if (!settings || (settings.localTextBackend !== "bundled" && settings.localTextBackend !== "server")) return false;
  // Never free mid-bible-build (active chapter, or a run with chapters still pending) — the engine
  // would lose the LLM it's extracting with.
  if (bibleActive || (bibleRunTotal > 0 && bibleRunDone < bibleRunTotal)) return false;
  const cs = chatSettingsOf(settings);
  if (cs.imageProvider !== "local" && settings.imageProvider !== "local") return false;
  // An external AUTOMATIC1111 server keeps its checkpoint resident in VRAM after a render (unlike the
  // app's managed ComfyUI, which releases it under memory pressure), so freeing the chat model for it
  // only strands the LLM — it can't reload into the now-contended GPU and the chat goes unresponsive.
  // Only free for engines whose VRAM the app actually coordinates (bundled server / managed ComfyUI).
  // Use the RESOLVED active backend: a fallback from A1111 to the managed ComfyUI does release VRAM.
  if ((settings.engineBackend ?? settings.localBackend) === "a1111") return false;
  // VRAM HEADROOM: only free when memory is actually tight. If the GPU can hold the chat model AND
  // the image model at once, keep BOTH resident — evicting the chat model and reloading it is the
  // expensive part (a big Ollama model is a multi-minute cold reload on the next message), so skip it
  // when there's clearly room. Free when low-VRAM is forced, when they can't both fit, or when a size
  // is unknown (the safe default). The bundled LLM's size is fixed; a "server" model's is estimated
  // from its name (params + quant) — 0/unknown falls through to freeing, so nothing regresses.
  if (!settings.lowVram && settings.gpuVramMb && settings.gpuVramMb > 0) {
    const imageGb = imageModelVramCostGb(settings.localModel ?? "");
    const chatGb =
      settings.localTextBackend === "bundled"
        ? BUNDLED_LLM_VRAM_GB
        : serverModelVramCostGb(cs.localServerTextModel ?? settings.localServerTextModel ?? "");
    const HEADROOM_GB = 2; // activations/latents/runtime overhead beyond the weights
    if (imageGb > 0 && chatGb > 0 && (imageGb + chatGb + HEADROOM_GB) * 1024 <= settings.gpuVramMb) {
      return false; // both fit — leave the chat model loaded (no evict/cold-reload thrash)
    }
  }
  try {
    return chatProviders().llm.id === "local-server";
  } catch {
    return false;
  }
}

/** Approx VRAM the bundled chat model (Llama 3.2 3B, launched fp16-ish with -c 8192) holds resident,
 * used only to decide whether it + the image model both fit so we can SKIP freeing it. */
const BUNDLED_LLM_VRAM_GB = 4;

/** Before a STANDALONE image render (no book open): stop the bundled chat LLM so ComfyUI gets the
 * whole GPU AND its model stops squatting system RAM. Once per burst; relaunched only on demand. */
async function freeChatLlmForRender(): Promise<void> {
  if (chatLlmFreed || !canFreeChatLlm()) return;
  chatLlmFreed = true;
  if (settings?.localTextBackend === "bundled") {
    await llmVramOp("stop"); // we own the bundled process — kill it to free its RAM/VRAM
  } else {
    // "server" backend (Ollama): we don't own the process, but Ollama evicts the model on a
    // keep_alive:0 request (no-op for non-Ollama servers like LM Studio). It reloads lazily.
    try {
      await chatProviders().llm.unload?.();
    } catch {
      /* best-effort — leave it loaded if the unload call fails */
    }
  }
}

/** Relaunch the bundled chat LLM after it was freed — called ON DEMAND (a chat turn, opening a
 * book), NOT after every render, so a pure image session leaves it unloaded (no RAM/VRAM held). */
async function restoreChatLlm(): Promise<void> {
  if (!chatLlmFreed) return;
  chatLlmFreed = false;
  // Only the bundled server needs an explicit relaunch. An Ollama ("server") model reloads
  // lazily on the next chat request (which is what triggered this restore), so nothing to start.
  if (settings?.localTextBackend === "bundled") await llmVramOp("ensure");
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
    case "runCodingAgents":
      void handleCodingAgents(msg);
      break;
    case "codingAgentCancel":
      codingAgentAborts.get(msg.requestId)?.abort();
      break;
    case "resolveConflicts":
      void handleResolveConflicts(msg);
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
    case "importGoogleTasks":
      void handleImportGoogleTasks(msg);
      break;
    case "createGoogleTask":
      void handleCreateGoogleTask(msg);
      break;
    case "createEvent":
      void handleCreateEvent(msg);
      break;
    case "loadCalendar":
      void handleLoadCalendar(msg);
      break;
    case "stockQuote":
      void handleStockQuote(msg);
      break;
    case "readPage":
      void handleReadPage(msg);
      break;
    case "remoteBusList":
      void handleRemoteBusList(msg);
      break;
    case "remoteBusReply":
      void handleRemoteBusReply(msg);
      break;
    case "marketIndicators":
      void handleMarketIndicators(msg);
      break;
    case "schwabConnect":
      void handleSchwabConnect(msg);
      break;
    case "schwabPlaceOrder":
      void handleSchwabPlaceOrder(msg);
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
    case "buddySendEmail":
      void handleSendEmail(msg.requestId, msg.call);
      break;
    case "chatCancel":
      chatAborts.get(msg.requestId)?.abort();
      chatAborts.delete(msg.requestId);
      break;
    case "warmLlm":
      cancelChatWarm(); // supersede any pending debounced warm — load it right now
      void doWarmChatModel();
      break;
    case "corsFetchResult": {
      const resolve = corsFetchPending.get(msg.fetchId);
      corsFetchPending.delete(msg.fetchId);
      resolve?.(msg);
      break;
    }
    case "mcpStdioResult": {
      const resolve = mcpStdioPending.get(msg.callId);
      mcpStdioPending.delete(msg.callId);
      resolve?.(msg);
      break;
    }
    case "agentToolResult": {
      const resolve = agentToolPending.get(msg.callId);
      agentToolPending.delete(msg.callId);
      resolve?.(msg.result);
      break;
    }
    case "hostFileResult": {
      const resolve = hostFilePending.get(msg.callId);
      hostFilePending.delete(msg.callId);
      resolve?.(msg);
      break;
    }
    case "llmVramResult": {
      const resolve = llmVramPending.get(msg.callId);
      llmVramPending.delete(msg.callId);
      resolve?.();
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
  const ac = new AbortController();
  chatAborts.set(requestId, ac); // so a Stop (chatCancel for this requestId) interrupts the render
  try {
    if (!settings) throw new Error("Settings not initialised yet.");
    cancelChatWarm(); // don't let a pending LLM warm steal VRAM from this render
    // Pass corsFetch so a self-hosted local engine (A1111/ComfyUI) is reached through the desktop
    // bridge (CORS-exempt) — a browser fetch from the packaged app's origin is CORS-blocked.
    const cfRender = corsFetch();
    const { image, tier } = buildProviders(settings, cfRender ? { corsFetch: cfRender } : {});
    const out = await renderFromText(image, tier, text, {
      ...(initImage ? { initImage } : {}),
      ...(denoise !== undefined ? { denoise } : {}),
      ...(size ? { width: size.width, height: size.height } : {}),
      signal: ac.signal,
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
  } catch (err) {
    const aborted = ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
    post({
      type: "testRendered",
      requestId,
      ok: false,
      error: aborted ? "Image generation stopped." : err instanceof Error ? err.message : String(err),
    });
  } finally {
    chatAborts.delete(requestId);
    warmChatModel(); // schedule the (debounced) LLM reload — and restore it if we freed its VRAM,
    // even when the render failed, so the bundled model is never left stopped.
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
    /** Hi-Res two-pass override (a per-request "make it high-res" from chat); falls back
     * to the tier's persisted setting when unset. Local engine only. */
    hires?: boolean;
    /** Render progress sink (0..1) for engines that report it (ComfyUI). */
    onProgress?: (fraction: number) => void;
    /** Cancellation: aborting it interrupts the in-flight ComfyUI render (the Stop button). */
    signal?: AbortSignal;
  } = {},
): Promise<{ bytes: ArrayBuffer; mimeType: string; prompt: string }> {
  // Standalone render (playground / chat generate_image): free the bundled chat LLM's VRAM first so
  // ComfyUI gets the whole GPU. Once per burst (gated to safe cases); relaunched after the burst by
  // the debounced warm or the next chat. The book's bible-illustration path doesn't come through
  // here, so it's never disturbed.
  await freeChatLlmForRender();
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
  // Hi-Res: a per-request override (chat "make it high-res") wins, else the tier setting.
  const hires = opts.hires ?? (isLocal ? tier.hires : undefined);
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
    ...(isLocal && hires ? { hires: true } : {}),
    ...(isLocal && tier.localCfg !== undefined ? { cfgOverride: tier.localCfg } : {}),
    ...(isLocal && tier.localSampler ? { localSampler: tier.localSampler } : {}),
    ...(isLocal && tier.localScheduler ? { localScheduler: tier.localScheduler } : {}),
    ...(opts.initImage ? { initImage: opts.initImage } : {}),
    ...(opts.denoise !== undefined ? { denoise: opts.denoise } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { bytes: out.bytes, mimeType: out.mimeType, prompt };
}

/**
 * Reload the local chat model into VRAM after an image render — image generation
 * (ComfyUI/local) evicts the LLM under GPU memory pressure, so the NEXT chat turn
 * would otherwise wait on a cold reload (felt like a hang). Fire-and-forget: a
 * 1-token request warms it while the reader looks at the rendered image. Cloud
 * chat models don't load locally, so they're skipped.
 *
 * DEBOUNCED + cancellable: during a BURST of rapid renders, warming the LLM after
 * each one steals VRAM back from the NEXT image — forcing ComfyUI to offload weights
 * to system RAM (the "…MB Staged" dynamic loading), which can slow a render 10×+
 * (e.g. 10s → 100s). So we cancel any pending warm when a render starts, and only
 * warm once the renders have settled — keeping the next chat turn fast without
 * throttling an image burst (during which the LLM simply stays evicted and ComfyUI
 * keeps the whole GPU).
 */
const WARM_DEBOUNCE_MS = 12_000;
let warmTimer: ReturnType<typeof setTimeout> | undefined;

/** Cancel a pending chat-model warm — called when a render STARTS so warming never
 * reloads the LLM mid-render (which would steal VRAM from the in-flight image). */
function cancelChatWarm(): void {
  if (warmTimer) {
    clearTimeout(warmTimer);
    warmTimer = undefined;
  }
}

function warmChatModel(): void {
  cancelChatWarm();
  warmTimer = setTimeout(() => {
    warmTimer = undefined;
    void doWarmChatModel();
  }, WARM_DEBOUNCE_MS);
}

/** Bring the local chat model back into memory (used by the debounced post-render warm AND the
 * manual "load model" command). If we freed it for the render burst, clear that first — bundled
 * relaunches its process, an Ollama ("server") model just clears the flag — then a 1-token request
 * loads it (cold) for both backends. After a render burst this restores it even in a pure image
 * session, so the reader's next chat is ready instead of waiting on a cold load. */
async function doWarmChatModel(): Promise<void> {
  if (chatLlmFreed) await restoreChatLlm();
  try {
    const { llm } = chatProviders();
    if (!supportsChat(llm) || (llm.id !== "local-server" && llm.id !== "webllm")) return;
    await llm.chat([{ role: "user", content: "ok" }], { maxTokens: 1 }).catch(() => {});
  } catch {
    /* no chat provider yet / not initialised — nothing to warm */
  }
}

// --- Reading-companion chat -------------------------------------------------

/** The user's thinking-level setting → the provider's reasoning_effort (undefined = the model's
 * own default; "off" turns the hidden reasoning pass off on models that support it). Harmless for
 * cloud + non-thinking local models, which ignore the field. */
function chatReasoningEffort(s: ReaderSettings | undefined): "none" | "low" | "medium" | "high" | undefined {
  switch (s?.localThinkingEffort) {
    case "off":
      return "none";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return undefined; // "auto" / unset
  }
}

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
/** Per-reply token budget for a LOCAL model = ~30% of the resolved window (so a 100k window writes
 * ~30k in ONE pass — fewer continuation hops, each of which re-prefills the growing context, so big
 * passes are also CHEAPER). Capped only by a sanity ceiling: a single local generation past ~32k
 * tokens is impractically slow to decode and tends to drift, and the loop AUTO-CONTINUES past it
 * with the Stop button able to interrupt between passes — so the cap bounds one *generation*, not
 * the total output. */
const LOCAL_REPLY_FRACTION = 0.3;
const MAX_LOCAL_REPLY_TOKENS = 32_768;
/** Per-reply budget for CLOUD models — kept moderate because cloud APIs REJECT a max_tokens above
 * the model's own output ceiling (Claude/Gemini ≈ 8k). They rarely truncate at this; if they do, the
 * loop continues just like local. */
const CLOUD_REPLY_TOKENS = 8192;

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
      reply: CLOUD_REPLY_TOKENS,
      ...(CLOUD_MAX_TOKENS[llmId] ? { maxTokens: CLOUD_MAX_TOKENS[llmId] } : {}),
    };
  }
  if (ctxTokens && ctxTokens > 0) {
    const usable = Math.min(ctxTokens, MAX_TRUSTED_CONTEXT_TOKENS);
    const inputChars = Math.min(Math.floor(usable * CHARS_PER_TOKEN * 0.45), MAX_LOCAL_INPUT_CHARS);
    return {
      book: Math.floor(inputChars * 0.7),
      history: Math.floor(inputChars * 0.3),
      // ~30% of the window per reply (floored so tiny windows still answer; ceilinged at
      // MAX_LOCAL_REPLY_TOKENS so ONE generation stays tractable). A 100k window → ~30k per pass, and
      // the chat/buddy loop AUTO-CONTINUES beyond even that — total output is effectively unbounded.
      reply: Math.min(MAX_LOCAL_REPLY_TOKENS, Math.max(512, Math.floor(usable * LOCAL_REPLY_FRACTION))),
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
  // Per-model num_ctx wins: it's the window we actually told Ollama to LOAD, so budget to it exactly.
  const activeModel = chatSettingsOf(settings).localServerTextModel ?? settings.localServerTextModel;
  const perModel = activeModel ? settings.localContextByModel?.[activeModel] : undefined;
  if (perModel && perModel > 0) return Math.min(perModel, MAX_TRUSTED_CONTEXT_TOKENS);
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
    ' These defaults are used unless the reader EXPLICITLY names a different model IN THEIR MESSAGE — only then pass "model".' +
    ' When you do, copy the reader\'s OWN WORDS (e.g. "flux 2 klein") or an EXACT name from the installed list above — NEVER invent a filename, guess a different model, or change the ".safetensors" extension.' +
    " If they didn't name a model, OMIT the model field so their selected model is used."
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
    const fullView = isNonFiction(book.contentMode) || msg.allowSpoilers;
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
      ...(chatReasoningEffort(settings) ? { reasoningEffort: chatReasoningEffort(settings)! } : {}),
      tools: {
        searchWeb: (q) => imageSearch.searchWeb(q),
        searchImages: (q) => imageSearch.search(q),
        searchBook: (q) => searchBookPassages(searchableChapters, q),
        readUrl: readUrlText(ac.signal),
        remember: async (n) => (await rememberNote(memoryStore(), n)).length,
        forget: async (m) => (await forgetNote(memoryStore(), m)).length,
        readSkill: async (name) => (await touchSkill(memoryStore(), name))?.body ?? "",
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
        else if (e.kind === "activity") post({ type: "chatActivity", requestId: msg.requestId, text: e.text });
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

/** The buddy's gmail_search dep (chat + task-planning research): a normal search, but an empty query
 * means "newest emails" (→ in:inbox), and if a TARGETED query finds nothing it widens ONCE to include
 * Promotions/Spam/Trash (a message the reader is hunting for can be mis-filed there) — so "show my
 * recent emails" and "find the email from X" both work. The background task SCAN does NOT use this; it
 * calls gmailSearch directly with its own narrow queries (it must never plan from spam/trash). */
function makeBuddyGmailSearch(transport: DirectTransport, tok: () => Promise<string>) {
  return async (q: string, max?: number) => {
    const query = q.trim() || "in:inbox";
    const results = await gmailSearch(transport, await tok(), query, max);
    if (results.length > 0 || /\bin:(anywhere|spam|trash)\b/i.test(query)) return results;
    return gmailSearch(transport, await tok(), `${query} in:anywhere`, max);
  };
}

/** Plan a task: bounded research (web + Gmail/Calendar) then a structured plan, persisted.
 * Reuses the buddy research tools + the CORS proxy; cancellable via the shared chatAborts. */
/** The readAttachment dep: re-read the email to resolve the attachment's name/type, download its
 * bytes, and extract text — text-like files inline, PDFs via the main thread (pdfjs). Auto-run,
 * NO approval — pulling a file in is safe "gather" work. */
function makeReadAttachment(transport: DirectTransport, tok: () => Promise<string>) {
  return async (messageId: string, attachmentId: string) => {
    const email = await gmailReadEmail(transport, await tok(), messageId);
    const meta = email.attachments?.find((a) => a.attachmentId === attachmentId);
    const bytes = await gmailGetAttachment(transport, await tok(), messageId, attachmentId);
    const filename = meta?.filename ?? "attachment";
    const mimeType = meta?.mimeType ?? "application/octet-stream";
    let text = extractAttachmentText(bytes, mimeType, filename);
    if (!text && (/pdf/i.test(mimeType) || /\.pdf$/i.test(filename))) {
      const r = await hostFile({ op: "pdftext", bytesBase64: bytesToBase64(bytes.buffer as ArrayBuffer) });
      if (r.ok && r.text) text = r.text;
    }
    return { filename, mimeType, bytesLen: bytes.length, ...(text ? { text: text.slice(0, 16_000) } : {}) };
  };
}

/** Local-file research deps for the planner/chat, GATED by the reader's settings: disk SEARCH only
 * when autonomous file search is on; reading a file when auto-pull-files is on (default). Both reach
 * the disk via the host round-trip (Tauri lives on the main thread); empty on the web. */
/** `force` wires file search/read regardless of the background-autonomy settings — used when the
 * reader EXPLICITLY asked for a plan that involves their files (a typed "plan this, my resume is on
 * my PC"). The idle sweep stays gated by the settings. */
function fileResearchDeps(force = false): Partial<BuddyDeps> {
  return {
    ...(force || settings?.autonomousFileSearch || settings?.fullAutonomy
      ? {
          findFiles: async (query: string) => {
            const r = await hostFile({ op: "search", query });
            if (!r.ok) throw new Error(r.error ?? "file search failed");
            return r.files ?? [];
          },
        }
      : {}),
    ...(force || (settings?.autoPullFiles ?? true) || settings?.fullAutonomy
      ? {
          readFile: async (path: string) => {
            const r = await hostFile({ op: "read", path });
            if (!r.ok) throw new Error(r.error ?? "couldn't read that file");
            return r.text ?? "";
          },
          openImage: async (path: string) => {
            const r = await hostFile({ op: "imageBytes", path });
            if (!r.ok || !r.imageBase64) throw new Error(r.error ?? "couldn't open that image");
            return { name: r.name ?? path.split(/[\\/]/).pop() ?? "image", mimeType: r.mimeType ?? "image/png", base64: r.imageBase64 };
          },
        }
      : {}),
  };
}

/** Sync a planned task's steps to Google Tasks as SUB-TASKS under its parent, RECONCILING against
 * what's already there (match by stored id, then title) so a re-plan never duplicates; completed
 * steps are marked complete; superseded sub-tasks are LEFT IN PLACE (never deleted — kept for
 * history, and Google access is read-and-create only). Refreshes the parent's notes. Best-effort;
 * returns the plan with each step's googleTaskId. */
async function syncPlanToGoogleTasks(plan: TaskPlan, transport: DirectTransport, tok: () => Promise<string>): Promise<TaskPlan> {
  const parentId = plan.googleTaskId;
  if (!parentId) return plan;
  let existing: { id: string; title: string; status?: string }[] = [];
  try {
    existing = await listSubtasks(transport, await tok(), parentId);
  } catch {
    /* best-effort — without the list we just won't reconnect to existing ones */
  }
  const actions = reconcileGoogleSubtasks(plan.steps, existing);
  const steps: TaskStep[] = [];
  let previous: string | undefined;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    const action = actions[i]!;
    let gid = action.existingId;
    if (action.create) {
      try {
        const child = await createTask(transport, await tok(), {
          title: step.title,
          ...(step.detail ? { notes: step.detail } : {}),
          ...(step.dueIso ? { due: step.dueIso } : {}),
          parent: parentId,
          ...(previous ? { previous } : {}),
        });
        gid = child.id;
      } catch {
        /* keep the in-app step even if its Google write failed */
      }
    }
    if (gid && action.needsComplete) {
      try {
        await patchTask(transport, await tok(), gid, { status: "completed" });
      } catch {
        /* best-effort */
      }
    }
    steps.push(gid ? { ...step, googleTaskId: gid } : step);
    if (gid) previous = gid;
  }
  // Write the WHOLE plan into the parent task's notes, so the current plan (summary + numbered
  // steps + deadline) is readable right in Google Tasks — not just a title with child rows. Remember
  // the exact string as the baseline so a later edit the reader makes in Google Tasks is detectable.
  const notes = formatPlanForGoogleNotes({ ...plan, steps });
  let googleNotesSynced = plan.googleNotesSynced;
  try {
    await patchTask(transport, await tok(), parentId, { notes });
    googleNotesSynced = notes;
  } catch {
    /* best-effort — keep the previous baseline if the write failed */
  }
  return { ...plan, steps, ...(googleNotesSynced !== undefined ? { googleNotesSynced } : {}) };
}

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
      ...fileResearchDeps(msg.allowFiles),
      searchWeb: (q) => imageSearch.searchWeb(q),
      readUrl: readUrlText(ac.signal),
      ...(googleConnected
        ? {
            gmailSearch: makeBuddyGmailSearch(transport, tok),
            readEmail: async (id: string) => gmailReadEmail(transport, await tok(), id),
            readAttachment: makeReadAttachment(transport, tok),
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
    // Re-planning an existing task (a scan stub, or a refresh) keeps its id + chat session so the
    // planned version REPLACES the stub in place instead of adding a duplicate — and PRESERVES its
    // Google link + repeat rule (runTaskPlanning doesn't know about them).
    const existing = msg.planId ? (await loadTaskPlans(store)).find((p) => p.id === msg.planId) : undefined;
    const baseFinal: TaskPlan = existing
      ? {
          ...plan,
          id: existing.id,
          createdAt: existing.createdAt,
          ...(existing.sessionId ? { sessionId: existing.sessionId } : {}),
          ...(existing.googleTaskId ? { googleTaskId: existing.googleTaskId } : {}),
          ...(existing.recurrence ? { recurrence: existing.recurrence } : {}),
          // Keep the reader's added details as context (sourceText already folded them in); dropping
          // `needsReplan` here is what CLEARS the re-attack flag once the refined plan is produced.
          ...(existing.userNotes ? { userNotes: existing.userNotes } : {}),
        }
      : plan;
    // When the task came FROM an email, drop a Gmail link on the step that needs the reply/send, so
    // the reader can jump straight to it from the plan (and from Google Tasks, via the notes).
    const srcEmailId =
      baseFinal.source.kind === "email" || baseFinal.source.kind === "scan" ? baseFinal.source.emailId : undefined;
    const finalPlan = attachSourceEmailLink(baseFinal, srcEmailId);
    // SAVE + return the plan FIRST, so the steps show in the app immediately and can't be lost to a
    // slow/hung Google call. The Google mirror is then best-effort in the BACKGROUND (below).
    await upsertTaskPlan(store, finalPlan);
    post({ type: "planned", requestId: msg.requestId, ok: true, plan: finalPlan });
    // Mirror to Google Tasks in the background: sync sub-tasks + notes under the existing parent, or
    // create a parent first for a user-typed plan with none yet. Re-saves with the Google ids when
    // done (skipped if the plan was deleted meanwhile). Never blocks the plan from saving/showing.
    if (googleConnected && finalPlan.steps.length > 0) {
      void (async () => {
        try {
          let synced = finalPlan;
          if (finalPlan.googleTaskId) {
            synced = await syncPlanToGoogleTasks(finalPlan, transport, tok);
          } else {
            const parent = await createTask(transport, await tok(), {
              title: finalPlan.title,
              ...(finalPlan.deadlineIso ? { due: finalPlan.deadlineIso } : {}),
            });
            if (parent.id) synced = await syncPlanToGoogleTasks({ ...finalPlan, googleTaskId: parent.id }, transport, tok);
          }
          if ((await loadTaskPlans(store)).some((p) => p.id === finalPlan.id)) await upsertTaskPlan(store, synced);
        } catch {
          /* best-effort — the in-app plan is already saved */
        }
      })();
    }
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
    const now = new Date();
    // Look ~45 days out so TRIPS that need booking ahead of time are visible (not just the
    // next few days). Pull recent actionable mail PLUS travel/booking confirmations, so the
    // classifier can tell whether a trip's flight/hotel is already arranged.
    const horizon = new Date(now.getTime() + 45 * 86_400_000);
    // FOCUS items the reader flagged (specific senders/subjects to always watch): a separate search
    // (no category exclusion, so a flagged sender surfaces even from Promotions), tagged for the
    // classifier to favour. Empty when none configured.
    const focusQuery = buildFocusQuery(settings?.scanFocus);
    const [recent, travel, focus, events] = await Promise.all([
      gmailSearch(transport, token, "newer_than:2d -category:promotions -category:social", 15).catch(() => []),
      gmailSearch(transport, token, "newer_than:60d (flight OR hotel OR reservation OR itinerary OR booking OR confirmation)", 12).catch(() => []),
      focusQuery ? gmailSearch(transport, token, `newer_than:30d (${focusQuery})`, 12).catch(() => []) : Promise.resolve([]),
      listEvents(transport, token, { max: 25, timeMin: now.toISOString(), timeMax: horizon.toISOString() }).catch(() => []),
    ]);
    const focusIds = new Set(focus.map((e) => e.id).filter((id): id is string => !!id));
    const seen = new Set<string>();
    const emails = [...focus, ...recent, ...travel].filter((e) => e.id && !seen.has(e.id) && seen.add(e.id));
    if (emails.length === 0 && events.length === 0) {
      post({ type: "scanned", requestId: msg.requestId, ok: true, candidates: [] });
      return;
    }
    const reply = await llm.chat(buildScanPrompt(emails, events, now.toISOString().slice(0, 10), focusIds), { maxTokens: 1024 });
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

/** Mirror the user's existing Google Tasks INTO the app's task list: read the Google Tasks tree
 * (parents + sub-tasks), then upsert a planned TaskPlan for any whose id isn't already linked to a
 * local plan — so a task the app created in Google (or the user added there) shows up in the app
 * even if its local plan was never written / got evicted. Read-only against Google; never deletes. */
async function handleImportGoogleTasks(msg: Extract<MainToWorker, { type: "importGoogleTasks" }>): Promise<void> {
  try {
    const store = memoryStore();
    const googleId = settings?.keys?.googleClientId;
    const googleSecret = settings?.keys?.googleClientSecret;
    if (!googleId || !googleSecret || !(await loadGoogleTokens(store))) {
      post({ type: "googleTasksImported", requestId: msg.requestId, ok: true, imported: 0 });
      return;
    }
    const transport = new DirectTransport(corsFetch());
    const token = await getFreshAccessToken(store, { clientId: googleId, clientSecret: googleSecret, transport });
    const trees = await listTaskTree(transport, token, 500); // paginates; counts sub-tasks per page
    const existingPlans = await loadTaskPlans(store);
    const toImport = importableGoogleTasks(trees, existingPlans);
    for (const tree of toImport) {
      await upsertTaskPlan(store, normalizeTaskPlan(planFromGoogleTask(tree)));
    }
    // SYNC FROM GOOGLE for each LINKED plan: mirror the reader's actions in Google Tasks back into
    // the app — [skip]/[ignore] in the title → archive ignored; marked complete → mark the plan
    // complete; deleted → archive removed (CONFIRMED via a single GET, since the tree caps at 100 and
    // "absent" could be truncation); otherwise detect a NOTES edit → re-plan. Never writes to Google.
    const treeById = new Map(trees.map((t) => [t.id, t]));
    let edited = 0; // notes edits → re-plan
    let mirrored = 0; // ignore / complete / delete mirrored from Google
    let deleteConfirms = 0; // bound the confirm GETs per sweep
    const now = Date.now();
    const todayIso = new Date().toISOString().slice(0, 10);
    for (const plan of existingPlans) {
      if (!plan.googleTaskId || plan.status === "archived") continue;
      const tree = treeById.get(plan.googleTaskId);
      if (tree) {
        if (hasGoogleSkipMarker(tree.title)) {
          // The reader marked it [skip]/[ignore] in Google → stop managing it (undo via Restore).
          await upsertTaskPlan(store, { ...plan, status: "archived", archivedReason: "ignored", archivedAt: now });
          mirrored++;
          continue;
        }
        if (tree.status === "completed" && plan.status !== "completed") {
          // Completed in Google. A RECURRING task rolls forward to the next occurrence (mirrors the
          // in-app completion): reset steps, shift the dates, and create a fresh parent Google Task
          // for the new cycle. A one-off just gets marked complete.
          const next = plan.recurrence ? nextOccurrence(plan, todayIso) : undefined;
          if (next) {
            let newGoogleId: string | undefined;
            try {
              const parent = await createTask(transport, token, {
                title: next.title,
                ...(next.summary ? { notes: next.summary } : {}),
                ...(next.deadlineIso ? { due: next.deadlineIso } : {}),
              });
              newGoogleId = parent.id;
            } catch {
              /* keep the rolled plan even if the Google write failed */
            }
            await upsertTaskPlan(
              store,
              normalizeTaskPlan({ ...next, id: plan.id, ...(newGoogleId ? { googleTaskId: newGoogleId } : {}) }),
            );
          } else {
            await upsertTaskPlan(store, { ...plan, status: "completed" });
          }
          mirrored++;
          continue;
        }
        if (plan.googleNotesSynced === undefined) {
          await upsertTaskPlan(store, { ...plan, googleNotesSynced: tree.notes ?? "" });
          continue;
        }
        const added = googleNotesUserEdit(tree.notes, plan.googleNotesSynced);
        if (!added) continue;
        const userNotes = [plan.userNotes, added].filter(Boolean).join("\n").slice(0, 4000);
        // Re-baseline to the current notes so the same edit isn't captured twice before the re-plan.
        await upsertTaskPlan(store, { ...plan, userNotes, needsReplan: true, googleNotesSynced: tree.notes ?? "" });
        edited++;
      } else if (plan.googleNotesSynced !== undefined && deleteConfirms < 25) {
        // Absent from the tree: could be a deletion OR just truncation (tree caps at 100). Only mirror
        // a deletion once a single GET CONFIRMS it's gone (404) — a network error throws and is skipped.
        deleteConfirms++;
        let gone = false;
        try {
          gone = !(await googleTaskExists(transport, token, plan.googleTaskId));
        } catch {
          gone = false; // couldn't confirm → don't mirror
        }
        if (gone) {
          await upsertTaskPlan(store, { ...plan, status: "archived", archivedReason: "removed", archivedAt: now });
          mirrored++;
        }
      }
    }
    post({
      type: "googleTasksImported",
      requestId: msg.requestId,
      ok: true,
      imported: toImport.length,
      ...(edited ? { edited } : {}),
      ...(mirrored ? { mirrored } : {}),
    });
  } catch (err) {
    post({ type: "googleTasksImported", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Create a bare Google Task (parent) for a surfaced scan stub, returning its id so the in-app
 * stub can be linked to it. Planning later pushes the sub-tasks + plan notes under this parent.
 * Best-effort: no-op (ok, no id) when Google isn't connected — the stub just stays in-app. */
async function handleCreateGoogleTask(msg: Extract<MainToWorker, { type: "createGoogleTask" }>): Promise<void> {
  try {
    const store = memoryStore();
    const googleId = settings?.keys?.googleClientId;
    const googleSecret = settings?.keys?.googleClientSecret;
    if (!googleId || !googleSecret || !(await loadGoogleTokens(store))) {
      post({ type: "googleTaskCreated", requestId: msg.requestId, ok: true });
      return;
    }
    const transport = new DirectTransport(corsFetch());
    const token = await getFreshAccessToken(store, { clientId: googleId, clientSecret: googleSecret, transport });
    const item = await createTask(transport, token, {
      title: msg.title,
      ...(msg.notes ? { notes: msg.notes } : {}),
      ...(msg.due ? { due: msg.due } : {}),
    });
    post({ type: "googleTaskCreated", requestId: msg.requestId, ok: true, ...(item.id ? { id: item.id } : {}) });
  } catch (err) {
    post({ type: "googleTaskCreated", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Create a Google Calendar event on the primary calendar (the manual "+ Add event" path). */
async function handleCreateEvent(msg: Extract<MainToWorker, { type: "createEvent" }>): Promise<void> {
  try {
    const store = memoryStore();
    const googleId = settings?.keys?.googleClientId;
    const googleSecret = settings?.keys?.googleClientSecret;
    if (!googleId || !googleSecret || !(await loadGoogleTokens(store))) {
      post({ type: "eventCreated", requestId: msg.requestId, ok: false, error: "Connect Google first." });
      return;
    }
    const transport = new DirectTransport(corsFetch());
    const token = await getFreshAccessToken(store, { clientId: googleId, clientSecret: googleSecret, transport });
    const ev = await createEvent(transport, token, {
      summary: msg.summary,
      start: msg.start,
      end: msg.end,
      ...(msg.description ? { description: msg.description } : {}),
      ...(msg.location ? { location: msg.location } : {}),
    });
    post({ type: "eventCreated", requestId: msg.requestId, ok: true, ...(ev.id ? { id: ev.id } : {}) });
  } catch (err) {
    post({ type: "eventCreated", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
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

// Remote bus: shared helper to build a Google transport + fresh token, or undefined when
// Google isn't connected (the host just skips the poll then).
async function googleAuth(): Promise<{ transport: DirectTransport; token: string } | undefined> {
  const store = memoryStore();
  const googleId = settings?.keys?.googleClientId;
  const googleSecret = settings?.keys?.googleClientSecret;
  if (!googleId || !googleSecret || !(await loadGoogleTokens(store))) return undefined;
  const transport = new DirectTransport(corsFetch());
  const token = await getFreshAccessToken(store, { clientId: googleId, clientSecret: googleSecret, transport });
  return { transport, token };
}

async function handleRemoteBusList(msg: Extract<MainToWorker, { type: "remoteBusList" }>): Promise<void> {
  try {
    const auth = await googleAuth();
    if (!auth) {
      post({ type: "remoteBusListed", requestId: msg.requestId, ok: true, commands: [] });
      return;
    }
    const tasks = await listTasks(auth.transport, auth.token, 30);
    post({ type: "remoteBusListed", requestId: msg.requestId, ok: true, commands: busCommands(tasks) });
  } catch (err) {
    post({ type: "remoteBusListed", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleRemoteBusReply(msg: Extract<MainToWorker, { type: "remoteBusReply" }>): Promise<void> {
  try {
    const auth = await googleAuth();
    if (!auth) throw new Error("Google isn't connected.");
    await patchTask(auth.transport, auth.token, msg.id, { status: "completed", notes: formatBusReply(msg.answer) });
    post({ type: "remoteBusReplied", requestId: msg.requestId, ok: true });
  } catch (err) {
    post({ type: "remoteBusReplied", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleReadPage(msg: Extract<MainToWorker, { type: "readPage" }>): Promise<void> {
  try {
    const cf = corsFetch();
    // Reading an arbitrary site is cross-origin; needs the CORS-exempt transport
    // (desktop/extension). On plain web most sites fail — surfaced as a clear error.
    const page = await fetchPageText(msg.url, {
      maxChars: 200_000,
      ...(cf ? { transport: new DirectTransport(cf) } : {}),
    });
    post({ type: "pageRead", requestId: msg.requestId, ok: true, page });
  } catch (err) {
    post({ type: "pageRead", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleStockQuote(msg: Extract<MainToWorker, { type: "stockQuote" }>): Promise<void> {
  try {
    const cf = corsFetch();
    // The keyless quote needs the CORS-exempt transport (desktop/extension); on plain web we
    // return no quote (the chart still embeds). Yahoo's chart endpoint (same source as the
    // analysis indicators) works with the proxy's UA — Stooq blocks it and times out.
    if (!cf) {
      post({ type: "stockQuoted", requestId: msg.requestId, ok: true });
      return;
    }
    const res = await new DirectTransport(cf).send({ url: yahooQuoteUrl(msg.symbol), method: "GET" });
    const quote = parseYahooQuote(await res.json(), msg.symbol);
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

async function handleSchwabPlaceOrder(msg: Extract<MainToWorker, { type: "schwabPlaceOrder" }>): Promise<void> {
  try {
    const clientId = settings?.keys?.schwabClientId;
    const clientSecret = settings?.keys?.schwabClientSecret;
    if (!clientId || !clientSecret) throw new Error("Schwab isn't connected.");
    const store = memoryStore();
    const transport = new DirectTransport(corsFetch());
    const token = await getFreshSchwabToken(store, { clientId, clientSecret, transport });
    const accounts = await schwabAccountNumbers(transport, token);
    const hash = accounts[0]?.hashValue;
    if (!hash) throw new Error("No Schwab account found.");
    const r = await placeSchwabOrder(transport, token, hash, msg.order);
    if (!r.ok) throw new Error(`Schwab rejected the order (HTTP ${r.status}).`);
    post({ type: "schwabOrderPlaced", requestId: msg.requestId, ok: true, status: r.status });
  } catch (err) {
    post({ type: "schwabOrderPlaced", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
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

// In-flight coding-agent runs (so a cancel can abort the LLM loops).
const codingAgentAborts = new Map<number, AbortController>();

/** BuddyDeps a coding agent never legitimately uses (open books / change style / remove books) —
 * throwing stubs satisfy the type; the prompt tells the agent to stick to writing code. */
function codingAgentStubDeps(): Pick<
  BuddyDeps,
  "openLibraryBook" | "openWebText" | "openPastedText" | "removeLibraryBook" | "setVisualStyle"
> {
  const no = async (): Promise<never> => {
    throw new Error("not available to a coding agent");
  };
  return {
    openLibraryBook: no,
    openWebText: no,
    openPastedText: no,
    removeLibraryBook: no,
    setVisualStyle: async () => ({}),
  };
}

/** Run write-capable CODING agents in parallel — each in its own worktree `dir`. Their LLM loops
 * run here; their run_command/write_file execute on the main thread (via runHostToolViaMain) in the
 * agent's worktree. The host (App) created the worktrees and merges them back after this returns. */
async function handleCodingAgents(msg: Extract<MainToWorker, { type: "runCodingAgents" }>): Promise<void> {
  const ac = new AbortController();
  codingAgentAborts.set(msg.requestId, ac);
  try {
    const { llm, imageSearch } = chatProviders();
    if (!supportsChat(llm)) {
      post({ type: "codingAgentsDone", requestId: msg.requestId, results: [], error: "the chat model can't run agents" });
      return;
    }
    const budgets = contextBudgets(llm.id, await localContextTokens(llm.id));
    // Optional worker (e.g. vLLM) model for the agents, leaving the main model free — same routing
    // as read-only sub-agents. A capable coding model is recommended here.
    const sf = corsFetch();
    const subUrl = settings?.subAgentServerUrl?.trim();
    const subModel = settings?.subAgentModel?.trim();
    const agentLlm =
      sf && subUrl && subModel
        ? new LocalServerLLMProvider({ baseUrl: subUrl, model: subModel, transport: new DirectTransport(sf), fetchImpl: sf })
        : llm;
    const deps: BuddyDeps = {
      ...codingAgentStubDeps(),
      ...fileResearchDeps(true), // readFile (find_files/run_command/write_file go via runHostTool)
      searchWeb: (q) => imageSearch.searchWeb(q),
      readUrl: readUrlText(ac.signal),
    };
    const total = msg.agents.length;
    const concurrency = Math.max(1, Math.min(settings?.agentConcurrency ?? 2, total));
    let done = 0;
    const announce = () =>
      post({
        type: "buddyActivity",
        requestId: msg.requestId,
        text:
          done < total
            ? `Coding agents working (${concurrency} at a time)… ${done}/${total} done`
            : `Coding agents finished (${total}/${total}) — merging…`,
      });
    announce();
    const results = await mapWithConcurrency(msg.agents, concurrency, async (agent, idx) => {
      try {
        const out = await runBuddyTurn({
          llm: agentLlm,
          system: buildCodingAgentPrompt({ title: agent.title, instructions: agent.instructions }, agent.dir),
          history: [{ role: "user", content: "Complete your subtask in your worktree, verify it, and report what you changed." }],
          deps,
          runHostTool: (call) => runHostToolViaMain(msg.runId, idx, call, agent.dir),
          maxTokens: budgets.reply,
          signal: ac.signal,
        });
        return { title: agent.title, result: out.text || "(no summary returned)" };
      } catch (e) {
        return { title: agent.title, result: `(agent failed: ${e instanceof Error ? e.message : String(e)})` };
      } finally {
        done++;
        announce();
      }
    });
    post({ type: "codingAgentsDone", requestId: msg.requestId, results });
  } catch (e) {
    post({ type: "codingAgentsDone", requestId: msg.requestId, results: [], error: e instanceof Error ? e.message : String(e) });
  } finally {
    codingAgentAborts.delete(msg.requestId);
  }
}

/** Defensive: strip a leading/trailing ``` fence if the model wrapped the file despite being told
 * not to (keeps the inner content; leaves un-fenced text untouched). */
function unfenceFile(text: string): string {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1]! : text;
}

/** Auto-resolve git merge conflicts with the MAIN model (high-stakes — not a small sub-agent). One
 * bounded pass per file; the host validates (no markers, completes the merge) before committing. */
async function handleResolveConflicts(msg: Extract<MainToWorker, { type: "resolveConflicts" }>): Promise<void> {
  try {
    const { llm } = chatProviders();
    if (!supportsChat(llm)) {
      post({ type: "conflictsResolved", requestId: msg.requestId, files: [], error: "the chat model can't resolve conflicts" });
      return;
    }
    const budgets = contextBudgets(llm.id, await localContextTokens(llm.id));
    const resolved = await mapWithConcurrency(msg.files, 1, async (f) => {
      const reply = await llm.chat(
        [
          { role: "system", content: "You resolve git merge conflicts. Output ONLY the final merged file — no prose, no fences, no conflict markers." },
          {
            role: "user",
            content: buildConflictResolvePrompt({ file: f.file, agentTitle: msg.agentTitle, base: f.base, ours: f.ours, theirs: f.theirs }),
          },
        ],
        { maxTokens: budgets.reply },
      );
      return { file: f.file, content: unfenceFile(reply) };
    });
    post({ type: "conflictsResolved", requestId: msg.requestId, files: resolved });
  } catch (e) {
    post({ type: "conflictsResolved", requestId: msg.requestId, files: [], error: e instanceof Error ? e.message : String(e) });
  }
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
            gmailSearch: makeBuddyGmailSearch(transport, tok),
            readEmail: async (id: string) => gmailReadEmail(transport, await tok(), id),
            readAttachment: makeReadAttachment(transport, tok),
            // Draft an email (auto-run — a draft just lands in Gmail Drafts for the reader to send).
            draftEmail: async (d) => createDraft(transport, await tok(), d),
            listEvents: async (o: { max?: number; timeMin?: string; timeMax?: string }) =>
              listEvents(transport, await tok(), o),
            createEvent: async (ev) => createEvent(transport, await tok(), ev),
            listTasks: async (max?: number) => listTasks(transport, await tok(), max),
            // Create the Google Task AND mirror it as a simple in-app task so it shows in the 📋
            // panel (0 steps → it carries a "Plan it" button to break it down later).
            createTask: async (t) => {
              const item = await createTask(transport, await tok(), t);
              await upsertTaskPlan(
                memoryStore(),
                normalizeTaskPlan({
                  title: t.title,
                  source: { kind: "typed", text: t.title },
                  ...(t.due ? { deadlineIso: t.due } : {}),
                  ...(item.id ? { googleTaskId: item.id } : {}), // link so planning can add sub-tasks under it
                  steps: [],
                }),
              );
              return item;
            },
            // A parent + nested sub-tasks: write them to Google Tasks AND mirror as one in-app
            // plan (parent = the task, sub-tasks = its steps) so both surfaces show the hierarchy.
            addTaskGroup: async (group) => {
              const { parent, subtasks } = await createTaskGroup(transport, await tok(), group);
              const plan = normalizeTaskPlan({
                title: group.title,
                source: { kind: "typed", text: group.title },
                ...(group.due ? { deadlineIso: group.due } : {}),
                ...(parent.id ? { googleTaskId: parent.id } : {}),
                steps: group.subtasks.map((s, i) => ({
                  title: s.title,
                  actor: "user_action",
                  ...(s.due ? { dueIso: s.due } : {}),
                  ...(subtasks[i]?.id ? { googleTaskId: subtasks[i]!.id } : {}),
                })),
              });
              await upsertTaskPlan(memoryStore(), plan);
              return { title: group.title, count: group.subtasks.length };
            },
          };
        })()
      : {};
    const deps: BuddyDeps = {
      ...googleDeps,
      ...fileResearchDeps(),
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
      // MCP servers the reader configured (HTTP/streamable). Resolve a server name → URL and
      // call it over the CORS-exempt transport; undefined name (or no proxy) → no result.
      ...((): Partial<BuddyDeps> => {
        const servers = parseMcpServers(settings?.mcpServers);
        if (servers.length === 0) return {};
        const cf = corsFetch();
        if (!cf) return {}; // both transports (HTTP proxy / stdio spawn) need the desktop/extension shell
        const transport = new DirectTransport(cf);
        const find = (name: string) => servers.find((s) => s.name.toLowerCase() === name.toLowerCase());
        return {
          mcpTools: async (server: string) => {
            const s = find(server);
            if (!s) return undefined;
            if (s.kind === "http") return mcpListTools(transport, s.url, ac.signal);
            const { lines, resultId } = buildStdioExchange("tools/list", {});
            return parseToolsList(pickStdioResult(await mcpStdioExchange(s.command, s.args, lines), resultId));
          },
          mcpCall: async (server: string, toolName: string, args: Record<string, unknown>) => {
            const s = find(server);
            if (!s) return undefined;
            if (s.kind === "http") return mcpCallTool(transport, s.url, toolName, args, ac.signal);
            const { lines, resultId } = buildStdioExchange("tools/call", { name: toolName, arguments: args });
            return parseToolCallText(pickStdioResult(await mcpStdioExchange(s.command, s.args, lines), resultId));
          },
        };
      })(),
      // Keyless stock quotes (Yahoo's chart endpoint, like the indicators below) over the
      // CORS-exempt transport; undefined on plain web (no proxy) so the model falls back to
      // search_web. Yahoo works with the proxy's UA — Stooq blocks it and times out.
      stockQuote: async (symbol: string) => {
        const cf = corsFetch();
        if (!cf) return undefined;
        const res = await new DirectTransport(cf).send({ url: yahooQuoteUrl(symbol), method: "GET" });
        return parseYahooQuote(await res.json(), symbol);
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
          schwabWatchlists: async () => schwabWatchlists(transport, await tok()),
        };
      })()),
      randomBooks: () => books.random(),
      remember: async (n) => (await rememberNote(store, n)).length,
      forget: async (m) => (await forgetNote(store, m)).length,
      readSkill: async (name) => (await touchSkill(store, name))?.body ?? "",
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
      // Capture sub-tasks the reader worked out in chat onto the EXISTING (active) plan, then mirror
      // to Google Tasks. planId defaults to the task this chat is working (msg.taskPlanId).
      addTaskSteps: async ({ planId, steps, replace }) => {
        const id = planId ?? msg.taskPlanId;
        if (!id) return undefined;
        const plan = (await loadTaskPlans(store)).find((p) => p.id === id);
        if (!plan) return undefined;
        let next = applyStepEdits(plan, steps, { ...(replace ? { replace: true } : {}) });
        if (plan.googleTaskId && googleConnected) {
          try {
            const t = new DirectTransport(corsFetch());
            const tk = () => getFreshAccessToken(store, { clientId: googleId!, clientSecret: googleSecret!, transport: t });
            next = await syncPlanToGoogleTasks(next, t, tk);
          } catch {
            /* best-effort — the in-app steps are saved regardless */
          }
        }
        await upsertTaskPlan(store, next);
        return { planTitle: next.title, count: steps.length, replaced: !!replace };
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
        // Web articles carry sanitized HTML so the reader can offer an "original layout" view;
        // fall back to plain text (pasted/keyless) when there's no HTML.
        const book = page.html
          ? bookFromHtml(title, page.text, page.html, call.mode, "Chat buddy")
          : bookFromText(title, page.text, call.mode, "Chat buddy");
        return opened(book, call.visuals);
      },
      openPastedText: async (call) =>
        opened(bookFromText(call.title, call.text, call.mode, "Pasted in chat"), call.visuals),
      openCode: async (call) =>
        opened(bookFromCode(call.title, call.code, call.language, "Code in chat"), call.visuals),
      createSpreadsheet: async (call) => {
        // Build the typed table from the spec, then open it as a TECHNICAL data book
        // (the pipe-text is what the pipeline reads; `data` powers the grid + chat tools).
        const table = recalcTable(createDataTable(call.columns, call.rows ?? []));
        const text = tableToText(table, table.rows.length) || call.title;
        const book = bookFromText(call.title || "Spreadsheet", text, "technical", "Generated in chat");
        return opened({ ...book, data: table }, false);
      },
      // Story "as you go": create the story book from the opening beat and open it (the
      // normal `opened` path → the host opens it, the worker rebuilds the engine with the
      // active-scene hook, beat one extracts + illustrates). worldStyle/style is applied
      // to the worker's settings so the open renders in the chosen look.
      startStory: async (call) => {
        const id = `story-${storyCounter++}-${(call.title || "story").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}`;
        const played = [call.roleplay?.you, call.roleplay?.me].filter((n): n is string => !!n);
        // Apply the requested art style to the worker's settings immediately, so the open's
        // providers render in it (mirrors set_visual_style's worker-settings update).
        if (call.style && settings) {
          const styleId = resolveStyleRequest(call.style);
          if (styleId) settings = { ...settings, imageStyle: styleId };
          post({
            type: "buddySettings",
            requestId: msg.requestId,
            ...(styleId ? { style: { id: styleId, label: getImageStyle(styleId).label } } : {}),
          });
        }
        story = {
          bookId: id,
          title: call.title || "Our Story",
          author: "Story with the chat buddy",
          beats: [call.opening],
          scene: emptyStoryScene(),
          ...(played.length ? { roleplay: { playedCharacterNames: played } } : {}),
          cadence: { mode: "per-response", n: 3 },
          beatsSinceImage: 0,
        };
        // Pre-seed the named cast (start_story `characters` + the role-played pair) into the
        // bible BEFORE the open, so the active-scene tracker resolves + keeps them present
        // from beat one even if the opening prose doesn't name them — closing the "setting-
        // only opening" gap. A cast entry's `description` seeds its LOOK (persistentTraits) so
        // the first image isn't arbitrary (e.g. the reader's remembered appearance in a "me and
        // you" story). Extraction UPSERTS by name on the first beat that describes them,
        // enriching this same entry (no duplicate). Written to the shared store so openBook
        // restores it. The played pair is added (name-only) when not already in `characters`.
        const seedCast: { name: string; description?: string }[] = [...(call.characters ?? []), ...played.map((name) => ({ name }))];
        const seen = new Set<string>();
        const cast = seedCast.filter((c) => {
          const k = c.name.trim().toLowerCase();
          if (!k || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        if (cast.length) {
          await store.putBible({
            ...createEmptyBible(id),
            characters: cast.map((c) => ({
              id: `char-${storySlug(c.name)}`,
              name: c.name.trim(),
              aliases: [],
              appearance: emptyAppearance(),
              persistentTraits: c.description ? [c.description] : [],
              clothing: [],
              anchor: { seed: deterministicSeed(c.name) },
              firstSeenChapter: 0,
            })),
          });
        }
        // Persist role-play + cadence ON the book (storyConfig) so a reopen resumes them.
        const book = { ...storyBook(id, story.title, story.author, story.beats), storyConfig: storyConfigOf(story) };
        return opened(book, true); // visuals on → beat one illustrates
      },
      // Append the next beat to the OPEN story. Stays IN the worker (no re-open): grows the
      // book, calls engine.appendChapter (extracts only the new span, fires the active-scene
      // hook, renders per the cadence), and posts a `storyBeat` so the host grows the reader
      // WITHOUT re-opening (which would dispose + rebuild the engine, undoing the append).
      continueStory: async (call) => {
        if (!story || !engine || currentBook?.kind !== "story") {
          throw new Error("no story is open — start one with start_story first");
        }
        story.beats.push(call.text);
        // Cadence: decide whether THIS beat auto-illustrates.
        let illustrate = true;
        if (story.cadence.mode === "manual") illustrate = false;
        else if (story.cadence.mode === "every-n") {
          story.beatsSinceImage += 1;
          illustrate = story.beatsSinceImage >= story.cadence.n;
        }
        if (illustrate) story.beatsSinceImage = 0;
        const book = { ...storyBook(story.bookId, story.title, story.author, story.beats), storyConfig: storyConfigOf(story) };
        const renderBook = toRenderUnits(book, "chapter").book;
        const { firstNewUnit } = await engine.appendChapter(renderBook, { illustrate });
        currentBook = book; // keep the chat's book context current
        post({ type: "storyBeat", requestId: msg.requestId, book, firstNewUnit, illustrate });
        return {
          title: book.title,
          chapters: book.chapters.length,
          pages: book.pages.length,
          visuals: illustrate,
          beats: story.beats.length,
          illustrated: illustrate,
        };
      },
      // Illustrate beats [from..to] of the open story on demand (1-based beat numbers →
      // 0-based units; default = the most recent beat).
      renderScene: async (call) => {
        if (!story || !engine) throw new Error("no story is open to illustrate");
        const last = story.beats.length;
        const from = call.from ?? last;
        const to = call.to ?? from;
        const lo = Math.max(1, Math.min(from, to)) - 1;
        const hi = Math.min(last, Math.max(from, to)) - 1;
        await engine.renderScene(lo, hi);
        return { rendered: hi - lo + 1, from: lo + 1, to: hi + 1 };
      },
      setStoryCadence: async (call) => {
        if (!story) throw new Error("no story is open");
        story.cadence = { mode: call.mode, n: call.n ?? story.cadence.n };
        if (call.mode === "per-response") story.beatsSinceImage = 0;
        // Persist the new cadence immediately (no new beat) so it survives a reopen: patch the
        // open book's storyConfig and hand it to the host to setBook + putBook.
        if (currentBook?.kind === "story" && currentBook.id === story.bookId) {
          currentBook = { ...currentBook, storyConfig: storyConfigOf(story) };
          post({ type: "storyConfig", requestId: msg.requestId, book: currentBook });
        }
        return { mode: story.cadence.mode, ...(story.cadence.mode === "every-n" ? { n: story.cadence.n } : {}) };
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
        slash.call.tool === "write_file" ||
        slash.call.tool === "screenshot" ||
        slash.call.tool === "plan_task" ||
        slash.call.tool === "prep_order" ||
        slash.call.tool === "tv_chart" ||
        slash.call.tool === "delegate" ||
        slash.call.tool === "send_email" ||
        slash.call.tool === "spawn_coding_agents"
      ) {
        post({ type: "buddyDone", requestId: msg.requestId, text: "", transcript: [], pendingTool: slash.call });
        return;
      }
      if (slash.call.tool === "spawn_agents") {
        // Parallel fan-out only makes sense inside an LLM turn (the model writes the subtasks) — not
        // as a one-shot slash command, which has no runSubAgents orchestration here.
        post({ type: "buddyDone", requestId: msg.requestId, text: "Ask me in chat to split the work — I'll fan it out to parallel sub-agents.", transcript: [] });
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
    await seedStarterSkills(store); // one-time: ship a few ready-made playbooks on a fresh install
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
        // Autonomous workspace: write_file + run_command run without a per-action click.
        ...(corsProxyAvailable && settings?.allowCommands && settings?.autonomousWorkspace
          ? { canAutonomousWorkspace: true }
          : {}),
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
        // TradingView Desktop bridge when enabled (desktop + opt-in).
        ...(corsProxyAvailable && settings?.allowTradingViewBridge ? { canTvBridge: true } : {}),
        // MCP servers the reader configured (advertise their tools), when a proxy can reach them.
        ...(corsProxyAvailable && parseMcpServers(settings?.mcpServers).length > 0
          ? { mcpServers: parseMcpServers(settings?.mcpServers).map((s) => s.name) }
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
      ...(chatReasoningEffort(settings) ? { reasoningEffort: chatReasoningEffort(settings)! } : {}),
      deps,
      // PARALLEL SUB-AGENTS: the model's `spawn_agents` tool fans independent read-only subtasks out
      // concurrently. Capped by `agentConcurrency` (default 2). TIER ROUTING: when a sub-agent
      // endpoint is configured (e.g. a vLLM server running a small fast model), sub-agents run on
      // THAT "worker" model — leaving the main model for the hard reasoning — which is what lets one
      // GPU do real parallel sub-agent work behind a batching server. Falls back to the main model
      // when unset OR if the worker endpoint errors (so a down server degrades, never breaks).
      runSubAgents: (tasks) => {
        const sf = corsFetch();
        const subUrl = settings?.subAgentServerUrl?.trim();
        const subModel = settings?.subAgentModel?.trim();
        const workerLlm =
          sf && subUrl && subModel
            ? new LocalServerLLMProvider({ baseUrl: subUrl, model: subModel, transport: new DirectTransport(sf), fetchImpl: sf })
            : undefined;
        const runOne = (useLlm: typeof llm | LocalServerLLMProvider, task: string) =>
          runBuddyTurn({
            llm: useLlm,
            system: buildDelegatePrompt(task),
            history: [{ role: "user", content: "Complete the subtask above and report back concisely." }],
            deps, // read-only by instruction; no runSubAgents ⇒ no nested fan-out
            maxTokens: budgets.reply,
            signal: ac.signal,
          });
        // LIVE STATUS: parallel sub-agents are invisible (they don't stream into the chat), so report
        // progress on the buddy-activity line — which tier is running them and how many have finished.
        const total = tasks.length;
        const tier = workerLlm ? `worker model (${subModel})` : "main model";
        const concurrency = Math.max(1, Math.min(settings?.agentConcurrency ?? 2, total));
        let done = 0;
        const announce = () =>
          post({
            type: "buddyActivity",
            requestId: msg.requestId,
            text:
              done < total
                ? `Running ${total} sub-agents on the ${tier} (${concurrency} at a time)… ${done}/${total} done`
                : `Sub-agents finished (${total}/${total}) — synthesizing…`,
          });
        announce();
        return mapWithConcurrency(tasks, settings?.agentConcurrency ?? 2, async (task) => {
          try {
            const sub = await runOne(workerLlm ?? llm, task);
            return { task, result: sub.text || "(the sub-agent returned nothing usable)" };
          } catch (e) {
            // Worker endpoint unreachable? fall back to the main model once before giving up.
            if (workerLlm) {
              try {
                const sub = await runOne(llm, task);
                return { task, result: sub.text || "(the sub-agent returned nothing usable)" };
              } catch {
                /* fall through to the error */
              }
            }
            return { task, result: `(sub-agent failed: ${e instanceof Error ? e.message : String(e)})` };
          } finally {
            done++;
            announce();
          }
        });
      },
      onEvent: (e) => {
        if (e.kind === "token") post({ type: "buddyToken", requestId: msg.requestId, text: e.text });
        else if (e.kind === "thinking") thinking(e.text);
        else if (e.kind === "activity") post({ type: "buddyActivity", requestId: msg.requestId, text: e.text });
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
            ...(e.result.openedImage ? { openedImage: e.result.openedImage } : {}),
            ...(e.result.error ? { error: e.result.error } : {}),
          });
      },
      signal: ac.signal,
    }));
    // Self-improving skills (opt-in): after a substantive, USER-initiated multi-step turn,
    // record the task; only when a SIMILAR task has RECURRED (so a playbook will actually pay
    // off next time) distil a candidate skill and OFFER it for the reader to keep — never saved
    // silently, never a near-duplicate. A failed reflection never breaks the turn.
    const isUserGoal = !!msg.userText && !msg.userText.startsWith("[");
    if (!outcome.pendingTool && settings?.autoLearnSkills && worthLearning(outcome.toolResults) && isUserGoal) {
      try {
        const recurred = taskRecurred(await loadTaskHistory(store), msg.userText);
        await recordTask(store, msg.userText);
        if (recurred) {
          post({ type: "buddyThinking", requestId: msg.requestId, text: "Reflecting on what I learned…" });
          const candidate = await runSkillProposal(llm, { goal: msg.userText, transcript: outcome.transcript, signal: ac.signal });
          if (candidate && !isDuplicateSkill(candidate, await loadSkills(store))) {
            post({ type: "buddySkillProposed", requestId: msg.requestId, skill: candidate });
          }
        }
      } catch {
        // Reflection is best-effort — skip silently on any failure.
      }
    }
    post({
      type: "buddyDone",
      requestId: msg.requestId,
      text: outcome.text,
      transcript: outcome.transcript,
      ...(outcome.pendingTool ? { pendingTool: outcome.pendingTool } : {}),
      ...(outcome.thinking ? { thinking: outcome.thinking } : {}),
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
  // Register an abort controller under THIS render's requestId so the Stop button (chatCancel)
  // can interrupt the ComfyUI render — without this the image kept rendering after Stop.
  const ac = new AbortController();
  chatAborts.set(requestId, ac);
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
      if (resolved) {
        cs = { ...cs, localModel: resolved };
      } else if (!cs.localModel) {
        // Nothing configured to fall back to — surface the miss so the reader can pick a model.
        throw new Error(
          `no installed image model matches "${call.model}"` +
            (installed.length
              ? ` — installed: ${installed.join(", ")}`
              : " — the local engine lists no models (is it running and connected in Settings?)"),
        );
      } else {
        // The named model didn't resolve — usually the CHAT model invented or mis-spelled a
        // filename (e.g. a ".saftextensors" typo, or the wrong family entirely). Don't dead-end
        // the render: fall back to the model the reader already selected in Settings, so "generate
        // an apple" still works with their chosen model instead of failing.
        console.info(
          `[visual-reader] generate_image model "${call.model}" matched no installed model — ` +
            `using the configured local model "${cs.localModel}" instead.`,
        );
      }
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
    cancelChatWarm(); // don't let a pending LLM warm steal VRAM from this render
    const out = await renderFromText(image, tier, call.prompt, {
      ...(call.steps ? { stepsOverride: call.steps } : {}),
      ...(call.highRes ? { hires: true } : {}),
      signal: ac.signal,
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
  } catch (err) {
    // A user Stop aborts the render — report it as a clean cancellation, not a scary error.
    const aborted = ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
    post({
      type: "chatToolResult",
      requestId,
      call,
      error: aborted ? "Image generation stopped." : err instanceof Error ? err.message : String(err),
    });
  } finally {
    chatAborts.delete(requestId);
    warmChatModel(); // (debounced) reload + restore the LLM if we freed it — even on failure.
  }
}

/** The local engine's installed model names (checkpoints + diffusion models), or []. */
async function installedModelNames(s: ReaderSettings): Promise<string[]> {
  const baseUrl = s.engineBaseUrl ?? s.localServerUrl;
  if (!baseUrl) return [];
  try {
    const backend =
      (s.engineBackend ?? s.localBackend) === "a1111"
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
  story = undefined; // a reopen rebuilds it from the book
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
  // Opening a book means the engine's bible-build will need the LLM — relaunch it if a prior image
  // session had freed it (otherwise extraction would hit a stopped server).
  await restoreChatLlm();
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
      // Story "as you go": illustrate as each beat (chapter) is read — the first image
      // appears right after beat one, not after the whole "book". Ordinary books keep the
      // user's setting (default whole-book for the best art).
      illustrateAfter: book.kind === "story" ? "chapter" : (settings.illustrateAfter ?? "book"),
      // Story active-scene hook (no-op for ordinary books): pin the tracked present cast +
      // location per beat so terse beats still illustrate the right scene.
      onChapterExtracted: storyPresentFor,
    });
    // A story renders ONE image per beat (chapter), independent of the global pages-per-image
    // cadence; ordinary books use the chosen granularity. The UI maps the reader's position to
    // the same units via toRenderUnits, so the two never drift.
    const grouping = book.kind === "story" ? ("chapter" as const) : (settings.pagesPerImage ?? 3);
    const renderBook = toRenderUnits(book, grouping).book;
    // A reopen (fresh worker / library reopen) has no matching live `story` — reconstruct it
    // from the book so continue_story keeps the right cast/place. A live start_story already
    // set `story` (matching id, with role-play/cadence + an empty scene the hook advances), so
    // leave it untouched.
    const reopenedStory = book.kind === "story" && (!story || story.bookId !== book.id);
    if (reopenedStory) story = rebuildStoryFromBook(book, undefined);
    // Loads the book + restores cached bible/images, but does NOT generate. The
    // user triggers generation via the "start" message ("Begin generating book").
    await engine.openBook(renderBook);
    // On a reopen, replay the active scene from the beats against the now-restored cached
    // bible so a post-reopen append carries the correct cast forward. (No-op for live starts.)
    if (reopenedStory && engine.getBible()) story = rebuildStoryFromBook(book, engine.getBible());
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
