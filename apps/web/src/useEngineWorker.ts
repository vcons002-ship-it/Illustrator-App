import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BookPassage,
  BookSearchHit,
  BookSource,
  BookSummary,
  BuddyPersona,
  BuddyToolCall,
  CharacterPatch,
  ChatTurn,
  ContextUsage,
  ImageResult,
  AnalyzeChart,
  DataTable,
  ImageSearchHit,
  CalendarEvent,
  ImportStats,
  PolishMode,
  TaskCandidate,
  TaskPlan,
  TaskSource,
  ToolCall,
  VisualBible,
  WebSearchHit,
} from "@visual-reader/core";
import { planRetention } from "@visual-reader/core";
import {
  identitySettingsKey,
  tuningSettingsKey,
  type DisplayResult,
  type ProvidersDiagnostics,
  type ReaderSettings,
} from "@visual-reader/ui";

export interface ImportResult {
  ok: boolean;
  stats?: ImportStats;
  error?: string;
}
import type { MainToWorker, WorkerToMain } from "./worker-protocol.js";
import { desktopHttpFetch, isDesktop } from "./runtime.js";

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
  /** Have the chat's vision model describe a captured screenshot. */
  assessImage: (
    image: { bytes: ArrayBuffer; mimeType: string },
    question?: string,
  ) => Promise<{ text?: string; error?: string }>;
  /** Abort the in-flight chat round, if any. */
  chatCancel: () => void;
  /** Landing-page buddy: one user message (no book open; streams via `onEvent`). */
  buddyChat: (
    history: ChatTurn[],
    userText: string,
    persona: BuddyPersona,
    library: BookSummary[],
    onEvent: (e: BuddyStreamEvent) => void,
    workingDir?: string,
    taskPlanId?: string,
  ) => Promise<BuddyDoneResult>;
  /** Abort the in-flight buddy round, if any. */
  buddyCancel: () => void;
  /** Compact a chat: summarize the model-facing turns into a continuation brief. */
  summarize: (turns: ChatTurn[]) => Promise<{ text?: string; error?: string }>;
  /** Finish Google OAuth in the worker (exchange the consent code for tokens). */
  googleConnect: (args: { code: string; redirectUri: string; codeVerifier: string }) => Promise<{ ok: boolean; email?: string; error?: string }>;
  /** Research + plan a task into a persisted TaskPlan (progress streamed via onProgress). */
  planTask: (args: { source: TaskSource; sourceText: string; onProgress?: (phase: string, note?: string) => void }) => Promise<{ ok: boolean; plan?: TaskPlan; error?: string }>;
  /** Idle scan: actionable email/calendar items as task candidates. */
  scanInbox: () => Promise<{ ok: boolean; candidates?: TaskCandidate[] }>;
  /** Load events across all Google calendars in a window (the calendar grid). */
  loadCalendar: (timeMin: string, timeMax: string) => Promise<{ ok: boolean; events?: CalendarEvent[] }>;
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
      error?: string;
    }
  /** A buddy tool opened a book — the app should open it (and start visuals). */
  | { kind: "opened"; book: BookSource; visuals: boolean }
  /** Where the request's context budget is going (for the usage donut). */
  | { kind: "usage"; usage: ContextUsage }
  /** remove_library_book deleted a book — the app should refresh its library. */
  | { kind: "libraryChanged" }
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
  const nextRefRequestId = useRef(1);
  // In-flight playground renders, resolved by `testRendered` replies.
  const testRequests = useRef<
    Map<number, { resolve: (result: TestRenderResult) => void; onProgress?: (fraction: number) => void }>
  >(new Map());
  const assessRequests = useRef<Map<number, (r: { text?: string; error?: string }) => void>>(new Map());
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
  // In-flight task-plan requests (resolved by `planned`, progress via `planProgress`).
  const planRequests = useRef<
    Map<number, { resolve: (r: { ok: boolean; plan?: TaskPlan; error?: string }) => void; onProgress?: (phase: string, note?: string) => void }>
  >(new Map());
  // In-flight idle scans, resolved by `scanned`.
  const scanRequests = useRef<Map<number, (r: { ok: boolean; candidates?: TaskCandidate[] }) => void>>(new Map());
  // In-flight calendar loads, resolved by `calendarLoaded`.
  const calendarRequests = useRef<Map<number, (r: { ok: boolean; events?: CalendarEvent[] }) => void>>(new Map());
  // In-flight document-polish stages, resolved by `polished` (and streamed via `polishToken`).
  const polishRequests = useRef<
    Map<number, { onToken?: (delta: string) => void; resolve: (r: PolishResult) => void }>
  >(new Map());

  const send = (msg: MainToWorker, transfer: Transferable[] = []) =>
    workerRef.current?.postMessage(msg, transfer);

  useEffect(() => {
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
    // worker = no badges, no generation, endless "painting…").
    worker.onerror = (e: ErrorEvent) => {
      setStatus(
        `Error: engine worker crashed — ${e.message || "module failed to load"}` +
          (e.filename ? ` (${e.filename}:${e.lineno})` : ""),
      );
    };
    worker.onmessageerror = () => setStatus("Error: engine worker sent an undecodable message");
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const msg = event.data;
      switch (msg.type) {
        case "corsFetch": {
          // Worker → Rust shell relay (workers can't reach the Tauri bridge).
          // desktopHttpFetch never rejects; failures travel back as { error }.
          void desktopHttpFetch(msg.request).then((r) =>
            send({ type: "corsFetchResult", fetchId: msg.fetchId, ...r }),
          );
          break;
        }
        case "status":
          setStatus(msg.message);
          break;
        case "providers":
          setProviders(msg.diagnostics);
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
        case "buddyLibraryChanged": {
          buddyRequests.current.get(msg.requestId)?.onEvent({ kind: "libraryChanged" });
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
          resolve?.({ ok: msg.ok, ...(msg.candidates ? { candidates: msg.candidates } : {}) });
          break;
        }
        case "calendarLoaded": {
          const resolve = calendarRequests.current.get(msg.requestId);
          calendarRequests.current.delete(msg.requestId);
          resolve?.({ ok: msg.ok, ...(msg.events ? { events: msg.events } : {}) });
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

  useEffect(() => {
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
        refRequests.current.set(requestId, resolve);
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
        testRequests.current.set(requestId, {
          resolve,
          ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
        });
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
        // A dead/HMR worker can't answer — surface a timeout so the approval flow
        // doesn't spin on "Generating the image…" forever (M5).
        const timeout = setTimeout(() => {
          if (chatToolRequests.current.delete(requestId)) {
            resolve({ error: "The image render timed out — try again." });
          }
        }, 180_000);
        chatToolRequests.current.set(requestId, {
          resolve: (r) => {
            clearTimeout(timeout);
            resolve(r);
          },
          ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
        });
        send({ type: "chatTool", requestId, call });
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
  const chatCancel = useCallback(() => {
    const id = activeChatRequestId.current;
    if (id !== undefined) send({ type: "chatCancel", requestId: id });
  }, []);
  const buddyChat = useCallback(
    (
      history: ChatTurn[],
      userText: string,
      persona: BuddyPersona,
      library: BookSummary[],
      onEvent: (e: BuddyStreamEvent) => void,
      workingDir?: string,
      taskPlanId?: string,
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
        send({ type: "buddyChat", requestId, history, userText, persona, library, ...(workingDir ? { workingDir } : {}), ...(taskPlanId ? { taskPlanId } : {}) });
      }),
    [],
  );
  const buddyCancel = useCallback(() => {
    const id = activeBuddyRequestId.current;
    if (id !== undefined) send({ type: "chatCancel", requestId: id });
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
  const planTask = useCallback(
    (args: {
      source: TaskSource;
      sourceText: string;
      onProgress?: (phase: string, note?: string) => void;
    }): Promise<{ ok: boolean; plan?: TaskPlan; error?: string }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (planRequests.current.delete(requestId)) resolve({ ok: false, error: "Planning timed out." });
        }, 240_000);
        planRequests.current.set(requestId, {
          resolve: (r) => {
            clearTimeout(timeout);
            resolve(r);
          },
          ...(args.onProgress ? { onProgress: args.onProgress } : {}),
        });
        send({ type: "planTask", requestId, source: args.source, sourceText: args.sourceText });
      }),
    [],
  );
  const scanInbox = useCallback(
    (): Promise<{ ok: boolean; candidates?: TaskCandidate[] }> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        const timeout = setTimeout(() => {
          if (scanRequests.current.delete(requestId)) resolve({ ok: false });
        }, 60_000);
        scanRequests.current.set(requestId, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        send({ type: "scanInbox", requestId });
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
    chat,
    chatTool,
    chatCancel,
    buddyChat,
    buddyCancel,
    summarize,
    googleConnect,
    planTask,
    scanInbox,
    loadCalendar,
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
