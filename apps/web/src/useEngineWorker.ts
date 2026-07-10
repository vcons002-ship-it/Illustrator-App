import { useCallback, useEffect, useRef, useState } from "react";
import {
  base64ToBytes,
  bytesToBase64,
  decodeFrame,
  deserializeFromRemote,
  encodeFrame,
  isAppSyncMessage,
  isLocalOnlyMessage,
  parseLinkToken,
  serializeForRemote,
  type RemoteMode,
} from "@visual-reader/core";
import type {
  BookPassage,
  BookSearchHit,
  BookSource,
  BookSummary,
  BuddyPersona,
  BuddyPlan,
  BuddyToolCall,
  BuddyToolResultPayload,
  CharacterPatch,
  ChatTurn,
  CreatedFileRef,
  ContextUsage,
  ImageResult,
  AnalyzeChart,
  DataTable,
  ImageSearchHit,
  CalendarEvent,
  StockQuote,
  PageText,
  BusCommand,
  Indicators,
  ImportStats,
  PolishMode,
  TaskCandidate,
  TaskPlan,
  TaskSource,
  ToolCall,
  VideoModelFiles,
  VideoRenderParams,
  VisualBible,
  WebSearchHit,
} from "@visual-reader/core";
import { planRetention } from "@visual-reader/core";
import {
  identitySettingsKey,
  tuningSettingsKey,
  type DisplayResult,
  type LocalBackendId,
  type ProvidersDiagnostics,
  type ReaderSettings,
} from "@visual-reader/ui";

export interface ImportResult {
  ok: boolean;
  stats?: ImportStats;
  error?: string;
}
import type { MainToWorker, WorkerToMain } from "./worker-protocol.js";
import type { AppSyncMessage, EngineVram } from "./remote-sync.js";
import {
  desktopHttpFetch,
  mcpStdioExchange,
  isDesktop,
  searchLocalFiles,
  readLocalFile,
  stopLocalLlm,
  ensureLocalLlm,
} from "./runtime.js";
import { pdfToText } from "./import-file.js";

/**
 * Resolve PHONE-CLIENT mode for this tab. A `vrlink=<token>` in the URL means "drive a remote desktop
 * over the relay." The token can arrive in the QUERY (`?vrlink=`, the internet/tunnel link) or the
 * HASH (`#vrlink=`, the LAN link); the query is used over a tunnel because a Cloudflare Access login
 * redirect drops a `#fragment` but preserves the query. The token is PERSISTED per-host in
 * localStorage, so a saved BARE link (`https://host/`, no token) keeps working afterward; with no
 * token in the URL, the saved one for this host is reused. A query token is scrubbed from the address
 * bar so it isn't left in history / re-shared. ws:// (LAN/http) vs wss:// (tunnel/https) is derived
 * from the page protocol. Undefined on a normal desktop/web load (no token anywhere).
 */
/** Worker requestIds minted by a linked PHONE start here, so they can never collide with the desktop's
 * own (which count from 1) in the shared worker's routing tables (H2). Also the marker the host-bridge
 * mirror uses to tell a phone-owned reply from a desktop-owned one (H5). */
const PHONE_REQUEST_ID_BASE = 1_000_000_000;

function initRemoteMode(): RemoteMode | undefined {
  if (typeof window === "undefined") return undefined;
  const { hash, search, host, protocol, pathname } = window.location;
  const key = `vr-link-token:${host}`;
  // Hash first (LAN), then query (tunnel/Access). One of them, or the remembered one for this host.
  let token = parseLinkToken(hash) ?? parseLinkToken(search) ?? undefined;
  const fromQuery = !parseLinkToken(hash) && !!parseLinkToken(search);
  const fromUrl = !!token;
  // Persist the token so a saved BARE link (no token in the URL) keeps working. Write to BOTH stores
  // and recover from EITHER: a heavy session can exhaust the localStorage quota (cached generated
  // images), and a failed write there used to silently drop the phone back to a local app on the next
  // load. sessionStorage has its own quota and survives an in-tab reload, so it's a reliable fallback.
  let persisted = false;
  try {
    if (token) {
      localStorage.setItem(key, token);
      persisted = true;
    } else {
      token = localStorage.getItem(key) ?? undefined;
    }
  } catch {
    /* localStorage full/blocked — the sessionStorage attempt below still carries the token */
  }
  try {
    if (token) {
      sessionStorage.setItem(key, token);
      persisted = true;
    } else {
      token = sessionStorage.getItem(key) ?? undefined;
    }
  } catch {
    /* sessionStorage blocked — fall back to whatever the URL gave us */
  }
  if (!token || !host) return undefined;
  // This tab IS a linked phone. Ask the browser to keep this origin's storage from being EVICTED
  // under pressure: heavy generated-image caching can fill the quota and evict the saved pairing
  // token, which silently drops the phone back to a local app (the "stopped linking after a bunch of
  // image generations" failure). Best-effort and async — ignored where unsupported.
  try {
    void (navigator as Navigator & { storage?: { persist?: () => Promise<boolean> } }).storage?.persist?.();
  } catch {
    /* Storage API unsupported — harmless */
  }
  // Drop the ?vrlink= token from the visible URL ONLY once it's safely remembered — otherwise a later
  // reload (e.g. after a software update, or a PWA relaunch) would have neither the URL token nor a
  // stored one, and the phone would fall back to a local app. If nowhere would persist it, keep it in
  // the URL so a reload can still recover it.
  if (fromQuery && fromUrl && persisted) {
    try {
      window.history.replaceState(null, "", (pathname || "/") + (hash || ""));
    } catch {
      /* history not available — harmless */
    }
  }
  const scheme = protocol === "https:" ? "wss" : "ws";
  return { wsUrl: `${scheme}://${host}/`, token };
}

/** Best-effort image mime from a filename extension (for the buddy's open_image bubble). */
function imageMimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "webp" ? "image/webp"
    : ext === "gif" ? "image/gif"
    : ext === "svg" ? "image/svg+xml"
    : ext === "bmp" ? "image/bmp"
    : "image/png";
}

/**
 * How long the chat may stay COMPLETELY silent (no token, reasoning, tool, or status
 * event) before we assume the worker is wedged (stale dev/HMR) and surface an error.
 * It is reset by every stream event, so a long-but-progressing answer never trips it —
 * the Stop button, not a timer, is how a reader interrupts a working model.
 */
const CHAT_SILENCE_MS = 120_000;

/**
 * Owns the engine Web Worker and surfaces its state to React. The worker does
 * all extraction + rendering; this hook just relays messages and keeps a copy
 * of the latest results so the UI re-renders. Changing settings re-opens the
 * current book so new keys/tier take effect immediately.
 */
export interface EngineWorkerApi {
  bible: VisualBible | undefined;
  results: Map<number, DisplayResult>;
  status: string;
  /** Persistent Visual-Bible line (building… / complete · model), separate from `status`. */
  bibleStatus: string;
  /** Structured chapter/prompt progress (for the always-visible workflow bar). */
  workflow: { bibleDone: number; bibleTotal: number; promptsDone: number; promptsTotal: number };
  /** Rolling average ms per rendered image (0 until measured), for ETAs. */
  avgRenderMs: number;
  /** Which providers are live vs. silent mock fallbacks (undefined until first init). */
  providers: ProvidersDiagnostics | undefined;
  /** Live GPU VRAM from the local ComfyUI engine (undefined when there's no local engine). */
  vram: EngineVram | undefined;
  /** Whether generation has been started for the current book. */
  generating: boolean;
  /** Independent pause state for the bible build vs. image rendering. */
  paused: { bible: boolean; images: boolean };
  openBook: (book: BookSource) => void;
  /** Exit the current book back to the landing page (disposes the worker engine). */
  closeBook: () => void;
  /** Push edited spreadsheet table(s) so the chat's analyze_data sees grid edits. */
  updateBookData: (patch: { data?: DataTable; dataSheets?: { name: string; table: DataTable }[] }) => void;
  startGeneration: () => void;
  pause: () => void;
  resume: () => void;
  /** Pause/resume the Visual Bible build alone (frees the GPU for images). */
  pauseBible: () => void;
  resumeBible: () => void;
  /** Pause/resume image rendering alone (frees the GPU for the bible build). */
  pauseImages: () => void;
  resumeImages: () => void;
  regenerateStoryboard: () => void;
  /** Story header controls (no model round). */
  storySetCadence: (mode: "per-response" | "every-n" | "manual", n?: number) => void;
  storyRenderLatest: () => void;
  storySetMode: (mode: "direct" | "roleplay") => void;
  regenerateAllImages: () => void;
  regenerateImage: (unitIndex: number) => void;
  /** Fill gaps (missing prompts + failed/un-rendered units); finished images are kept. */
  completeBook: () => void;
  /** Discard stored illustration prompts and rebuild them (LLM); images kept. */
  rebuildPrompts: () => void;
  /** Save a user correction to a character (persisted; existing images unchanged). */
  updateCharacter: (characterId: string, patch: CharacterPatch) => void;
  /** Add a user-uploaded IP-Adapter reference image (multi-view, capped per character). */
  addCharacterReference: (characterId: string, image: { bytes: ArrayBuffer; mimeType: string }) => void;
  /** Remove one of a character's reference images (deletes its stored bytes). */
  removeCharacterReference: (characterId: string, refId: string) => void;
  /** Fetch a reference image's bytes for a thumbnail (undefined when missing). */
  getCharacterReference: (refId: string) => Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined>;
  /** Download the current Visual Bible (+ AI rules) as a JSON file. */
  exportBible: () => void;
  /** Import a Visual Bible JSON onto the current book. */
  importBible: (json: string) => void;
  /** Series continuity: carry a prior book's bible into the current book. */
  carryOverBible: (fromBookId: string) => void;
  /** Result of the last import (success stats or an error), or undefined. */
  importResult: ImportResult | undefined;
  /** Clear the last import result (e.g. on closing the import dialog). */
  clearImportResult: () => void;
  /** Tell the engine which unit the reader is on so memory windowing can keep that
   * region's images resident and drop far ones (a long-book RAM bound; no-op otherwise). */
  setActiveUnit: (unit: number) => void;
  /** Repaint from a unit to the end with current settings (earlier units kept). */
  paintForward: (fromUnit: number) => void;
  /** Playground: render ONE image from text (optionally img2img from a base photo). */
  testRender: (
    text: string,
    opts?: {
      initImage?: { bytes: ArrayBuffer; mimeType: string };
      denoise?: number;
      size?: { width: number; height: number };
      onProgress?: (fraction: number) => void;
    },
  ) => Promise<TestRenderResult>;
  /** Reading-companion chat: one user message (streams via `onEvent`). */
  chat: (
    history: ChatTurn[],
    userText: string,
    position: { pageIndex: number; paragraphIndex: number },
    allowSpoilers: boolean,
    onEvent: (e: ChatStreamEvent) => void,
  ) => Promise<ChatDoneResult>;
  /** Run a user-approved generate_image tool call. */
  chatTool: (call: ToolCall, opts?: { onProgress?: (fraction: number) => void }) => Promise<ChatToolRender>;
  /** Run an approved generate_video call: the host resolves the source image bytes + model files. */
  chatVideo: (
    call: Extract<BuddyToolCall, { tool: "generate_video" }>,
    image: { bytes: ArrayBuffer; mimeType: string } | undefined,
    models: VideoModelFiles,
    params: VideoRenderParams | undefined,
    opts?: { onProgress?: (fraction: number) => void; warmBatch?: boolean; keepResident?: boolean; endImage?: { bytes: ArrayBuffer; mimeType: string } },
  ) => Promise<ChatToolRender>;
  /** Push a just-resolved engine URL (+ which backend it speaks) to the worker RIGHT NOW (race-free,
   * ahead of the debounced settings sync) so the next STANDALONE render — which rebuilds providers fresh
   * from settings — uses it. Used by the low-VRAM deferred-engine-start path (ComfyUI or AUTOMATIC1111). */
  applyEngineConfig: (baseUrl: string, backend?: LocalBackendId) => void;
  /** Update the worker's list of workspace files the assistant wrote this session, so it injects a terse
   * reminder into the buddy prompt (the model stays aware of what it made + can read_file before editing). */
  setFileLedger: (files: CreatedFileRef[]) => void;
  /** Update the worker's workspace project-guide text (AGENTS.md / CONVENTIONS.md) injected each turn. */
  setProjectGuide: (text: string) => void;
  /** Set/clear the document the reader is viewing so the buddy can discuss + revise it (uploaded docs). */
  setActiveDocument: (doc?: { title: string; content: string }) => void;
  /** Have the chat's vision model describe a captured screenshot. */
  assessImage: (
    image: { bytes: ArrayBuffer; mimeType: string },
    question?: string,
  ) => Promise<{ text?: string; error?: string }>;
  /** Send a user-approved email from the connected Google account. */
  sendBuddyEmail: (
    call: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] },
  ) => Promise<{ id?: string; error?: string }>;
  /** Run write-capable coding agents in parallel (each in its worktree `dir`); `onAgentTool`
   * executes one agent's host tool on the main thread in that dir. */
  runCodingAgents: (
    runId: string,
    agents: { title: string; instructions: string; dir: string }[],
    onAgentTool: (call: BuddyToolCall, cwd: string, agentIdx: number) => Promise<BuddyToolResultPayload>,
    onProgress?: (text: string) => void,
  ) => Promise<{ results?: { title: string; result: string }[]; error?: string }>;
  /** Auto-resolve git merge conflicts on the main model — returns the merged content per file
   * (the caller validates + completes the merge). */
  resolveConflicts: (
    agentTitle: string,
    files: { file: string; base: string; ours: string; theirs: string }[],
  ) => Promise<{ files?: { file: string; content: string }[]; error?: string }>;
  /** Abort the in-flight chat round, if any. */
  chatCancel: () => void;
  /** Force-load the local chat model now (image renders evict it to free the GPU). */
  warmLlm: () => void;
  /** Landing-page buddy: one user message (no book open; streams via `onEvent`). */
  buddyChat: (
    history: ChatTurn[],
    userText: string,
    persona: BuddyPersona,
    library: BookSummary[],
    onEvent: (e: BuddyStreamEvent) => void,
    workingDir?: string,
    taskPlanId?: string,
    currentCodeFile?: { name: string; title: string; language?: string },
    plan?: BuddyPlan,
    appManagedSteps?: boolean,
  ) => Promise<BuddyDoneResult>;
  /** Abort the in-flight buddy round, if any. */
  buddyCancel: () => void;
  /** Compact a chat: summarize the model-facing turns into a continuation brief. */
  summarize: (turns: ChatTurn[]) => Promise<{ text?: string; error?: string }>;
  /** Finish Google OAuth in the worker (exchange the consent code for tokens). */
  googleConnect: (args: { code: string; redirectUri: string; codeVerifier: string }) => Promise<{ ok: boolean; email?: string; error?: string }>;
  /** Exchange a pasted Schwab consent code for tokens (manual connect). */
  schwabConnect: (args: { code: string; redirectUri: string }) => Promise<{ ok: boolean; error?: string }>;
  /** Place a reviewed order via Schwab (called only from the order-review modal). */
  schwabPlaceOrder: (order: Record<string, unknown>) => Promise<{ ok: boolean; status?: number; error?: string }>;
  /** Research + plan a task into a persisted TaskPlan (progress streamed via onProgress). */
  planTask: (args: { source: TaskSource; sourceText: string; planId?: string; allowFiles?: boolean; timeoutMs?: number; onProgress?: (phase: string, note?: string) => void }) => Promise<{ ok: boolean; plan?: TaskPlan; error?: string }>;
  /** Idle scan: actionable email/calendar items as task candidates. */
  scanInbox: () => Promise<{ ok: boolean; candidates?: TaskCandidate[]; error?: string }>;
  /** Mirror existing Google Tasks into the app's task list; resolves with how many were imported. */
  importGoogleTasks: () => Promise<{ ok: boolean; imported?: number; edited?: number; mirrored?: number; error?: string }>;
  /** Create a bare Google Task (parent) for a surfaced stub; resolves with its id when connected. */
  createGoogleTask: (args: { title: string; notes?: string; due?: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  /** Create a Google Calendar event (manual "+ Add event"); resolves with its id when connected. */
  createEvent: (args: { summary: string; start: string; end: string; description?: string; location?: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  /** Load events across all Google calendars in a window (the calendar grid). */
  loadCalendar: (timeMin: string, timeMax: string) => Promise<{ ok: boolean; events?: CalendarEvent[]; error?: string }>;
  /** Fetch a keyless stock quote (Stooq via the CORS-exempt transport). */
  stockQuote: (symbol: string) => Promise<{ ok: boolean; quote?: StockQuote }>;
  /** Fetch a URL's readable text + on-page links for the in-app browser. */
  readPage: (url: string) => Promise<{ ok: boolean; page?: PageText; error?: string }>;
  /** Remote bus: list pending "VR:" Google-Task commands; write an answer back + complete one. */
  remoteBusList: () => Promise<{ ok: boolean; commands?: BusCommand[] }>;
  remoteBusReply: (id: string, answer: string) => Promise<{ ok: boolean; error?: string }>;
  /** LAN phone link: bridge this desktop's engine worker to the relay (start/stop with the link).
   * `onOpen` fires on every (re)connect — used to re-push a snapshot so a waiting phone re-populates. */
  startHostBridge: (wsUrl: string, token: string, onOpen?: () => void) => void;
  stopHostBridge: () => void;
  /** True when THIS tab is a phone client driving a remote desktop (opened via a #vrlink). */
  isRemoteClient: boolean;
  /** Register the handler for app-state mirror frames (library/book/bible/settings + commands). */
  setAppSyncHandler: (fn: (msg: AppSyncMessage) => void) => void;
  /** Send an app-state mirror frame to the other side of the link (phone⇄desktop). */
  sendAppSync: (msg: AppSyncMessage) => void;
  /** Apply a synced visual bible (a linked phone rendering the desktop's open book). */
  setBible: (bible: VisualBible | undefined) => void;
  /** Fetch keyless technical indicators (VWAP/MA/RSI/recent-move) for a symbol. */
  marketIndicators: (symbol: string, interval?: string, range?: string) => Promise<{ ok: boolean; indicators?: Indicators }>;
  /** Run one document-polish stage; returns the requestId (for cancel) + the result. */
  polishText: (args: {
    stage: "understand" | "produce";
    mode?: PolishMode;
    freeText: string;
    source: string;
    confirmedPlan?: string;
    onToken?: (delta: string) => void;
  }) => { requestId: number; result: Promise<PolishResult> };
  /** Cancel an in-flight polish stage by its requestId. */
  polishCancel: (requestId: number) => void;
}

export type BuddyStreamEvent =
  | { kind: "token"; text: string }
  /** A thinking model's live reasoning text (shown dimmed while it works). */
  | { kind: "thinking"; text: string }
  /** Live status while the model works invisibly (thinking-model reasoning). */
  | { kind: "activity"; text: string }
  | { kind: "tool"; call: BuddyToolCall }
  | {
      kind: "toolResult";
      call: BuddyToolCall;
      hits?: WebSearchHit[];
      books?: BookSearchHit[];
      imageHits?: ImageSearchHit[];
      applied?: { style?: string; pagesPerImage?: number | "chapter"; illustrateAfter?: "chapter" | "book" };
      removed?: string;
      calc?: { expression: string; result: string };
      wolfram?: { query: string; answer: string };
      memory?: { action: "remembered" | "forgot"; note: string; count: number };
      /** open_image outcome — the picture's bytes (base64) so the app shows it inline in chat. */
      openedImage?: { name: string; mimeType: string; base64: string; observation?: string };
      error?: string;
    }
  /** A buddy tool opened a book — the app should open it (and start visuals). */
  | { kind: "opened"; book: BookSource; visuals: boolean }
  /** Story "as you go": a beat grew the open story IN the worker — the app applies the grown
   * book (setBook + putBook, NOT a re-open) and scrolls to the new beat. */
  | { kind: "storyBeat"; book: BookSource; firstNewUnit: number; illustrate: boolean }
  /** Story config changed (cadence/role-play) — persist the book's storyConfig, no scroll. */
  | { kind: "storyConfig"; book: BookSource }
  /** create_document made a real document — the app shows a downloadable file card (PDF/Word/
   * Markdown) + side reader, saves the source to the workspace, and caches it for phone download. */
  | { kind: "documentCreated"; id: string; title: string; content: string; path: string; format?: "pdf" | "docx" | "md" | "html" }
  /** The buddy updated its working checklist (set_plan/complete_step) — the app renders + persists it. */
  | { kind: "plan"; plan: BuddyPlan }
  /** Where the request's context budget is going (for the usage donut). */
  | { kind: "usage"; usage: ContextUsage }
  /** remove_library_book deleted a book — the app should refresh its library. */
  | { kind: "libraryChanged" }
  /** schedule_task/cancel_scheduled changed the scheduled-task list — refresh it. */
  | { kind: "scheduledChanged" }
  /** set_price_alert/cancel_alert changed the alerts list — refresh it. */
  | { kind: "alertsChanged" }
  /** The buddy distilled a reusable skill from a recurring task — offer it to keep. */
  | { kind: "skillProposed"; skill: { name: string; description: string; body: string } }
  /** set_visual_style resolved — the app (settings owner) should commit it. */
  | {
      kind: "settings";
      style?: { id: string; label: string };
      pagesPerImage?: number | "chapter";
      illustrateAfter?: "chapter" | "book";
      /** A generic settings patch from update_setting + a chip summary. */
      patch?: Partial<ReaderSettings>;
      summary?: string;
    };

export interface BuddyDoneResult {
  text: string;
  /** Turns to append to the stored buddy history (assistant + tool feedback). */
  transcript: ChatTurn[];
  /** An un-executed generate_image awaiting the reader's approval. */
  pendingTool?: BuddyToolCall;
  /** The turn's reasoning, persisted onto the settled message as a collapsible. */
  thinking?: string;
  /** The turn paused at a cloud "keep going?" budget checkpoint — offer a Continue affordance. */
  paused?: boolean;
  error?: string;
}

export type ChatStreamEvent =
  | { kind: "token"; text: string }
  /** A thinking model's live reasoning text (shown dimmed while it works). */
  | { kind: "thinking"; text: string }
  /** Live status while the model works invisibly (thinking-model reasoning). */
  | { kind: "activity"; text: string }
  | { kind: "tool"; call: ToolCall }
  | {
      kind: "toolResult";
      call: ToolCall;
      hits?: WebSearchHit[];
      imageHits?: ImageSearchHit[];
      /** search_book passages (slash commands render these in the panel). */
      passages?: BookPassage[];
      /** lookup_bible detail (slash commands render this in the panel). */
      bibleDetail?: string;
      memory?: { action: "remembered" | "forgot"; note: string; count: number };
      /** A grounded analyze_data result table (rendered inline). */
      analysis?: { table: DataTable; summary: string; chart?: AnalyzeChart };
      error?: string;
    }
  /** Where the request's context budget is going (for the usage donut). */
  | { kind: "usage"; usage: ContextUsage };

export interface ChatDoneResult {
  text: string;
  /** Turns to append to the stored history (assistant + tool feedback). */
  transcript: ChatTurn[];
  pendingTool?: ToolCall;
  error?: string;
}

export interface ChatToolRender {
  image?: { bytes: ArrayBuffer; mimeType: string };
  /** An image-to-video render's output clip. */
  video?: { bytes: ArrayBuffer; mimeType: string };
  error?: string;
}

export interface TestRenderResult {
  ok: boolean;
  image?: { bytes: ArrayBuffer; mimeType: string };
  /** The exact prompt sent (the text + the active style suffix). */
  prompt?: string;
  error?: string;
}

/** One polish stage's outcome: understand returns plan/question; produce returns text. */
export interface PolishResult {
  plan?: string;
  question?: string;
  text?: string;
  error?: string;
}

/** Minimal image-cache read surface (the main-thread IndexedDB store), for reloads. */
export interface ImageReadStore {
  getImage(requestId: string): Promise<{ bytes: ArrayBuffer; mimeType: string; prompt?: string } | undefined>;
}

export function useEngineWorker(settings: ReaderSettings, imageStore?: ImageReadStore): EngineWorkerApi {
  const workerRef = useRef<Worker | undefined>(undefined);
  const lastBook = useRef<BookSource | undefined>(undefined);
  // Whether the user has begun generating the current book. Survives the
  // settings-driven re-open (which builds a fresh engine) so generation resumes
  // instead of silently reverting to "not started".
  const generationRequested = useRef(false);
  const [bible, setBible] = useState<VisualBible | undefined>();
  const [results, setResults] = useState<Map<number, DisplayResult>>(new Map());
  // Memory windowing: the reader's current unit, a live mirror of `results` (so the
  // planner reads the latest without IO inside a state updater), and reloads already
  // in flight (so we never re-request the same evicted image while its read is pending).
  const activeUnitRef = useRef(0);
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const reloadingRef = useRef(new Set<number>());
  const [status, setStatus] = useState("");
  const [bibleStatus, setBibleStatus] = useState("");
  const [workflow, setWorkflow] = useState({
    bibleDone: 0,
    bibleTotal: 0,
    promptsDone: 0,
    promptsTotal: 0,
  });
  const [avgRenderMs, setAvgRenderMs] = useState(0);
  // Per-unit render start times + a rolling average, for image ETAs.
  const renderStart = useRef<Map<number, number>>(new Map());
  const renderAvg = useRef<{ avg: number; n: number }>({ avg: 0, n: 0 });
  const [providers, setProviders] = useState<ProvidersDiagnostics | undefined>();
  const [vram, setVram] = useState<EngineVram | undefined>();
  const [generating, setGenerating] = useState(false);
  const [paused, setPaused] = useState<{ bible: boolean; images: boolean }>({
    bible: false,
    images: false,
  });
  const [importResult, setImportResult] = useState<ImportResult | undefined>();
  // In-flight getCharacterReference requests, resolved by `characterReference` replies.
  const refRequests = useRef<
    Map<number, (image: { bytes: ArrayBuffer; mimeType: string } | undefined) => void>
  >(new Map());
  // In-flight playground renders, resolved by `testRendered` replies.
  const testRequests = useRef<
    Map<number, { resolve: (result: TestRenderResult) => void; onProgress?: (fraction: number) => void }>
  >(new Map());
  const assessRequests = useRef<Map<number, (r: { text?: string; error?: string }) => void>>(new Map());
  const emailRequests = useRef<Map<number, (r: { id?: string; error?: string }) => void>>(new Map());
  // In-flight coding-agent runs + the live handler that executes one agent's host tool in its
  // worktree (set for the duration of a run; only one run is active at a time — approval is serial).
  const codingAgentsRequests = useRef<
    Map<
      number,
      {
        resolve: (r: { results?: { title: string; result: string }[]; error?: string }) => void;
        onProgress?: (text: string) => void;
      }
    >
  >(new Map());
  const conflictRequests = useRef<
    Map<number, (r: { files?: { file: string; content: string }[]; error?: string }) => void>
  >(new Map());
  const agentToolHandler = useRef<
    ((call: BuddyToolCall, cwd: string, agentIdx: number) => Promise<BuddyToolResultPayload>) | undefined
  >(undefined);
  // The in-flight parallel coding-agent run, so Stop can send `codingAgentCancel` at it.
  const activeCodingAgentsRequestId = useRef<number | undefined>(undefined);
  // In-flight chat rounds: streaming events + the final resolve, keyed by requestId.
  const chatRequests = useRef<
    Map<
      number,
      { onEvent: (e: ChatStreamEvent) => void; resolve: (r: ChatDoneResult) => void; bump: () => void }
    >
  >(new Map());
  // In-flight approved tool renders (chatTool), resolved by `chatToolResult`.
  const chatToolRequests = useRef<
    Map<number, { resolve: (r: ChatToolRender) => void; onProgress?: (fraction: number) => void }>
  >(new Map());
  const activeChatRequestId = useRef<number | undefined>(undefined);
  // The in-flight standalone image render (a chatTool/buddy approved generate_image, or a
  // playground testRender). It runs under its OWN requestId — NOT activeChatRequestId — so the Stop
  // button must cancel THIS too, or a long render keeps going after Stop.
  const activeRenderRequestId = useRef<number | undefined>(undefined);
  // In-flight buddy rounds (landing page), keyed by requestId like chatRequests.
  const buddyRequests = useRef<
    Map<
      number,
      { onEvent: (e: BuddyStreamEvent) => void; resolve: (r: BuddyDoneResult) => void; bump: () => void }
    >
  >(new Map());
  const activeBuddyRequestId = useRef<number | undefined>(undefined);
  // In-flight compact-summaries, resolved by `summarized` replies.
  const summarizeRequests = useRef<Map<number, (r: { text?: string; error?: string }) => void>>(
    new Map(),
  );
  // In-flight Google OAuth exchanges, resolved by `googleConnected`.
  const googleConnectRequests = useRef<Map<number, (r: { ok: boolean; email?: string; error?: string }) => void>>(
    new Map(),
  );
  const schwabConnectRequests = useRef<Map<number, (r: { ok: boolean; error?: string }) => void>>(new Map());
  const schwabOrderRequests = useRef<Map<number, (r: { ok: boolean; status?: number; error?: string }) => void>>(new Map());
  // In-flight task-plan requests (resolved by `planned`, progress via `planProgress`).
  const planRequests = useRef<
    Map<number, { resolve: (r: { ok: boolean; plan?: TaskPlan; error?: string }) => void; onProgress?: (phase: string, note?: string) => void }>
  >(new Map());
  // In-flight idle scans, resolved by `scanned`.
  const scanRequests = useRef<Map<number, (r: { ok: boolean; candidates?: TaskCandidate[]; error?: string }) => void>>(new Map());
  // In-flight Google-Task imports, resolved by `googleTasksImported`.
  const importTaskRequests = useRef<Map<number, (r: { ok: boolean; imported?: number; edited?: number; mirrored?: number; error?: string }) => void>>(new Map());
  // In-flight Google-Task creations (for surfaced stubs), resolved by `googleTaskCreated`.
  const createTaskRequests = useRef<Map<number, (r: { ok: boolean; id?: string; error?: string }) => void>>(new Map());
  // In-flight manual calendar-event creations, resolved by `eventCreated`.
  const createEventRequests = useRef<Map<number, (r: { ok: boolean; id?: string; error?: string }) => void>>(new Map());
  // In-flight calendar loads, resolved by `calendarLoaded`.
  const calendarRequests = useRef<Map<number, (r: { ok: boolean; events?: CalendarEvent[]; error?: string }) => void>>(new Map());
  // In-flight stock-quote fetches, resolved by `stockQuoted`.
  const quoteRequests = useRef<Map<number, (r: { ok: boolean; quote?: StockQuote }) => void>>(new Map());
  // In-flight page reads (in-app browser), resolved by `pageRead`.
  const pageRequests = useRef<Map<number, (r: { ok: boolean; page?: PageText; error?: string }) => void>>(new Map());
  // In-flight remote-bus list/reply ops (phone↔Google↔desktop).
  const busListRequests = useRef<Map<number, (r: { ok: boolean; commands?: BusCommand[] }) => void>>(new Map());
  const busReplyRequests = useRef<Map<number, (r: { ok: boolean; error?: string }) => void>>(new Map());
  // In-flight indicator fetches, resolved by `marketIndicatorsResult`.
  const indicatorRequests = useRef<Map<number, (r: { ok: boolean; indicators?: Indicators }) => void>>(new Map());
  // In-flight document-polish stages, resolved by `polished` (and streamed via `polishToken`).
  const polishRequests = useRef<
    Map<number, { onToken?: (delta: string) => void; resolve: (r: PolishResult) => void }>
  >(new Map());

  // A worker crash must not strand in-flight promises: drain EVERY pending-request map with an
  // error-shaped result (chat turns get { error }, ok-shaped ops get ok:false) and reset the busy
  // flags, so callers settle into a retryable state instead of hanging forever behind a dead worker.
  const failAllPending = useCallback((error: string): void => {
    const drain = <T,>(map: { current: Map<number, T> }, fn: (entry: T) => void): void => {
      const entries = [...map.current.values()];
      map.current.clear(); // clear FIRST so a resolver that sends a follow-up can re-register cleanly
      for (const entry of entries) fn(entry);
    };
    drain(refRequests, (resolve) => resolve(undefined));
    drain(testRequests, (r) => r.resolve({ ok: false, error }));
    drain(assessRequests, (resolve) => resolve({ error }));
    drain(emailRequests, (resolve) => resolve({ error }));
    drain(codingAgentsRequests, (r) => r.resolve({ error }));
    drain(conflictRequests, (resolve) => resolve({ error }));
    drain(chatRequests, (r) => r.resolve({ text: "", transcript: [], error }));
    drain(chatToolRequests, (r) => r.resolve({ error }));
    drain(buddyRequests, (r) => r.resolve({ text: "", transcript: [], error }));
    drain(summarizeRequests, (resolve) => resolve({ error }));
    drain(googleConnectRequests, (resolve) => resolve({ ok: false, error }));
    drain(schwabConnectRequests, (resolve) => resolve({ ok: false, error }));
    drain(schwabOrderRequests, (resolve) => resolve({ ok: false, error }));
    drain(planRequests, (r) => r.resolve({ ok: false, error }));
    drain(scanRequests, (resolve) => resolve({ ok: false, error }));
    drain(importTaskRequests, (resolve) => resolve({ ok: false, error }));
    drain(createTaskRequests, (resolve) => resolve({ ok: false, error }));
    drain(createEventRequests, (resolve) => resolve({ ok: false, error }));
    drain(calendarRequests, (resolve) => resolve({ ok: false, error }));
    drain(quoteRequests, (resolve) => resolve({ ok: false }));
    drain(pageRequests, (resolve) => resolve({ ok: false, error }));
    drain(busListRequests, (resolve) => resolve({ ok: false }));
    drain(busReplyRequests, (resolve) => resolve({ ok: false, error }));
    drain(indicatorRequests, (resolve) => resolve({ ok: false }));
    drain(polishRequests, (r) => r.resolve({ error }));
    activeChatRequestId.current = undefined;
    activeRenderRequestId.current = undefined;
    activeBuddyRequestId.current = undefined;
    activeCodingAgentsRequestId.current = undefined;
    setGenerating(false);
  }, []);

  // PHONE-CLIENT MODE: when opened via a #vrlink=… link, this tab drives a remote desktop
  // engine over the relay instead of a local Web Worker. Detected once. (Undefined normally —
  // the default local-worker path below is unchanged.)
  const remoteRef = useRef<RemoteMode | undefined>(initRemoteMode());
  // Worker requestId counter. A linked phone relays its raw worker frames into the DESKTOP's shared
  // worker, which routes replies purely by requestId — so the phone's ids must NOT overlap the
  // desktop's own (both would otherwise count from 1 and a same-type collision delivers a result to
  // the wrong side, or the phone's silence-watchdog aborts the desktop's turn). Namespace the phone's
  // ids into a high band so the two counters can never meet (H2).
  const nextRefRequestId = useRef(remoteRef.current ? PHONE_REQUEST_ID_BASE : 1);
  const phoneWsRef = useRef<WebSocket | undefined>(undefined);
  // HOST-BRIDGE: on the desktop, when a phone is linked, mirror the engine worker to the relay.
  const hostBridgeRef = useRef<{ ws: WebSocket; token: string } | undefined>(undefined);
  // Auto-reconnect state for the host bridge (a generation counter invalidates a superseded/stopped
  // reconnect loop; the pending timer lets a dropped bridge come back like the phone client does).
  const hostBridgeGen = useRef(0);
  const hostBridgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // APP-STATE MIRROR: a handler (set by App) for incoming library/book/bible/settings frames, so
  // the phone renders the desktop's content and the desktop answers the phone's commands.
  const appSyncRef = useRef<((msg: AppSyncMessage) => void) | undefined>(undefined);
  const setAppSyncHandler = useCallback((fn: (msg: AppSyncMessage) => void) => {
    appSyncRef.current = fn;
  }, []);
  // PHONE: frames produced while the relay socket is reconnecting (a wifi blip) used to vanish
  // silently — a tapped command just never happened. Queue a small burst instead and flush it in
  // order when the socket re-opens (bounded: a phone's frames are commands/settings, not media).
  const phonePendingFrames = useRef<string[]>([]);
  const PHONE_PENDING_MAX = 32;
  const phoneSendOrQueue = useCallback((frame: string): void => {
    const ws = phoneWsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(frame);
      return;
    }
    phonePendingFrames.current.push(frame);
    if (phonePendingFrames.current.length > PHONE_PENDING_MAX) phonePendingFrames.current.shift(); // drop OLDEST
  }, []);
  const flushPhonePending = useCallback((ws: WebSocket): void => {
    const pending = phonePendingFrames.current;
    phonePendingFrames.current = [];
    for (const frame of pending) ws.send(frame);
  }, []);

  // Send an app-state mirror frame to the other side: the phone sends commands up its relay socket;
  // the desktop pushes state down the host-bridge socket. No-op when this side isn't linked.
  const sendAppSync = useCallback((msg: AppSyncMessage) => {
    const remote = remoteRef.current;
    if (remote) {
      phoneSendOrQueue(encodeFrame(remote.token, serializeForRemote(msg, bytesToBase64)));
      return;
    }
    const hb = hostBridgeRef.current;
    if (hb && hb.ws.readyState === WebSocket.OPEN) {
      hb.ws.send(encodeFrame(hb.token, serializeForRemote(msg, bytesToBase64)));
    }
  }, []);

  const send = (msg: MainToWorker, transfer: Transferable[] = []) => {
    const remote = remoteRef.current;
    if (remote) {
      // No local worker on the phone — frame the request to the desktop over the relay
      // (queued while the socket is still connecting/reconnecting).
      phoneSendOrQueue(encodeFrame(remote.token, serializeForRemote(msg, bytesToBase64)));
      return;
    }
    workerRef.current?.postMessage(msg, transfer);
  };
  const startHostBridge = useCallback((wsUrl: string, token: string, onOpen?: () => void) => {
    // Reconnect like the phone client does: the relay is local (127.0.0.1) but it can restart, and a
    // dead bridge used to leave a reconnecting phone talking to a relay with no desktop behind it —
    // it connects but never gets a snapshot (blank). A generation counter retires the old loop.
    const gen = ++hostBridgeGen.current;
    if (hostBridgeTimer.current) {
      clearTimeout(hostBridgeTimer.current);
      hostBridgeTimer.current = undefined;
    }
    hostBridgeRef.current?.ws.close();
    let attempt = 0;
    const connect = (): void => {
      if (hostBridgeGen.current !== gen) return; // superseded by a newer start, or stopped
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        attempt = 0;
        // (Re)push the desktop's full state so a phone already waiting on the relay re-populates
        // even though it won't re-send `vrcmd:hello` while its own socket stayed up.
        onOpen?.();
      };
      ws.onmessage = (e) => {
        // A frame from the linked phone: either an app-sync COMMAND (open a book / ask for a
        // snapshot) handled by App, or an engine request to run on the desktop's real worker.
        if (typeof e.data !== "string") return;
        const payload = decodeFrame(e.data, token);
        if (!payload) return;
        const msg = deserializeFromRemote(payload, base64ToBytes);
        if (isAppSyncMessage(msg)) appSyncRef.current?.(msg as AppSyncMessage);
        else if (!isLocalOnlyMessage(msg)) workerRef.current?.postMessage(msg);
      };
      ws.onclose = () => {
        if (hostBridgeRef.current?.ws === ws) hostBridgeRef.current = undefined;
        if (hostBridgeGen.current !== gen) return; // stopped/superseded — don't retry
        const delay = Math.min(1000 * 2 ** attempt, 10_000); // 1s, 2s, 4s, 8s, 10s…
        attempt++;
        hostBridgeTimer.current = setTimeout(connect, delay);
      };
      hostBridgeRef.current = { ws, token };
    };
    connect();
  }, []);
  const stopHostBridge = useCallback(() => {
    hostBridgeGen.current++; // invalidate any in-flight reconnect loop
    if (hostBridgeTimer.current) {
      clearTimeout(hostBridgeTimer.current);
      hostBridgeTimer.current = undefined;
    }
    hostBridgeRef.current?.ws.close();
    hostBridgeRef.current = undefined;
  }, []);

  useEffect(() => {
    // The entire message-handling switch, reused by both the local worker and the phone WS.
    const handleMsg = (msg: WorkerToMain) => {
      // Host bridge: mirror the engine's output to a linked phone (skip local-only CORS msgs). A
      // byte-heavy reply (rendered image / video / character-ref, tens of MB) is only worth sending
      // to the phone that ASKED for it — mirroring a desktop-owned one just floods the tunnel with
      // bytes the phone discards, and can kill the socket. Phone requestIds live in the high band, so
      // a heavy reply below it is desktop-owned → don't mirror it (H5).
      const hb = hostBridgeRef.current;
      const heavyDesktopReply =
        (msg.type === "chatToolResult" || msg.type === "testRendered" || msg.type === "characterReference") &&
        msg.requestId < PHONE_REQUEST_ID_BASE;
      if (hb && hb.ws.readyState === WebSocket.OPEN && !isLocalOnlyMessage(msg) && !heavyDesktopReply) {
        hb.ws.send(encodeFrame(hb.token, serializeForRemote(msg, bytesToBase64)));
      }
      switch (msg.type) {
        case "corsFetch": {
          // Worker → Rust shell relay (workers can't reach the Tauri bridge).
          // desktopHttpFetch never rejects; failures travel back as { error }.
          void desktopHttpFetch(msg.request).then((r) =>
            send({ type: "corsFetchResult", fetchId: msg.fetchId, ...r }),
          );
          break;
        }
        case "mcpStdio": {
          // Worker → Rust shell relay: spawn a stdio MCP server and pipe JSON-RPC lines.
          void mcpStdioExchange(msg.command, msg.args, msg.input)
            .then((lines) => send({ type: "mcpStdioResult", callId: msg.callId, ok: true, lines }))
            .catch((err: unknown) =>
              send({ type: "mcpStdioResult", callId: msg.callId, ok: false, error: err instanceof Error ? err.message : String(err) }),
            );
          break;
        }
        case "hostFile": {
          // Worker → main relay for local files: the Tauri bridge (search/read) + pdfjs (PDF text)
          // live here, not in the worker. The worker has already gated this on the reader's
          // settings, so we just run it. PDF-from-bytes works on web too (no Tauri needed).
          const reply = (r: { ok: boolean; files?: { name: string; path: string }[]; text?: string; imageBase64?: string; mimeType?: string; name?: string; error?: string }) =>
            send({ type: "hostFileResult", callId: msg.callId, ...r });
          void (async () => {
            try {
              if (msg.op === "search") {
                const files = await searchLocalFiles(msg.query ?? "");
                reply({ ok: true, files: files.slice(0, 20).map((f) => ({ name: f.name, path: f.path })) });
              } else if (msg.op === "read") {
                const file = await readLocalFile(msg.path ?? "");
                const bytes = new Uint8Array(await file.arrayBuffer());
                const text = /\.pdf$/i.test(file.name) ? await pdfToText(bytes) : new TextDecoder().decode(bytes);
                reply({ ok: true, text: text.slice(0, 200_000) });
              } else if (msg.op === "imageBytes") {
                // Read an image file's raw bytes (no text decode) so the buddy can show it inline in chat.
                const file = await readLocalFile(msg.path ?? "");
                const bytes = new Uint8Array(await file.arrayBuffer());
                reply({ ok: true, imageBase64: bytesToBase64(bytes.buffer as ArrayBuffer), mimeType: imageMimeFromName(file.name), name: file.name });
              } else {
                reply({ ok: true, text: (await pdfToText(new Uint8Array(base64ToBytes(msg.bytesBase64 ?? "")))).slice(0, 200_000) });
              }
            } catch (err) {
              reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          })();
          break;
        }
        case "llmVram": {
          // Worker → main relay: free (stop) or relaunch (ensure) the bundled chat LLM. Tauri lives
          // here. On the web / when nothing's running these are no-ops; we always ack so the worker
          // proceeds. The worker has gated this to the safe (bundled, local-image, no-bible) case.
          void (async () => {
            try {
              if (msg.action === "stop") await stopLocalLlm();
              else await ensureLocalLlm();
            } catch {
              /* not desktop / nothing to do */
            }
            send({ type: "llmVramResult", callId: msg.callId });
          })();
          break;
        }
        case "status":
          setStatus(msg.message);
          break;
        case "providers":
          setProviders(msg.diagnostics);
          break;
        case "vram":
          setVram(msg.vram);
          break;
        case "generating":
          setGenerating(msg.value);
          break;
        case "paused":
          setPaused({ bible: msg.bible, images: msg.images });
          break;
        case "opened":
          setBible(msg.bible);
          break;
        case "update":
          setResults((prev) => new Map(prev).set(msg.pageIndex, toDisplayResult(msg.result)));
          // Time each image (first "rendering" → "ready") into a rolling average.
          if (msg.result.status === "rendering" && !renderStart.current.has(msg.pageIndex)) {
            renderStart.current.set(msg.pageIndex, Date.now());
          } else if (msg.result.status === "ready") {
            const startedAt = renderStart.current.get(msg.pageIndex);
            renderStart.current.delete(msg.pageIndex);
            if (startedAt) {
              const dur = Date.now() - startedAt;
              const a = renderAvg.current;
              a.avg = (a.avg * a.n + dur) / (a.n + 1);
              a.n += 1;
              setAvgRenderMs(a.avg);
            }
          }
          break;
        case "bibleStatus":
          setBibleStatus(msg.text);
          break;
        case "workflow":
          setWorkflow({
            bibleDone: msg.bibleDone,
            bibleTotal: msg.bibleTotal,
            promptsDone: msg.promptsDone,
            promptsTotal: msg.promptsTotal,
          });
          break;
        case "export":
          downloadJson(msg.json, "visual-bible.json");
          break;
        case "imported":
          setImportResult({
            ok: msg.ok,
            ...(msg.stats ? { stats: msg.stats } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          });
          break;
        case "characterReference": {
          const resolve = refRequests.current.get(msg.requestId);
          refRequests.current.delete(msg.requestId);
          resolve?.(msg.image);
          break;
        }
        case "testProgress": {
          testRequests.current.get(msg.requestId)?.onProgress?.(msg.fraction);
          chatToolRequests.current.get(msg.requestId)?.onProgress?.(msg.fraction);
          break;
        }
        case "imageAssessed": {
          const resolve = assessRequests.current.get(msg.requestId);
          assessRequests.current.delete(msg.requestId);
          resolve?.({ ...(msg.text ? { text: msg.text } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "buddyEmailSent": {
          const resolve = emailRequests.current.get(msg.requestId);
          emailRequests.current.delete(msg.requestId);
          resolve?.({ ...(msg.id ? { id: msg.id } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "agentTool": {
          // A coding agent (in the worker) wants to run a host tool in its worktree — execute it via
          // the active run's handler and post the result back, or report no handler.
          const handler = agentToolHandler.current;
          if (handler) {
            void handler(msg.call, msg.cwd, msg.agentIdx).then(
              (result) => send({ type: "agentToolResult", callId: msg.callId, result }),
              (e) => send({ type: "agentToolResult", callId: msg.callId, result: { error: e instanceof Error ? e.message : String(e) } }),
            );
          } else {
            send({ type: "agentToolResult", callId: msg.callId, result: { error: "no coding-agent run is active" } });
          }
          break;
        }
        case "codingAgentsDone": {
          const req = codingAgentsRequests.current.get(msg.requestId);
          codingAgentsRequests.current.delete(msg.requestId);
          req?.resolve(msg.error ? { error: msg.error } : { results: msg.results });
          break;
        }
        case "conflictsResolved": {
          const resolve = conflictRequests.current.get(msg.requestId);
          conflictRequests.current.delete(msg.requestId);
          resolve?.(msg.error ? { error: msg.error } : { files: msg.files });
          break;
        }
        case "testRendered": {
          const req = testRequests.current.get(msg.requestId);
          testRequests.current.delete(msg.requestId);
          req?.resolve({
            ok: msg.ok,
            ...(msg.image ? { image: msg.image } : {}),
            ...(msg.prompt ? { prompt: msg.prompt } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          });
          break;
        }
        case "chatContextUsage": {
          // Routed to whichever chat (book or buddy) owns the request id.
          chatRequests.current.get(msg.requestId)?.onEvent({ kind: "usage", usage: msg.usage });
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "usage", usage: msg.usage });
          break;
        }
        case "chatToken": {
          chatRequests.current.get(msg.requestId)?.onEvent({ kind: "token", text: msg.text });
          break;
        }
        case "chatThinking": {
          chatRequests.current.get(msg.requestId)?.onEvent({ kind: "thinking", text: msg.text });
          break;
        }
        case "chatActivity": {
          chatRequests.current.get(msg.requestId)?.onEvent({ kind: "activity", text: msg.text });
          break;
        }
        case "chatTool": {
          chatRequests.current.get(msg.requestId)?.onEvent({ kind: "tool", call: msg.call });
          break;
        }
        case "chatToolResult": {
          // Either an approved tool render's reply, or a mid-chat search result.
          const toolReq = chatToolRequests.current.get(msg.requestId);
          if (toolReq) {
            chatToolRequests.current.delete(msg.requestId);
            toolReq.resolve({
              ...(msg.image ? { image: msg.image } : {}),
              ...(msg.video ? { video: msg.video } : {}),
              ...(msg.error ? { error: msg.error } : {}),
            });
            break;
          }
          chatRequests.current.get(msg.requestId)?.onEvent({
            kind: "toolResult",
            call: msg.call,
            ...(msg.hits ? { hits: msg.hits } : {}),
            ...(msg.imageHits ? { imageHits: msg.imageHits } : {}),
            ...(msg.passages ? { passages: msg.passages } : {}),
            ...(msg.bibleDetail !== undefined ? { bibleDetail: msg.bibleDetail } : {}),
            ...(msg.memory ? { memory: msg.memory } : {}),
            ...(msg.analysis ? { analysis: msg.analysis } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          });
          break;
        }
        case "chatDone": {
          const req = chatRequests.current.get(msg.requestId);
          chatRequests.current.delete(msg.requestId);
          if (activeChatRequestId.current === msg.requestId) activeChatRequestId.current = undefined;
          req?.resolve({
            text: msg.text,
            transcript: msg.transcript,
            ...(msg.pendingTool ? { pendingTool: msg.pendingTool } : {}),
          });
          break;
        }
        case "chatError": {
          const req = chatRequests.current.get(msg.requestId);
          chatRequests.current.delete(msg.requestId);
          if (activeChatRequestId.current === msg.requestId) activeChatRequestId.current = undefined;
          req?.resolve({ text: "", transcript: [], error: msg.message });
          break;
        }
        case "buddyToken": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "token", text: msg.text });
          break;
        }
        case "buddyThinking": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "thinking", text: msg.text });
          break;
        }
        case "buddyActivity": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "activity", text: msg.text });
          // A parallel coding-agents run posts its "X/N done" progress under ITS own requestId (not a
          // buddy turn), so route that to the run's progress callback too — otherwise it never shows (H8).
          codingAgentsRequests.current.get(msg.requestId)?.onProgress?.(msg.text);
          break;
        }
        case "buddyTool": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "tool", call: msg.call });
          break;
        }
        case "buddyToolResult": {
          buddyRequests.current.get(msg.requestId)?.onEvent({
            kind: "toolResult",
            call: msg.call,
            ...(msg.hits ? { hits: msg.hits } : {}),
            ...(msg.books ? { books: msg.books } : {}),
            ...(msg.imageHits ? { imageHits: msg.imageHits } : {}),
            ...(msg.applied ? { applied: msg.applied } : {}),
            ...(msg.removed ? { removed: msg.removed } : {}),
            ...(msg.calc ? { calc: msg.calc } : {}),
            ...(msg.wolfram ? { wolfram: msg.wolfram } : {}),
            ...(msg.memory ? { memory: msg.memory } : {}),
            ...(msg.openedImage ? { openedImage: msg.openedImage } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          });
          break;
        }
        case "buddyOpened": {
          buddyRequests.current
            .get(msg.requestId)
            ?.onEvent({ kind: "opened", book: msg.book, visuals: msg.visuals });
          break;
        }
        case "storyBeat": {
          buddyRequests.current
            .get(msg.requestId)
            ?.onEvent({ kind: "storyBeat", book: msg.book, firstNewUnit: msg.firstNewUnit, illustrate: msg.illustrate });
          break;
        }
        case "documentCreated": {
          buddyRequests.current.get(msg.requestId)?.onEvent({
            kind: "documentCreated",
            id: msg.id,
            title: msg.title,
            content: msg.content,
            path: msg.path,
            ...(msg.format ? { format: msg.format } : {}),
          });
          break;
        }
        case "storyConfig": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "storyConfig", book: msg.book });
          break;
        }
        case "buddyPlan": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "plan", plan: msg.plan });
          break;
        }
        case "buddyLibraryChanged": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "libraryChanged" });
          break;
        }
        case "buddyScheduledChanged": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "scheduledChanged" });
          break;
        }
        case "buddyAlertsChanged": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "alertsChanged" });
          break;
        }
        case "buddySkillProposed": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "skillProposed", skill: msg.skill });
          break;
        }
        case "buddySettings": {
          buddyRequests.current.get(msg.requestId)?.onEvent({
            kind: "settings",
            ...(msg.style ? { style: msg.style } : {}),
            ...(msg.pagesPerImage !== undefined ? { pagesPerImage: msg.pagesPerImage } : {}),
            ...(msg.illustrateAfter !== undefined ? { illustrateAfter: msg.illustrateAfter } : {}),
            ...(msg.patch ? { patch: msg.patch } : {}),
            ...(msg.summary ? { summary: msg.summary } : {}),
          });
          break;
        }
        case "buddyDone": {
          const req = buddyRequests.current.get(msg.requestId);
          buddyRequests.current.delete(msg.requestId);
          if (activeBuddyRequestId.current === msg.requestId) activeBuddyRequestId.current = undefined;
          req?.resolve({
            text: msg.text,
            transcript: msg.transcript,
            ...(msg.pendingTool ? { pendingTool: msg.pendingTool } : {}),
            ...(msg.thinking ? { thinking: msg.thinking } : {}),
            ...(msg.paused ? { paused: true } : {}),
          });
          break;
        }
        case "buddyError": {
          const req = buddyRequests.current.get(msg.requestId);
          buddyRequests.current.delete(msg.requestId);
          if (activeBuddyRequestId.current === msg.requestId) activeBuddyRequestId.current = undefined;
          req?.resolve({ text: "", transcript: [], error: msg.message });
          break;
        }
        case "summarized": {
          const resolve = summarizeRequests.current.get(msg.requestId);
          summarizeRequests.current.delete(msg.requestId);
          resolve?.(msg.ok && msg.text ? { text: msg.text } : { error: msg.error ?? "Summarize failed." });
          break;
        }
        case "googleConnected": {
          const resolve = googleConnectRequests.current.get(msg.requestId);
          googleConnectRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.email ? { email: msg.email } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "schwabConnected": {
          const resolve = schwabConnectRequests.current.get(msg.requestId);
          schwabConnectRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "schwabOrderPlaced": {
          const resolve = schwabOrderRequests.current.get(msg.requestId);
          schwabOrderRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.status !== undefined ? { status: msg.status } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "planProgress": {
          planRequests.current.get(msg.requestId)?.onProgress?.(msg.phase, msg.note);
          break;
        }
        case "planned": {
          const req = planRequests.current.get(msg.requestId);
          planRequests.current.delete(msg.requestId);
          req?.resolve(
            msg.ok && msg.plan
              ? { ok: true, plan: msg.plan }
              : { ok: false, ...(msg.error ? { error: msg.error } : {}) },
          );
          break;
        }
        case "scanned": {
          const resolve = scanRequests.current.get(msg.requestId);
          scanRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.candidates ? { candidates: msg.candidates } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "googleTasksImported": {
          const resolve = importTaskRequests.current.get(msg.requestId);
          importTaskRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(typeof msg.imported === "number" ? { imported: msg.imported } : {}), ...(typeof msg.edited === "number" ? { edited: msg.edited } : {}), ...(typeof msg.mirrored === "number" ? { mirrored: msg.mirrored } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "googleTaskCreated": {
          const resolve = createTaskRequests.current.get(msg.requestId);
          createTaskRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.id ? { id: msg.id } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "eventCreated": {
          const resolve = createEventRequests.current.get(msg.requestId);
          createEventRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.id ? { id: msg.id } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "calendarLoaded": {
          const resolve = calendarRequests.current.get(msg.requestId);
          calendarRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.events ? { events: msg.events } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "stockQuoted": {
          const resolve = quoteRequests.current.get(msg.requestId);
          quoteRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.quote ? { quote: msg.quote } : {}) });
          break;
        }
        case "pageRead": {
          const resolve = pageRequests.current.get(msg.requestId);
          pageRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.page ? { page: msg.page } : {}), ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "remoteBusListed": {
          const resolve = busListRequests.current.get(msg.requestId);
          busListRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.commands ? { commands: msg.commands } : {}) });
          break;
        }
        case "remoteBusReplied": {
          const resolve = busReplyRequests.current.get(msg.requestId);
          busReplyRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.error ? { error: msg.error } : {}) });
          break;
        }
        case "marketIndicatorsResult": {
          const resolve = indicatorRequests.current.get(msg.requestId);
          indicatorRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.indicators ? { indicators: msg.indicators } : {}) });
          break;
        }
        case "polishToken": {
          polishRequests.current.get(msg.requestId)?.onToken?.(msg.text);
          break;
        }
        case "polished": {
          const req = polishRequests.current.get(msg.requestId);
          polishRequests.current.delete(msg.requestId);
          req?.resolve(
            msg.ok
              ? {
                  ...(msg.plan !== undefined ? { plan: msg.plan } : {}),
                  ...(msg.question !== undefined ? { question: msg.question } : {}),
                  ...(msg.text !== undefined ? { text: msg.text } : {}),
                }
              : { error: msg.error ?? "Polish failed." },
          );
          break;
        }
        case "error":
          setStatus(`Error: ${msg.message}`);
          break;
      }
    };

    // PHONE-CLIENT MODE: no local worker — drive the desktop engine over the relay. The socket
    // AUTO-RECONNECTS (with backoff) so a desktop restart, an in-app update's reload, or a brief Wi-Fi
    // blip doesn't strand the phone — when the desktop's relay comes back on the SAME persisted link,
    // the phone re-attaches and re-syncs, no manual reload needed.
    const remote = remoteRef.current;
    if (remote) {
      let stopped = false; // set on unmount — stop reconnecting then
      let attempt = 0;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      const connect = (): void => {
        const ws = new WebSocket(remote.wsUrl);
        ws.onopen = () => {
          attempt = 0;
          setStatus("Linked to a desktop");
          // Re-ask for a full snapshot every (re)connect, so the phone re-syncs after a gap —
          // BEFORE flushing commands queued during the gap (they act on the re-synced state).
          ws.send(encodeFrame(remote.token, { type: "vrcmd:hello" }));
          flushPhonePending(ws);
        };
        ws.onclose = () => {
          if (phoneWsRef.current === ws) phoneWsRef.current = undefined;
          if (stopped) return;
          const delay = Math.min(1000 * 2 ** attempt, 10_000); // 1s, 2s, 4s, 8s, 10s, 10s…
          attempt++;
          setStatus("Reconnecting to the desktop…");
          reconnectTimer = setTimeout(connect, delay);
        };
        ws.onerror = () => {
          /* an onclose follows and schedules the retry */
        };
        ws.onmessage = (e) => {
          if (typeof e.data !== "string") return;
          const payload = decodeFrame(e.data, remote.token);
          if (!payload) return;
          const msg = deserializeFromRemote(payload, base64ToBytes);
          // App-sync state pushes (library/book/bible/settings) go to App; everything else is an
          // engine message streamed from the desktop's worker.
          if (isAppSyncMessage(msg)) appSyncRef.current?.(msg as AppSyncMessage);
          else if (!isLocalOnlyMessage(msg)) handleMsg(msg as WorkerToMain);
        };
        phoneWsRef.current = ws;
      };
      connect();
      return () => {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        phoneWsRef.current?.close();
      };
    }

    let worker: Worker;
    try {
      worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (err) {
      setStatus(
        `Error: couldn't start the engine worker — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // Surface worker load/runtime crashes instead of failing silently (a dead
    // worker = no badges, no generation, endless "painting…"), and settle every
    // in-flight promise so chat turns / renders / plan requests error out
    // retryably instead of hanging behind the crash.
    worker.onerror = (e: ErrorEvent) => {
      const why =
        `engine worker crashed — ${e.message || "module failed to load"}` +
        (e.filename ? ` (${e.filename}:${e.lineno})` : "");
      setStatus(`Error: ${why}`);
      failAllPending(`The ${why}. Try again.`);
    };
    worker.onmessageerror = () => setStatus("Error: engine worker sent an undecodable message");
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => handleMsg(event.data);
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  // Settings changes take two paths so a style tweak never interrupts running work:
  //  - IDENTITY changes (providers, keys, models, pages-per-image, …) rebuild the
  //    providers and re-open the book — the old engine is disposed (aborting its
  //    in-flight work) because the providers themselves are different now.
  //  - TUNING changes (style, quality, aspect, sampler overrides, …) only affect how
  //    FUTURE renders are made: a light "tune" message updates the live engine's tier
  //    in place. Nothing is aborted, results stay, the bible build keeps running.
  // `panelsPerView` is pure UI and reaches neither path.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const identityKey = identitySettingsKey(settings);
  const tuningKey = tuningSettingsKey(settings);

  const identityApplied = useRef(false);
  useEffect(() => {
    // On a linked phone the engine lives on the DESKTOP — never push init/open/tune up the relay
    // (it would clobber the desktop's own engine + open book). The desktop owns its settings.
    if (remoteRef.current) return;
    const apply = (): void => {
      send({ type: "init", settings: settingsRef.current, ...(isDesktop ? { corsProxy: true } : {}) });
      if (lastBook.current) {
        setResults(new Map());
        send({ type: "open", book: lastBook.current });
        if (generationRequested.current) send({ type: "start" });
      }
    };
    // First run initialises the worker immediately. LATER identity changes are
    // debounced: an identity re-open clones the whole book to the worker and
    // rebuilds the engine (aborting in-flight work), so typing an API key must
    // coalesce into one rebuild — not one per keystroke.
    if (!identityApplied.current) {
      identityApplied.current = true;
      apply();
      return;
    }
    const timer = setTimeout(apply, 400);
    return () => clearTimeout(timer);
  }, [identityKey]); // deliberately keyed on the identity FIELDS, not the settings object

  // Hand the worker a just-started managed-engine URL immediately (the low-VRAM deferred-start path),
  // ahead of the debounced identity sync, so the next standalone render uses it without a race. The URL
  // is passed EXPLICITLY (settingsRef hasn't re-rendered with it yet); other fields ride the stale-but-
  // current snapshot and the full identity sync follows shortly after.
  const applyEngineConfig = useCallback((baseUrl: string, backend: LocalBackendId = "comfyui") => {
    if (remoteRef.current) return;
    send({ type: "tune", settings: { ...settingsRef.current, engineBaseUrl: baseUrl, engineBackend: backend } });
  }, []);

  const setFileLedger = useCallback((files: CreatedFileRef[]) => {
    if (remoteRef.current) return; // a phone's worker is the desktop's; the desktop owns the ledger
    send({ type: "fileLedger", files });
  }, []);

  const setProjectGuide = useCallback((text: string) => {
    if (remoteRef.current) return;
    send({ type: "projectGuide", text });
  }, []);

  /** Set/clear the document the reader is viewing (e.g. one they uploaded) so the buddy can discuss +
   * revise it. create_document sets this itself worker-side; this is for host-opened/uploaded docs. */
  const setActiveDocument = useCallback((doc?: { title: string; content: string }) => {
    if (remoteRef.current) return;
    send({ type: "activeDocument", ...(doc ? { doc } : {}) });
  }, []);

  useEffect(() => {
    if (remoteRef.current) return; // the desktop tunes its own engine (see the identity effect)
    send({ type: "tune", settings: settingsRef.current });
  }, [tuningKey]); // deliberately keyed on the tuning FIELDS, not the settings object

  const openBook = useCallback(
    (book: BookSource) => {
      lastBook.current = book;
      generationRequested.current = false; // a new book waits for the button
      setBible(undefined);
      setResults(new Map());
      reloadingRef.current.clear();
      activeUnitRef.current = 0;
      if (remoteRef.current) return; // a linked phone opens books on the desktop via vrcmd:open
      send({ type: "init", settings, ...(isDesktop ? { corsProxy: true } : {}) });
      send({ type: "open", book });
    },
    [settings],
  );

  // Push edited table(s) to the worker so the chat's analyze_data uses the new
  // values (the worker caches the opened book; a grid edit must refresh that copy).
  const updateBookData = useCallback(
    (patch: { data?: DataTable; dataSheets?: { name: string; table: DataTable }[] }) => {
      if (lastBook.current) {
        lastBook.current = {
          ...lastBook.current,
          ...(patch.data ? { data: patch.data } : {}),
          ...(patch.dataSheets ? { dataSheets: patch.dataSheets } : {}),
        };
      }
      send({ type: "updateBookData", ...patch });
    },
    [],
  );

  const closeBook = useCallback(() => {
    // Forget the book so a later settings change can't re-open it, reset the
    // local view, and tell the worker to dispose its engine.
    lastBook.current = undefined;
    generationRequested.current = false;
    setBible(undefined);
    setResults(new Map());
    setStatus("");
    setBibleStatus("");
    send({ type: "close" });
  }, []);

  const startGeneration = useCallback(() => {
    generationRequested.current = true;
    send({ type: "start" });
  }, []);
  const pause = useCallback(() => send({ type: "pause" }), []);
  const resume = useCallback(() => {
    generationRequested.current = true;
    send({ type: "resume" });
  }, []);
  const pauseBible = useCallback(() => send({ type: "pauseBible" }), []);
  const resumeBible = useCallback(() => {
    generationRequested.current = true;
    send({ type: "resumeBible" });
  }, []);
  const pauseImages = useCallback(() => send({ type: "pauseImages" }), []);
  const resumeImages = useCallback(() => {
    generationRequested.current = true;
    send({ type: "resumeImages" });
  }, []);
  const regenerateStoryboard = useCallback(() => {
    generationRequested.current = true;
    send({ type: "regenerateStoryboard" });
  }, []);
  // Story header controls (no model round): cadence, illustrate-latest, and mid-story workflow switch.
  const storySetCadence = useCallback((mode: "per-response" | "every-n" | "manual", n?: number) => {
    send({ type: "storySetCadence", mode, ...(n !== undefined ? { n } : {}) });
  }, []);
  const storyRenderLatest = useCallback(() => {
    send({ type: "storyRenderLatest" });
  }, []);
  const storySetMode = useCallback((mode: "direct" | "roleplay") => {
    send({ type: "storySetMode", mode });
  }, []);
  const rebuildPrompts = useCallback(() => {
    generationRequested.current = true;
    send({ type: "rebuildPrompts" });
  }, []);
  const regenerateAllImages = useCallback(() => {
    generationRequested.current = true;
    send({ type: "regenerateAllImages" });
  }, []);
  const regenerateImage = useCallback((unitIndex: number) => {
    generationRequested.current = true;
    send({ type: "regenerateImage", unitIndex });
  }, []);
  const completeBook = useCallback(() => {
    generationRequested.current = true;
    send({ type: "completeBook" });
  }, []);
  const updateCharacter = useCallback(
    (characterId: string, patch: CharacterPatch) =>
      send({ type: "updateCharacter", characterId, patch }),
    [],
  );
  const addCharacterReference = useCallback(
    (characterId: string, image: { bytes: ArrayBuffer; mimeType: string }) =>
      send({ type: "addCharacterReference", characterId, image }),
    [],
  );
  const removeCharacterReference = useCallback(
    (characterId: string, refId: string) =>
      send({ type: "removeCharacterReference", characterId, refId }),
    [],
  );
  const getCharacterReference = useCallback(
    (refId: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        // Timeout like every sibling request — a lost reply (worker crash/HMR) must not leak an
        // unresolvable promise; resolving undefined just renders the reference as missing.
        const timeout = setTimeout(() => {
          if (refRequests.current.delete(requestId)) resolve(undefined);
        }, 15_000);
        refRequests.current.set(requestId, (img) => {
          clearTimeout(timeout);
          resolve(img);
        });
        send({ type: "getCharacterReference", refId, requestId });
      }),
    [],
  );
  const exportBible = useCallback(() => send({ type: "exportBible" }), []);
  const importBible = useCallback((json: string) => {
    setImportResult(undefined);
    send({ type: "importBible", json });
  }, []);
  const clearImportResult = useCallback(() => setImportResult(undefined), []);

  // Memory windowing: drop image bytes far from the reader (they stay on disk) and
  // reload evicted images that have come back near. A no-op for typical-length books
  // (see RETAIN_MIN_RESIDENT) and when no image store is wired (e.g. tests).
  const runRetention = useCallback(() => {
    if (!imageStore) return;
    const { evict, reload } = planRetention(resultsRef.current, activeUnitRef.current);
    // Reload evicted images that are back near the reader (from the IndexedDB cache).
    for (const { unit, requestId } of reload) {
      if (reloadingRef.current.has(unit)) continue;
      reloadingRef.current.add(unit);
      void imageStore
        .getImage(requestId)
        .then((img) => {
          if (!img) return;
          setResults((p) => {
            const r = p.get(unit);
            if (!r || !r.evicted) return p; // book switched / already back — leave it
            return new Map(p).set(unit, {
              ...r,
              image: { blob: new Blob([img.bytes], { type: img.mimeType }), mimeType: img.mimeType },
              evicted: false,
            });
          });
        })
        .finally(() => reloadingRef.current.delete(unit));
    }
    if (evict.length === 0) return;
    setResults((prev) => {
      const next = new Map(prev);
      for (const unit of evict) {
        const r = next.get(unit);
        if (!r || !r.image) continue;
        // Drop the heavy bytes (omit the key — exactOptionalPropertyTypes), flag evicted.
        const { image: _dropped, ...rest } = r;
        next.set(unit, { ...rest, evicted: true });
      }
      return next;
    });
  }, [imageStore]);

  const setActiveUnit = useCallback(
    (unit: number) => {
      if (activeUnitRef.current === unit) return;
      activeUnitRef.current = unit;
      runRetention();
    },
    [runRetention],
  );

  // Also window during generation: pre-rendering a whole long book while the reader
  // sits still would otherwise pile every image into memory. Rate-limited (leading
  // edge) so a render burst can't thrash — it just trims around the reader's position.
  const lastRetentionRef = useRef(0);
  useEffect(() => {
    if (!imageStore) return;
    const now = Date.now();
    if (now - lastRetentionRef.current < 1500) return;
    lastRetentionRef.current = now;
    runRetention();
  }, [results, runRetention, imageStore]);
  const carryOverBible = useCallback((fromBookId: string) => send({ type: "carryOverBible", fromBookId }), []);
  const paintForward = useCallback(
    (fromUnit: number) => send({ type: "paintForward", fromUnit }),
    [],
  );
  const testRender = useCallback(
    (
      text: string,
      opts?: {
        initImage?: { bytes: ArrayBuffer; mimeType: string };
        denoise?: number;
        size?: { width: number; height: number };
        onProgress?: (fraction: number) => void;
      },
    ): Promise<TestRenderResult> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        activeRenderRequestId.current = requestId; // so Stop can interrupt this render
        // Silence watchdog: a lost `testRendered` reply (worker crash, dropped message) otherwise hangs
        // the playground spinner forever. Fail the render if there's been NO progress AND no reply for a
        // generous window; each progress tick re-arms it, so a slow-but-alive render is never killed (H8).
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const settle = (r: TestRenderResult) => {
          if (watchdog) clearTimeout(watchdog);
          testRequests.current.delete(requestId);
          if (activeRenderRequestId.current === requestId) activeRenderRequestId.current = undefined;
          resolve(r);
        };
        const arm = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            if (testRequests.current.has(requestId)) settle({ ok: false, error: "the render timed out — no response from the engine" });
          }, 600_000);
        };
        testRequests.current.set(requestId, {
          resolve: settle,
          onProgress: (f) => {
            arm();
            opts?.onProgress?.(f);
          },
        });
        arm();
        send({
          type: "testRender",
          requestId,
          text,
          ...(opts?.initImage ? { initImage: opts.initImage } : {}),
          ...(opts?.denoise !== undefined ? { denoise: opts.denoise } : {}),
          ...(opts?.size ? { size: opts.size } : {}),
        });
      }),
    [],
  );
  const chat = useCallback(
    (
      history: ChatTurn[],
      userText: string,
      position: { pageIndex: number; paragraphIndex: number },
      allowSpoilers: boolean,
      onEvent: (e: ChatStreamEvent) => void,
    ): Promise<ChatDoneResult> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        activeChatRequestId.current = requestId;
        // SILENCE watchdog (not a hard cap): a complex ask can take as long as it
        // needs as long as it keeps streaming tokens or reasoning — every event
        // resets this. It only fires when the model goes truly SILENT (no output at
        // all) for a long while, which means a wedged/stale worker (dev/HMR); the
        // Stop button handles a model the reader simply wants to interrupt.
        let timer: ReturnType<typeof setTimeout>;
        const fail = () => {
          if (chatRequests.current.delete(requestId)) {
            send({ type: "chatCancel", requestId });
            if (activeChatRequestId.current === requestId) activeChatRequestId.current = undefined;
            resolve({ text: "", transcript: [], error: "The chat went quiet for too long — try again, or press Stop." });
          }
        };
        const bump = () => {
          clearTimeout(timer);
          timer = setTimeout(fail, CHAT_SILENCE_MS);
        };
        bump();
        chatRequests.current.set(requestId, {
          onEvent: (e) => {
            bump();
            onEvent(e);
          },
          bump,
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
        });
        send({ type: "chat", requestId, history, userText, position, allowSpoilers });
      }),
    [],
  );
  const chatTool = useCallback(
    (call: ToolCall, opts?: { onProgress?: (fraction: number) => void }): Promise<ChatToolRender> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        activeRenderRequestId.current = requestId; // so Stop can interrupt this render
        // Only a genuinely dead/HMR worker times out — a SLOW render must not (a Hi-Res / low-VRAM
        // render can take many minutes, and the worker keeps the job alive via queue-aware polling).
        // Each progress tick RE-ARMS the deadline, so an actively-rendering job is never killed and
        // its finished image is never dropped; the long backstop only fires on true silence.
        let timeout: ReturnType<typeof setTimeout>;
        const done = (r: ChatToolRender): void => {
          clearTimeout(timeout);
          if (activeRenderRequestId.current === requestId) activeRenderRequestId.current = undefined;
          resolve(r);
        };
        const arm = (): void => {
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            if (chatToolRequests.current.delete(requestId)) {
              done({ error: "The image render timed out — the engine stopped responding. Try again." });
            }
          }, 1_200_000); // 20 min of SILENCE (no progress, no result) ⇒ the worker/engine is dead
        };
        arm();
        chatToolRequests.current.set(requestId, {
          resolve: done,
          onProgress: (fraction) => {
            arm(); // the engine is alive and working — push the deadline out
            opts?.onProgress?.(fraction);
          },
        });
        send({ type: "chatTool", requestId, call });
      }),
    [],
  );
  const chatVideo = useCallback(
    (
      call: Extract<BuddyToolCall, { tool: "generate_video" }>,
      image: { bytes: ArrayBuffer; mimeType: string } | undefined,
      models: VideoModelFiles,
      params: VideoRenderParams | undefined,
      opts?: { onProgress?: (fraction: number) => void; warmBatch?: boolean; keepResident?: boolean; endImage?: { bytes: ArrayBuffer; mimeType: string } },
    ): Promise<ChatToolRender> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        activeRenderRequestId.current = requestId; // so Stop can interrupt this render
        // Video is even slower than an image — re-arm the silence deadline on every progress tick so an
        // actively-rendering clip is never killed; the long backstop only fires on true engine silence.
        let timeout: ReturnType<typeof setTimeout>;
        const done = (r: ChatToolRender): void => {
          clearTimeout(timeout);
          if (activeRenderRequestId.current === requestId) activeRenderRequestId.current = undefined;
          resolve(r);
        };
        const arm = (): void => {
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            if (chatToolRequests.current.delete(requestId)) {
              done({ error: "The video render timed out — the engine stopped responding. Try again." });
            }
          }, 1_200_000);
        };
        arm();
        chatToolRequests.current.set(requestId, {
          resolve: done,
          onProgress: (fraction) => {
            arm();
            opts?.onProgress?.(fraction);
          },
        });
        // Bytes travel zero-copy to the worker (the source frame + the optional end frame).
        // Text-to-video sends no image.
        send(
          {
            type: "chatVideo",
            requestId,
            call,
            models,
            ...(image ? { image } : {}),
            ...(opts?.endImage ? { endImage: opts.endImage } : {}),
            ...(params ? { params } : {}),
            ...(opts?.warmBatch ? { warmBatch: true } : {}),
            ...(opts?.keepResident ? { keepResident: true } : {}),
          },
          [...(image ? [image.bytes] : []), ...(opts?.endImage ? [opts.endImage.bytes] : [])],
        );
      }),
    [],
  );
  const assessImage = useCallback(
    (image: { bytes: ArrayBuffer; mimeType: string }, question?: string): Promise<{ text?: string; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (assessRequests.current.delete(requestId)) resolve({ error: "Looking at the screen timed out." });
        }, 120_000);
        assessRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "assessImage", requestId, image, ...(question ? { question } : {}) }, [image.bytes]);
      }),
    [],
  );
  const sendBuddyEmail = useCallback(
    (call: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] }): Promise<{ id?: string; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (emailRequests.current.delete(requestId)) resolve({ error: "Sending the email timed out." });
        }, 60_000);
        emailRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "buddySendEmail", requestId, call });
      }),
    [],
  );
  const runCodingAgents = useCallback(
    (
      runId: string,
      agents: { title: string; instructions: string; dir: string }[],
      onAgentTool: (call: BuddyToolCall, cwd: string, agentIdx: number) => Promise<BuddyToolResultPayload>,
      onProgress?: (text: string) => void,
    ): Promise<{ results?: { title: string; result: string }[]; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        agentToolHandler.current = onAgentTool;
        activeCodingAgentsRequestId.current = requestId;
        codingAgentsRequests.current.set(requestId, {
          resolve: (r) => {
            agentToolHandler.current = undefined;
            if (activeCodingAgentsRequestId.current === requestId) activeCodingAgentsRequestId.current = undefined;
            resolve(r);
          },
          ...(onProgress ? { onProgress } : {}),
        });
        send({ type: "runCodingAgents", requestId, runId, agents });
      }),
    [],
  );
  const resolveConflicts = useCallback(
    (
      agentTitle: string,
      files: { file: string; base: string; ours: string; theirs: string }[],
    ): Promise<{ files?: { file: string; content: string }[]; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (conflictRequests.current.delete(requestId)) resolve({ error: "conflict resolution timed out" });
        }, 5 * 60_000);
        conflictRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "resolveConflicts", requestId, agentTitle, files });
      }),
    [],
  );
  const chatCancel = useCallback(() => {
    const id = activeChatRequestId.current;
    if (id !== undefined) send({ type: "chatCancel", requestId: id });
    // Also interrupt a standalone image render in flight (an approved generate_image runs under its
    // OWN requestId, after the chat turn ended — so cancelling only the turn left it rendering).
    const rid = activeRenderRequestId.current;
    if (rid !== undefined) send({ type: "chatCancel", requestId: rid });
  }, []);
  const warmLlm = useCallback(() => send({ type: "warmLlm" }), []);
  const buddyChat = useCallback(
    (
      history: ChatTurn[],
      userText: string,
      persona: BuddyPersona,
      library: BookSummary[],
      onEvent: (e: BuddyStreamEvent) => void,
      workingDir?: string,
      taskPlanId?: string,
      currentCodeFile?: { name: string; title: string; language?: string },
      plan?: BuddyPlan,
      appManagedSteps?: boolean,
    ): Promise<BuddyDoneResult> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        activeBuddyRequestId.current = requestId;
        // Same SILENCE watchdog as `chat`: never caps a streaming reply, only fires
        // on a truly silent (wedged/stale) worker; Stop handles a normal interrupt.
        let timer: ReturnType<typeof setTimeout>;
        const fail = () => {
          if (buddyRequests.current.delete(requestId)) {
            send({ type: "chatCancel", requestId });
            if (activeBuddyRequestId.current === requestId) activeBuddyRequestId.current = undefined;
            resolve({ text: "", transcript: [], error: "The chat went quiet for too long — try again, or press Stop." });
          }
        };
        const bump = () => {
          clearTimeout(timer);
          timer = setTimeout(fail, CHAT_SILENCE_MS);
        };
        bump();
        buddyRequests.current.set(requestId, {
          onEvent: (e) => {
            bump();
            onEvent(e);
          },
          bump,
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
        });
        send({ type: "buddyChat", requestId, history, userText, persona, library, ...(workingDir ? { workingDir } : {}), ...(taskPlanId ? { taskPlanId } : {}), ...(currentCodeFile ? { currentCodeFile } : {}), ...(plan ? { plan } : {}), ...(appManagedSteps ? { appManagedSteps: true } : {}) });
      }),
    [],
  );
  const buddyCancel = useCallback(() => {
    const id = activeBuddyRequestId.current;
    if (id !== undefined) send({ type: "chatCancel", requestId: id });
    // Also interrupt a standalone image render the buddy kicked off (runs under its own requestId).
    const rid = activeRenderRequestId.current;
    if (rid !== undefined) send({ type: "chatCancel", requestId: rid });
    // And a parallel coding-agent run — its cancel type existed in the protocol but nothing sent it,
    // so Stop couldn't end a run.
    const cid = activeCodingAgentsRequestId.current;
    if (cid !== undefined) send({ type: "codingAgentCancel", requestId: cid });
  }, []);
  const summarize = useCallback(
    (turns: ChatTurn[]): Promise<{ text?: string; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (summarizeRequests.current.delete(requestId)) {
            resolve({ error: "Compacting timed out — try again." });
          }
        }, 120_000);
        summarizeRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "summarize", requestId, turns });
      }),
    [],
  );
  const googleConnect = useCallback(
    (args: { code: string; redirectUri: string; codeVerifier: string }): Promise<{ ok: boolean; email?: string; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (googleConnectRequests.current.delete(requestId)) resolve({ ok: false, error: "Connecting timed out." });
        }, 60_000);
        googleConnectRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "googleConnect", requestId, ...args });
      }),
    [],
  );
  const schwabConnect = useCallback(
    (args: { code: string; redirectUri: string }): Promise<{ ok: boolean; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (schwabConnectRequests.current.delete(requestId)) resolve({ ok: false, error: "Connecting timed out." });
        }, 60_000);
        schwabConnectRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "schwabConnect", requestId, ...args });
      }),
    [],
  );
  const schwabPlaceOrder = useCallback(
    (order: Record<string, unknown>): Promise<{ ok: boolean; status?: number; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (schwabOrderRequests.current.delete(requestId)) resolve({ ok: false, error: "Order timed out." });
        }, 30_000);
        schwabOrderRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "schwabPlaceOrder", requestId, order });
      }),
    [],
  );
  const planTask = useCallback(
    (args: {
      source: TaskSource;
      sourceText: string;
      /** Re-plan an existing task in place (a scan stub or a refresh) instead of adding a new one. */
      planId?: string;
      /** The reader explicitly asked for this plan, so let the planner search/read their files. */
      allowFiles?: boolean;
      /** Optional safety timeout (ms). The background sweep sets one so a single wedged plan can't
       * hang the whole queue forever; the manual/user path leaves it off (deep planning is fine). */
      timeoutMs?: number;
      onProgress?: (phase: string, note?: string) => void;
    }): Promise<{ ok: boolean; plan?: TaskPlan; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        // NO timeout by default: deep planning can take a long time, and it usually runs while
        // you're away. A timeoutMs (the background sweep) caps a wedged run so it can't stall the
        // sweep loop forever — the worker still answers later (ignored), and the turn is cancellable.
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (args.timeoutMs) {
          timer = setTimeout(() => {
            if (planRequests.current.delete(requestId)) {
              send({ type: "chatCancel", requestId });
              resolve({ ok: false, error: "Planning timed out." });
            }
          }, args.timeoutMs);
        }
        planRequests.current.set(requestId, {
          resolve: (r) => {
            if (timer) clearTimeout(timer);
            resolve(r);
          },
          ...(args.onProgress ? { onProgress: args.onProgress } : {}),
        });
        send({
          type: "planTask",
          requestId,
          source: args.source,
          sourceText: args.sourceText,
          ...(args.planId ? { planId: args.planId } : {}),
          ...(args.allowFiles ? { allowFiles: true } : {}),
        });
      }),
    [],
  );
  const scanInbox = useCallback(
    (): Promise<{ ok: boolean; candidates?: TaskCandidate[]; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (scanRequests.current.delete(requestId)) resolve({ ok: false, error: "Scan timed out." });
        }, 60_000);
        scanRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "scanInbox", requestId });
      }),
    [],
  );
  const importGoogleTasks = useCallback(
    (): Promise<{ ok: boolean; imported?: number; edited?: number; mirrored?: number; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (importTaskRequests.current.delete(requestId)) resolve({ ok: false, error: "Importing Google Tasks timed out." });
        }, 60_000);
        importTaskRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "importGoogleTasks", requestId });
      }),
    [],
  );
  const createGoogleTask = useCallback(
    (args: { title: string; notes?: string; due?: string }): Promise<{ ok: boolean; id?: string; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (createTaskRequests.current.delete(requestId)) resolve({ ok: false, error: "Creating the Google Task timed out." });
        }, 30_000);
        createTaskRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "createGoogleTask", requestId, title: args.title, ...(args.notes ? { notes: args.notes } : {}), ...(args.due ? { due: args.due } : {}) });
      }),
    [],
  );
  const createEvent = useCallback(
    (args: { summary: string; start: string; end: string; description?: string; location?: string }): Promise<{ ok: boolean; id?: string; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (createEventRequests.current.delete(requestId)) resolve({ ok: false, error: "Creating the event timed out." });
        }, 30_000);
        createEventRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({
          type: "createEvent",
          requestId,
          summary: args.summary,
          start: args.start,
          end: args.end,
          ...(args.description ? { description: args.description } : {}),
          ...(args.location ? { location: args.location } : {}),
        });
      }),
    [],
  );
  const loadCalendar = useCallback(
    (timeMin: string, timeMax: string): Promise<{ ok: boolean; events?: CalendarEvent[] }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (calendarRequests.current.delete(requestId)) resolve({ ok: false });
        }, 60_000);
        calendarRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "loadCalendar", requestId, timeMin, timeMax });
      }),
    [],
  );
  const stockQuote = useCallback(
    (symbol: string): Promise<{ ok: boolean; quote?: StockQuote }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (quoteRequests.current.delete(requestId)) resolve({ ok: false });
        }, 20_000);
        quoteRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "stockQuote", requestId, symbol });
      }),
    [],
  );
  const readPage = useCallback(
    (url: string): Promise<{ ok: boolean; page?: PageText; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (pageRequests.current.delete(requestId)) resolve({ ok: false, error: "Timed out loading the page." });
        }, 30_000);
        pageRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "readPage", requestId, url });
      }),
    [],
  );
  const remoteBusList = useCallback(
    (): Promise<{ ok: boolean; commands?: BusCommand[] }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (busListRequests.current.delete(requestId)) resolve({ ok: false });
        }, 20_000);
        busListRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "remoteBusList", requestId });
      }),
    [],
  );
  const remoteBusReply = useCallback(
    (id: string, answer: string): Promise<{ ok: boolean; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (busReplyRequests.current.delete(requestId)) resolve({ ok: false, error: "Timed out." });
        }, 20_000);
        busReplyRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "remoteBusReply", requestId, id, answer });
      }),
    [],
  );
  const marketIndicators = useCallback(
    (symbol: string, interval?: string, range?: string): Promise<{ ok: boolean; indicators?: Indicators }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (indicatorRequests.current.delete(requestId)) resolve({ ok: false });
        }, 20_000);
        indicatorRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "marketIndicators", requestId, symbol, ...(interval ? { interval } : {}), ...(range ? { range } : {}) });
      }),
    [],
  );
  const polishText = useCallback(
    (args: {
      stage: "understand" | "produce";
      mode?: PolishMode;
      freeText: string;
      source: string;
      confirmedPlan?: string;
      onToken?: (delta: string) => void;
    }): { requestId: number; result: Promise<PolishResult> } => {
      const requestId = nextRefRequestId.current++;
      const result = new Promise<PolishResult>((resolve) => {
        // Produce can be slow on a local model — generous, like the buddy timeout.
        const timeout = setTimeout(() => {
          if (polishRequests.current.delete(requestId)) resolve({ error: "The model timed out — try again." });
        }, 180_000);
        polishRequests.current.set(requestId, {
          ...(args.onToken ? { onToken: args.onToken } : {}),
          resolve: (r) => {
            clearTimeout(timeout);
            resolve(r);
          },
        });
        send({
          type: "polish",
          requestId,
          stage: args.stage,
          ...(args.mode ? { mode: args.mode } : {}),
          freeText: args.freeText,
          source: args.source,
          ...(args.confirmedPlan ? { confirmedPlan: args.confirmedPlan } : {}),
        });
      });
      return { requestId, result };
    },
    [],
  );
  const polishCancel = useCallback((requestId: number) => {
    if (polishRequests.current.delete(requestId)) send({ type: "chatCancel", requestId });
  }, []);

  return {
    bible,
    results,
    status,
    bibleStatus,
    workflow,
    avgRenderMs,
    providers,
    vram,
    generating,
    paused,
    openBook,
    closeBook,
    updateBookData,
    startGeneration,
    pause,
    resume,
    pauseBible,
    resumeBible,
    pauseImages,
    resumeImages,
    regenerateStoryboard,
    storySetCadence,
    storyRenderLatest,
    storySetMode,
    regenerateAllImages,
    regenerateImage,
    completeBook,
    rebuildPrompts,
    exportBible,
    importBible,
    importResult,
    clearImportResult,
    setActiveUnit,
    carryOverBible,
    updateCharacter,
    addCharacterReference,
    removeCharacterReference,
    getCharacterReference,
    paintForward,
    testRender,
    assessImage,
    sendBuddyEmail,
    runCodingAgents,
    resolveConflicts,
    chat,
    chatTool,
    chatVideo,
    applyEngineConfig,
    setFileLedger,
    setProjectGuide,
    setActiveDocument,
    chatCancel,
    warmLlm,
    buddyChat,
    buddyCancel,
    summarize,
    googleConnect,
    schwabConnect,
    schwabPlaceOrder,
    planTask,
    scanInbox,
    importGoogleTasks,
    createGoogleTask,
    createEvent,
    loadCalendar,
    stockQuote,
    readPage,
    remoteBusList,
    remoteBusReply,
    startHostBridge,
    stopHostBridge,
    isRemoteClient: !!remoteRef.current,
    setAppSyncHandler,
    sendAppSync,
    /** Set the open book's bible directly — used by a linked phone to apply a synced snapshot. */
    setBible,
    marketIndicators,
    polishText,
    polishCancel,
  };
}

/**
 * Re-home a result's image bytes into a Blob on receipt. The worker transfers
 * the only copy of the bytes here, and the UI keeps EVERY page's result for the
 * whole session — as ArrayBuffers that's hundreds of MB of pinned JS heap on a
 * long book, while a Blob's data is browser-managed (it can spill out of the
 * heap, and object URLs are made from a Blob anyway).
 */
function toDisplayResult(result: ImageResult): DisplayResult {
  if (!result.image) return result;
  const { image, ...rest } = result;
  return {
    ...rest,
    image: { blob: new Blob([image.bytes], { type: image.mimeType }), mimeType: image.mimeType },
  };
}

/** Trigger a browser download of a JSON string. */
function downloadJson(json: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
