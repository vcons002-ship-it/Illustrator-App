import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Automatic1111Backend,
  BUNDLED_LLM,
  ComfyUIBackend,
  DirectTransport,
  DEFAULT_LOCAL_TEXT_SERVER,
  IndexedDbStore,
  LocalServerLLMProvider,
  LOCAL_IMAGE_MODELS,
  imageModelVramCostGb,
  LOCAL_TEXT_SERVER_DEFAULT_URL,
  ollamaModelMatches,
  computeBloomTarget,
  composeScenePrompt,
  monotonicBloom,
  decryptSecrets,
  encryptSecrets,
  getImageStyle,
  displayCaption,
  latestSpoilerParagraphIndex,
  panelGroup,
  paragraphIndexFromId,
  parseImportedBible,
  resolveKeyEvent,
  resolvePageEntities,
  spoilerRevealPoint,
  toRenderUnits,
  formatToolResult,
  formatBuddyToolResult,
  planHasPendingStep,
  planQueueResumeFeedback,
  stripToolCallJson,
  toolFailureDirective,
  anchorByParagraph,
  bestParagraphIndex,
  conceptIntroductions,
  subjectFromCaption,
  rankLocalFiles,
  chartDatasetFromTable,
  buildAnalysisTable,
  recalcTable,
  recalcWorkbook,
  setTableCell,
  setColumnFormula,
  parseA1,
  addRow,
  removeRow,
  addColumn,
  removeColumn,
  renameColumn,
  loadSkills,
  saveSkill,
  forgetSkill,
  loadMemory,
  saveMemory,
  MAX_NOTE_CHARS,
  MAX_MEMORY_NOTES,
  loadSoul,
  saveSoul,
  loadSoulName,
  saveSoulName,
  loadSoulImages,
  saveSoulImages,
  MAX_SOUL_NOTES,
  MAX_SOUL_NOTE_CHARS,
  MAX_SOUL_NAME_CHARS,
  loadTaskPlans,
  deleteTaskPlan,
  archiveTaskPlan,
  restoreTaskPlan,
  removeIgnore,
  upsertTaskPlan,
  updateTaskStep,
  setTaskPlanComplete,
  resolveActiveTaskPlanId,
  sessionLabelForPlan,
  agentBranchName,
  parseGitConflicts,
  countChangedFiles,
  hasConflictMarkers,
  loadScheduledTasks,
  upsertScheduledTask,
  deleteScheduledTask,
  advanceSchedule,
  dueScheduledTasks,
  describeSchedule,
  type ScheduledTask,
  loadPriceAlerts,
  upsertPriceAlert,
  deletePriceAlert,
  normalizePriceAlert,
  evaluateAlert,
  advanceAlert,
  describeAlert,
  type PriceAlert,
  advanceStep,
  addIgnore,
  sourceFrom,
  sourceId,
  normalizeTaskPlan,
  exportFilename,
  isNonFiction,
  type ContentMode,
  recordAction,
  loadActionHistory,
  getActionsViewedAt,
  markActionsViewed,
  clearActionHistory,
  unseenCount,
  type ActionEntry,
  type ActionKind,
  nextOccurrence,
  describeRecurrence,
  type TaskRecurrence,
  dedupeCandidates,
  loadIgnored,
  needsAttention,
  taskStubFromCandidate,
  type TaskPlan,
  type TaskCandidate,
  type CalendarEvent,
  type StockQuote,
  type PageText,
  generatePairingToken,
  buildRemoteLinkUrl,
  buildDelegatePrompt,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_DESC_CHARS,
  MAX_SKILL_BODY_CHARS,
  zipProject,
  PROJECT_ZIP_MIME,
  parseDocImages,
  embedDocImages,
  bytesToBase64,
  base64ToBytes,
  generatePkce,
  clearGoogleTokens,
  GOOGLE_SCOPES,
  buildSchwabAuthUrl,
  buildEquityOrder,
  buildOptionOrder,
  describeOrder,
  tvActionScript,
  POLISH_PRESETS,
  type ConceptIntro,
  type PageAnchored,
  type ChapterInfographic,
  type DataTable,
  type JsonValue,
  type ProjectFile,
  type Skill,
  type MemoryNote,
  type SoulNote,
  type SoulKind,
  type SoulImage,
  resolveViewAs,
  type BookViewCategory,
  type BookSource,
  type BookSummary,
  type ChapterDataset,
  type BuddyPersona,
  normalizeBuddyPersona,
  type BuddyPlan,
  type BuddyToolCall,
  type BuddyToolResultPayload,
  type Workflow,
  compileWorkflow,
  evaluateStep,
  advanceWorkflow,
  activeStep,
  isToolContract,
  workflowToPlan,
  workflowParked,
  resumeWorkflow,
  boundChatHistoryForMirror,
  chunkArrayBuffer,
  concatArrayBuffers,
  externalizeChatImages,
  externalizedImageId,
  restoreInlineImages,
  applyFileEdits,
  summarizeFileEdits,
  shouldAutoCompact,
  resolveVideoModelFiles,
  videoModelDownloads,
  VIDEO_MODELS,
  videoModelById,
  type ChatTurn,
  type CreatedFileRef,
  type ContextUsage,
  type EncryptedSecrets,
  type StoreBackup,
  type StoredChatMessage,
  type ToolCall,
  type ToolResultPayload,
} from "@visual-reader/core";
import {
  bookFromText,
  bookFromCode,
  buildIllustratedEpub,
  buildIllustratedHtml,
  buildXlsx,
  dataTableToCsv,
  dataTableToXlsx,
  sheetFromDataTable,
  markdownToBlocks,
  blocksToPdf,
  blocksToDocx,
  DOCX_MIME,
  PDF_MIME,
  type ExportImage,
  type ExportImages,
} from "@visual-reader/epub";
import { IMPORT_ACCEPT, importBookFile, type FileHandler } from "./import-file.js";
import {
  CharacterBible,
  ChatBuddyPanel,
  ChatPanel,
  DataChart,
  Infographic,
  DataTablePreview,
  JsonTreeView,
  SkillsPanel,
  MemoriesPanel,
  SoulPanel,
  StorySetupModal,
  type StoryStartPayload,
  TasksPanel,
  ScheduledTasksPanel,
  CalendarPanel,
  ActivityCenter,
  DownloadStatus,
  ActionHistoryPanel,
  RenameExportModal,
  StockChartPanel,
  BrowserPanel,
  OrderReviewModal,
  type CalendarDeadline,
  DEFAULT_SETTINGS,
  applyLocalModelComponents,
  DocumentPolishPanel,
  FirstRunWizard,
  ImagePanel,
  PanelGrid,
  LibraryPanel,
  SettingsPanel,
  useScrollDepth,
  useNarrow,
  ConceptCard,
  ConceptText,
  DocBlocksView,
  HtmlParagraph,
  ARTICLE_HTML_STYLE,
  InlineFigure,
  SupportRow,
  type DisplayResult,
  type FileActions,
  type FileRef,
  type InstalledModel,
  type LocalBackendId,
  type LocalEngineSource,
  type ProvidersDiagnostics,
  type ReaderSettings,
} from "@visual-reader/ui";
import type { LocalTextServerId } from "@visual-reader/core";
import { loadSampleBook } from "./sample.js";
import { useEngineWorker, type ImportResult, type TestRenderResult } from "./useEngineWorker.js";
import { useActivityLog } from "./useActivityLog.js";
import type { ChatLive, ChatMirror, ChatSendAttachment, CmdToDesktop, EngineInventory, EngineVram, PlannerCommand, PlannerMirror, SyncToPhone } from "./remote-sync.js";
import {
  downloadLora,
  desktopFetch,
  downloadModel,
  ensureEngine,
  ensureLocalLlm,
  gpuVramMb,
  gpuVramUsage,
  restartApp,
  isDesktop,
  listLocalModels,
  listLoras,
  captureScreen,
  loraFamilies,
  onEngineProgress,
  onLlmProgress,
  onModelProgress,
  readLocalFile,
  runCommand,
  whichInterpreter,
  appRepoRoot,
  writeWorkspaceFile,
  readWorkspaceFile,
  delegateCodingTask,
  gitEnsureRepo,
  gitWorktreeCreate,
  gitCommitAll,
  gitWorktreeDiff,
  gitMergeBranch,
  gitMergeAbort,
  gitConflictVersions,
  gitCompleteMerge,
  gitWorktreeRemove,
  pickFolder,
  googleOauthLoopback,
  tvBridgeEval,
  startRemoteServer,
  stopRemoteServer,
  remoteServerStatus,
  openBrowserWindow,
  type RemoteServerStatus,
  saveExportFile,
  searchLocalFiles,
  openPathOnPC,
} from "./runtime.js";

/** Chat-history key for the landing-page buddy's FIRST session — reserved, never a
 * book id. Additional sessions use ids like "__buddy__-<n>". */
const BUDDY_CHAT_ID = "__buddy__";

/** One landing-page chat session: its own history (keyed by id) + working folder. */
interface BuddySession {
  id: string;
  workingDir: string;
  /** A user-set display name; falls back to the folder name, then "Chat N". */
  label?: string;
}

/** Build the universal-file-card descriptor for a generated image so it gets Download / Open-on-PC
 * actions, named from its prompt. */
function imageAttachment(prompt: string, image: { bytes: ArrayBuffer; mimeType: string }): FileRef {
  const ext = image.mimeType.includes("jpeg") ? "jpg" : image.mimeType.includes("webp") ? "webp" : "png";
  const stem =
    (prompt || "image")
      .replace(/[^\w]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image";
  // Stable id so a linked phone can fetch these bytes back on demand after the mirror strips them.
  const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // SHARE the generated image's buffer (no defensive copy): the inline image + this card hold the same
  // bytes, so externalizeChatImages de-dups them to one blob and the in-RAM copy isn't doubled.
  return { id, name: `${stem}.${ext}`, mime: image.mimeType, kind: "image", bytes: image.bytes };
}

/** A downloadable file card for a generated video clip (the chat shows it inline + offers Download). */
function videoAttachment(prompt: string, video: { bytes: ArrayBuffer; mimeType: string }): FileRef {
  const m = video.mimeType;
  const ext = m.includes("mp4") ? "mp4" : m.includes("webm") ? "webm" : m.includes("gif") ? "gif" : "webp";
  const stem =
    (prompt || "video")
      .replace(/[^\w]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "video";
  const id = `vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, name: `${stem}.${ext}`, mime: m, kind: "video", bytes: video.bytes };
}

const DATA_FILE_EXTS = new Set(["csv", "tsv", "json", "xlsx", "xls", "ods", "numbers", "xml", "yaml", "yml"]);
const CODE_FILE_EXTS = new Set([
  "js", "ts", "tsx", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "c", "cc", "cpp", "h", "hpp",
  "cs", "rb", "php", "swift", "sh", "bash", "css", "scss", "html", "htm", "sql", "toml", "ipynb",
]);
/** The display kind for a file the assistant just authored (write_file / a saved doc), from its
 * extension — picks which universal file-card actions show (data grid, code, or document reader). */
function createdFileKind(name: string): FileRef["kind"] {
  const ext = (name.toLowerCase().split(".").pop() ?? "");
  return DATA_FILE_EXTS.has(ext) ? "data" : CODE_FILE_EXTS.has(ext) ? "code" : "doc";
}

/** Is this code book renderable markup (HTML/SVG), so we can show the rendered PAGE — not just the
 * source — in an in-app iframe? Detects by language, title extension, or a sniff of the source. PURE. */
function markupPreviewKind(book: { language?: string; title?: string } | undefined, draft: string): "html" | "svg" | undefined {
  if (!book) return undefined;
  const lang = (book.language ?? "").toLowerCase();
  const title = (book.title ?? "").toLowerCase();
  const head = draft.slice(0, 400);
  if (lang === "svg" || title.endsWith(".svg") || /^\s*<svg[\s>]/i.test(head)) return "svg";
  if (
    ["html", "htm", "xhtml", "xml", "markup"].includes(lang) ||
    title.endsWith(".html") ||
    title.endsWith(".htm") ||
    /<!doctype html|<html[\s>]/i.test(head)
  )
    return "html";
  return undefined;
}

/** Last path segment, for a session's display label (so a folder-bound session reads
 * as its folder name). */
function lastPathSegment(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Message shown when a figure search returns nothing (or errors) — so an empty
 * result is visible instead of looking like the search silently did nothing. */
/** Direct-image extensions for the "just display this URL" shortcut. */
const IMAGE_URL_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)(\?|#|$)/i;
/** Excel workbook MIME for downloads (the OOXML spreadsheet type). */
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** Per-attachment text cap for a chat-attached document — generous (a long report) but bounded
 * so several attachments can't blow the chat's context budget. */
const ATTACH_DOC_MAX_CHARS = 30_000;

/**
 * If a message is really a request to just SHOW a web image (a bare image link, or
 * "show/open/view the image at <link>"), return that URL — so the chat displays it
 * inline instead of trying to open it as a book or running another search.
 */
function pastedImageUrl(text: string): string | undefined {
  const t = text.trim();
  const m =
    /^(?:show|open|view|display|see)?\s*(?:me\s+|the\s+)?(?:image\s+(?:on|at|from)\s+(?:that\s+|this\s+)?(?:link|url|page)?\s*:?\s*)?(https?:\/\/\S+)$/i.exec(
      t,
    );
  const url = m?.[1] ?? (/^https?:\/\/\S+$/i.test(t) ? t : undefined);
  return url && IMAGE_URL_RE.test(url) ? url : undefined;
}

function imageSearchMiss(query: string, error: string | undefined, hasSearchKey: boolean): string {
  if (error) return `⚠ Image search failed for “${query}”: ${error}`;
  return (
    `🔍 No figure found for “${query}”.` +
    (hasSearchKey
      ? ""
      : " (Free image search uses Wikimedia Commons — strong on diagrams/science/history," +
        " weak on pop-culture or specific products. Add a Google Programmable Search key in" +
        " Settings → Scientific sources for whole-web image results.)")
  );
}

/** How many checklist steps are done — used to tell whether a turn advanced the working plan. */
function countDonePlanSteps(plan: BuddyPlan | undefined): number {
  return plan ? plan.steps.filter((s) => s.status === "done").length : 0;
}

export function App() {
  const stored = useMemo(loadStoredSettings, []);
  const [settings, setSettings] = useState<ReaderSettings>(stored.settings);
  // Always-current settings, so engine resolution can read the latest URL/source/backend without
  // re-creating its callbacks on every keystroke (which would refire the resolve effect).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [book, setBook] = useState<BookSource | undefined>();
  // Current book in a ref so callbacks/event handlers (which capture a render-time `book`) can read
  // the live value — e.g. to dedupe a buddy re-open of the book that's already showing.
  const bookRef = useRef(book);
  bookRef.current = book;
  // PHONE: the id of a book the reader CLOSED here, so a passive desktop re-mirror of it (a bible/image
  // update, a story beat, a re-render) doesn't yank them back into it. Cleared when they open something.
  const phoneExitedBookId = useRef<string | undefined>(undefined);
  // Code books open as a full-screen, editable code workspace (run / test / edit in place). `codeDraft`
  // is the live editor text; `codeEditMode` toggles to the illustrated reading view; the run output is
  // shown under the editor. `codeSaveTimer` debounces persisting edits back to the library + workspace.
  const [codeDraft, setCodeDraft] = useState<string>("");
  const [codeEditMode, setCodeEditMode] = useState(true);
  // Show the code book's analysis (glossary of symbols, module map, current illustration) in a side
  // pane alongside the editor, so it's available without leaving the editor for the read view.
  const [codeAnalysisOpen, setCodeAnalysisOpen] = useState(false);
  // Render an HTML/SVG code book IN-APP (a sandboxed iframe) instead of showing its source — "open the
  // page, not just the text". Works on the phone too (plain iframe srcDoc).
  const [codePreviewOpen, setCodePreviewOpen] = useState(false);
  const [codeRunning, setCodeRunning] = useState(false);
  const [codeRunOutput, setCodeRunOutput] = useState<
    { stdout?: string; stderr?: string; code?: number; error?: string; cwd?: string } | undefined
  >();
  const codeSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [localError, setLocalError] = useState<string>("");
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
  // Split-file component files (text encoders / VAEs) the local engine has, for the
  // Settings dropdowns + the model-aware suggestion. Empty for an all-in-one (A1111) engine.
  const [installedTextEncoders, setInstalledTextEncoders] = useState<string[]>([]);
  const [installedVaes, setInstalledVaes] = useState<string[]>([]);
  // Video-graph components, read from the exact ComfyUI node enums (so the Settings dropdowns offer
  // precisely what the engine accepts): Wan diffusion models, the LTX 2× upscaler, the LTX Gemma encoder.
  const [installedDiffusionModels, setInstalledDiffusionModels] = useState<string[]>([]);
  const [installedUpscalers, setInstalledUpscalers] = useState<string[]>([]);
  const [installedLtxTextEncoders, setInstalledLtxTextEncoders] = useState<string[]>([]);
  // Files attached to the next buddy message — docs become text context, images become a
  // vision-model description; both are read by the buddy. Cleared when the message is sent.
  const [buddyAttachments, setBuddyAttachments] = useState<
    {
      id: string;
      name: string;
      kind: "doc" | "image";
      status: "reading" | "ready" | "error";
      error?: string;
      text?: string;
      image?: { bytes: ArrayBuffer; mimeType: string };
    }[]
  >([]);
  const [connectingLocal, setConnectingLocal] = useState(false);
  const [textModels, setTextModels] = useState<InstalledModel[]>([]);
  // The selected Ollama chat model's loaded num_ctx + arch max (from /api/show), so Settings can show
  // the real default/ceiling instead of a blank field. Desktop-fetched; mirrored to the phone.
  const [textModelContext, setTextModelContext] = useState<{ loaded?: number; max?: number } | undefined>();
  const [connectingLocalText, setConnectingLocalText] = useState(false);
  const [modelProgress, setModelProgress] = useState<Record<string, number>>({});
  // Which component file of a split-file model is downloading ("file 2/3: …").
  const [downloadStage, setDownloadStage] = useState<Record<string, string>>({});
  // Per-entry file position, to fold per-file Rust progress into one combined bar.
  const multiFile = useRef<Record<string, { index: number; count: number }>>({});
  const [pullProgress, setPullProgress] = useState<Record<string, { status: string; percent?: number }>>({});
  const [engineStatus, setEngineStatus] = useState("");
  // PHONE-side mirrors of the desktop's model tags + GPU VRAM (the phone has no engine of its own,
  // so its status bar shows what the desktop reports). On the desktop these stay undefined and the
  // status bar reads the live hook values instead.
  const [remoteProviders, setRemoteProviders] = useState<ProvidersDiagnostics | undefined>();
  const [remoteVram, setRemoteVram] = useState<EngineVram | undefined>();
  // Whole-GPU VRAM via nvidia-smi (desktop + NVIDIA): counts ALL processes, so a co-resident LLM
  // is included — the engine's own /system_stats only sees its image-model context. Preferred over
  // the worker's engine reading when present (see `effectiveVram`); undefined ⇒ fall back to it.
  const [gpuVram, setGpuVram] = useState<EngineVram | undefined>();
  // Low-VRAM deferred engine start: at boot we DON'T launch the app-managed ComfyUI (so a large local
  // LLM can take the whole GPU); it spins up on the first image instead. `engineDeferredRef` marks that
  // we skipped the eager start; `managedBaseUrlRef` holds the URL the moment it starts (read race-free,
  // before the React settings sync); `engineStartingRef` coalesces concurrent lazy starts.
  const engineDeferredRef = useRef(false);
  const managedBaseUrlRef = useRef<string | undefined>(undefined);
  const engineStartingRef = useRef<Promise<true | string> | undefined>(undefined);
  const [installedLoras, setInstalledLoras] = useState<string[]>([]);
  const [loraFamilyMap, setLoraFamilyMap] = useState<Record<string, string>>({});
  const [library, setLibrary] = useState<BookSummary[]>([]);
  const libraryStore = useMemo(() => new IndexedDbStore(), []);
  const hydrated = useRef(false);
  const {
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
    openBook: openInWorker,
    closeBook,
    updateBookData,
    startGeneration,
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
    updateCharacter,
    addCharacterReference,
    removeCharacterReference,
    getCharacterReference,
    exportBible,
    importBible,
    importResult,
    clearImportResult,
    carryOverBible,
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
    planTask,
    scanInbox,
    importGoogleTasks,
    createGoogleTask,
    createEvent: createCalendarEvent,
    loadCalendar,
    stockQuote,
    readPage,
    remoteBusList,
    remoteBusReply,
    startHostBridge,
    stopHostBridge,
    isRemoteClient,
    setAppSyncHandler,
    sendAppSync,
    setBible,
    marketIndicators,
    schwabConnect,
    schwabPlaceOrder,
    setActiveUnit,
    polishText,
    polishCancel,
  } = useEngineWorker(settings, libraryStore);
  // The VRAM the status bar shows: prefer the whole-GPU nvidia-smi reading (includes the LLM) when
  // available, else the worker's engine /system_stats reading (image-model context only).
  const effectiveVram = gpuVram ?? vram;
  // The configured local image engine's display name (for the phone's compact engine pill — it can't
  // reach the engine itself, which runs on the desktop).
  const localEngineName = (settings.engineBackend ?? settings.localBackend) === "a1111" ? "AUTOMATIC1111" : "ComfyUI";
  // Poll the whole GPU (nvidia-smi) on desktop so the indicator reflects TOTAL VRAM use — the LLM
  // and the image model — not just the engine's own context. No-op on the phone (it mirrors the
  // desktop) and on web / non-NVIDIA (gpuVramUsage resolves undefined ⇒ fall back to the engine).
  useEffect(() => {
    if (isRemoteClient || !isDesktop) return undefined;
    let cancelled = false;
    let inFlight = false;
    const tick = async (): Promise<void> => {
      if (inFlight) return; // don't stack nvidia-smi spawns if one is slow
      inFlight = true;
      try {
        const v = await gpuVramUsage();
        if (!cancelled) setGpuVram(v);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isRemoteClient]);
  // App-wide activity log (the status center) + a way to drop a reference line into the buddy chat
  // when an out-of-chat button does something, so you can always see what worked. `buddyNoteRef` is
  // a ref so callbacks defined ABOVE the chat plumbing can post a note without a forward reference.
  const { activities, begin: beginActivity } = useActivityLog();
  const buddyNoteRef = useRef<(text: string) => void>(() => {});
  // Persistent agent-action history (survives reloads; the transient activity pill does not). The
  // header badge counts entries since the reader last opened the log.
  const [actionHistory, setActionHistory] = useState<ActionEntry[]>([]);
  const [actionsViewedAt, setActionsViewedAt] = useState(0);
  const [panelNewSince, setPanelNewSince] = useState(0); // snapshot at open: highlights what's new
  const [showActionHistory, setShowActionHistory] = useState(false);
  useEffect(() => {
    void loadActionHistory(libraryStore).then(setActionHistory).catch(() => {});
    void getActionsViewedAt(libraryStore).then(setActionsViewedAt).catch(() => {});
  }, [libraryStore]);
  const logAction = useCallback(
    (kind: ActionKind, label: string, detail?: string) => {
      void recordAction(libraryStore, { kind, label, ...(detail ? { detail } : {}) })
        .then(() => loadActionHistory(libraryStore))
        .then(setActionHistory)
        .catch(() => {});
    },
    [libraryStore],
  );
  const logActionRef = useRef(logAction);
  logActionRef.current = logAction;
  // Google connection status (loaded from stored tokens in an effect below) — declared here so the
  // task-surfacing/planning callbacks can mirror scanned items to Google Tasks.
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleEmail, setGoogleEmail] = useState<string | undefined>();
  const [showCharacters, setShowCharacters] = useState(false);
  const [showData, setShowData] = useState(false);
  // Whether the reader's inline spreadsheet preview is expanded. Lifted out of ReaderColumn (and the
  // raw `<details open>`) so it SURVIVES re-renders/remounts — on a linked phone the frequent vrsync
  // pushes + socket reconnects re-mounted ReaderColumn, which reset an uncontrolled `<details open>`
  // back to open, so a collapse the reader made kept springing back. Defaults open (show the data).
  const [dataPreviewOpen, setDataPreviewOpen] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [showPasteText, setShowPasteText] = useState(false);
  const [showTestImage, setShowTestImage] = useState(false);
  // Photo-transform (img2img) panel + an optional starting photo (from upload / find).
  const [showPhoto, setShowPhoto] = useState(false);
  const [photoInitial, setPhotoInitial] = useState<
    { name: string; bytes: ArrayBuffer; mimeType: string } | undefined
  >();
  // Prefill for the paste modal when a text-bearing FILE (txt/md/html/pdf) was opened.
  const [pasteInitial, setPasteInitial] = useState<
    {
      title: string;
      text: string;
      mode?: "fiction" | "technical";
      data?: DataTable;
      dataSheets?: { name: string; table: DataTable }[];
      tree?: JsonValue;
    } | undefined
  >();
  const [showSkills, setShowSkills] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  // Skills live in the same shared store the worker reads (libraryStore → IndexedDB),
  // so panel edits show up on the assistant's next turn with no extra plumbing.
  const refreshSkills = useCallback(() => {
    // The phone shows the desktop's MIRRORED skills (vrsync:skills); loading its own empty store
    // would clobber them — same guard as Memory/Tasks.
    if (isRemoteClient) return;
    void loadSkills(libraryStore).then(setSkills).catch(() => {});
  }, [libraryStore, isRemoteClient]);
  const openSkills = useCallback(async () => {
    if (!isRemoteClient) await loadSkills(libraryStore).then(setSkills).catch(() => {});
    setShowSkills(true);
  }, [libraryStore, isRemoteClient]);
  // Reader memory — the durable "remember" notes, in the same shared store the worker reads, so
  // panel edits apply on the assistant's next turn (and the buddy's own remember/forget show here).
  const [showMemories, setShowMemories] = useState(false);
  const [memories, setMemories] = useState<MemoryNote[]>([]);
  const refreshMemories = useCallback(() => {
    // The phone shows the desktop's MIRRORED memories (vrsync:memories); loading its own empty
    // store would clobber them — same guard as Tasks.
    if (isRemoteClient) return;
    void loadMemory(libraryStore).then(setMemories).catch(() => {});
  }, [libraryStore, isRemoteClient]);
  const openMemories = useCallback(async () => {
    if (!isRemoteClient) await loadMemory(libraryStore).then(setMemories).catch(() => {});
    setShowMemories(true);
  }, [libraryStore, isRemoteClient]);

  // The two identity "souls" — the assistant's own identity (self) and what it knows about the
  // reader's own character (user). Same shared store the worker reads, edited via the Soul panels.
  const [showSoul, setShowSoul] = useState<SoulKind | undefined>(undefined);
  const [selfSoulNotes, setSelfSoulNotes] = useState<SoulNote[]>([]);
  const [selfSoulName, setSelfSoulName] = useState("");
  const [userSoulNotes, setUserSoulNotes] = useState<SoulNote[]>([]);
  const [userSoulName, setUserSoulName] = useState("");
  const [selfSoulImages, setSelfSoulImages] = useState<SoulImage[]>([]);
  const [userSoulImages, setUserSoulImages] = useState<SoulImage[]>([]);
  const setSoulNotes = (kind: SoulKind, n: SoulNote[]) => (kind === "self" ? setSelfSoulNotes(n) : setUserSoulNotes(n));
  const setSoulName = (kind: SoulKind, n: string) => (kind === "self" ? setSelfSoulName(n) : setUserSoulName(n));
  const setSoulImagesState = (kind: SoulKind, im: SoulImage[]) => (kind === "self" ? setSelfSoulImages(im) : setUserSoulImages(im));
  const openSoul = useCallback(
    async (kind: SoulKind) => {
      await Promise.all([
        loadSoul(libraryStore, kind).then((n) => setSoulNotes(kind, n)),
        loadSoulName(libraryStore, kind).then((n) => setSoulName(kind, n)),
        loadSoulImages(libraryStore, kind).then((im) => setSoulImagesState(kind, im)),
      ]).catch(() => {});
      setShowSoul(kind);
    },
    [libraryStore],
  );
  // A skill the buddy distilled from a recurring task, awaiting the reader's Keep/Dismiss.
  const [pendingSkill, setPendingSkill] = useState<{ name: string; description: string; body: string } | null>(null);
  const keepPendingSkill = useCallback(async () => {
    if (!pendingSkill) return;
    await saveSkill(libraryStore, pendingSkill).catch(() => {});
    setPendingSkill(null);
    refreshSkills();
  }, [pendingSkill, libraryStore, refreshSkills]);
  const [showTasks, setShowTasks] = useState(false);
  const [taskPlans, setTaskPlans] = useState<TaskPlan[]>([]);
  const [planningCount, setPlanningCount] = useState(0);
  // Background-planning idle gate. IDLE = no in-flight process (chat turn / planning / scan / image
  // generation) AND no chat message or user request for IDLE_MS. `lastRequestAt` is bumped by those
  // user actions (NOT raw clicks/scrolling); `processActiveRef` mirrors the in-flight signals so the
  // 90s sweep can read both without re-subscribing. `markUserRequest` is called from each user entry.
  const lastRequestAt = useRef(Date.now());
  const markUserRequest = useCallback(() => {
    lastRequestAt.current = Date.now();
  }, []);
  const processActiveRef = useRef(false);
  // The last per-task plan's outcome (success/steps, or the actual error) — shown in the Tasks
  // panel so clicking "Plan" is never a silent no-op.
  const [planMessage, setPlanMessage] = useState<string | undefined>();
  const refreshTaskPlans = useCallback(() => {
    // The phone shows the desktop's MIRRORED tasks; loading its own (empty) store would clobber them.
    if (isRemoteClient) return;
    void loadTaskPlans(libraryStore).then(setTaskPlans).catch(() => {});
  }, [libraryStore, isRemoteClient]);
  // Load the desktop's saved memories + task plans + skills ONCE on startup, so they're populated
  // BEFORE any panel is opened — and therefore already present in the snapshot/mirror a linked phone
  // receives on connect. Without this they sat [] until the desktop user happened to open each panel
  // (or the buddy edited them), so a freshly-loaded desktop mirrored EMPTY tasks/memories/skills to
  // the phone. All three refreshers no-op on the phone (it owns no store and gets them via the mirror).
  useEffect(() => {
    refreshMemories();
    refreshTaskPlans();
    refreshSkills();
  }, [refreshMemories, refreshTaskPlans, refreshSkills]);
  // On a linked phone, Tasks/Calendar actions are RELAYED to the desktop (which owns the data and
  // re-mirrors the result). Each handler below early-returns through this when isRemoteClient.
  const sendPlanner = useCallback(
    (command: PlannerCommand) => sendAppSync({ type: "vrcmd:planner", command }),
    [sendAppSync],
  );
  // SURFACE the actionable items a scan found as UNPLANNED stubs — they appear in the task list
  // (and their dates on the calendar) with NO LLM work. Planning happens later (the periodic
  // sweep below, or the per-task "Plan" button). Deduped so a re-scan never adds the same item twice.
  // When Google is connected, each new stub is ALSO created as a Google Task right away (a bare
  // parent), so you stay updated on new to-dos on your phone — and because the stub is then linked
  // by googleTaskId, the background planner pushes its sub-tasks + the plan under that same task.
  const addCandidatesAsTasks = useCallback(
    async (cands: TaskCandidate[]) => {
      if (cands.length === 0) return;
      const existing = await loadTaskPlans(libraryStore);
      const fresh = dedupeCandidates(cands, existing, await loadIgnored(libraryStore));
      for (const c of fresh.slice(0, 8)) {
        let googleTaskId: string | undefined;
        if (googleConnected) {
          const created = await createGoogleTask({
            title: c.title,
            ...(c.reason ? { notes: c.reason } : {}),
            ...(c.suggestedDeadlineIso ? { due: c.suggestedDeadlineIso } : {}),
          }).catch(() => ({ id: undefined }));
          googleTaskId = created.id;
        }
        await upsertTaskPlan(
          libraryStore,
          normalizeTaskPlan({ ...taskStubFromCandidate(c), ...(googleTaskId ? { googleTaskId } : {}) }),
        );
      }
      if (fresh.length) refreshTaskPlans();
    },
    [libraryStore, refreshTaskPlans, googleConnected, createGoogleTask],
  );
  // Plan ONE task in place (a scan stub, or a refresh): research + fill its steps, keeping its id.
  // Shared by the per-task "Plan" button (userInitiated → may use the reader's files) and the
  // periodic sweep (background → file access stays gated by the settings).
  const planOneTask = useCallback(
    // `track` registers a status-center entry (+ a buddy note); the sweep passes false because it
    // owns the whole queue's entries itself (so each task shows queued → active → done in order).
    async (planId: string, userInitiated = true, track = true) => {
      if (userInitiated) markUserRequest();
      const plan = (await loadTaskPlans(libraryStore)).find((p) => p.id === planId);
      if (!plan) return;
      const act = track ? beginActivity(`Planning: ${plan.title}`) : undefined;
      if (track) setPlanMessage(`🔄 Planning “${plan.title}”…`);
      setPlanningCount((n) => n + 1);
      try {
        const sourceText = [
          plan.title,
          plan.summary,
          plan.deadlineIso ? `Hard deadline: ${plan.deadlineIso}.` : "",
          // Details the reader added (answers to clarifying questions / new context) — refine with them.
          plan.userNotes ? `Details the reader added (use these to refine the plan): ${plan.userNotes}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        // Background plans (the sweep, userInitiated=false) get a safety timeout so one wedged plan
        // can't stall the whole backlog loop; explicit "Plan it" clicks keep deep planning untimed.
        const res = await planTask({
          source: plan.source,
          sourceText,
          planId,
          ...(userInitiated ? { allowFiles: true } : { timeoutMs: 4 * 60_000 }),
        });
        if (res.ok) refreshTaskPlans();
        const n = res.plan?.steps.length ?? 0;
        act?.finish(res.ok ? { detail: `${n} step${n === 1 ? "" : "s"}` } : { status: "error", detail: res.error ?? "failed" });
        if (res.ok && n > 0) buddyNoteRef.current(`🧩 Planned “${plan.title}” — ${n} step${n === 1 ? "" : "s"}.`);
        if (res.ok) logActionRef.current("plan", `Planned: ${plan.title}`, `${n} step${n === 1 ? "" : "s"}`);
        // Always tell the user the outcome — a per-task plan used to fail/return nothing silently.
        if (track) {
          if (!res.ok) setPlanMessage(`⚠ Couldn't plan “${plan.title}”: ${res.error ?? "the planner failed. Check that a text model is set up in Settings."}`);
          else if (n === 0) setPlanMessage(`⚠ The planner returned no steps for “${plan.title}” — try rephrasing it or adding detail.`);
          else setPlanMessage(`✓ Planned “${plan.title}” — ${n} step${n === 1 ? "" : "s"}. Click it to see the steps.`);
        }
      } catch (e) {
        if (track) setPlanMessage(`⚠ Couldn't plan “${plan.title}”: ${e instanceof Error ? e.message : String(e)}`);
        act?.finish({ status: "error", detail: e instanceof Error ? e.message : String(e) });
      } finally {
        setPlanningCount((n) => Math.max(0, n - 1));
      }
    },
    [libraryStore, planTask, refreshTaskPlans, beginActivity, markUserRequest],
  );
  // Plan the backlog of unplanned stubs, up to `limit` per sweep, SEQUENTIALLY. `keepGoing` lets
  // the caller stop early (e.g. the reader came back) so a long sweep yields instead of grinding on.
  // Every pending item is registered up-front as QUEUED so the status center shows the whole line-up
  // (1. active, 2. queued, 3. queued…) even after you leave the Tasks window.
  const planPendingTasks = useCallback(
    async (limit: number, keepGoing?: () => boolean) => {
      if (limit <= 0) return;
      const pending = (await loadTaskPlans(libraryStore)).filter(needsAttention).slice(0, limit);
      const handles = pending.map((p) => beginActivity(`Planning: ${p.title}`, "queued"));
      for (let i = 0; i < pending.length; i++) {
        if (keepGoing && !keepGoing()) {
          handles.slice(i).forEach((h) => h.finish()); // clear the not-reached queue entries
          break;
        }
        handles[i]!.activate();
        await planOneTask(pending[i]!.id, false, false); // the sweep owns this entry (track=false)
        handles[i]!.finish();
      }
    },
    [libraryStore, planOneTask, beginActivity],
  );
  // Manual "plan the backlog now": plan EVERY unplanned stub on demand (no idle gate), so you can
  // verify the background planner end-to-end — each one researches, fills its steps, and mirrors to
  // Google Tasks. Surfaces progress in the status center + the panel message.
  const planAllPending = useCallback(async () => {
    markUserRequest();
    const pending = (await loadTaskPlans(libraryStore)).filter(needsAttention);
    if (pending.length === 0) {
      setPlanMessage("✓ Nothing to plan — no unplanned tasks in the backlog.");
      return;
    }
    setPlanMessage(`🔄 Planning ${pending.length} pending task${pending.length === 1 ? "" : "s"}… (mirrors to Google Tasks)`);
    await planPendingTasks(pending.length); // no keepGoing → plan the whole backlog
    setPlanMessage(`✓ Planned ${pending.length} task${pending.length === 1 ? "" : "s"} — check Google Tasks for the sub-tasks.`);
  }, [libraryStore, planPendingTasks, markUserRequest]);
  // The most precise "don't surface this" rule for a plan: the exact email/event item, else its
  // sender, else its title as a phrase. Shared by Ignore (adds it) and Restore (removes it).
  const ignoreRuleFor = useCallback((plan: TaskPlan): { kind: "item" | "sender" | "phrase"; value: string } | undefined => {
    const id = sourceId(plan.source);
    const from = sourceFrom(plan.source);
    if (id) return { kind: "item", value: id };
    if (from) return { kind: "sender", value: from };
    if (plan.title) return { kind: "phrase", value: plan.title };
    return undefined;
  }, []);
  // "Don't surface this again" — record the ignore rule AND soft-remove the plan (archive, not hard
  // delete) so it lands in the undoable "Removed" list. Because the archived plan stays "known",
  // future scans/imports skip it too (dedupeCandidates/importableGoogleTasks see ALL plans).
  const ignoreTask = useCallback(
    async (planId: string) => {
      const plan = (await loadTaskPlans(libraryStore)).find((p) => p.id === planId);
      const rule = plan ? ignoreRuleFor(plan) : undefined;
      if (rule) await addIgnore(libraryStore, rule).catch(() => {});
      await archiveTaskPlan(libraryStore, planId, "ignored");
      refreshTaskPlans();
    },
    [libraryStore, refreshTaskPlans, ignoreRuleFor],
  );
  // Soft-remove (the per-card "Remove" button) — archive without a broad ignore rule. Undoable.
  const removeTask = useCallback(
    async (planId: string) => {
      if (!window.confirm("Remove this task? You can restore it from the Removed list.")) return;
      await archiveTaskPlan(libraryStore, planId, "removed");
      refreshTaskPlans();
    },
    [libraryStore, refreshTaskPlans],
  );
  // Undo a removal: un-archive, and if it had been Ignored, drop the ignore rule too so it can
  // surface again.
  const restoreTask = useCallback(
    async (planId: string) => {
      const plan = (await loadTaskPlans(libraryStore)).find((p) => p.id === planId);
      if (plan?.archivedReason === "ignored") {
        const rule = ignoreRuleFor(plan);
        if (rule) await removeIgnore(libraryStore, rule).catch(() => {});
      }
      await restoreTaskPlan(libraryStore, planId);
      refreshTaskPlans();
    },
    [libraryStore, refreshTaskPlans, ignoreRuleFor],
  );
  // Re-attack with new info: the reader adds details to a task (answers to clarifying questions, new
  // context). Store them + flag needsReplan, so the background sweep refines the plan with them at the
  // next opportunity. The detail also goes into the Google Task notes on the next sync (formatPlan…).
  const onAddTaskDetails = useCallback(
    async (planId: string, text: string) => {
      const detail = text.trim();
      if (!detail) return;
      const plan = (await loadTaskPlans(libraryStore)).find((p) => p.id === planId);
      if (!plan) return;
      const userNotes = [plan.userNotes, detail].filter(Boolean).join("\n").slice(0, 4000);
      await upsertTaskPlan(libraryStore, { ...plan, userNotes, needsReplan: true });
      refreshTaskPlans();
      setPlanMessage(`✓ Got it — I'll refine “${plan.title}” with that at the next planning sweep (or click ↻ Refresh plan now).`);
    },
    [libraryStore, refreshTaskPlans],
  );
  // Permanently delete (from the Removed list) — gone for good (a fresh scan/import could surface
  // a still-existing source again later).
  const deleteTaskForever = useCallback(
    async (planId: string) => {
      if (!window.confirm("Permanently delete this task? This can't be undone.")) return;
      await deleteTaskPlan(libraryStore, planId);
      refreshTaskPlans();
    },
    [libraryStore, refreshTaskPlans],
  );
  const openTasks = useCallback(() => {
    // Reload from the store on the desktop; on a linked phone this is a no-op (refreshTaskPlans is
    // gated) so it keeps the desktop-mirrored task list instead of clobbering it with the phone's
    // own empty store.
    refreshTaskPlans();
    setShowTasks(true);
  }, [refreshTaskPlans]);
  // App-managed recurrence: when every step of a REPEATING task is done, roll it forward in place
  // to the next occurrence (steps reset to pending, deadline + step dues shifted by the rule) and
  // create a fresh Google Task for the new cycle — so a repeating to-do comes back once, on cadence,
  // instead of piling up as duplicates. No-op for one-off tasks.
  const maybeRollRecurring = useCallback(
    async (planId: string) => {
      const plan = (await loadTaskPlans(libraryStore)).find((p) => p.id === planId);
      if (!plan?.recurrence) return;
      // An ignored/removed recurring task must never roll forward — ignoring it stops it for good.
      if (plan.status === "archived") return;
      const allDone = plan.steps.length > 0 && plan.steps.every((s) => s.status === "done");
      if (!allDone && plan.status !== "completed") return;
      const next = nextOccurrence(plan, new Date().toISOString().slice(0, 10));
      if (!next) return;
      let googleTaskId: string | undefined;
      if (googleConnected) {
        const created = await createGoogleTask({
          title: next.title,
          ...(next.summary ? { notes: next.summary } : {}),
          ...(next.deadlineIso ? { due: next.deadlineIso } : {}),
        }).catch(() => ({ id: undefined }));
        googleTaskId = created.id;
      }
      await upsertTaskPlan(libraryStore, normalizeTaskPlan({ ...next, id: plan.id, ...(googleTaskId ? { googleTaskId } : {}) }));
      buddyNoteRef.current(
        `🔁 “${plan.title}” repeats ${describeRecurrence(plan.recurrence)} — rolled to the next occurrence (due ${next.deadlineIso}).`,
      );
      refreshTaskPlans();
    },
    [libraryStore, refreshTaskPlans, googleConnected, createGoogleTask],
  );
  const onAdvanceTaskStep = useCallback(
    async (planId: string, stepId: string) => {
      const plan = (await loadTaskPlans(libraryStore)).find((p) => p.id === planId);
      if (!plan) return;
      const step = plan.steps.find((s) => s.id === stepId);
      // advanceStep marks the first non-done step done; only act if that's the one shown.
      if (step && step.status !== "done") {
        await upsertTaskPlan(libraryStore, advanceStep(plan).plan);
        refreshTaskPlans();
        await maybeRollRecurring(planId);
      }
    },
    [libraryStore, refreshTaskPlans, maybeRollRecurring],
  );
  // Toggle ONE specific step done/undone (the timeline checkbox + the detail ticks) — unlike
  // onAdvanceTaskStep this targets any step, not just the next-due one.
  const onToggleStepDone = useCallback(
    async (planId: string, stepId: string, done: boolean) => {
      await updateTaskStep(libraryStore, planId, stepId, { status: done ? "done" : "ready" });
      refreshTaskPlans();
      if (done) await maybeRollRecurring(planId);
    },
    [libraryStore, refreshTaskPlans, maybeRollRecurring],
  );
  // Mark a WHOLE task complete (or reopen it) — the per-card "✓ Complete task" button. Works for a
  // plain to-do with no steps as well as a multi-step plan; completing a repeating task rolls it on.
  const onCompleteTask = useCallback(
    async (planId: string, complete: boolean) => {
      await setTaskPlanComplete(libraryStore, planId, complete);
      refreshTaskPlans();
      if (complete) await maybeRollRecurring(planId);
    },
    [libraryStore, refreshTaskPlans, maybeRollRecurring],
  );
  // Add a task with an optional due date: the assistant researches it and plans the steps
  // (the worker persists the plan), then we honour the user's explicit deadline.
  const [creatingTask, setCreatingTask] = useState(false);
  const onCreateTask = useCallback(
    async (title: string, dueIso?: string, recurrence?: TaskRecurrence, planNow = true) => {
      markUserRequest();
      // "Add as-is": drop a plain to-do straight onto the list — no planner, no LLM. We deliberately
      // leave `planned` UNSET (not false): a `planned:false` stub is what the background sweep auto-
      // plans, but a manual to-do must stay as-is until the user hits "⚡ Plan it". With 0 steps it
      // still shows that button.
      if (!planNow) {
        await upsertTaskPlan(
          libraryStore,
          normalizeTaskPlan({
            title,
            source: { kind: "typed", text: title },
            steps: [],
            ...(dueIso ? { deadlineIso: dueIso } : {}),
            ...(recurrence ? { recurrence } : {}),
          }),
        );
        refreshTaskPlans();
        buddyNoteRef.current(`🗂️ Added to-do “${title}”.`);
        logActionRef.current("create_task", `Added to-do: ${title}`);
        return;
      }
      setCreatingTask(true);
      const act = beginActivity(`Creating task: ${title}`);
      try {
        const repeatNote = recurrence ? `\n\nThis is a recurring task (${describeRecurrence(recurrence)}).` : "";
        const sourceText = (dueIso ? `${title}\n\nHard deadline: ${dueIso}.` : title) + repeatNote;
        const res = await planTask({ source: { kind: "typed", text: title }, sourceText, allowFiles: true });
        if (res.ok && res.plan) {
          if ((dueIso && res.plan.deadlineIso !== dueIso) || recurrence) {
            await upsertTaskPlan(libraryStore, {
              ...res.plan,
              ...(dueIso ? { deadlineIso: dueIso } : {}),
              ...(recurrence ? { recurrence } : {}),
            });
          }
          refreshTaskPlans();
          const n = res.plan.steps.length;
          act.finish({ detail: `${n} step${n === 1 ? "" : "s"}` });
          buddyNoteRef.current(`🗂️ Created & planned task “${title}” — ${n} step${n === 1 ? "" : "s"}.`);
          logActionRef.current("create_task", `Created & planned: ${title}`, `${n} step${n === 1 ? "" : "s"}`);
        } else {
          act.finish({ status: "error", detail: res.error ?? "couldn't plan" });
        }
      } finally {
        setCreatingTask(false);
      }
    },
    [planTask, libraryStore, refreshTaskPlans, beginActivity],
  );
  // Faithful document-polish panel + an optional prefill (from upload or a home click).
  const [showPolish, setShowPolish] = useState(false);
  const [polishInitial, setPolishInitial] = useState<{ title?: string; text?: string } | undefined>();
  const [showLibrary, setShowLibrary] = useState(false);
  // Reading-companion chat (per book; persisted in IndexedDB).
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<StoredChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStreaming, setChatStreaming] = useState("");
  const [chatThinking, setChatThinking] = useState("");
  const [chatActivity, setChatActivity] = useState("");
  const [chatPendingTool, setChatPendingTool] = useState<ToolCall | undefined>();
  const [chatUsage, setChatUsage] = useState<ContextUsage | undefined>();
  // Bumped whenever a turn is superseded (Clear / cancel) so its async completion
  // is ignored — a cancelled turn's late reply (or stray error) can't reappear.
  const chatTurnSeq = useRef(0);
  const buddyTurnSeq = useRef(0);
  const [allowSpoilers, setAllowSpoilers] = useState(false);
  // The pending generate_image's transcript (assistant JSON turn), folded into the
  // history only when the user approves — a dismissed call never reaches the model.
  const pendingTranscript = useRef<ChatTurn[]>([]);
  // Same synchronous double-render guard as the buddy (see buddyRenderingRef): a fast double-click /
  // relayed approve can't fire the in-book render twice.
  const chatRenderingRef = useRef(false);
  // Landing-page buddy (persisted under its own key; finds + opens books via tools).
  const [buddyMessages, setBuddyMessages] = useState<StoredChatMessage[]>([]);
  // The desktop keeps the FULL history (with image bytes) here; a linked phone fetches a stripped
  // card's bytes back by id from this (see the vrcmd:fetchFile handler). Ref so the handler isn't
  // re-bound on every message.
  const buddyMessagesRef = useRef<StoredChatMessage[]>([]);
  buddyMessagesRef.current = buddyMessages;
  const [buddyBusy, setBuddyBusy] = useState(false);
  const [buddyStreaming, setBuddyStreaming] = useState("");
  // Mirror of the live stream, so when a tool fires mid-message we can KEEP any prose the model
  // said first (a briefing) instead of losing it when the turn's final answer replaces the stream.
  const buddyStreamingRef = useRef("");
  const [buddyThinking, setBuddyThinking] = useState("");
  const [buddyActivity, setBuddyActivity] = useState("");
  // A running log of the steps (tools) the buddy takes this turn, so its process is visible.
  const [buddySteps, setBuddySteps] = useState<string[]>([]);
  // The chat's lightweight working checklist (set_plan/complete_step) — a single evolving object per
  // session, shown live and re-injected into the prompt each turn so a paused/failed run resumes from
  // the first unfinished step. NOT a TaskPlan. Persisted per session under `buddy-plan:<id>`.
  const [buddyPlan, setBuddyPlan] = useState<BuddyPlan | undefined>(undefined);
  const buddyPlanRef = useRef<BuddyPlan | undefined>(undefined);
  buddyPlanRef.current = buddyPlan;
  const planMemoKey = (id: string) => `buddy-plan:${id}`;
  // App-managed-steps mode: the host-owned WORKFLOW (the compiled plan + per-step DoneWhen contracts +
  // attempts/status). When active, the app runs the checklist and ticks steps from observed evidence;
  // buddyPlan above becomes a read-only PROJECTION of this (for the prompt + UI). Persisted per session.
  const [buddyWorkflow, setBuddyWorkflow] = useState<Workflow | undefined>(undefined);
  const buddyWorkflowRef = useRef<Workflow | undefined>(undefined);
  buddyWorkflowRef.current = buddyWorkflow;
  const workflowMemoKey = (id: string) => `buddy-workflow:${id}`;
  // Evidence accumulated for the CURRENT step across its turn(s): auto-run tool results (from the
  // worker's toolResult events) + host-tool outcomes (pushed by the approve* handlers) + the settle
  // text. Reset when a step advances. The "collar" (evaluateStep) judges the step from THIS, never the
  // model's claim.
  const buddyStepEvidenceRef = useRef<{ toolResults: { call: BuddyToolCall; result: BuddyToolResultPayload }[]; text: string }>({
    toolResults: [],
    text: "",
  });
  // Whether App-managed steps runs this chat. Opt-in setting (the model's checklist meta-tools are
  // unreliable across models, so the app drives instead). Off → the legacy model-driven path.
  const appManagedActive = !!settings.appManagedSteps;
  // Set + persist the workflow, and mirror its read-only plan projection into buddyPlan (so the prompt,
  // the existing UI, and the phone mirror all advance with it).
  const applyWorkflow = useCallback(
    (wf: Workflow | undefined): void => {
      buddyWorkflowRef.current = wf;
      setBuddyWorkflow(wf);
      const plan = wf ? workflowToPlan(wf) : undefined;
      buddyPlanRef.current = plan;
      setBuddyPlan(plan);
      if (!isRemoteClient && !settings.incognitoRemote) {
        const id = activeBuddyIdRef.current;
        void libraryStore.putMemo?.(workflowMemoKey(id), wf ? JSON.stringify(wf) : "").catch(() => {});
        void libraryStore.putMemo?.(planMemoKey(id), plan ? JSON.stringify(plan) : "").catch(() => {});
      }
    },
    [libraryStore, isRemoteClient, settings.incognitoRemote],
  );
  const loadBuddyPlan = useCallback(
    async (id: string): Promise<BuddyPlan | undefined> => {
      const raw = await libraryStore.getMemo?.(planMemoKey(id)).catch(() => undefined);
      if (!raw) return undefined;
      try {
        const p = JSON.parse(raw) as BuddyPlan;
        return p && Array.isArray(p.steps) && p.steps.length > 0 ? p : undefined;
      } catch {
        return undefined;
      }
    },
    [libraryStore],
  );
  // FILE LEDGER (per session): the workspace files the assistant has written this session, so the worker
  // can keep a terse non-trimmable reminder in the prompt — the model stays aware of what it made and
  // re-opens a file with read_file before editing instead of forgetting it. Persisted per session.
  const createdFilesRef = useRef<CreatedFileRef[]>([]);
  const ledgerMemoKey = (id: string) => `buddy-file-ledger:${id}`;
  /** Record a workspace file the assistant just wrote (write_file). Appends accumulate the line count
   * for the same path; a fresh write replaces it. Bounded + persisted; the next buddy turn pushes it. */
  const recordCreatedFile = useCallback(
    (path: string, contentLines: number, append: boolean): void => {
      const prev = createdFilesRef.current.filter((f) => f.path !== path);
      const existing = createdFilesRef.current.find((f) => f.path === path);
      const lines = append && existing ? existing.lines + contentLines : contentLines;
      const next = [...prev, { path, lines }].slice(-20); // most-recent-last, bounded
      createdFilesRef.current = next;
      setFileLedger(next);
      if (!isRemoteClient && !settings.incognitoRemote) {
        void libraryStore.putMemo?.(ledgerMemoKey(activeBuddyIdRef.current), JSON.stringify(next)).catch(() => {});
      }
    },
    [setFileLedger, libraryStore, isRemoteClient, settings.incognitoRemote],
  );
  const loadFileLedger = useCallback(
    async (id: string): Promise<CreatedFileRef[]> => {
      const raw = await libraryStore.getMemo?.(ledgerMemoKey(id)).catch(() => undefined);
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw) as CreatedFileRef[];
        return Array.isArray(arr) ? arr.filter((f) => f && typeof f.path === "string") : [];
      } catch {
        return [];
      }
    },
    [libraryStore],
  );
  // Restore an app-managed workflow for a session (so a reload mid-run resumes at the active step with
  // its contracts + attempts intact). Empty/blank memo → none.
  const loadBuddyWorkflow = useCallback(
    async (id: string): Promise<Workflow | undefined> => {
      const raw = await libraryStore.getMemo?.(workflowMemoKey(id)).catch(() => undefined);
      if (!raw) return undefined;
      try {
        const w = JSON.parse(raw) as Workflow;
        return w && Array.isArray(w.steps) && w.steps.length > 0 ? w : undefined;
      } catch {
        return undefined;
      }
    },
    [libraryStore],
  );
  const [buddyPersona, setBuddyPersona] = useState<BuddyPersona>("assistant");
  // Multiple landing-page chat SESSIONS — each with its own history (keyed by id) and
  // (desktop) working folder, while skills/memory stay global. Persisted so they
  // survive reloads.
  const [buddySessions, setBuddySessions] = useState<BuddySession[]>([{ id: BUDDY_CHAT_ID, workingDir: "" }]);
  const [activeBuddyId, setActiveBuddyId] = useState(BUDDY_CHAT_ID);
  const buddyWorkingDir = buddySessions.find((s) => s.id === activeBuddyId)?.workingDir ?? "";
  // Live mirrors: a turn dispatched right after opening a task runs before the async
  // refreshTaskPlans lands AND through a useCallback whose deps omit these — reading the
  // refs resolves the active plan from FRESH state instead of a stale captured closure.
  const taskPlansRef = useRef(taskPlans);
  taskPlansRef.current = taskPlans;
  const activeBuddyIdRef = useRef(activeBuddyId);
  activeBuddyIdRef.current = activeBuddyId;
  // Starting a "story as you go" spins up a fresh dedicated session; this remembers the session we
  // came from so exiting the story book returns there. The switch fn is held in a ref because
  // onExitBook is defined far above onSwitchBuddySession (avoids a TDZ in the dep array).
  const storyReturnSessionRef = useRef<string | undefined>(undefined);
  const switchBuddyRef = useRef<((id: string) => void) | undefined>(undefined);
  /** The plan whose execution chat is the active session (the task being "worked"), if any. */
  const activeTaskPlanId = () => resolveActiveTaskPlanId(taskPlansRef.current, activeBuddyIdRef.current);
  const persistSessions = useCallback(
    (sessions: BuddySession[]) => void libraryStore.putMemo?.("buddy-sessions", JSON.stringify(sessions)).catch(() => {}),
    [libraryStore],
  );
  // Rename a chat session (a user-set label that overrides the folder/"Chat N" fallback). Empty
  // clears it back to the fallback.
  const onRenameBuddySession = useCallback(
    (id: string, label: string) => {
      const trimmed = label.trim().slice(0, 60);
      if (isRemoteClient) {
        sendAppSync({ type: "vrcmd:chatRename", id, label: trimmed }); // rename on the desktop
        return;
      }
      setBuddySessions((prev) => {
        const next = prev.map((s) => {
          if (s.id !== id) return s;
          if (trimmed) return { ...s, label: trimmed };
          const { label: _drop, ...rest } = s; // clear → fall back to folder/"Chat N"
          return rest;
        });
        persistSessions(next);
        return next;
      });
    },
    [isRemoteClient, sendAppSync, persistSessions],
  );
  // The active session's working folder ("" = the default VisualReader workspace).
  const setWorkingDir = useCallback(
    (dir: string) => {
      setBuddySessions((prev) => {
        const next = prev.map((s) => (s.id === activeBuddyId ? { ...s, workingDir: dir } : s));
        persistSessions(next);
        return next;
      });
    },
    [activeBuddyId, persistSessions],
  );
  const [buddyPendingTool, setBuddyPendingTool] = useState<BuddyToolCall | undefined>();
  // Phase-2 per-step approval QUEUE for coding agents: when Autonomous workspace is OFF, each agent's
  // write/command waits here for the reader's click while siblings keep running. Display in state;
  // the call+cwd+resolver live in a ref (functions don't belong in render state).
  const [agentApprovals, setAgentApprovals] = useState<{ id: number; title: string; call: BuddyToolCall }[]>([]);
  const agentApprovalCtx = useRef(
    new Map<number, { call: BuddyToolCall; cwd: string; resolve: (r: BuddyToolResultPayload) => void }>(),
  );
  const nextAgentApprovalId = useRef(1);
  const [buddyUsage, setBuddyUsage] = useState<ContextUsage | undefined>();
  // The pending generate_image's transcript, folded in only on approval (same
  // injection guard as the book chat's pendingTranscript).
  const pendingBuddyTranscript = useRef<ChatTurn[]>([]);
  // Synchronous guard against a DOUBLE render: fullAutonomy fire-and-forgets approveGenerateImage
  // while setBuddyPendingTool(undefined) is still an async React update, so a second approval (a
  // manual click, or the phone's vrcmd:chatApproveTool relay) can grab the same pending tool and
  // render again. A ref flips synchronously, so the duplicate is dropped before it can re-enter.
  const buddyRenderingRef = useRef(false);
  // The model-facing history of the turn that produced a pendingTool — so an
  // approved run_command can auto-react with the exact context up to its call.
  const pendingBuddyHistory = useRef<ChatTurn[]>([]);
  // Working-checklist auto-advance budget: while a plan has unfinished steps, the host hands the
  // model another turn so it works straight down the list without the reader typing "continue".
  // Reset on each fresh user turn; `count` caps a runaway chain, `noProgress` stops a stalled one
  // (a step that's actually a question to the reader ticks nothing → halts after one tolerated turn).
  const buddyQueueAdvanceRef = useRef({ count: 0, noProgress: 0 });
  // Session grant for buddy-initiated filesystem search: once the reader picks
  // "Allow this session", later find_files calls run without re-confirming (a
  // direct /find never needed confirming — the reader typed it). Reset on reload.
  const fileAccessGranted = useRef(false);
  // Session grant for buddy screen captures: once the reader picks "Allow this
  // session", later screenshot calls capture without re-prompting (so a test loop
  // can observe a running game without a click each frame). Reset on reload.
  const screenCaptureGranted = useRef(false);
  // The last NUMBERED list the buddy showed (file-search hits or image-search hits),
  // so "open #2" / "show 3" can act on it without re-running the search.
  const lastRefs = useRef<{ kind: "file" | "image"; label: string; path?: string; url?: string }[]>([]);
  // Buddy messages handed into the next opened book's chat (consumed on book change),
  // so a buddy-initiated open continues the conversation inside the reader.
  const buddyHandoff = useRef<StoredChatMessage[] | undefined>(undefined);
  const { registerParagraph, activeParagraphId, activeParagraphProgress } = useScrollDepth();
  // Phone-sized viewport → single-column reader, auto-collapsed toolbar + chat history.
  const narrow = useNarrow(760);
  // Top toolbar's big button row collapses behind a "Tools" caret — default collapsed on phones
  // to reclaim vertical space; the title + Exit book + mode badge stay visible regardless.
  const [toolbarOpen, setToolbarOpen] = useState(() => !narrow);
  // The bottom chat dock keeps its input bar always visible; its message history expands/collapses.
  // Default expanded on desktop, collapsed on phones (the reader gets the room).
  const [chatHistoryOpen, setChatHistoryOpen] = useState(() => !narrow);

  // Decrypt stored keys after mount, then enable persistence. Persisting is gated
  // on hydration so the initial empty-keys render can't clobber the saved keys.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let resolved = stored.settings;
      if (stored.encrypted) {
        try {
          resolved = { ...stored.settings, keys: await decryptSecrets(stored.encrypted) };
        } catch {
          /* key vault unavailable / changed — fall back to no keys */
        }
        if (!cancelled) setSettings(resolved);
      }
      hydrated.current = true;
      void saveSettings(resolved); // re-persist (migrates any legacy plaintext keys)
    })();
    return () => {
      cancelled = true;
    };
  }, [stored]);

  useEffect(() => {
    if (hydrated.current) void saveSettings(settings);
  }, [settings]);

  // Desktop: subscribe to engine-setup and model-download progress (Rust events).
  useEffect(() => {
    if (!isDesktop) return;
    const unEngine = onEngineProgress((p) => {
      setEngineStatus(p.phase === "ready" ? "" : p.percent !== undefined ? `${p.message} ${Math.round(p.percent)}%` : p.message);
    });
    const unModel = onModelProgress((p) => {
      // A split-file model reports per-file percent under one id; fold it into the
      // entry's combined 0..100 using the current file position.
      const mf = multiFile.current[p.id];
      const pct = mf ? ((mf.index + p.percent / 100) / mf.count) * 100 : p.percent;
      setModelProgress((prev) => ({ ...prev, [p.id]: pct }));
    });
    const unLlm = onLlmProgress((p) => {
      setEngineStatus(
        p.phase === "ready"
          ? ""
          : p.percent !== undefined
            ? `${p.message} ${Math.round(p.percent)}%`
            : p.message,
      );
    });
    return () => {
      void unEngine?.then((fn) => fn());
      void unModel?.then((fn) => fn());
      void unLlm?.then((fn) => fn());
    };
  }, []);

  // Desktop: when text is set to the BUILT-IN model, make sure the bundled
  // llama-server is running (downloads/launches on first use) and point the
  // local-server provider at it — mirrors the image-engine setup above.
  useEffect(() => {
    if (
      !isDesktop ||
      settings.textProvider !== "local" ||
      settings.localTextBackend !== "bundled" ||
      settings.localServerTextUrl
    )
      return;
    let cancelled = false;
    void (async () => {
      try {
        setEngineStatus("Starting the built-in model…");
        const { baseUrl, model } = await ensureLocalLlm();
        if (cancelled) return;
        setEngineStatus("");
        // List the running model so the picker isn't empty — and so a LINKED PHONE sees it via the
        // inventory mirror (the phone has no local server to query). The bundled server reports this
        // one model id; without this, textModels stayed [] and the phone showed "connect locally".
        setTextModels([{ id: model, label: BUNDLED_LLM.label }]);
        setSettings((s) => ({ ...s, localServerTextUrl: baseUrl, localServerTextModel: model }));
      } catch (err) {
        if (!cancelled) {
          setEngineStatus("");
          setLocalError(`Built-in model failed to start: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.textProvider, settings.localTextBackend, settings.localServerTextUrl]);

  // Desktop: when the text provider is a LOCAL SERVER (Ollama / LM Studio / llama.cpp) with a saved
  // URL, list its models on load so the picker is populated without a manual reconnect — and so a
  // linked phone (which can't reach the desktop's localhost server) sees the list via the inventory
  // mirror. Best-effort; a wedged/offline server just leaves the list as-is.
  useEffect(() => {
    if (!isDesktop || settings.textProvider !== "local" || settings.localTextBackend !== "server") return;
    const url =
      settings.localServerTextUrl?.trim() ||
      LOCAL_TEXT_SERVER_DEFAULT_URL[settings.localTextServer ?? DEFAULT_LOCAL_TEXT_SERVER];
    if (!url) return;
    let cancelled = false;
    void LocalServerLLMProvider.listModels(url)
      .then((models) => {
        if (!cancelled && models.length) setTextModels(models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settings.textProvider, settings.localTextBackend, settings.localServerTextUrl, settings.localTextServer]);

  // Start (or reuse) the app-managed ComfyUI and load its inventory; point the ACTIVE engine at it
  // (always ComfyUI). Returns `true` on success, or a reason string (`"unavailable"` off the desktop)
  // so the resolver can fall back. Desktop only — `ensureEngine` rejects elsewhere.
  const startManagedEngine = useCallback(async (): Promise<true | string> => {
    if (!isDesktop) return "unavailable";
    try {
      setEngineStatus("Setting up the local engine…");
      // Detect VRAM once: it both caps Auto-quality AND decides --lowvram (best-effort; undefined on
      // non-NVIDIA GPUs leaves Auto uncapped).
      const vram = await gpuVramMb();
      // VRAM- and model-aware --lowvram: offload the big text encoder to system RAM ONLY when the
      // chosen image model won't comfortably fit the GPU. When VRAM is unknown, fall back to the
      // manual Low-VRAM toggle. (fp8 weights stay tied to the toggle separately, in the workflow.)
      const LOWVRAM_HEADROOM_GB = 4; // activations/latents/runtime overhead beyond the weights
      const s = settingsRef.current;
      const modelCostGb = imageModelVramCostGb(s.localModel ?? "");
      const needsLowVram =
        vram === undefined ? !!s.lowVram : modelCostGb > 0 && (modelCostGb + LOWVRAM_HEADROOM_GB) * 1024 > vram;
      const baseUrl = await ensureEngine(needsLowVram);
      const models = await listLocalModels();
      const loras = await listLoras();
      // Detect each LoRA's base architecture (reads only the safetensors header) so the UI can flag
      // one that won't load on the active model.
      const families = await loraFamilies();
      setEngineStatus("");
      setInstalledModels(models);
      setInstalledLoras(loras);
      setLoraFamilyMap(families);
      // The managed engine is ComfyUI — read its text-encoder + VAE files over the HTTP API (same as
      // the "connect" path) so the split-file dropdowns are populated on desktop too.
      try {
        // Through the Rust bridge (CORS-exempt) — the managed engine is desktop-only, and a browser
        // fetch from the packaged app's Tauri-scheme origin would be CORS-blocked (empty dropdowns).
        const engine = new ComfyUIBackend({ baseUrl, transport: new DirectTransport(desktopFetch) });
        const [comps, vid] = await Promise.all([engine.listComponents(), engine.listVideoComponents()]);
        setInstalledTextEncoders(comps.textEncoders);
        setInstalledVaes(comps.vaes);
        setInstalledDiffusionModels(vid.diffusionModels);
        setInstalledUpscalers(vid.upscalers);
        setInstalledLtxTextEncoders(vid.ltxTextEncoders);
      } catch {
        /* leave components empty — the fields fall back to manual entry */
      }
      // Record the URL synchronously (refs don't wait for the React re-render) so a deferred lazy start
      // can hand it straight to the worker, and clear the deferred flag now that the engine is up.
      managedBaseUrlRef.current = baseUrl;
      engineDeferredRef.current = false;
      setSettings((cur) => ({
        ...cur,
        engineBaseUrl: baseUrl,
        engineBackend: "comfyui",
        // Remember the managed ComfyUI URL per-backend so VIDEO routing (comfyUrlForVideo) still finds it
        // even when the user's IMAGE backend is AUTOMATIC1111 — the two engines run side by side.
        localServerUrlByBackend: { ...cur.localServerUrlByBackend, comfyui: baseUrl },
        ...(vram ? { gpuVramMb: vram } : {}),
      }));
      return true;
    } catch (err) {
      setEngineStatus("");
      return err instanceof Error ? err.message : String(err);
    }
  }, []);

  // Probe a self-hosted SD server (ComfyUI/A1111): list its models + components and, on success,
  // point the ACTIVE engine at it (engineBaseUrl + engineBackend) and pick a sensible model. Throws
  // if the server can't be reached (so the resolver / connect handler can fall back).
  const probeServer = useCallback(async (backend: LocalBackendId, url: string): Promise<void> => {
    if (!url) throw new Error("no server URL set");
    // On desktop, reach the server through the Rust HTTP bridge (CORS-exempt) — the same path
    // generation uses. A plain browser fetch is CORS-bound, and in the PACKAGED app the WebView
    // origin is the Tauri custom scheme (not localhost:5173), which a self-hosted A1111/ComfyUI
    // `--cors-allow-origins` set for the dev origin won't match — so the link "stops working" in prod.
    const transport = isDesktop ? new DirectTransport(desktopFetch) : undefined;
    const engine =
      backend === "a1111"
        ? new Automatic1111Backend({ baseUrl: url, ...(transport ? { transport } : {}) })
        : new ComfyUIBackend({ baseUrl: url, ...(transport ? { transport } : {}) });
    const models = await engine.listModels(); // throws when the server is unreachable
    setInstalledModels(models);
    try {
      const comps = await engine.listComponents();
      setInstalledTextEncoders(comps.textEncoders);
      setInstalledVaes(comps.vaes);
      if (engine instanceof ComfyUIBackend) {
        const vid = await engine.listVideoComponents();
        setInstalledDiffusionModels(vid.diffusionModels);
        setInstalledUpscalers(vid.upscalers);
        setInstalledLtxTextEncoders(vid.ltxTextEncoders);
      }
    } catch {
      /* leave components empty (A1111 has none; a ComfyUI miss falls back to manual entry) */
    }
    setSettings((s) => {
      const base: ReaderSettings = {
        ...s,
        engineBaseUrl: url,
        engineBackend: backend,
        // Persist this backend's URL so the OTHER engine's URL survives — video always routes to the
        // remembered ComfyUI URL even while images run on AUTOMATIC1111 (both alive at once).
        localServerUrlByBackend: { ...s.localServerUrlByBackend, [backend]: url },
      };
      // Keep the current model if the server still has it; otherwise pick its first + restore that
      // model's remembered encoder/VAE combo.
      if (s.localModel && models.some((m) => m.id === s.localModel)) return base;
      const localModel = models[0]?.id;
      return localModel ? applyLocalModelComponents(base, localModel) : base;
    });
  }, []);

  // Resolve which local engine actually renders, honouring the user's "Generate on" choice and
  // falling back to the OTHER engine when the chosen one can't be reached (so a wrong server URL no
  // longer dead-ends — it drops to the app-managed ComfyUI, and vice-versa).
  const resolveLocalEngine = useCallback(async (): Promise<void> => {
    const s = settingsRef.current;
    if (s.imageProvider !== "local") return;
    const source: LocalEngineSource = s.localSource ?? (isDesktop ? "managed" : "server");
    const backend = s.localBackend ?? "comfyui";
    const url = (s.localServerUrl ?? "").trim();
    const backendName = backend === "a1111" ? "AUTOMATIC1111" : "ComfyUI";
    setLocalError("");
    // LOW-VRAM deferred start: don't launch the app-managed ComfyUI at boot — a large local LLM can then
    // take the whole GPU. It starts lazily on the first standalone image (ensureRenderEngineReady) or
    // eagerly when a book opens (its bible build needs it). Only the managed paths defer; a configured
    // user server is still probed (it's their process, not ours to schedule). Skipped once a book is open.
    const managedStart = source === "managed" || (source === "server" && !url);
    if (managedStart && isDesktop && s.lowVram && !bookRef.current) {
      engineDeferredRef.current = true;
      return;
    }
    if (source === "server") {
      if (!url) {
        // Nothing configured yet: on desktop start the managed engine; on web just wait for Connect
        // (no error noise before the user has entered anything).
        await startManagedEngine();
        return;
      }
      try {
        await probeServer(backend, url);
        return;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        // Fallback: drop to the app-managed engine when the server can't be reached.
        if ((await startManagedEngine()) === true) {
          setLocalError(`Couldn't reach your ${backendName} server${url ? ` at ${url}` : ""} — using the app-managed engine instead.`);
          return;
        }
        setLocalError(`Couldn't reach your ${backendName} server${url ? ` at ${url}` : ""}: ${why}. Check the URL + that it's running with CORS for ${location.origin}.`);
      }
    } else {
      const managed = await startManagedEngine();
      if (managed === true) return;
      // No managed engine here (or it failed) — fall back to the user's server.
      try {
        await probeServer(backend, url);
        setLocalError(
          managed === "unavailable"
            ? "The app-managed engine needs the Windows desktop app — using your server instead."
            : `The app-managed engine couldn't start (${managed}) — using your server instead.`,
        );
      } catch {
        setLocalError(
          managed === "unavailable"
            ? "The app-managed engine needs the Windows desktop app. Add your own ComfyUI/AUTOMATIC1111 server URL below."
            : `Local engine setup failed: ${managed}`,
        );
      }
    }
  }, [probeServer, startManagedEngine]);

  // Lazily start the deferred (low-VRAM) managed engine before a STANDALONE render, then hand its URL to
  // the worker immediately (applyEngineConfig) so the render — which rebuilds providers fresh from
  // settings — uses it without waiting on the debounced settings sync. No-op when not deferred (already
  // running, a user's own server, or low-VRAM off). Concurrent calls share ONE in-flight start.
  const ensureRenderEngineReady = useCallback(async (): Promise<void> => {
    if (!engineDeferredRef.current) return;
    setEngineStatus("Starting the local image engine…");
    const start = engineStartingRef.current ?? startManagedEngine();
    engineStartingRef.current = start;
    try {
      const res = await start;
      if (res === true && managedBaseUrlRef.current) applyEngineConfig(managedBaseUrlRef.current);
    } finally {
      engineStartingRef.current = undefined;
    }
  }, [startManagedEngine, applyEngineConfig]);

  // LOW-VRAM: when a book opens while the managed engine was deferred, start it now — a bible build needs
  // it, and the full start path rebuilds the book's persistent engine with the real URL (vs. the
  // tune-only flush used for standalone chat/playground renders). Desktop + local-image only.
  useEffect(() => {
    if (!book || !engineDeferredRef.current) return;
    if (!isDesktop || settingsRef.current.imageProvider !== "local") return;
    void startManagedEngine();
  }, [book, startManagedEngine]);

  // Re-resolve the active engine when the local path is chosen and whenever the "Generate on" source
  // changes. NOT on URL keystrokes or a backend-dropdown flip — those are committed explicitly via
  // Connect (so flipping to an unconfigured backend never silently auto-starts a different engine).
  // `resolveLocalEngine` is stable, so this only fires on the listed inputs.
  useEffect(() => {
    // A linked phone has NO local engine — it mirrors the desktop's settings (incl. imageProvider:
    // "local"), but the engine runs on the desktop. Probing here would hit the PHONE's own
    // 127.0.0.1 and fail with a misleading "couldn't reach ComfyUI / CORS" error. The phone shows a
    // compact engine pill in the status bar instead (see the isRemoteClient badge branch).
    if (isRemoteClient) return;
    if (settings.imageProvider !== "local") return;
    void resolveLocalEngine();
  }, [isRemoteClient, settings.imageProvider, settings.localSource, resolveLocalEngine]);

  // Desktop: list the app-managed engine's installed image models on startup with a CHEAP folder scan
  // (no need to boot ComfyUI), so the picker + the phone-link inventory are populated immediately —
  // even before the engine resolves, and even when the image provider is currently CLOUD (so the
  // phone can still see + switch to a local model). Skipped for a user's OWN server (its models live
  // on the server and are listed by probeServer instead, not in the managed folder).
  useEffect(() => {
    if (!isDesktop || settings.localSource === "server") return;
    let cancelled = false;
    void (async () => {
      try {
        const [models, loras] = await Promise.all([listLocalModels(), listLoras()]);
        if (cancelled) return;
        if (models.length) setInstalledModels(models);
        if (loras.length) setInstalledLoras(loras);
      } catch {
        /* managed engine not installed yet — nothing to list */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.localSource]);

  // Download a catalog model: every component file of a split-file model (diffusion
  // model + text encoder + VAE, each into its ComfyUI subfolder), or the single
  // checkpoint. Sequential, with one combined progress bar; already-present files
  // are skipped on the Rust side, so a retry resumes where it failed. On success
  // the model is auto-selected so it "just works".
  // For the unified download indicator: a friendly label for a progress key (catalog id / filename), and
  // the set of video component filenames to suppress (they download under their model's parent row).
  const downloadLabelFor = useCallback(
    (key: string): string | undefined =>
      videoModelById(key)?.label ?? LOCAL_IMAGE_MODELS.find((m) => m.id === key)?.label,
    [],
  );
  const videoChildFiles = useMemo(() => {
    const s = new Set<string>();
    for (const m of VIDEO_MODELS) for (const d of m.downloads) s.add(d.filename);
    return s;
  }, []);
  const isVideoChildFile = useCallback((key: string) => videoChildFiles.has(key), [videoChildFiles]);

  const onDownloadModel = useCallback(async (id: string) => {
    const model = LOCAL_IMAGE_MODELS.find((m) => m.id === id);
    if (!model) return;
    const files = model.files ?? [{ filename: model.filename, url: model.url, folder: "checkpoints" as const }];
    setModelProgress((prev) => ({ ...prev, [id]: 0 }));
    let currentFile = files[0]!.filename;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        currentFile = f.filename;
        multiFile.current[id] = { index: i, count: files.length };
        if (files.length > 1) {
          setDownloadStage((prev) => ({ ...prev, [id]: `file ${i + 1}/${files.length}: ${f.filename}` }));
        }
        await downloadModel({ id, filename: f.filename, url: f.url, folder: f.folder });
        setModelProgress((prev) => ({ ...prev, [id]: ((i + 1) / files.length) * 100 }));
      }
      setInstalledModels(await listLocalModels());
      setSettings((s) => applyLocalModelComponents(s, model.filename));
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setLocalError(
        `Model download failed at ${currentFile}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Retrying skips files that finished.`,
      );
    } finally {
      delete multiFile.current[id];
      setDownloadStage((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, []);

  // Download an image-to-video model's files (Wan 2.2: two experts + encoder + VAE) into ComfyUI's
  // diffusion_models / text_encoders / vae folders, with the same per-file progress as image models.
  const onDownloadVideoModel = useCallback(async (id: string) => {
    const files = videoModelDownloads(id);
    if (files.length === 0) return;
    setModelProgress((prev) => ({ ...prev, [id]: 0 }));
    let currentFile = files[0]!.filename;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        currentFile = f.filename;
        multiFile.current[id] = { index: i, count: files.length };
        setDownloadStage((prev) => ({ ...prev, [id]: `file ${i + 1}/${files.length}: ${f.filename}` }));
        // Report progress under the MODEL id (not the filename) so the per-file Rust progress folds into
        // the model's single combined bar (multiFile above) — matching onDownloadModel. Using the filename
        // as the id breaks the fold (the bar sits at 0% until each file finishes) and the live per-file
        // progress lands on a child-file key the download indicator hides, so it looks like nothing happens.
        await downloadModel({ id, filename: f.filename, url: f.url, folder: f.folder });
        setModelProgress((prev) => ({ ...prev, [id]: ((i + 1) / files.length) * 100 }));
      }
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setLocalError(`Video model download failed at ${currentFile}: ${err instanceof Error ? err.message : String(err)}. Retrying skips finished files.`);
    } finally {
      delete multiFile.current[id];
      setDownloadStage((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, []);

  // Download a text model INTO Ollama from the Settings menu (no terminal needed),
  // with live progress; on success refresh the model list and auto-select it.
  const onPullTextModel = useCallback(
    async (model: string) => {
      const url =
        settings.localServerTextUrl?.trim() ||
        LOCAL_TEXT_SERVER_DEFAULT_URL[settings.localTextServer ?? DEFAULT_LOCAL_TEXT_SERVER];
      setLocalError("");
      setPullProgress((prev) => ({ ...prev, [model]: { status: "starting…" } }));
      try {
        await LocalServerLLMProvider.pullModel(url, model, (p) =>
          setPullProgress((prev) => ({ ...prev, [model]: p })),
        );
        const models = await LocalServerLLMProvider.listModels(url);
        setTextModels(models);
        const installed = models.find((m) => ollamaModelMatches(m.id, model))?.id ?? model;
        setSettings((s) => ({ ...s, localServerTextUrl: url, localServerTextModel: installed }));
      } catch (err) {
        setLocalError(
          `Couldn't download ${model}: ${err instanceof Error ? err.message : String(err)}. ` +
            `Make sure Ollama is running (it resumes where it left off).`,
        );
      } finally {
        setPullProgress((prev) => {
          const next = { ...prev };
          delete next[model];
          return next;
        });
      }
    },
    [settings.localServerTextUrl, settings.localTextServer],
  );

  // Download the LoRA for a style into the managed engine — from the catalog URL,
  // or a URL the user pasted (customUrl). Saved as the style's LoRA name.
  const onDownloadStyleLora = useCallback(async (styleId: string, customUrl?: string) => {
    const lora = getImageStyle(styleId).local?.lora;
    if (!lora) return;
    const url = customUrl?.trim() || lora.url;
    if (!url) return;
    const id = lora.name;
    const filename = lora.filename ?? `${lora.name}.safetensors`;
    setModelProgress((prev) => ({ ...prev, [id]: 0 }));
    try {
      await downloadLora({ id, filename, url });
      setModelProgress((prev) => ({ ...prev, [id]: 100 }));
      setInstalledLoras(await listLoras());
      setLoraFamilyMap(await loraFamilies());
      setSettings((s) => ({ ...s })); // refresh providers so the engine picks it up
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setLocalError(`Style pack download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // Download a checkpoint from a pasted URL into the managed engine.
  const onDownloadModelUrl = useCallback(async (url: string) => {
    const clean = url.trim();
    if (!clean) return;
    const filename = fileNameFromUrl(clean);
    setModelProgress((prev) => ({ ...prev, [filename]: 0 }));
    try {
      await downloadModel({ id: filename, filename, url: clean });
      setModelProgress((prev) => ({ ...prev, [filename]: 100 }));
      setInstalledModels(await listLocalModels());
      setSettings((s) => ({ ...s }));
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[filename];
        return next;
      });
      setLocalError(`Model download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // Connect to a self-hosted engine (AUTOMATIC1111 / ComfyUI): probe it, switch to the "server"
  // source, and remember the URL UNDER its backend so flipping the dropdown later restores it. On
  // failure, fall back to the app-managed engine (desktop) instead of dead-ending.
  const onConnectLocalServer = useCallback(
    async (backend: LocalBackendId, url: string) => {
      setLocalError("");
      setConnectingLocal(true);
      const name = backend === "a1111" ? "AUTOMATIC1111" : "ComfyUI";
      // Persist the choice + per-backend URL memory whether or not the probe succeeds, so the field
      // keeps what the user typed and the dropdown restores it next time.
      const remember = (s: ReaderSettings): ReaderSettings => ({
        ...s,
        localSource: "server",
        localBackend: backend,
        localServerUrl: url,
        localServerUrlByBackend: { ...(s.localServerUrlByBackend ?? {}), [backend]: url },
      });
      try {
        await probeServer(backend, url); // sets engineBaseUrl/engineBackend/models on success
        setSettings(remember);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        setSettings(remember);
        // Fallback so a bad URL doesn't leave the user with no engine.
        if ((await startManagedEngine()) === true) {
          setLocalError(`Couldn't reach ${name} at ${url} — using the app-managed engine instead. (${why})`);
        } else {
          setLocalError(
            `Couldn't reach ${name} at ${url}: ${why}. Make sure it's running with its API and CORS enabled for ${location.origin}.`,
          );
        }
      } finally {
        setConnectingLocal(false);
      }
    },
    [probeServer, startManagedEngine],
  );

  // Connect to a local LLM server (Ollama / LM Studio / llama.cpp), load its model
  // list, and remember it for next time. A direct fetch is fine in the web app
  // (the browser calls localhost); the extension equivalent passes a proxy transport.
  const onConnectLocalTextServer = useCallback(async (server: LocalTextServerId, url: string) => {
    setLocalError("");
    setConnectingLocalText(true);
    try {
      const models = await LocalServerLLMProvider.listModels(url);
      setTextModels(models);
      setSettings((s) => {
        const keep = s.localServerTextModel && models.some((m) => m.id === s.localServerTextModel);
        const localServerTextModel = keep ? s.localServerTextModel : models[0]?.id;
        return {
          ...s,
          localTextServer: server,
          localServerTextUrl: url,
          ...(localServerTextModel ? { localServerTextModel } : {}),
        };
      });
    } catch (err) {
      setLocalError(
        `Couldn't reach ${server} at ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Make sure it's running, and (for Ollama in a browser) set OLLAMA_ORIGINS to ${location.origin}.`,
      );
    } finally {
      setConnectingLocalText(false);
    }
  }, []);

  // Ping the sub-agent "worker" endpoint (vLLM/llama.cpp/Ollama) and report the models it serves, so
  // Settings can confirm the tier is live before you rely on it. Same direct-fetch path as the local
  // text-server connect above (the browser calls localhost); GET /models is the OpenAI-compatible probe.
  const onTestSubAgentEndpoint = useCallback(
    async (url: string): Promise<{ ok: boolean; models?: string[]; error?: string }> => {
      try {
        const models = await LocalServerLLMProvider.listModels(url);
        return { ok: true, models: models.map((m) => m.id) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [],
  );

  const openBook = useCallback(
    (source: BookSource) => {
      setLocalError("");
      setBook(source);
      openInWorker(source);
      // Remember it in the library so it can be reopened later (Bible + images
      // are already cached, so switching back is instant).
      void libraryStore
        .putBook(source)
        .then(() => libraryStore.listBooks())
        .then(setLibrary)
        .catch(() => {});
    },
    [openInWorker, libraryStore],
  );

  // Change the open book's view category (the reader's drop-down): only "story" shows the illustration
  // window; the rest render the text/data/code full-screen. A pure render switch (no engine re-open —
  // the worker isn't illustrating until the reader hits Start), persisted on the book so it sticks.
  const setViewAs = useCallback(
    (cat: BookViewCategory) => {
      setBook((cur) => {
        if (!cur) return cur;
        const next = { ...cur, viewAs: cat };
        bookRef.current = next;
        void libraryStore
          .putBook(next)
          .then(() => libraryStore.listBooks())
          .then(setLibrary)
          .catch(() => {});
        return next;
      });
      if (cat === "code") setCodeEditMode(true); // the code view IS the full-screen editor
    },
    [libraryStore],
  );

  // Apply an edit to the open spreadsheet's active table (the chosen sheet, and `data`
  // when it aliases that sheet), persist the book, and push the new table(s) to the
  // worker so the chat's analyze_data sees the change. All grid edits route through here.
  const mutateBookTable = useCallback(
    (sheetIndex: number | null, fn: (t: DataTable) => DataTable) => {
      // Edit, then recompute formula cells so the grid + chat see live results.
      const apply = (t: DataTable) => recalcTable(fn(t));
      setBook((prev) => {
        if (!prev) return prev;
        let next: BookSource;
        if (sheetIndex !== null && prev.dataSheets) {
          const sheets = prev.dataSheets.map((s, i) => (i === sheetIndex ? { ...s, table: apply(s.table) } : s));
          next = { ...prev, dataSheets: sheets, ...(sheets[0] ? { data: sheets[0].table } : {}) };
        } else if (prev.data) {
          next = { ...prev, data: apply(prev.data) };
        } else {
          return prev;
        }
        void libraryStore.putBook(next).catch(() => {});
        updateBookData({
          ...(next.data ? { data: next.data } : {}),
          ...(next.dataSheets ? { dataSheets: next.dataSheets } : {}),
        });
        return next;
      });
    },
    [libraryStore, updateBookData],
  );
  // Cell + structure edits for the data grid (sheetIndex is null for a single table).
  const dataEdit = useMemo(
    () => ({
      onEditCell: (s: number | null, r: number, c: number, raw: string) => mutateBookTable(s, (t) => setTableCell(t, r, c, raw)),
      onAddRow: (s: number | null) => mutateBookTable(s, (t) => addRow(t)),
      onDeleteRow: (s: number | null, r: number) => mutateBookTable(s, (t) => removeRow(t, r)),
      onAddColumn: (s: number | null) => mutateBookTable(s, (t) => addColumn(t)),
      onDeleteColumn: (s: number | null, c: number) => mutateBookTable(s, (t) => removeColumn(t, c)),
      onRenameColumn: (s: number | null, c: number, name: string) => mutateBookTable(s, (t) => renameColumn(t, c, name)),
    }),
    [mutateBookTable],
  );

  // Add a LIVE statistical Analysis sheet to the open workbook: a new tab whose
  // cells are cross-sheet formulas over the primary sheet's data, recomputed in place
  // (so it updates as the data changes). Converts a single-table import into a
  // two-sheet workbook; re-running replaces the existing Analysis tab.
  const addAnalysisSheet = useCallback(() => {
    setBook((prev) => {
      if (!prev?.data) return prev;
      const base = prev.dataSheets && prev.dataSheets.length > 0 ? prev.dataSheets : [{ name: "Sheet1", table: prev.data }];
      const primary = base[0]!;
      const analysis = buildAnalysisTable(primary.table, primary.name);
      if (!analysis) return prev; // nothing numeric to analyse
      const withoutOld = base.filter((s) => s.name !== "Analysis");
      const sheets = recalcWorkbook([...withoutOld, { name: "Analysis", table: analysis }]);
      const next: BookSource = { ...prev, dataSheets: sheets, ...(sheets[0] ? { data: sheets[0].table } : {}) };
      void libraryStore.putBook(next).catch(() => {});
      updateBookData({ ...(next.data ? { data: next.data } : {}), dataSheets: sheets });
      return next;
    });
  }, [libraryStore, updateBookData]);

  // Transient "✓ your click did X" feedback, so a Redo press is never ambiguous.
  // (Declared up here because handlers below — mode toggle, redo — depend on it.)
  const [actionNote, setActionNote] = useState("");
  const actionNoteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteAction = useCallback((text: string) => {
    setActionNote(text);
    if (actionNoteTimer.current) clearTimeout(actionNoteTimer.current);
    actionNoteTimer.current = setTimeout(() => setActionNote(""), 8000);
  }, []);

  // Switch the book between STORY and TECHNICAL analysis. Re-opens the book with
  // the new mode (cheap; restores cache) — but the existing bible was built for
  // the OLD mode, so the action note points at Redo → Story analysis.
  const onToggleContentMode = useCallback(() => {
    if (!book) return;
    const next: BookSource = {
      ...book,
      contentMode: book.contentMode === "technical" ? "fiction" : "technical",
    };
    openBook(next); // persists to the library + re-opens in the worker
    noteAction(
      `✓ Now a ${next.contentMode === "technical" ? "TECHNICAL" : "STORY"} book — run ↻ Redo → Story analysis to rebuild the analysis for this mode.`,
    );
  }, [book, openBook, noteAction]);

  // Exit the current book back to the landing page (the buddy/home screen). The
  // book stays in the library; this just closes the reader and stops generation.
  const onExitBook = useCallback(() => {
    chatCancel(); // stop any in-flight chat turn before its book is torn down
    setShowChat(false);
    setShowCharacters(false);
    // On a linked phone, remember which book we closed so the desktop's passive re-mirrors don't reopen it.
    if (isRemoteClient) phoneExitedBookId.current = bookRef.current?.id;
    // Exiting a "story as you go" returns to the chat session we started it from (its history intact);
    // the dedicated story session is kept in the list so the book can be resumed later.
    const ret = storyReturnSessionRef.current;
    storyReturnSessionRef.current = undefined;
    if (ret && bookRef.current?.kind === "story") switchBuddyRef.current?.(ret);
    setBook(undefined);
    closeBook();
  }, [closeBook, chatCancel, isRemoteClient]);

  // Load the library on mount (recent books to switch between).
  useEffect(() => {
    void libraryStore.listBooks().then(setLibrary).catch(() => {});
  }, [libraryStore]);

  const onPickBook = useCallback(
    async (id: string) => {
      if (!id || id === book?.id) return;
      // On a linked phone, opening happens on the DESKTOP (which then pushes the book back).
      if (isRemoteClient) {
        phoneExitedBookId.current = undefined; // an explicit re-open clears the "closed it" guard
        sendAppSync({ type: "vrcmd:open", bookId: id });
        return;
      }
      try {
        const source = await libraryStore.getBook(id);
        if (source) openBook(source);
      } catch {
        /* ignore */
      }
    },
    [book, libraryStore, openBook, isRemoteClient, sendAppSync],
  );

  const onRemoveBook = useCallback(
    (id: string) => {
      if (isRemoteClient) {
        // The desktop OWNS the library; a phone-local delete is just re-clobbered by the next
        // vrsync:library push. Relay it so the desktop deletes + re-pushes the trimmed library.
        sendAppSync({ type: "vrcmd:libraryDelete", bookId: id });
        return;
      }
      void libraryStore
        .removeBook(id)
        .then(() => libraryStore.listBooks())
        .then(setLibrary)
        .catch(() => {});
    },
    [libraryStore, isRemoteClient, sendAppSync],
  );

  // PHONE MIRROR: a linked phone shows exactly what THIS desktop shows — its library, the open
  // book, that book's analysis (bible), and the render-affecting settings. The desktop is the
  // source of truth and pushes its state down the relay; the phone renders it and sends back
  // high-level commands (open a library book, go home). The engine stays on the desktop, so
  // illustrate/analyse/chat the phone triggers run here and stream their results back — the phone
  // never needs its own image model or data. (`isRemoteClient` ⇒ this tab IS the phone.)
  const [remoteHost, setRemoteHost] = useState<string | undefined>();
  // The desktop engine's inventory, bundled so the phone's model/component/LoRA pickers mirror it.
  // Read the selected Ollama model's real context window (Modelfile num_ctx + arch max) so Settings
  // can show "default 40960 · max 262144" instead of a blank field. Desktop-only (the phone can't
  // reach the desktop's Ollama directly); it receives this through the mirrored inventory.
  useEffect(() => {
    if (isRemoteClient) return;
    const server = settings.localTextServer ?? "ollama";
    const url = settings.localServerTextUrl;
    const model = settings.localServerTextModel;
    if (settings.localTextBackend !== "server" || server !== "ollama" || !url || !model) {
      setTextModelContext(undefined);
      return;
    }
    let cancelled = false;
    void LocalServerLLMProvider.contextLength(url, model)
      .then((info) => {
        if (!cancelled) setTextModelContext(info ?? undefined);
      })
      .catch(() => {
        if (!cancelled) setTextModelContext(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [isRemoteClient, settings.localTextServer, settings.localServerTextUrl, settings.localServerTextModel, settings.localTextBackend]);
  const engineInventory = useMemo(
    (): EngineInventory => ({
      installedModels,
      installedTextEncoders,
      installedVaes,
      installedLoras,
      loraFamilies: loraFamilyMap,
      textModels,
      engineStatus,
      ...(providers ? { providers } : {}),
      ...(textModelContext ? { textModelContext } : {}),
    }),
    [installedModels, installedTextEncoders, installedVaes, installedLoras, loraFamilyMap, textModels, engineStatus, providers, textModelContext],
  );
  // The planner (tasks + calendar) state is declared lower in the file, so the hello snapshot and
  // the phone's apply-handler reach it through refs kept current by effects below (the same pattern
  // as buildSnapshotRef / refreshCalendarRef).
  const plannerMirrorRef = useRef<PlannerMirror>({
    tasks: [],
    calendarEvents: [],
    calendarMonth: new Date().toISOString(),
    calendarLoading: false,
    googleConnected: false,
  });
  const applyPlannerRef = useRef<(p: PlannerMirror) => void>(() => {});
  const plannerCommandRef = useRef<(c: PlannerCommand) => void>(() => {});
  // The landing-page chat (buddy) lives lower in the file too, so the hello snapshot + the phone's
  // apply-handler + the desktop's relayed-command runner reach it through refs (same pattern as the
  // planner). `chatMirrorRef` holds the latest mirror for the snapshot; `applyChatRef` is the phone's
  // adopt-the-desktop's-chat setter; `chatCommandRef` runs a phone-relayed chat command on the desktop.
  const chatMirrorRef = useRef<ChatMirror>({ sessions: [], activeId: "", messages: [], persona: "assistant", busy: false });
  const applyChatRef = useRef<(c: ChatMirror) => void>(() => {});
  const chatCommandRef = useRef<(c: CmdToDesktop) => void>(() => {});
  // The live in-flight-turn state (streaming/thinking/activity/steps/pending approvals/usage) — held
  // in a ref so the connect snapshot carries it and the throttled push effect can land a trailing
  // send; `applyChatLiveRef` is the phone's adopt-the-live-state setter.
  const chatLiveRef = useRef<ChatLive>({ streaming: "", thinking: "", activity: "", steps: [], agentApprovals: [] });
  const applyChatLiveRef = useRef<(l: ChatLive) => void>(() => {});
  const chatLiveSentAt = useRef(0);
  const chatLiveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // DESKTOP: open a PC file (that the phone tapped in a /find result) as a book — assigned below,
  // since the importer/openBook are declared later; the early-registered relay handler reaches it here.
  const openLocalFileRef = useRef<(path: string) => void>(() => {});
  // Phone-triggered software update: the DESKTOP runs it via this ref (assigned below, since
  // onSoftwareUpdate is declared later); the PHONE holds the in-flight request here so a relayed
  // vrsync:updateStatus can resolve it + reload.
  const runUpdateForPhoneRef = useRef<() => void>(() => {});
  type UpdateResult = { status: "uptodate" | "updated" | "needs-restart" | "error"; message: string };
  const phoneUpdatePending = useRef<{ resolve: (r: UpdateResult) => void; onProgress: (m: string) => void } | undefined>(
    undefined,
  );
  // Desktop-runtime host tools (find_files/run_command/write_file/screenshot) the PHONE relays here:
  // the desktop runs them via runHostToolForRemoteRef and replies vrsync:hostToolResult, resolved
  // through this per-requestId map.
  const runHostToolForRemoteRef = useRef<(call: BuddyToolCall, cwd?: string) => Promise<BuddyToolResultPayload>>(async () => ({}));
  const hostToolPending = useRef(new Map<number, (p: BuddyToolResultPayload) => void>());
  // PHONE: lazy image-card fetches awaiting the desktop's vrsync:fileData reply, keyed by reqId.
  const fileFetchPending = useRef(new Map<number, (r: { bytes?: ArrayBuffer; mime?: string }) => void>());
  // Partial chunks of an in-flight chunked file fetch (vrsync:fileData), keyed by reqId.
  const fileChunkBufs = useRef(new Map<number, { parts: (ArrayBuffer | undefined)[]; got: number; mime?: string }>());
  // PHONE: inline-image bytes fetched back for stripped messages, kept by attachment id so the restored
  // picture survives the mirror re-pushing its image-less version; plus the ids being fetched right now.
  const restoredImages = useRef(new Map<string, { bytes: ArrayBuffer; mimeType: string }>());
  const fetchingImageIds = useRef(new Set<string>());
  // DESKTOP: blob keys (`${chatId}::${id}`) already written to the chat blob store this session, so the
  // debounced persist doesn't re-write the same image bytes on every subsequent turn.
  const writtenBlobIds = useRef(new Set<string>());
  const fileFetchSeq = useRef(0);
  const hostToolReqId = useRef(0);
  const buildSnapshot = useCallback(
    (): SyncToPhone => ({
      type: "vrsync:state",
      host: "this desktop",
      library,
      settings,
      inventory: engineInventory,
      planner: plannerMirrorRef.current,
      chat: chatMirrorRef.current,
      live: chatLiveRef.current,
      memories,
      skills,
      ...(book ? { book } : {}),
      ...(bible ? { bible } : {}),
      ...(effectiveVram ? { vram: effectiveVram } : {}),
    }),
    [library, settings, engineInventory, book, bible, memories, skills, effectiveVram],
  );
  // PHONE side: adopt the desktop's mirrored inventory so the local-model pickers show the SAME
  // installed models/components the desktop has (the phone has no engine to enumerate).
  const applyInventory = useCallback((inv: EngineInventory) => {
    setInstalledModels(inv.installedModels);
    setInstalledTextEncoders(inv.installedTextEncoders);
    setInstalledVaes(inv.installedVaes);
    setInstalledLoras(inv.installedLoras);
    setLoraFamilyMap(inv.loraFamilies);
    setTextModels(inv.textModels);
    setEngineStatus(inv.engineStatus);
    setRemoteProviders(inv.providers);
    setTextModelContext(inv.textModelContext);
  }, []);
  const buildSnapshotRef = useRef(buildSnapshot);
  buildSnapshotRef.current = buildSnapshot;
  // Register the relay handler once: the PHONE applies the desktop's state pushes; the DESKTOP
  // answers the phone's commands. (Reads live refs so the single registration stays current.)
  useEffect(() => {
    setAppSyncHandler((msg) => {
      if (isRemoteClient) {
        switch (msg.type) {
          case "vrsync:state":
            setLibrary(msg.library);
            setSettings(msg.settings);
            applyInventory(msg.inventory);
            applyPlannerRef.current(msg.planner);
            applyChatRef.current(msg.chat);
            applyChatLiveRef.current(msg.live);
            setMemories(msg.memories);
            setSkills(msg.skills);
            setBook(msg.book);
            setBible(msg.bible);
            setRemoteVram(msg.vram);
            setRemoteHost(msg.host);
            break;
          case "vrsync:library":
            setLibrary(msg.library);
            break;
          case "vrsync:settings":
            setSettings(msg.settings);
            break;
          case "vrsync:inventory":
            applyInventory(msg);
            break;
          case "vrsync:planner":
            applyPlannerRef.current(msg);
            break;
          case "vrsync:memories":
            setMemories(msg.memories);
            break;
          case "vrsync:skills":
            setSkills(msg.skills);
            break;
          case "vrsync:vram":
            setRemoteVram(msg.vram);
            break;
          case "vrsync:chat":
            applyChatRef.current(msg);
            break;
          case "vrsync:chatLive":
            applyChatLiveRef.current(msg);
            break;
          case "vrsync:book":
            // Don't re-yank the reader into a book they CLOSED on the phone: the desktop keeps it open
            // and re-mirrors it on every bible/image update, story beat, or re-render. Ignore those
            // passive re-pushes of the SAME closed book (a DIFFERENT id is a genuine new open → adopt).
            if (msg.book && msg.book.id === phoneExitedBookId.current && !bookRef.current) {
              setBible(msg.bible); // keep the bible fresh so a re-open is current
              break;
            }
            if (msg.book?.id !== phoneExitedBookId.current) phoneExitedBookId.current = undefined;
            setBook(msg.book);
            setBible(msg.bible);
            break;
          case "vrsync:hostToolResult": {
            // The desktop ran a host tool the phone relayed; hand the result to the waiting request.
            const r = hostToolPending.current.get(msg.requestId);
            if (r) {
              hostToolPending.current.delete(msg.requestId);
              r(msg.payload);
            }
            break;
          }
          case "vrsync:fileData": {
            // The desktop is returning a file's bytes (vrcmd:fetchFile), CHUNKED — accumulate until all
            // `total` pieces arrive, then reassemble and resolve. `total === 0` ⇒ the desktop couldn't find it.
            const r = fileFetchPending.current.get(msg.reqId);
            if (!r) {
              fileChunkBufs.current.delete(msg.reqId); // late chunk after a timeout — drop the partial
              break;
            }
            if (msg.total === 0) {
              fileFetchPending.current.delete(msg.reqId);
              fileChunkBufs.current.delete(msg.reqId);
              r({});
              break;
            }
            let acc = fileChunkBufs.current.get(msg.reqId);
            if (!acc) {
              acc = { parts: new Array<ArrayBuffer | undefined>(msg.total), got: 0 };
              fileChunkBufs.current.set(msg.reqId, acc);
            }
            if (msg.mime) acc.mime = msg.mime;
            if (msg.bytes && acc.parts[msg.seq] === undefined) {
              acc.parts[msg.seq] = msg.bytes;
              acc.got += 1;
            }
            if (acc.got >= msg.total) {
              fileChunkBufs.current.delete(msg.reqId);
              fileFetchPending.current.delete(msg.reqId);
              r({ bytes: concatArrayBuffers(acc.parts as ArrayBuffer[]), ...(acc.mime ? { mime: acc.mime } : {}) });
            }
            break;
          }
          case "vrsync:updateStatus": {
            // Progress/result of an update the phone asked for. "working" → progress; otherwise it's
            // the final outcome — resolve the in-flight request, and reload to the new UI if applied.
            const p = phoneUpdatePending.current;
            if (msg.status === "working") {
              p?.onProgress(msg.message);
            } else {
              phoneUpdatePending.current = undefined;
              p?.resolve({ status: msg.status, message: msg.message });
              if (msg.reload) setTimeout(() => window.location.reload(), 2500);
            }
            break;
          }
          default:
            break; // commands are desktop-bound
        }
      } else {
        switch (msg.type) {
          case "vrcmd:hello":
            sendAppSync(buildSnapshotRef.current());
            break;
          case "vrcmd:open":
            void libraryStore
              .getBook(msg.bookId)
              .then((s) => {
                if (s) openBook(s);
              })
              .catch(() => {});
            break;
          case "vrcmd:libraryDelete":
            // The phone deleted a library book; delete it HERE (we own the library) — our library
            // change-effect then re-pushes vrsync:library WITHOUT the book, so it stays gone.
            void libraryStore
              .removeBook(msg.bookId)
              .then(() => libraryStore.listBooks())
              .then(setLibrary)
              .catch(() => {});
            break;
          case "vrcmd:home":
            setBook(undefined);
            closeBook();
            break;
          case "vrcmd:settings":
            // The phone edited settings (it has no engine of its own); apply them here so the
            // desktop renders with them. Our own change-effect re-mirrors them back to the phone.
            setSettings(msg.settings);
            break;
          case "vrcmd:planner":
            // The phone triggered a Tasks/Calendar action; run it here (we own the data) and the
            // planner mirror re-pushes the result.
            plannerCommandRef.current(msg.command);
            break;
          case "vrcmd:memory":
            // The phone edited the Memory panel; save the whole list HERE (we own the store) — our
            // memories-mirror effect then re-pushes vrsync:memories with the saved result.
            void saveMemory(libraryStore, msg.notes).then(setMemories).catch(() => {});
            break;
          case "vrcmd:skillSave":
            // The phone saved a skill; save it HERE (we own the store) and reload → the skills-mirror
            // effect re-pushes vrsync:skills with the result.
            void saveSkill(libraryStore, { name: msg.name, description: msg.description, body: msg.body })
              .then(() => refreshSkills())
              .catch(() => {});
            break;
          case "vrcmd:skillDelete":
            void forgetSkill(libraryStore, msg.name).then(() => refreshSkills()).catch(() => {});
            break;
          case "vrcmd:chatSend":
          case "vrcmd:chatSwitch":
          case "vrcmd:chatNew":
          case "vrcmd:chatDelete":
          case "vrcmd:chatDeleteMessage":
          case "vrcmd:chatRename":
          case "vrcmd:chatPersona":
          case "vrcmd:chatClear":
          case "vrcmd:chatCancel":
          case "vrcmd:chatApproveTool":
          case "vrcmd:chatDismissTool":
          case "vrcmd:chatAgentApprove":
          case "vrcmd:chatAgentDeny":
            // The phone drove the landing-page chat; run it HERE on our buddy handlers (we own the
            // models + the working folder), and the chat mirror re-pushes the result to the phone.
            chatCommandRef.current(msg);
            break;
          case "vrcmd:chatPlanClear":
            // The phone dismissed the working checklist — clear it HERE (we own it) so the ChatLive
            // mirror stops re-pushing it.
            setBuddyPlan(undefined);
            setBuddyWorkflow(undefined);
            buddyWorkflowRef.current = undefined;
            void libraryStore.deleteMemo?.(planMemoKey(activeBuddyIdRef.current)).catch(() => {});
            void libraryStore.deleteMemo?.(workflowMemoKey(activeBuddyIdRef.current)).catch(() => {});
            break;
          case "vrcmd:update":
            // The phone asked us to update: run the same pull+rebuild+reload, streaming status back.
            runUpdateForPhoneRef.current();
            break;
          case "vrcmd:restart":
            // The phone asked us to fully relaunch (Settings → Restart app on the phone).
            void restartApp().catch(() => {});
            break;
          case "vrcmd:openLocalFile":
            // The phone tapped a desktop file (a /find result) to open into the reader; read + import
            // it HERE (we have the filesystem), and the opened book mirrors back to the phone.
            void openLocalFileRef.current(msg.path);
            break;
          case "vrcmd:hostTool":
            // The phone's buddy hit a desktop-runtime tool (files/command/screenshot); run it HERE
            // (we have the runtime + the working folder) and relay the result back.
            void runHostToolForRemoteRef.current(msg.call, msg.cwd).then((payload) =>
              sendAppSync({ type: "vrsync:hostToolResult", requestId: msg.requestId, payload }),
            );
            break;
          case "vrcmd:fetchFile": {
            // The phone asked for the full bytes of a file card whose bytes the mirror stripped (a large
            // or older generated image). Find it in our FULL history (we kept the bytes) and send it back
            // CHUNKED, so a big image syncs in pieces instead of being dropped for blowing one tunnel frame.
            const reqId = msg.reqId;
            const fileId = msg.id;
            void (async () => {
              let found: { bytes?: ArrayBuffer; mime?: string } | undefined;
              for (const m of buddyMessagesRef.current) {
                const a = m.attachments?.find((x) => x.id === fileId && x.bytes);
                if (a?.bytes) {
                  found = { bytes: a.bytes, mime: a.mime };
                  break;
                }
                // A live (un-stripped) inline image carrying this id also serves the bytes.
                if (m.image && "bytes" in m.image && m.image.id === fileId) {
                  found = { bytes: m.image.bytes, mime: m.image.mimeType };
                  break;
                }
              }
              // After a desktop reload the in-memory messages are byte-less (bytes were externalized) —
              // serve them from the chat blob store instead so the phone can still fetch older images.
              if (!found?.bytes) {
                const blob = await libraryStore.getImageBlob?.(activeBuddyIdRef.current, fileId).catch(() => undefined);
                if (blob) found = { bytes: blob.bytes, mime: blob.mimeType };
              }
              if (!found?.bytes) {
                sendAppSync({ type: "vrsync:fileData", reqId, seq: 0, total: 0 }); // not found
              } else {
                const chunks = chunkArrayBuffer(found.bytes);
                chunks.forEach((chunk, seq) =>
                  sendAppSync({
                    type: "vrsync:fileData",
                    reqId,
                    seq,
                    total: chunks.length,
                    bytes: chunk,
                    ...(seq === 0 && found!.mime ? { mime: found!.mime } : {}),
                  }),
                );
              }
            })();
            break;
          }
          default:
            break;
        }
      }
    });
  }, [isRemoteClient, setAppSyncHandler, sendAppSync, setBible, libraryStore, openBook, closeBook, applyInventory]);
  // Desktop: push each slice of state to a linked phone as it changes — granularly, so a settings
  // tweak doesn't resend the whole book (no-op without a linked phone: `sendAppSync` only writes
  // when the host bridge is open).
  useEffect(() => {
    if (!isRemoteClient) sendAppSync({ type: "vrsync:library", library });
  }, [isRemoteClient, sendAppSync, library]);
  useEffect(() => {
    if (!isRemoteClient) sendAppSync({ type: "vrsync:settings", settings });
  }, [isRemoteClient, sendAppSync, settings]);
  useEffect(() => {
    if (!isRemoteClient) sendAppSync({ type: "vrsync:book", ...(book ? { book } : {}), ...(bible ? { bible } : {}) });
  }, [isRemoteClient, sendAppSync, book, bible]);
  useEffect(() => {
    if (!isRemoteClient) sendAppSync({ type: "vrsync:inventory", ...engineInventory });
  }, [isRemoteClient, sendAppSync, engineInventory]);
  useEffect(() => {
    // Mirror the assistant's remembered notes to a linked phone so its Memory panel isn't empty.
    if (!isRemoteClient) sendAppSync({ type: "vrsync:memories", memories });
  }, [isRemoteClient, sendAppSync, memories]);
  useEffect(() => {
    // Mirror the assistant's saved skills to a linked phone so its Skills panel isn't empty.
    if (!isRemoteClient) sendAppSync({ type: "vrsync:skills", skills });
  }, [isRemoteClient, sendAppSync, skills]);
  useEffect(() => {
    // Tick the phone's VRAM indicator. Its own lightweight push (not folded into the heavier
    // inventory mirror) so a ~4s GPU reading doesn't re-send the whole installed-model inventory.
    if (!isRemoteClient) sendAppSync({ type: "vrsync:vram", ...(effectiveVram ? { vram: effectiveVram } : {}) });
  }, [isRemoteClient, sendAppSync, effectiveVram]);
  // Settings edits: on the desktop, apply locally (it owns the engine). On a linked PHONE, also push
  // the change to the desktop (vrcmd:settings) so the render the phone triggers uses it — the desktop
  // applies it and re-mirrors it back. (The phone applies the desktop's pushes via setSettings
  // directly, so this never loops.)
  const onSettingsChange = useCallback(
    (next: ReaderSettings) => {
      setSettings(next);
      if (isRemoteClient) sendAppSync({ type: "vrcmd:settings", settings: next });
    },
    [isRemoteClient, sendAppSync],
  );

  // In-app software update (desktop): git-pull the latest code, reinstall deps, rebuild the web
  // bundle, then reload the window to apply it. The app serves apps/web/dist (or Vite in dev), so a
  // JS/TS update — almost everything — applies on reload without rebuilding the Rust shell; a core
  // (src-tauri) change is detected and the reader is told to fully relaunch to finish it.
  const onSoftwareUpdate = useCallback(
    async (
      onProgress: (msg: string) => void,
    ): Promise<{ status: "uptodate" | "updated" | "needs-restart" | "error"; message: string }> => {
      if (!isDesktop) return { status: "error", message: "Updates need the desktop app." };
      const token = settings.keys?.github || undefined;
      const trim = (s: string): string => s.trim().slice(0, 300);
      const root = await appRepoRoot();
      if (!root) {
        return { status: "error", message: "Couldn't find the Visual Reader project folder — update with update.bat instead." };
      }
      onProgress("Checking for updates…");
      const pull = await runCommand("git pull --ff-only", token, root);
      if (pull.timedOut || pull.code !== 0) {
        return { status: "error", message: `Couldn't download the update: ${trim(pull.stderr || pull.stdout) || "git pull failed"}. Try update.bat.` };
      }
      if (/already up to date/i.test(pull.stdout)) {
        return { status: "uptodate", message: "You're already on the latest version." };
      }
      // What did the pull change? A core/shell (src-tauri) change can't be applied by a reload.
      const diff = await runCommand("git diff --name-only ORIG_HEAD HEAD", token, root);
      const coreChanged = /apps\/desktop\/src-tauri\//.test(diff.stdout);
      onProgress("Installing dependencies…");
      const install = await runCommand("pnpm install", token, root);
      if (install.timedOut || install.code !== 0) {
        return { status: "error", message: `Dependency install failed: ${trim(install.stderr || install.stdout)}. Try update.bat.` };
      }
      onProgress("Rebuilding (this can take a minute)…");
      const build = await runCommand("pnpm -r build", token, root);
      if (build.timedOut || build.code !== 0) {
        return { status: "error", message: `Rebuild failed: ${trim(build.stderr || build.stdout)}. Try update.bat.` };
      }
      if (coreChanged) {
        return {
          status: "needs-restart",
          message: "Updated! This release also changes the core app — fully close and reopen Visual Reader (run desktop.bat) to finish.",
        };
      }
      onProgress("Reloading…");
      setTimeout(() => window.location.reload(), 1200);
      return { status: "updated", message: "Updated — reloading the app…" };
    },
    [settings.keys],
  );

  // Settings → Restart app (and the "Restart now" button after a core update). restartApp() never
  // resolves on success (the process relaunches); it REJECTS only when the running build exposes
  // no `restart_app` command yet (an older shell that hasn't been rebuilt) — then guide the reader.
  const onRestartApp = useCallback(async () => {
    try {
      await restartApp();
    } catch {
      window.alert(
        "Couldn't restart automatically — this build doesn't have the restart command yet. " +
          "Fully close and reopen Visual Reader (run desktop.bat) to finish updating.",
      );
    }
  }, []);
  // DESKTOP side of a phone-triggered update: run the same update, streaming progress to the phone
  // (vrsync:updateStatus) and signalling it to reload when a JS update was applied. Kept in a ref so
  // the early-registered relay handler can reach it.
  const runUpdateForPhone = useCallback(() => {
    void (async () => {
      const result = await onSoftwareUpdate((m) =>
        sendAppSync({ type: "vrsync:updateStatus", status: "working", message: m }),
      );
      sendAppSync({
        type: "vrsync:updateStatus",
        status: result.status,
        message: result.message,
        ...(result.status === "updated" ? { reload: true } : {}),
      });
    })();
  }, [onSoftwareUpdate, sendAppSync]);
  useEffect(() => {
    runUpdateForPhoneRef.current = runUpdateForPhone;
  }, [runUpdateForPhone]);

  // PHONE side: ask the desktop to update and await the relayed result. The desktop reloads itself
  // and tells us to reload too (we re-fetch the new UI from its rebuilt bundle, then reconnect via
  // the persisted token in our URL). A long backstop covers an older desktop build that can't update.
  const onSoftwareUpdateRemote = useCallback(
    (onProgress: (msg: string) => void): Promise<UpdateResult> =>
      new Promise<UpdateResult>((resolve) => {
        const entry = { resolve, onProgress };
        phoneUpdatePending.current = entry;
        onProgress("Asking the desktop to update…");
        sendAppSync({ type: "vrcmd:update" });
        setTimeout(() => {
          if (phoneUpdatePending.current === entry) {
            phoneUpdatePending.current = undefined;
            resolve({ status: "error", message: "The desktop didn't respond — update it from the desktop app, or check the link." });
          }
        }, 600_000); // 10 min: a full rebuild can be slow
      }),
    [sendAppSync],
  );

  // PHONE side: ask the desktop to fully relaunch. Fire-and-forget — the desktop restarts (and the
  // link reconnects via the persisted token); there's no result to await.
  const onRestartAppRemote = useCallback(() => {
    sendAppSync({ type: "vrcmd:restart" });
  }, [sendAppSync]);

  // OCR: read the text out of a scanned image with the configured vision model, then open it
  // as a (technical) document via the paste modal. Reuses the screenshot tool's vision path —
  // needs a vision-capable model (cloud Claude/Gemini/OpenAI, or a local vision model).
  const extractTextFromImage = useCallback(
    async (img: { name: string; bytes: ArrayBuffer; mimeType: string }) => {
      setShowPhoto(false);
      setPhotoInitial(undefined);
      setLocalError("Reading the text in the image…");
      const r = await assessImage(
        { bytes: img.bytes.slice(0), mimeType: img.mimeType },
        "Transcribe ALL text in this image exactly as written, preserving line breaks and reading order. Output only the transcribed text with no commentary. If there is no readable text, reply exactly: (no text found).",
      );
      setLocalError("");
      const text = r.text?.trim();
      if (r.error || !text || /^\(no text found\)\.?$/i.test(text)) {
        setLocalError(r.error ? `Couldn't read the image: ${r.error}` : "No readable text found (OCR needs a vision-capable model — see Settings).");
        return;
      }
      setPasteInitial({ title: img.name.replace(/\.[^.]+$/, "") || "Scanned text", text, mode: "technical" });
      setShowPasteText(true);
    },
    [assessImage],
  );
  const onUpload = useCallback(
    async (file: File, handler: FileHandler = "auto") => {
      try {
        const imported = await importBookFile(file, handler);
        if (imported.kind === "book") {
          openBook(imported.book);
        } else if (imported.kind === "image") {
          // A picture isn't a book — open it in the photo-transform (img2img) panel.
          setPhotoInitial({ name: imported.name, bytes: imported.bytes, mimeType: imported.mimeType });
          setShowPhoto(true);
        } else {
          // An uploaded DOCUMENT (PDF/Word/CSV/text → extracted text): save it to the workspace so the
          // buddy can find_files / read_file it, and make it the ACTIVE document so it can be discussed
          // right away — addressing "uploaded docs aren't saved to the workspace for use".
          const docTitle = imported.title || file.name.replace(/\.[^.]+$/, "") || "Document";
          setActiveDocument({ title: docTitle, content: imported.text });
          if (isDesktop) {
            const slug = docTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "document";
            const wsPath = `uploads/${slug}.md`;
            try {
              await writeWorkspaceFile(wsPath, imported.text);
              recordCreatedFile(wsPath, imported.text.split("\n").length, false);
            } catch {
              /* workspace write best-effort (no desktop bridge / disk error) */
            }
          }
          // A Markdown / created document opens straight as a formatted "document" view (no
          // illustration window, no fiction/technical modal) — the buddy's docs land here.
          if (!imported.data && !imported.dataSheets && /\.(md|markdown|txt)$/i.test(file.name)) {
            const md = /\.(md|markdown)$/i.test(file.name);
            openBook({ ...bookFromText(docTitle, imported.text, "technical"), viewAs: md ? "document" : "text" });
            return;
          }
          // Extracted text (PDF/Word/CSV/…): confirm in the paste modal so the user can
          // fix the title and the fiction/technical choice before the book is created
          // (data files arrive pre-marked technical).
          setPasteInitial({
            title: imported.title,
            text: imported.text,
            ...(imported.mode ? { mode: imported.mode } : {}),
            ...(imported.data ? { data: imported.data } : {}),
            ...(imported.dataSheets ? { dataSheets: imported.dataSheets } : {}),
            ...(imported.tree !== undefined ? { tree: imported.tree } : {}),
          });
          setShowPasteText(true);
        }
      } catch (err) {
        setLocalError(`Couldn't import ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [openBook, setActiveDocument, recordCreatedFile],
  );

  // Map the active paragraph back to its page and steer the predictive buffer.
  // During a fast scroll no paragraph may be in the active band for a few frames
  // (IntersectionObserver gap) — HOLD the last known page instead of snapping the
  // status/caption/image to page 0 and back.
  const lastActivePage = useRef(0);
  useEffect(() => {
    lastActivePage.current = 0;
  }, [book]);
  const activePageIndex = useMemo(() => {
    if (book && activeParagraphId) {
      const pageId = activeParagraphId.replace(/-\d+$/, "");
      const idx = book.pages.findIndex((p) => p.id === pageId);
      if (idx >= 0) {
        lastActivePage.current = idx;
        return idx;
      }
    }
    return lastActivePage.current;
  }, [book, activeParagraphId]);

  // Render units: a group of pages (or a whole chapter) shares one illustration.
  // The reader still scrolls the original pages; `pageToUnit` maps the active page
  // to the unit the engine rendered (must match the worker — shared toRenderUnits).
  const pagesPerImage = settings.pagesPerImage ?? 3;
  const panelsPerView = settings.panelsPerView ?? 1;
  // Whole-web image/figure search is active only with BOTH a search key (the
  // dedicated one, or the Gemini key as fallback) and a Programmable Search engine
  // id; otherwise figure search is keyless Wikimedia Commons (encyclopedic).
  const hasSearchKey = Boolean(
    (settings.keys?.search || settings.keys?.gemini) && settings.searchEngineId,
  );
  // Multi-panel views (a drawn comic PAGE, or the per-image panel grid) are
  // detail-dense — give them a much wider image column so panels aren't shrunk.
  const comicPageMode =
    (settings.drawAsComicPage ?? false) &&
    (settings.imageStyle === "comic" || settings.imageStyle === "manga");
  const wideImageColumn = panelsPerView > 1 || comicPageMode;
  const units = useMemo(
    () => (book ? toRenderUnits(book, pagesPerImage) : undefined),
    [book, pagesPerImage],
  );
  const unitIndex = units?.pageToUnit[activePageIndex] ?? activePageIndex;
  // NOTE: the reader's position is deliberately NOT fed to the engine — generation
  // runs front-to-back on its own; scrolling only drives the reveal (bloom). The one
  // exception is MEMORY windowing: tell the worker where the reader is so a long book
  // keeps only nearby images' bytes resident (far ones drop to disk, reload on return).
  useEffect(() => setActiveUnit(unitIndex), [unitIndex, setActiveUnit]);

  const activePage = book?.pages[activePageIndex];
  // Original-layout view (web articles that carry sanitized HTML per paragraph). Off by default.
  const [articleLayout, setArticleLayout] = useState(false);
  const bookHasHtml = useMemo(
    () => !!book?.pages.some((p) => p.paragraphs.some((pr) => pr.html)),
    [book],
  );
  const pageEntities =
    book && bible && activePage ? resolvePageEntities(bible, activePage) : undefined;
  const pageSpoilerIds = pageEntities?.spoilerIds ?? [];
  // The story-chapter index of the page being read (keys the bible's per-chapter
  // storyboard/datasets) — same mapping the engine uses.
  // Pages tagged with their chapter index, for anchoring per-chapter data/info-graphics to the
  // paragraph they belong next to (so they scroll WITH the text, like figures + concept cards).
  const techPagesWithChapter = useMemo(() => {
    if (!book) return [];
    const idxById = new Map(book.chapters.map((c) => [c.id, c.index]));
    return book.pages.map((p) => ({ chapterIndex: idxById.get(p.chapterId) ?? 0, paragraphs: p.paragraphs }));
  }, [book]);
  const techDatasetsByPage = useMemo(
    () =>
      isNonFiction(book?.contentMode) && bible?.datasets?.length
        ? anchorByParagraph(techPagesWithChapter, bible.datasets, (d) => d.chapterIndex, (d) => d.source || d.title)
        : undefined,
    [book, bible?.datasets, techPagesWithChapter],
  );
  const techInfographicsByPage = useMemo(
    () =>
      isNonFiction(book?.contentMode) && bible?.infographics?.length
        ? anchorByParagraph(techPagesWithChapter, bible.infographics, (g) => g.chapterIndex, (g) => g.anchor || g.title)
        : undefined,
    [book, bible?.infographics, techPagesWithChapter],
  );

  // --- Technical-mode reading support (inline, anchored to source paragraphs) --
  // Key concepts marked in the text + first-appearance explanation cards. Depends
  // only on the book + glossary, so it survives result churn untouched.
  const techConcepts = useMemo(() => {
    if (!book || !isNonFiction(book.contentMode) || !bible?.glossary.length) return undefined;
    const definitions = new Map(bible.glossary.map((g) => [g.term.toLowerCase(), g.definition]));
    return {
      terms: bible.glossary.map((g) => g.term),
      definitions,
      conceptsByPage: conceptIntroductions(book.pages, bible.glossary),
    };
  }, [book, bible?.glossary]);
  // Each unit's retrieved figure (or its "no verified figure" note), anchored to
  // the paragraph that best matches the figure's subject on the unit's first page.
  const techFiguresByPage = useMemo(() => {
    if (!book || !isNonFiction(book.contentMode) || !units) return undefined;
    const byPage = new Map<number, { unitIndex: number; paragraphIndex: number; result: DisplayResult }[]>();
    const firstPageOfUnit = new Map<number, number>();
    units.pageToUnit.forEach((u, page) => {
      if (!firstPageOfUnit.has(u)) firstPageOfUnit.set(u, page);
    });
    for (const [unitIndex, result] of results) {
      const showable =
        (result.status === "ready" && (result.image || result.sourceUrl)) ||
        (result.status === "skipped" && result.prompt);
      if (!showable) continue;
      const page = firstPageOfUnit.get(unitIndex);
      const paragraphs = page !== undefined ? book.pages[page]?.paragraphs : undefined;
      if (page === undefined || !paragraphs) continue;
      const subject = subjectFromCaption(result.prompt ?? "") ?? "";
      const paragraphIndex = subject
        ? bestParagraphIndex(paragraphs.map((p) => p.text), subject)
        : 0;
      const list = byPage.get(page) ?? [];
      list.push({ unitIndex, paragraphIndex, result });
      byPage.set(page, list);
    }
    return byPage;
  }, [book, units, results]);
  const technicalSupport = useMemo<TechnicalSupportData | undefined>(
    () =>
      isNonFiction(book?.contentMode)
        ? {
            ...(techConcepts ?? {}),
            ...(techFiguresByPage ? { figuresByPage: techFiguresByPage } : {}),
            ...(techDatasetsByPage ? { datasetsByPage: techDatasetsByPage } : {}),
            ...(techInfographicsByPage ? { infographicsByPage: techInfographicsByPage } : {}),
          }
        : undefined,
    [book, techConcepts, techFiguresByPage, techDatasetsByPage, techInfographicsByPage],
  );

  // The reader's view category (the header drop-down): only "story" shows the illustration window;
  // the rest render full-screen text / data / code. Best-guessed from the book, overridable + saved.
  const viewAs: BookViewCategory = book ? resolveViewAs(book) : "document";
  // --- Reading-companion chat ------------------------------------------------
  const isTechnical = isNonFiction(book?.contentMode);
  // Load this book's chat history; reset transient chat state on book change.
  // A buddy-initiated open seeds the history with the handed-off landing
  // conversation, then the stored history is PREPENDED when it loads (it's
  // older than the handoff — and a plain set would race away the handoff).
  // Tracks the live book so an async chat continuation can detect a switch/exit
  // and not write the old book's reply into the new book's chat (cross-book bleed).
  const chatBookRef = useRef<BookSource | undefined>(book);
  useEffect(() => {
    // A chat turn for the previous book is now irrelevant — cancel it so the worker
    // stops streaming/spending and its completion is ignored (the continuation also
    // guards on the book id).
    chatCancel();
    chatBookRef.current = book;
    const handoff = buddyHandoff.current;
    buddyHandoff.current = undefined;
    setChatMessages(book && handoff ? handoff : []);
    setChatPendingTool(undefined);
    setChatStreaming("");
    setChatActivity("");
    setChatUsage(undefined);
    // Clear busy too: a turn in flight when the book changes returns early at its
    // guard (book mismatch) WITHOUT resetting busy, which left the next book's chat
    // stuck on "Thinking…" with no way to send (only Clear recovered it).
    setChatBusy(false);
    if (!book) return;
    let cancelled = false;
    void libraryStore.getChatHistory?.(book.id).then((stored) => {
      if (!cancelled && stored?.length) setChatMessages((prev) => [...stored, ...prev]);
    });
    return () => {
      cancelled = true;
    };
  }, [book, libraryStore, chatCancel]);
  // Persist (debounced) — image bytes ride along so generated pictures survive reload.
  // `chatHadMessages` tracks whether this book's chat HELD messages this session:
  // deleting the last one must clear the stored copy, but the initial empty render
  // (before the history loads) must not wipe it. `persistedFor` guards the book-switch
  // race: on A→B the effect re-runs with book=B but chatMessages still A's (the load
  // effect's reset hasn't flushed) — so SKIP the first run for a new book, which both
  // avoids writing A's messages under B.id and resets the had-messages flag.
  const chatHadMessages = useRef(false);
  const persistedFor = useRef<BookSource | undefined>(undefined);
  useEffect(() => {
    if (persistedFor.current !== book) {
      persistedFor.current = book;
      chatHadMessages.current = false;
      return;
    }
    if (!book) return;
    if (chatMessages.length === 0) {
      if (chatHadMessages.current) void libraryStore.deleteChatHistory?.(book.id);
      return;
    }
    chatHadMessages.current = true;
    const t = setTimeout(() => void libraryStore.putChatHistory?.(book.id, chatMessages), 500);
    return () => clearTimeout(t);
  }, [book, chatMessages, libraryStore]);

  /** Model-facing history: each stored message contributes its explicit turns
   * (tool messages) or maps 1:1 (plain user/assistant prose). */
  const chatTurnsOf = (messages: StoredChatMessage[]): ChatTurn[] =>
    messages.flatMap((m): ChatTurn[] => {
      if (m.turns) return m.turns;
      if (m.role === "tool") return [];
      return m.text ? [{ role: m.role, content: m.text }] : [];
    });

  const appendChat = (msg: Omit<StoredChatMessage, "at">) =>
    setChatMessages((prev) => [...prev, { ...msg, at: Date.now() }]);

  // Rename-before-save: open a modal with a content-derived default name and resolve with the
  // chosen name (or null on cancel). Every export routes through this so the reader names the file.
  const [renameModal, setRenameModal] = useState<{ defaultName: string; what?: string; resolve: (n: string | null) => void } | undefined>();
  const promptExportName = useCallback(
    (defaultName: string, what?: string): Promise<string | null> =>
      new Promise((resolve) => setRenameModal({ defaultName, ...(what ? { what } : {}), resolve })),
    [],
  );
  // Save through the rename modal: prompt with `default`, then write (no-op on cancel).
  const saveNamed = useCallback(
    async (defaultName: string, data: string | Uint8Array, mime: string, what?: string): Promise<string | true | undefined> => {
      const name = await promptExportName(defaultName, what);
      if (!name) return undefined;
      return saveExportFile(name, data, mime);
    },
    [promptExportName],
  );
  // Save a file the assistant wrote in a code block (a webpage, CSV worksheet,
  // script…) — desktop writes to ~/VisualReader/exports, web downloads it.
  const onSaveChatFile = useCallback(
    async (filename: string, content: string, mime: string): Promise<string | true> => {
      const name = await promptExportName(filename, "Save the assistant's file");
      return name ? saveExportFile(name, content, mime) : true; // cancel → treated as handled
    },
    [promptExportName],
  );
  // Backup / Restore: dev (`cargo tauri dev`) and the packaged build use DIFFERENT storage origins,
  // so data doesn't carry over. Export bundles the reader's library, chats, tasks, memories + skills
  // (and the non-secret settings) into one JSON; restore merges it back. API keys aren't included —
  // they're device-encrypted per origin, so re-enter them after a restore.
  const onExportData = useCallback(async (): Promise<void> => {
    const data = await libraryStore.exportData();
    let storedSettings: string | undefined;
    try {
      storedSettings = localStorage.getItem("vr-settings") ?? undefined;
    } catch {
      /* storage blocked */
    }
    const stamp = new Date().toISOString().slice(0, 10);
    await saveExportFile(
      `visual-reader-backup-${stamp}.json`,
      JSON.stringify({ ...data, settings: storedSettings }),
      "application/json",
    );
  }, [libraryStore]);
  const onImportData = useCallback(
    async (file: File): Promise<{ ok: boolean; error?: string }> => {
      try {
        const parsed = JSON.parse(await file.text()) as StoreBackup & { settings?: string };
        await libraryStore.importData(parsed);
        if (typeof parsed.settings === "string") {
          try {
            localStorage.setItem("vr-settings", parsed.settings);
          } catch {
            /* storage blocked */
          }
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [libraryStore],
  );

  // Download a grounded analysis-result table (a pivot/aggregate the chat computed)
  // as a real Excel workbook or CSV — built in the host from the typed DataTable.
  const onDownloadData = useCallback(
    (table: DataTable, name: string, format: "xlsx" | "csv") => {
      const base = exportFilename(name || "data", format, "data");
      if (format === "csv") void saveNamed(base, dataTableToCsv(table), "text/csv", "Analysis (CSV)");
      else void saveNamed(base, dataTableToXlsx(table), XLSX_MIME, "Analysis (Excel)");
    },
    [saveNamed],
  );

  // Google (Gmail/Calendar/Tasks) connection status, derived from the stored tokens. (Declared up
  // by the engine hook so task surfacing/planning can mirror to Google Tasks; loaded below.)

  useEffect(() => {
    // The phone has no Google tokens of its own — its connection status is mirrored from the desktop.
    if (isRemoteClient) return;
    void libraryStore.getMemo?.("google-tokens").then((t) => setGoogleConnected(!!t)).catch(() => {});
    void libraryStore.getMemo?.("google-email").then((e) => setGoogleEmail(e || undefined)).catch(() => {});
  }, [libraryStore, isRemoteClient]);
  const onConnectGoogle = useCallback(async (): Promise<{ ok: boolean; email?: string; error?: string }> => {
    if (!isDesktop) return { ok: false, error: "Connecting Google needs the desktop app." };
    if (!settings.keys?.googleClientId || !settings.keys?.googleClientSecret) {
      return { ok: false, error: "Add your Google client ID and secret first." };
    }
    try {
      const { verifier, challenge } = await generatePkce();
      const state = crypto.randomUUID();
      const { code, redirectUri } = await googleOauthLoopback({
        clientId: settings.keys.googleClientId,
        scope: GOOGLE_SCOPES.join(" "),
        codeChallenge: challenge,
        state,
      });
      const res = await googleConnect({ code, redirectUri, codeVerifier: verifier });
      if (res.ok) {
        setGoogleConnected(true);
        setGoogleEmail(res.email);
        if (res.email) void libraryStore.putMemo?.("google-email", res.email).catch(() => {});
      }
      return res;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [settings.keys?.googleClientId, settings.keys?.googleClientSecret, googleConnect, libraryStore]);
  const onDisconnectGoogle = useCallback(() => {
    setGoogleConnected(false);
    setGoogleEmail(undefined);
    void clearGoogleTokens(libraryStore).catch(() => {});
    void libraryStore.deleteMemo?.("google-email").catch(() => {});
  }, [libraryStore]);

  // Phase-2 idle scan: while the app is open, Google's connected, automation is on, AND the app is
  // IDLE — no in-flight process and no chat/request for IDLE_MS — periodically scan recent email +
  // calendar for actionable items, then plan a couple. Never interrupts active work (no daemon).
  const scanningRef = useRef(false);
  // Set once the calendar refresher is defined below; lets the scan sync the app calendar
  // without a forward reference / re-subscribing the interval.
  const refreshCalendarRef = useRef<() => void>(() => {});
  useEffect(() => {
    // Runs by DEFAULT once Google is connected (set autoTaskScan=false to stop background scans).
    // Each idle sweep does TWO things, read/research-only (no email/calendar writes): (1) scan for
    // new items and surface them as unplanned stubs, then (2) PLAN a couple of the still-unplanned
    // backlog — so heavy planning happens in the background while you're away, not on demand.
    if (!googleConnected || settings.autoTaskScan === false) return;
    const IDLE_MS = 3 * 60_000;
    const rate = settings.backgroundPlanRate ?? 2;
    const id = setInterval(() => {
      // IDLE = this sweep isn't already running, nothing else is in flight (chat/plan/scan/render),
      // and no chat message or user request within IDLE_MS.
      if (scanningRef.current || processActiveRef.current || Date.now() - lastRequestAt.current < IDLE_MS) return;
      scanningRef.current = true;
      void scanInbox()
        .then(async (r) => {
          if (r.candidates?.length) await addCandidatesAsTasks(r.candidates);
          // Pull any Google Tasks not yet mirrored locally (e.g. created on another device).
          const imp = await importGoogleTasks().catch(() => ({ imported: 0, edited: 0, mirrored: 0 }));
          // `edited` = notes the reader changed (now flagged needsReplan → re-planned below this same
          // sweep); `mirrored` = ignore/complete/delete mirrored back from Google Tasks.
          const i = imp as { imported?: number; edited?: number; mirrored?: number };
          if ((i.imported ?? 0) > 0 || (i.edited ?? 0) > 0 || (i.mirrored ?? 0) > 0) refreshTaskPlans();
          refreshCalendarRef.current(); // the scan just scraped the calendar — sync the app's view
          // Plan up to `rate` of the unplanned backlog, but stop early the moment the reader sends a
          // message or makes a request (lastRequestAt bumps → this returns false → the sweep yields).
          await planPendingTasks(rate, () => Date.now() - lastRequestAt.current >= IDLE_MS);
        })
        .catch(() => {})
        .finally(() => {
          scanningRef.current = false;
        });
    }, 90_000);
    return () => clearInterval(id);
  }, [googleConnected, settings.autoTaskScan, settings.backgroundPlanRate, scanInbox, importGoogleTasks, addCandidatesAsTasks, refreshTaskPlans, planPendingTasks]);

  // In-app calendar synced with the user's Google calendar(s). `calendarMonth` is the
  // first day of the visible month; `loadCalendarFor` pulls the events spanning the whole
  // grid (the month plus the leading/trailing spill weeks) so edge days aren't blank.
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState<string | undefined>();
  const loadCalendarFor = useCallback(
    async (month: Date, silent = false): Promise<{ ok: boolean; count: number; error?: string }> => {
      // The phone shows the desktop's MIRRORED calendar; it has no Google of its own to fetch.
      if (isRemoteClient || !googleConnected) return { ok: false, count: 0 };
      // Cover the 6×7 grid: from the Sunday on/before the 1st to ~42 days later.
      const first = new Date(month.getFullYear(), month.getMonth(), 1);
      const start = new Date(first);
      start.setDate(1 - first.getDay());
      const end = new Date(start);
      end.setDate(start.getDate() + 42);
      if (!silent) setCalendarLoading(true);
      try {
        const res = await loadCalendar(start.toISOString(), end.toISOString());
        if (res.ok && res.events) {
          setCalendarEvents(res.events);
          setCalendarError(undefined);
          return { ok: true, count: res.events.length };
        }
        // A failed load shouldn't wipe the last-good view; just record why it's not updating.
        if (!res.ok) setCalendarError(res.error ?? "Couldn't load your Google calendar.");
        return { ok: res.ok, count: res.events?.length ?? 0, ...(res.error ? { error: res.error } : {}) };
      } finally {
        if (!silent) setCalendarLoading(false);
      }
    },
    [googleConnected, loadCalendar, isRemoteClient],
  );
  // Keep the in-app calendar in sync without a visible reload — used after the agent creates an
  // event and after the idle scan scrapes the calendar, so the app's calendar reflects Google.
  const calendarMonthRef = useRef(calendarMonth);
  useEffect(() => {
    calendarMonthRef.current = calendarMonth;
  }, [calendarMonth]);
  const refreshCalendar = useCallback(() => {
    if (googleConnected) void loadCalendarFor(calendarMonthRef.current, true);
  }, [googleConnected, loadCalendarFor]);
  useEffect(() => {
    refreshCalendarRef.current = refreshCalendar;
  }, [refreshCalendar]);
  // Manually add an event to the (Google) calendar from the in-app grid, then refresh so it shows.
  const onCreateCalendarEvent = useCallback(
    async (ev: { summary: string; start: string; end: string; description?: string; location?: string }): Promise<{ ok: boolean; error?: string }> => {
      const res = await createCalendarEvent(ev);
      if (res.ok) {
        refreshCalendar();
        buddyNoteRef.current(`📅 Added event “${ev.summary}”.`);
        logActionRef.current("calendar", `Added event: ${ev.summary}`);
      }
      return { ok: res.ok, ...(res.error ? { error: res.error } : {}) };
    },
    [createCalendarEvent, refreshCalendar],
  );
  // Mirror the planner (tasks + calendar) to a linked phone. The desktop owns the data (Google +
  // the task store); the phone renders this snapshot so its panels aren't empty. Re-pushed whenever
  // any piece changes. The `calendarMonth` Date rides as ISO (JSON can't carry a Date).
  const plannerMirror = useMemo<PlannerMirror>(
    () => ({
      tasks: taskPlans,
      calendarEvents,
      calendarMonth: calendarMonth.toISOString(),
      calendarLoading,
      ...(calendarError ? { calendarError } : {}),
      googleConnected,
    }),
    [taskPlans, calendarEvents, calendarMonth, calendarLoading, calendarError, googleConnected],
  );
  useEffect(() => {
    plannerMirrorRef.current = plannerMirror;
    if (!isRemoteClient) sendAppSync({ type: "vrsync:planner", ...plannerMirror });
  }, [isRemoteClient, sendAppSync, plannerMirror]);
  // PHONE side: adopt the desktop's mirrored planner. (Kept in a ref so the early-registered relay
  // handler can reach these later-declared setters.)
  const applyPlanner = useCallback((p: PlannerMirror) => {
    setTaskPlans(p.tasks);
    setCalendarEvents(p.calendarEvents);
    setCalendarMonth(new Date(p.calendarMonth));
    setCalendarLoading(p.calendarLoading);
    setCalendarError(p.calendarError);
    setGoogleConnected(p.googleConnected);
  }, []);
  useEffect(() => {
    applyPlannerRef.current = applyPlanner;
  }, [applyPlanner]);
  // Mirror the landing-page chat (buddy) to a linked phone. The desktop owns the chat (its models +
  // working folder); the phone renders the active session's history so its chat isn't a separate,
  // empty one. Re-pushed whenever the sessions, active id, that session's messages, persona, or the
  // busy flag change — so a phone-triggered turn shows "working…" and then the result, all here.
  const chatMirror = useMemo<ChatMirror>(
    () => ({
      sessions: buddySessions.map((s) => ({ id: s.id, workingDir: s.workingDir, ...(s.label ? { label: s.label } : {}) })),
      activeId: activeBuddyId,
      messages: boundChatHistoryForMirror(buddyMessages),
      persona: buddyPersona,
      busy: buddyBusy,
    }),
    [buddySessions, activeBuddyId, buddyMessages, buddyPersona, buddyBusy],
  );
  useEffect(() => {
    chatMirrorRef.current = chatMirror;
    if (!isRemoteClient) sendAppSync({ type: "vrsync:chat", ...chatMirror });
  }, [isRemoteClient, sendAppSync, chatMirror]);
  // PHONE side: adopt the desktop's mirrored chat (kept in a ref so the early-registered relay handler
  // reaches these later-declared setters). The phone never persists/loads chat locally (those effects
  // are gated on isRemoteClient), so this mirror is its only source of chat state.
  const applyChat = useCallback((c: ChatMirror) => {
    setBuddySessions(c.sessions.map((s) => ({ id: s.id, workingDir: s.workingDir, ...(s.label ? { label: s.label } : {}) })));
    // Never let an OLDER desktop snapshot erase chat the phone is already showing. A stale vrsync:chat
    // can race a phone-typed message: the desktop re-pushes its pre-send history before it has run the
    // new turn, which used to clobber the phone's in-flight message ("lost the new chat on mobile").
    // If we're on the SAME session and the incoming history is a strict PREFIX of what we show (fewer
    // messages, all matching by role+timestamp), it's stale — keep ours and wait for the real (longer)
    // update that includes the message. A different activeId is a genuine switch/new chat — adopt fully.
    const sameSession = activeBuddyIdRef.current === c.activeId;
    setActiveBuddyId(c.activeId);
    setBuddyMessages((prev) =>
      sameSession &&
      c.messages.length < prev.length &&
      c.messages.every((m, i) => prev[i] && prev[i].role === m.role && prev[i].at === m.at)
        ? prev
        : // put back any inline images this phone already fetched (the mirror re-strips them each push)
          restoreInlineImages(c.messages, restoredImages.current),
    );
    setBuddyPersona(normalizeBuddyPersona(c.persona));
    setBuddyBusy(c.busy);
  }, []);
  useEffect(() => {
    applyChatRef.current = applyChat;
  }, [applyChat]);
  // Mirror the LIVE turn state to a linked phone (streaming answer, reasoning, activity, the tool
  // log, a pending tool / coding-agent approvals, and the usage donut) so the phone shows the same
  // real-time view. The streaming text updates per token, so throttle to ~8 pushes/sec but always
  // land a TRAILING send (the cleanup clears a superseded timer) so the final text/approval isn't
  // lost. Pushing the cumulative streaming string keeps the phone correct even if a push is dropped.
  const chatLive = useMemo<ChatLive>(
    () => ({
      streaming: buddyStreaming,
      thinking: buddyThinking,
      activity: buddyActivity,
      steps: buddySteps,
      ...(buddyPendingTool ? { pendingTool: buddyPendingTool } : {}),
      agentApprovals,
      ...(buddyUsage ? { usage: buddyUsage } : {}),
      ...(buddyPlan ? { plan: buddyPlan } : {}),
    }),
    [buddyStreaming, buddyThinking, buddyActivity, buddySteps, buddyPendingTool, agentApprovals, buddyUsage, buddyPlan],
  );
  chatLiveRef.current = chatLive;
  useEffect(() => {
    if (isRemoteClient) return;
    // Throttle to ~8/sec: push immediately if a full interval has passed, else schedule ONE trailing
    // send (which reads the latest ref). While a send is already scheduled, newer changes just update
    // the ref — so steady streaming pushes periodically (not suppressed) and the final state always lands.
    if (chatLiveTimer.current) return;
    const fire = () => {
      chatLiveTimer.current = undefined;
      chatLiveSentAt.current = Date.now();
      sendAppSync({ type: "vrsync:chatLive", ...chatLiveRef.current });
    };
    const since = Date.now() - chatLiveSentAt.current;
    if (since >= 120) fire();
    else chatLiveTimer.current = setTimeout(fire, 120 - since);
  }, [isRemoteClient, sendAppSync, chatLive]);
  // PHONE side: adopt the desktop's live turn state (via a ref, like applyChat). These setters drive
  // the same streaming view / approval modal the desktop shows; the approve/dismiss buttons relay back.
  const applyChatLive = useCallback((l: ChatLive) => {
    setBuddyStreaming(l.streaming);
    setBuddyThinking(l.thinking);
    setBuddyActivity(l.activity);
    setBuddySteps(l.steps);
    setBuddyPendingTool(l.pendingTool);
    setAgentApprovals(l.agentApprovals);
    setBuddyUsage(l.usage);
    setBuddyPlan(l.plan); // PHONE: mirror the desktop's live working checklist
  }, []);
  useEffect(() => {
    applyChatLiveRef.current = applyChatLive;
  }, [applyChatLive]);
  // On-demand: scan email + calendar for tasks right now and SURFACE them (as unplanned stubs) +
  // refresh the in-app calendar. It does NOT plan — planning is left to the background sweep or the
  // per-task "Plan" button, so a manual scan is fast and never kicks off long LLM work.
  const scanningNowRef = useRef(false);
  const [scanningNow, setScanningNow] = useState(false);
  // Mirror the "a process is in flight" signals into a ref the idle sweep reads each tick: a chat
  // turn, planning, a manual scan, or image generation. While any is true the app is NOT idle.
  useEffect(() => {
    processActiveRef.current = buddyBusy || planningCount > 0 || scanningNow || generating;
  }, [buddyBusy, planningCount, scanningNow, generating]);
  // A short outcome line shown under the Scan button so a manual scan never looks like it "did
  // nothing": it reports what it found/synced, or surfaces the actual Google error instead of
  // failing silently.
  const [scanMessage, setScanMessage] = useState<string | undefined>();
  const scanNow = useCallback(async () => {
    if (!googleConnected || scanningNowRef.current) return;
    markUserRequest();
    scanningNowRef.current = true;
    setScanningNow(true);
    setScanMessage(undefined);
    const act = beginActivity("Searching email & calendar");
    try {
      // Run both Google reads; surface the first real error rather than swallowing it.
      const [scan, imported] = await Promise.all([scanInbox(), importGoogleTasks()]);
      if (scan.candidates?.length) await addCandidatesAsTasks(scan.candidates);
      const editedInGoogle = imported.edited ?? 0;
      const mirroredFromGoogle = imported.mirrored ?? 0;
      if ((imported.imported ?? 0) > 0 || editedInGoogle > 0 || mirroredFromGoogle > 0) refreshTaskPlans();
      const cal = await loadCalendarFor(calendarMonthRef.current, true);
      const err = scan.error || imported.error || cal?.error;
      if (err) {
        setScanMessage(`⚠ Scan failed: ${err}`);
        act.finish({ status: "error", detail: err });
        buddyNoteRef.current(`🔍 Scan failed: ${err}`);
      } else {
        const found = scan.candidates?.length ?? 0;
        const added = imported.imported ?? 0;
        const events = cal?.count ?? 0;
        const bits = [
          found ? `${found} new item${found === 1 ? "" : "s"} from email/calendar` : "",
          added ? `${added} Google task${added === 1 ? "" : "s"} imported` : "",
          editedInGoogle ? `${editedInGoogle} edited in Google Tasks — re-planning` : "",
          mirroredFromGoogle ? `${mirroredFromGoogle} mirrored from Google Tasks (done/removed/ignored)` : "",
          `${events} calendar event${events === 1 ? "" : "s"} synced`,
        ].filter(Boolean);
        const summary = bits.join(" · ");
        setScanMessage(found || added || editedInGoogle || mirroredFromGoogle ? `✓ ${summary}` : `✓ Up to date — ${summary}`);
        act.finish({ detail: summary });
        buddyNoteRef.current(`🔍 Scanned email & calendar — ${summary}.`);
        logActionRef.current("scan", "Scanned email & calendar", summary);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setScanMessage(`⚠ Scan failed: ${msg}`);
      act.finish({ status: "error", detail: msg });
      buddyNoteRef.current(`🔍 Scan failed: ${msg}`);
    } finally {
      scanningNowRef.current = false;
      setScanningNow(false);
    }
  }, [googleConnected, scanInbox, importGoogleTasks, addCandidatesAsTasks, refreshTaskPlans, loadCalendarFor, beginActivity]);
  const openCalendar = useCallback(() => {
    setShowCalendar(true);
    void loadCalendarFor(calendarMonth);
  }, [loadCalendarFor, calendarMonth]);
  const shiftCalendarMonth = useCallback(
    (delta: number | "today") => {
      setCalendarMonth((prev) => {
        const next =
          delta === "today"
            ? (() => {
                const n = new Date();
                return new Date(n.getFullYear(), n.getMonth(), 1);
              })()
            : new Date(prev.getFullYear(), prev.getMonth() + delta, 1);
        void loadCalendarFor(next);
        return next;
      });
    },
    [loadCalendarFor],
  );
  // Scheduled / periodic tasks (recurring agentic actions fired while the app is open).
  const [showScheduled, setShowScheduled] = useState(false);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const refreshScheduled = useCallback(() => {
    void loadScheduledTasks(libraryStore).then(setScheduledTasks).catch(() => {});
  }, [libraryStore]);
  const toggleScheduled = useCallback(
    async (id: string, enabled: boolean) => {
      const t = (await loadScheduledTasks(libraryStore)).find((x) => x.id === id);
      if (t) await upsertScheduledTask(libraryStore, { ...t, enabled });
      refreshScheduled();
    },
    [libraryStore, refreshScheduled],
  );
  const removeScheduled = useCallback(
    async (id: string) => {
      await deleteScheduledTask(libraryStore, id);
      refreshScheduled();
    },
    [libraryStore, refreshScheduled],
  );
  useEffect(() => {
    refreshScheduled();
  }, [refreshScheduled]);
  // Markets panel: a TradingView chart for a ticker + a keyless quote snapshot.
  const [showStocks, setShowStocks] = useState(false);
  const [stockSymbol, setStockSymbol] = useState("AAPL");
  const [stockQuoteData, setStockQuoteData] = useState<StockQuote | null>(null);
  const [stockLoading, setStockLoading] = useState(false);
  // In-app price alerts / watch levels.
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>([]);
  const refreshAlerts = useCallback(() => {
    void loadPriceAlerts(libraryStore).then(setPriceAlerts).catch(() => {});
  }, [libraryStore]);
  const addAlert = useCallback(
    async (symbol: string, type: PriceAlert["type"], value?: number) => {
      const a = normalizePriceAlert({ symbol, type, ...(value !== undefined ? { value } : {}) });
      if (!a) return;
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
      } catch {
        /* notifications optional */
      }
      await upsertPriceAlert(libraryStore, a);
      refreshAlerts();
    },
    [libraryStore, refreshAlerts],
  );
  const removeAlert = useCallback(
    async (id: string) => {
      await deletePriceAlert(libraryStore, id);
      refreshAlerts();
    },
    [libraryStore, refreshAlerts],
  );
  useEffect(() => {
    refreshAlerts();
  }, [refreshAlerts]);
  const loadStockQuote = useCallback(
    async (symbol: string) => {
      setStockLoading(true);
      setStockQuoteData(null);
      try {
        const r = await stockQuote(symbol);
        setStockQuoteData(r.quote ?? null);
      } finally {
        setStockLoading(false);
      }
    },
    [stockQuote],
  );
  const openStocks = useCallback(
    (symbol?: string) => {
      const s = (symbol ?? stockSymbol).toUpperCase();
      setStockSymbol(s);
      setShowStocks(true);
      void loadStockQuote(s);
    },
    [stockSymbol, loadStockQuote],
  );
  // In-app browser (desktop): read a URL's text + links over the CORS-exempt transport.
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserPage, setBrowserPage] = useState<PageText | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const browserHistory = useRef<string[]>([]);
  const loadPage = useCallback(
    async (url: string, pushHistory = true) => {
      if (pushHistory && browserUrl) browserHistory.current.push(browserUrl);
      setBrowserUrl(url);
      setBrowserLoading(true);
      setBrowserError(null);
      setBrowserPage(null);
      try {
        const r = await readPage(url);
        if (r.ok && r.page) setBrowserPage(r.page);
        else setBrowserError(r.error ?? "Couldn't load that page.");
      } finally {
        setBrowserLoading(false);
      }
    },
    [browserUrl, readPage],
  );
  const openBrowser = useCallback(
    (url?: string) => {
      setShowBrowser(true);
      if (url) void loadPage(url, false);
    },
    [loadPage],
  );
  const browserBack = useCallback(() => {
    const prev = browserHistory.current.pop();
    if (prev) void loadPage(prev, false);
  }, [loadPage]);
  // Remote link (LAN, desktop): start/stop the WebSocket relay so a phone on the same Wi-Fi
  // can drive the assistant. Clicking it IS the opt-in (nothing listens until you start it).
  // `remoteLink` is the running server (kept while the panel is closed, so the URL + pairing token
  // stay CONSTANT across re-opens AND app restarts — persisted, see persistedRemoteToken);
  // `showRemoteLink` only controls the modal's visibility.
  const [remoteLink, setRemoteLink] = useState<RemoteServerStatus | null>(null);
  const [showRemoteLink, setShowRemoteLink] = useState(false);
  const bridgeToRelay = useCallback(
    (status: RemoteServerStatus, token: string) => {
      if (status.running && status.port) {
        // On every (re)connect, push a fresh snapshot so a phone already on the relay re-populates
        // even when only the desktop's bridge dropped (the phone won't re-`hello` while its own
        // socket stayed up). `buildSnapshotRef` reads live state without re-binding this callback.
        startHostBridge(`ws://127.0.0.1:${status.port}/`, token, () => sendAppSync(buildSnapshotRef.current()));
      }
    },
    [startHostBridge, sendAppSync],
  );
  // On desktop startup, adopt an already-running relay so a reload doesn't lose (or duplicate) it.
  // If none is running but the user had the link enabled in a previous session, bring it back up
  // with the SAME persisted token so a paired phone reconnects without re-pairing.
  useEffect(() => {
    if (!isDesktop) return;
    void remoteServerStatus().then(async (s) => {
      if (s.running) {
        setRemoteLink(s);
        if (s.token) bridgeToRelay(s, s.token);
        return;
      }
      if (remoteWasEnabled()) {
        const token = persistedRemoteToken();
        const status = await startRemoteServer(token);
        setRemoteLink(status);
        if (status.running) bridgeToRelay(status, token);
      }
    });
  }, [bridgeToRelay]);
  // Open the panel WITHOUT restarting a live server: reuse the running one (same URL/token) and
  // only start a server when nothing is listening yet — with the PERSISTED token, so the link is
  // the same address the phone saved before (stable across sessions until "Change link").
  const openRemoteLink = useCallback(async () => {
    const existing = remoteLink?.running ? remoteLink : await remoteServerStatus();
    if (existing.running) {
      setRemoteLink(existing);
      setShowRemoteLink(true);
      if (existing.token) bridgeToRelay(existing, existing.token);
      return;
    }
    const token = persistedRemoteToken();
    const status = await startRemoteServer(token);
    setRemoteEnabled(status.running);
    setRemoteLink(status);
    setShowRemoteLink(true);
    bridgeToRelay(status, token);
  }, [remoteLink, bridgeToRelay]);
  // "Change link": the ONLY thing that rotates the pairing code. Mint a new token, persist it, and
  // restart the server so previously-paired phones must re-open the new address.
  const changeRemoteLink = useCallback(async () => {
    stopHostBridge();
    await stopRemoteServer();
    const token = rotateRemoteToken();
    const status = await startRemoteServer(token);
    setRemoteEnabled(status.running);
    setRemoteLink(status);
    if (status.running) bridgeToRelay(status, token);
  }, [stopHostBridge, bridgeToRelay]);
  // Explicit stop: tear down the bridge + server and forget the opt-in (no auto-restart next
  // session). The token stays persisted, so re-opening the link gives the SAME address — only
  // "Change link" rotates it.
  const stopRemoteLink = useCallback(async () => {
    stopHostBridge();
    await stopRemoteServer();
    setRemoteEnabled(false);
    setRemoteLink(null);
    setShowRemoteLink(false);
  }, [stopHostBridge]);
  // Schwab connect (manual code-paste flow, no Rust loopback needed): open the consent
  // URL for the user's own Schwab app, then exchange the redirected ?code=… they paste.
  const [schwabConnected, setSchwabConnected] = useState(false);
  useEffect(() => {
    void libraryStore.getMemo?.("schwab-tokens").then((t) => setSchwabConnected(!!t)).catch(() => {});
  }, [libraryStore]);
  // TradingView Desktop bridge status (probed on startup + when opening Markets).
  const [tvBridgeStatus, setTvBridgeStatus] = useState<string | null>(null);
  const tvBridgeEnabled = isDesktop && !!settings.allowTradingViewBridge;
  const testTvBridge = useCallback(async () => {
    setTvBridgeStatus("checking…");
    const r = await tvBridgeEval(tvActionScript("read_state"));
    setTvBridgeStatus(r.ok ? "Connected to TradingView" : r.error ?? "TradingView not detected");
  }, []);
  useEffect(() => {
    if (tvBridgeEnabled) void testTvBridge();
  }, [tvBridgeEnabled, testTvBridge]);
  // Order review-and-place gate (the assistant preps; the reader places). Never auto-submits.
  const [orderReview, setOrderReview] = useState<{ summary: string; order: Record<string, unknown> } | null>(null);
  const [orderPlacing, setOrderPlacing] = useState(false);
  const [orderResult, setOrderResult] = useState<{ ok: boolean; message: string } | null>(null);
  const openOrderReview = useCallback((call: Extract<BuddyToolCall, { tool: "prep_order" }>) => {
    const order =
      call.assetType === "OPTION"
        ? buildOptionOrder({ optionSymbol: call.symbol, quantity: call.quantity, instruction: call.instruction as "BUY_TO_OPEN", orderType: call.orderType, ...(call.price !== undefined ? { price: call.price } : {}) })
        : buildEquityOrder({ symbol: call.symbol, quantity: call.quantity, instruction: call.instruction === "SELL" ? "SELL" : "BUY", orderType: call.orderType, ...(call.price !== undefined ? { price: call.price } : {}) });
    setOrderResult(null);
    setOrderReview({ summary: describeOrder(order), order });
  }, []);
  const placeReviewedOrder = useCallback(async () => {
    if (!orderReview) return;
    setOrderPlacing(true);
    try {
      const r = await schwabPlaceOrder(orderReview.order);
      setOrderResult({ ok: r.ok, message: r.ok ? "✓ Order placed at Schwab. Check your Schwab/thinkorswim app to confirm." : `⚠ ${r.error ?? "Order failed."}` });
    } finally {
      setOrderPlacing(false);
    }
  }, [orderReview, schwabPlaceOrder]);
  // Run one TradingView Desktop chart action via the CDP bridge, then report back.
  const runTvChart = async (call: Extract<BuddyToolCall, { tool: "tv_chart" }>, modelTurns: ChatTurn[]): Promise<void> => {
    const script = tvActionScript(call.action, {
      ...(call.symbol ? { symbol: call.symbol } : {}),
      ...(call.interval ? { interval: call.interval } : {}),
      ...(call.study ? { study: call.study } : {}),
      ...(call.pine ? { pine: call.pine } : {}),
    });
    const r = await tvBridgeEval(script);
    appendBuddy({
      role: "tool",
      text: r.ok ? `📈 TradingView: ${r.value ?? "done"}` : `⚠ TradingView bridge: ${r.error ?? "failed"}`,
      turns: [
        ...modelTurns,
        {
          role: "user",
          content: r.ok
            ? `[tv_chart ${call.action} ok: ${r.value ?? "done"}] Confirm it to the reader briefly.`
            : `[tv_chart failed: ${r.error}] Tell the reader to open a chart in TradingView Desktop (launched with remote debugging) — see the Markets panel — or that the bridge needs the desktop app.`,
        },
      ],
    });
  };
  const connectSchwab = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const clientId = settings.keys?.schwabClientId;
    if (!clientId || !settings.keys?.schwabClientSecret) return { ok: false, error: "Add your Schwab app key + secret in Settings first." };
    const redirectUri = "https://127.0.0.1";
    try {
      const url = buildSchwabAuthUrl({ clientId, redirectUri, state: crypto.randomUUID() });
      window.open(url, "_blank", "noopener");
      const pasted = window.prompt(
        "A Schwab login opened in your browser. After you approve, it redirects to https://127.0.0.1/?code=… (the page may show an error — that's fine). Paste the FULL redirected URL (or just the code) here:",
      );
      if (!pasted) return { ok: false, error: "Cancelled." };
      const code = /[?&]code=([^&]+)/.exec(pasted)?.[1] ?? pasted.trim();
      const res = await schwabConnect({ code: decodeURIComponent(code), redirectUri });
      if (res.ok) setSchwabConnected(true);
      return res;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [settings.keys?.schwabClientId, settings.keys?.schwabClientSecret, schwabConnect]);
  // Overlay the assistant's planned deadlines (plan-level + each dated step) onto the grid.
  const calendarDeadlines = useMemo<CalendarDeadline[]>(() => {
    const out: CalendarDeadline[] = [];
    for (const p of taskPlans) {
      if (p.status === "archived") continue;
      if (p.deadlineIso) out.push({ date: p.deadlineIso.slice(0, 10), title: p.title, planId: p.id });
      for (const s of p.steps) {
        if (s.dueIso) out.push({ date: s.dueIso.slice(0, 10), title: `${p.title}: ${s.title}`, planId: p.id });
      }
    }
    return out;
  }, [taskPlans]);
  // Bundle a multi-file answer (its named code blocks) into one project.zip — keeps a
  // linked HTML/CSS/JS site or small script project together with its relative paths.
  const onSaveProject = useCallback(
    async (files: ProjectFile[]): Promise<string | true> => {
      const name = await promptExportName("project.zip", "Save project (zip)");
      return name ? saveExportFile(name, zipProject(files), PROJECT_ZIP_MIME) : true;
    },
    [promptExportName],
  );
  // A designed document (invite, flyer, card): generate each `data-generate` image via
  // the normal render path and embed it as a self-contained data: URI, so the finished
  // HTML previews/saves as one standalone file. Failed renders just fall back to alt text.
  const onBuildDocument = useCallback(
    async (html: string, onProgress?: (done: number, total: number) => void) => {
      await ensureRenderEngineReady(); // low-VRAM: start the deferred engine before the first doc image
      const placeholders = parseDocImages(html);
      const srcById = new Map<string, string>();
      let generated = 0;
      let failed = 0;
      for (let k = 0; k < placeholders.length; k++) {
        const p = placeholders[k]!;
        onProgress?.(k, placeholders.length);
        const res = await testRender(p.prompt, {
          ...(p.width && p.height ? { size: { width: p.width, height: p.height } } : {}),
        });
        if (res.image) {
          srcById.set(p.id, `data:${res.image.mimeType};base64,${bytesToBase64(res.image.bytes)}`);
          generated++;
        } else {
          failed++;
        }
      }
      onProgress?.(placeholders.length, placeholders.length);
      return { html: embedDocImages(html, srcById), generated, failed };
    },
    [testRender, ensureRenderEngineReady],
  );

  // Playground render that first spins up the deferred (low-VRAM) managed engine, then renders.
  const onTestRender = useCallback(
    async (text: string, opts?: Parameters<typeof testRender>[1]): ReturnType<typeof testRender> => {
      await ensureRenderEngineReady();
      return testRender(text, opts);
    },
    [ensureRenderEngineReady, testRender],
  );

  // Drop a rendered image (from Test image / Transform photo) into the live chat —
  // the book chat when one is open, otherwise the landing buddy, opening it so it shows.
  const onAddImageToChat = (image: { bytes: ArrayBuffer; mimeType: string }) => {
    const msg = { role: "assistant" as const, text: "", image, at: Date.now() };
    if (book) {
      setChatMessages((prev) => [...prev, msg]);
      setShowChat(true);
    } else {
      setBuddyMessages((prev) => [...prev, msg]);
    }
  };

  const onChatSend = useCallback(
    async (text: string) => {
      if (!book) return;
      markUserRequest();
      // A pasted/typed image URL just gets DISPLAYED — don't feed a .jpg to the LLM
      // (which would try to read it as a page or re-search).
      const directImg = pastedImageUrl(text);
      if (directImg) {
        appendChat({ role: "user", text });
        appendChat({ role: "tool", text: "Here's that image:", gallery: [{ thumb: directImg, full: directImg }] });
        return;
      }
      const turnBookId = book.id; // guard: ignore this turn if the reader switches/exits
      const seq = ++chatTurnSeq.current; // guard: ignore if Clear/cancel supersedes it
      const history = chatTurnsOf(chatMessages);
      appendChat({ role: "user", text });
      setChatBusy(true);
      setChatStreaming("");
      setChatThinking("");
      setChatActivity("");
      setChatPendingTool(undefined);
      const paragraphIndex = paragraphIndexFromId(activeParagraphId ?? "") ?? 0;
      const res = await chat(
        history,
        text,
        { pageIndex: activePageIndex, paragraphIndex },
        isTechnical || allowSpoilers,
        (e) => {
          if (e.kind === "token") {
            setChatStreaming((prev) => prev + e.text);
            setChatActivity(""); // visible text replaces any "Reasoning…" status
          } else if (e.kind === "thinking") setChatThinking(e.text);
          else if (e.kind === "activity") setChatActivity(e.text);
          else if (e.kind === "usage") setChatUsage(e.usage);
          else if (e.kind === "tool")
            setChatActivity(
              e.call.tool === "search_web"
                ? `Searching the web for “${e.call.query}”…`
                : e.call.tool === "read_url"
                  ? `Reading ${e.call.url}…`
                  : e.call.tool === "search_images"
                    ? `Looking for images of “${e.call.query}”…`
                    : e.call.tool === "search_book"
                      ? `Looking in the book for “${e.call.query}”…`
                      : e.call.tool === "lookup_bible"
                        ? `Looking up “${e.call.query}”…`
                        : e.call.tool === "remember" || e.call.tool === "forget"
                          ? "Updating memory…"
                          : "Preparing an image…",
            );
          else {
            setChatActivity("");
            // Inline search results: links for web hits, a hotlinked figure for images.
            if (e.hits?.length) {
              appendChat({
                role: "tool",
                text: `Web results for “${"query" in e.call ? e.call.query : ""}”:`,
                links: e.hits.map((h) => ({ url: h.link, ...(h.title ? { title: h.title } : {}) })),
              });
            } else if (e.imageHits?.length) {
              // Show EVERY hit as a thumbnail gallery (click to enlarge), not just the
              // first — so "show me 3 images of X" actually shows several.
              const hits = e.imageHits.slice(0, 8);
              appendChat({
                role: "tool",
                text:
                  hits.length > 1
                    ? `Found ${hits.length} images — tap any to enlarge:`
                    : `Found: ${hits[0]!.title ?? "image"} (tap to enlarge)`,
                gallery: hits.map((h) => ({
                  thumb: h.thumbnailLink ?? h.link,
                  full: h.link,
                  ...(h.title ? { title: h.title } : {}),
                })),
              });
            } else if (e.analysis) {
              appendChat({
                role: "tool",
                text: `📊 ${e.analysis.summary}`,
                analysis: {
                  table: e.analysis.table,
                  ...(e.analysis.summary ? { summary: e.analysis.summary } : {}),
                  ...(e.analysis.chart ? { chart: e.analysis.chart } : {}),
                },
              });
            } else if (e.memory) {
              appendChat({
                role: "tool",
                text: `🧠 ${e.memory.action === "remembered" ? "Remembered" : "Forgot"}: “${e.memory.note}”`,
              });
              refreshMemories(); // shared memory — keep the Memory panel in sync with in-book chat edits
            } else if (e.passages?.length) {
              // Slash-command /book results (model-driven searches consume these
              // silently as feedback; a direct command shows them to the reader).
              appendChat({
                role: "tool",
                text: e.passages
                  .map((p) => `Chapter ${p.chapterIndex + 1}${p.chapterTitle ? ` (${p.chapterTitle})` : ""}: ${p.text}`)
                  .join("\n\n"),
              });
            } else if (e.bibleDetail !== undefined) {
              appendChat({
                role: "tool",
                text: e.bibleDetail || `Nothing in the Visual Bible matches that yet.`,
              });
            } else if (text.startsWith("/") && e.error) {
              // A direct command's failure has no model to fold it into — show it.
              appendChat({ role: "tool", text: `⚠ ${e.error}` });
            } else if (text.startsWith("/") && e.call.tool === "search_book") {
              appendChat({ role: "tool", text: `🔍 Nothing found in the book for “${e.call.query}”.` });
            } else if (e.call.tool === "search_images") {
              // Make a failed/empty figure search VISIBLE — otherwise it looks like
              // nothing happened (Commons is encyclopedic; misses are common).
              appendChat({ role: "tool", text: imageSearchMiss(e.call.query, e.error, hasSearchKey) });
            } else if (e.call.tool === "search_web" && !e.hits?.length) {
              appendChat({ role: "tool", text: `🔍 No web results for “${e.call.query}”.` });
            }
          }
        },
      );
      // Always clear THIS turn's busy/transient state unless a newer turn superseded
      // it (that newer turn owns the busy flag) — so a book switch/exit mid-turn can
      // never leave the panel stuck "Thinking…". Then ignore the RESULT itself when
      // it belongs to a book the reader has since left, or a superseded turn.
      if (chatTurnSeq.current === seq) {
        setChatBusy(false);
        setChatStreaming("");
        setChatThinking("");
        setChatActivity("");
      }
      if (chatBookRef.current?.id !== turnBookId || chatTurnSeq.current !== seq) return;
      if (res.error) {
        appendChat({ role: "tool", text: `⚠ ${res.error}`, turns: [] });
        return;
      }
      if (res.pendingTool) {
        // export_book is a safe host action — run it now and feed the result back,
        // rather than showing the (image-only) approval bubble.
        if (res.pendingTool.tool === "export_book") {
          void runChatExport(res.pendingTool.format, [{ role: "user", content: text }, ...res.transcript]);
          return;
        }
        // export_data is a safe host action too — build the .xlsx/.csv and save it.
        if (res.pendingTool.tool === "export_data") {
          const { format, totals, analyze, chart } = res.pendingTool;
          void runChatDataExport(format, totals, !!analyze, chart, [{ role: "user", content: text }, ...res.transcript]);
          return;
        }
        // set_cell / add_formula_column edit the open spreadsheet in place.
        if (res.pendingTool.tool === "set_cell" || res.pendingTool.tool === "add_formula_column") {
          void runChatDataEdit(res.pendingTool, [{ role: "user", content: text }, ...res.transcript]);
          return;
        }
        pendingTranscript.current = [{ role: "user", content: text }, ...res.transcript];
        setChatPendingTool(res.pendingTool);
        return;
      }
      // Store the model-facing transcript whenever there was one (tool rounds), even
      // if the final visible prose is empty — otherwise the next turn loses the
      // exchange and the tool feedback the model expects to have seen (L5).
      if (res.text || res.transcript.length > 0) {
        appendChat({
          role: "assistant",
          text: res.text,
          turns: [{ role: "user", content: text }, ...res.transcript],
        });
      }
    },
    [book, chatMessages, chat, activePageIndex, activeParagraphId, isTechnical, allowSpoilers, hasSearchKey],
  );

  const onApproveChatTool = useCallback(async () => {
    const call = chatPendingTool;
    if (!call || call.tool !== "generate_image") return;
    if (chatRenderingRef.current) return; // a render is already in flight — drop the duplicate approval
    chatRenderingRef.current = true;
    setChatPendingTool(undefined);
    setChatBusy(true);
    setChatActivity("Generating the image…");
    try {
      const out = await chatTool(call, {
        onProgress: (f) => setChatActivity(`Generating the image… ${Math.round(f * 100)}%`),
      });
      setChatBusy(false);
      setChatActivity("");
      const feedback = formatToolResult(call, {
        image: { ok: Boolean(out.image), ...(out.error ? { error: out.error } : {}) },
      });
      appendChat({
        role: "tool",
        text: out.error ? `⚠ Image generation failed: ${out.error}` : "",
        ...(out.image ? { image: out.image } : {}),
        turns: [...pendingTranscript.current, { role: "user", content: feedback }],
      });
      pendingTranscript.current = [];
    } finally {
      chatRenderingRef.current = false;
    }
  }, [chatPendingTool, chatTool]);

  const onClearChat = useCallback(() => {
    // Supersede + cancel any in-flight turn and return the panel to a clean idle
    // state — clearing while "thinking" otherwise left it stuck busy with no reply.
    chatTurnSeq.current++;
    chatCancel();
    setChatBusy(false);
    setChatStreaming("");
    setChatActivity("");
    setChatMessages([]);
    setChatPendingTool(undefined);
    if (book) void libraryStore.deleteChatHistory?.(book.id);
  }, [book, libraryStore, chatCancel]);

  // Stable view-model + handlers for the memoised ChatPanel: rebuilt only when the
  // history actually changes, so app-level renders (scroll frames, status lines)
  // don't re-render every settled bubble, and bubble object identity holds across
  // keystrokes/stream tokens (MessageBubble is memoised on it).
  const chatPanelMessages = useMemo(
    () =>
      chatMessages.map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.image ? { image: m.image } : {}),
        ...(m.links ? { links: m.links } : {}),
        ...(m.gallery ? { gallery: m.gallery } : {}),
        ...(m.analysis ? { analysis: m.analysis } : {}),
      })),
    [chatMessages],
  );
  const onChatSendText = useCallback((text: string) => void onChatSend(text), [onChatSend]);
  const onApprovePendingTool = useCallback(() => void onApproveChatTool(), [onApproveChatTool]);
  const onDismissPendingTool = useCallback(() => {
    setChatPendingTool(undefined);
    pendingTranscript.current = [];
  }, []);
  const onCloseChat = useCallback(() => setShowChat(false), []);

  // --- Landing-page buddy ------------------------------------------------------
  // Same persistence scheme as the per-book chat, under a reserved key that can
  // never collide with a book id (epub hashes / "text-…").
  const buddyReady = useRef(false);
  useEffect(() => {
    // On a linked PHONE the chat is mirrored from the desktop (vrsync:chat), not loaded locally —
    // loading the phone's own (empty/stale) sessions here would clobber the mirror.
    if (isRemoteClient) return;
    let cancelled = false;
    void (async () => {
      const rawSessions = await libraryStore.getMemo?.("buddy-sessions").catch(() => undefined);
      let sessions: BuddySession[] = [];
      try {
        const parsed = rawSessions ? (JSON.parse(rawSessions) as unknown) : null;
        if (Array.isArray(parsed)) {
          sessions = parsed
            .filter((s): s is BuddySession => !!s && typeof (s as BuddySession).id === "string")
            .map((s) => ({ id: s.id, workingDir: typeof s.workingDir === "string" ? s.workingDir : "" }));
        }
      } catch {
        /* corrupt — start fresh below */
      }
      if (sessions.length === 0) {
        // First run (or pre-sessions install): migrate the legacy single working-dir.
        const legacyDir = (await libraryStore.getMemo?.("buddy-working-dir").catch(() => undefined)) || "";
        sessions = [{ id: BUDDY_CHAT_ID, workingDir: legacyDir }];
      }
      const savedActive = (await libraryStore.getMemo?.("buddy-active-session").catch(() => undefined)) || BUDDY_CHAT_ID;
      const active = sessions.some((s) => s.id === savedActive) ? savedActive : sessions[0]!.id;
      const hist = await libraryStore.getChatHistory?.(active).catch(() => undefined);
      if (cancelled) return;
      const savedPlan = await loadBuddyPlan(active);
      const savedWorkflow = await loadBuddyWorkflow(active);
      const savedLedger = await loadFileLedger(active);
      if (cancelled) return;
      setBuddySessions(sessions);
      setActiveBuddyId(active);
      if (hist) setBuddyMessages(hist);
      createdFilesRef.current = savedLedger; // the active session's written-files ledger (pushed per turn)
      setFileLedger(savedLedger);
      setBuddyPlan(savedPlan);
      buddyPlanRef.current = savedPlan; // match the ref to the restored session's plan from the first tick
      // App-managed: restore the workflow too (the plan above is just its projection), so the executor
      // resumes at the active step with its contracts/attempts instead of stalling.
      setBuddyWorkflow(savedWorkflow);
      buddyWorkflowRef.current = savedWorkflow;
      buddyReady.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryStore, isRemoteClient]);
  // Persist the ACTIVE session's history (debounced). Deletion is explicit (clear /
  // delete session), so an empty conversation just stores nothing — never wiping a
  // session before its history has loaded. On a linked PHONE the chat is the desktop's
  // (mirrored), so the phone never persists it to its own store.
  useEffect(() => {
    // Incognito (remote privacy): the desktop runs the turn but never writes the conversation, so a
    // remote session leaves nothing on disk.
    if (isRemoteClient || settings.incognitoRemote || !buddyReady.current || buddyMessages.length === 0) return;
    const id = activeBuddyId;
    const t = setTimeout(() => {
      void (async () => {
        // Externalize image bytes OUT of the persisted array: write each new blob to the chat blob store
        // (once per id), then persist the byte-stripped messages so the history stays small (no megabyte
        // re-write per turn) and a reload starts lean — images re-load lazily from the blob store. The
        // in-RAM `buddyMessages` keep their bytes for the live session; only the DISK copy is stripped.
        const stored: StoredChatMessage[] = [];
        for (const m of buddyMessages) {
          // Deterministic per-message ids (reset per message, stable order: attachments then inline) so
          // re-persisting the same message yields the same id — no orphaned blobs across turns.
          let k = 0;
          const { message, blobs } = externalizeChatImages(m, () => `img-x-${m.at}-${k++}`);
          if (libraryStore.putImageBlob) {
            for (const b of blobs) {
              const key = `${id}::${b.id}`;
              if (writtenBlobIds.current.has(key)) continue;
              await libraryStore.putImageBlob(id, b.id, b.bytes, b.mimeType);
              writtenBlobIds.current.add(key);
            }
            stored.push(message);
          } else {
            stored.push(m); // backend without a blob store: persist bytes inline (legacy behavior)
          }
        }
        await libraryStore.putChatHistory?.(id, stored);
      })();
    }, 500);
    return () => clearTimeout(t);
  }, [buddyMessages, activeBuddyId, libraryStore, isRemoteClient, settings.incognitoRemote]);

  const appendBuddy = (msg: Omit<StoredChatMessage, "at">) =>
    setBuddyMessages((prev) => [...prev, { ...msg, at: Date.now() }]);
  // A reference line posted to the buddy chat when an out-of-chat button does something (scan,
  // plan, create task), so the buddy thread is a running record of "what worked". A `tool`-role
  // note renders as a system line (like a delegated-subtask note), not as the assistant talking.
  buddyNoteRef.current = (text: string) => appendBuddy({ role: "tool", text });

  // Open a local file the desktop `/find` surfaced: read its bytes via the Rust
  // bridge, then run it through the SAME importer as an upload. On a linked PHONE there's no
  // filesystem of its own — relay the path so the DESKTOP reads + imports + opens it (the opened
  // book then mirrors back via vrsync:book, so it appears in the phone's reader + library).
  const onOpenLocalFile = useCallback(
    async (path: string) => {
      if (isRemoteClient) {
        sendAppSync({ type: "vrcmd:openLocalFile", path });
        return;
      }
      try {
        const file = await readLocalFile(path);
        await onUpload(file);
      } catch (err) {
        setLocalError(`Couldn't open that file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [isRemoteClient, sendAppSync, onUpload],
  );
  // DESKTOP side: open a PC file a PHONE tapped (vrcmd:openLocalFile). Unlike the desktop's own click
  // (which routes a doc through the paste-confirm modal — the phone can't see that), this creates the
  // book DIRECTLY from the import (sensible defaults: the file's name as title, the detected mode),
  // then openBook mirrors it to the phone. A buddy note carries the outcome so the phone sees feedback.
  const openLocalFileDirect = useCallback(
    async (path: string) => {
      try {
        const file = await readLocalFile(path);
        const imported = await importBookFile(file);
        if (imported.kind === "book") {
          openBook(imported.book);
        } else if (imported.kind === "image") {
          // An image isn't a book; the desktop's photo (img2img) panel can't be driven from the phone.
          buddyNoteRef.current(`🖼 “${file.name}” is an image — open it in the desktop's photo tools.`);
        } else {
          const created = bookFromText(imported.title, imported.text, imported.mode, "Imported file");
          openBook({
            ...created,
            ...(imported.data ? { data: imported.data } : {}),
            ...(imported.dataSheets ? { dataSheets: imported.dataSheets } : {}),
            ...(imported.tree !== undefined ? { tree: imported.tree } : {}),
          });
          buddyNoteRef.current(`📖 Opened “${imported.title}” in the reader.`);
        }
      } catch (err) {
        buddyNoteRef.current(`⚠ Couldn't open that file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [openBook],
  );
  useEffect(() => {
    openLocalFileRef.current = openLocalFileDirect;
  }, [openLocalFileDirect]);

  // Materialize a surfaced FileRef (created content or generated bytes) into a real File so it flows
  // through the SAME importer as an uploaded file.
  const fileFromRef = useCallback((ref: FileRef): File => {
    const type = ref.mime || "application/octet-stream";
    const body: BlobPart = ref.bytes ? new Uint8Array(ref.bytes) : (ref.content ?? "");
    return new File([body], ref.name, { type });
  }, []);

  // Import a surfaced file and SAVE it to the library (without taking over the screen). A found PC
  // file is read first; in-chat content/bytes import directly. Refreshes the library list + notes it.
  const addRefToLibrary = useCallback(
    async (ref: FileRef): Promise<void> => {
      try {
        const file = ref.path ? await readLocalFile(ref.path) : fileFromRef(ref);
        const imported = await importBookFile(file);
        if (imported.kind === "image") {
          buddyNoteRef.current(`🖼 “${ref.name}” is an image — open it in the photo tools, not the library.`);
          return;
        }
        const book =
          imported.kind === "book"
            ? imported.book
            : {
                ...bookFromText(imported.title, imported.text, imported.mode ?? "fiction", "Created in chat"),
                ...(imported.data ? { data: imported.data } : {}),
                ...(imported.dataSheets ? { dataSheets: imported.dataSheets } : {}),
                ...(imported.tree !== undefined ? { tree: imported.tree } : {}),
              };
        await libraryStore.putBook(book);
        const lib = await libraryStore.listBooks();
        setLibrary(lib);
        buddyNoteRef.current(`📚 Added “${ref.name}” to your library.`);
      } catch (err) {
        buddyNoteRef.current(`⚠ Couldn't add to the library: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [fileFromRef, libraryStore],
  );

  // Desktop "Open on PC": a found file opens by its path; in-chat content/bytes are saved to the
  // exports folder first, then opened in the OS default app.
  const revealRefOnPC = useCallback(
    async (ref: FileRef): Promise<void> => {
      try {
        let path = ref.path;
        if (!path) {
          const data = ref.bytes ? new Uint8Array(ref.bytes) : (ref.content ?? "");
          const saved = await saveExportFile(ref.name, data, ref.mime || "application/octet-stream");
          if (typeof saved === "string") path = saved;
        }
        if (path) await openPathOnPC(path);
      } catch (err) {
        buddyNoteRef.current(`⚠ Couldn't open it on your PC: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [],
  );

  // PHONE: fetch an older image card's bytes back from the desktop on demand (the mirror strips heavy
  // bytes from old cards to stay tunnel-safe; the desktop kept the originals). Resolves undefined on
  // timeout or if the desktop can't find it. No-op (undefined) off a linked phone.
  const fetchRemoteFileBytes = useCallback(
    (id: string): Promise<ArrayBuffer | undefined> =>
      new Promise((resolve) => {
        if (!isRemoteClient) return resolve(undefined);
        const reqId = ++fileFetchSeq.current;
        const timer = setTimeout(() => {
          fileChunkBufs.current.delete(reqId); // drop any partial chunks for this stalled fetch
          if (fileFetchPending.current.delete(reqId)) resolve(undefined);
        }, 45000); // generous: a big image arrives as several chunked frames
        fileFetchPending.current.set(reqId, ({ bytes }) => {
          clearTimeout(timer);
          resolve(bytes);
        });
        sendAppSync({ type: "vrcmd:fetchFile", reqId, id });
      }),
    [isRemoteClient, sendAppSync],
  );
  // Seed the LRU with a restored image's bytes (bounded to 20 so the cache can't grow without limit),
  // then re-inline it into the visible messages.
  const cacheRestoredImage = useCallback((id: string, bytes: ArrayBuffer, mimeType: string) => {
    restoredImages.current.set(id, { bytes, mimeType });
    while (restoredImages.current.size > 20) {
      const oldest = restoredImages.current.keys().next().value;
      if (oldest === undefined) break;
      restoredImages.current.delete(oldest);
    }
    setBuddyMessages((prev) => restoreInlineImages(prev, restoredImages.current));
  }, []);
  // The mime to render a restored image with: the byte-less inline `{ id, mimeType }`, else the image
  // file-card's mime, else PNG.
  const restoredImageMime = (m: StoredChatMessage): string => {
    if (m.image && "id" in m.image) return m.image.mimeType || "image/png";
    return m.attachments?.find((a) => a.kind === "image" && a.id && !a.bytes)?.mime || "image/png";
  };
  // Re-hydrate a RECENT message whose image bytes were stripped — on the PHONE the mirror dropped them
  // to stay tunnel-safe (fetch back over the tunnel, chunked); on the DESKTOP they were externalized to
  // the chat blob store on persist (load back from there after a reload). Cached by id so it survives a
  // mirror re-push; bounded by the LRU so RAM stays flat across a long image-heavy session.
  useEffect(() => {
    const chatId = activeBuddyId;
    for (const m of buddyMessages.slice(-8)) {
      const id = externalizedImageId(m);
      if (!id || restoredImages.current.has(id) || fetchingImageIds.current.has(id)) continue;
      const mime = restoredImageMime(m);
      fetchingImageIds.current.add(id);
      const load: Promise<ArrayBuffer | undefined> = isRemoteClient
        ? fetchRemoteFileBytes(id)
        : (libraryStore.getImageBlob?.(chatId, id).then((b) => b?.bytes) ?? Promise.resolve(undefined));
      void load.then((bytes) => {
        fetchingImageIds.current.delete(id);
        if (bytes) cacheRestoredImage(id, bytes, mime);
      });
    }
  }, [isRemoteClient, buddyMessages, fetchRemoteFileBytes, activeBuddyId, libraryStore, cacheRestoredImage]);
  // Fill in a card's bytes from the desktop when the mirror stripped them (older image on a phone).
  const withFetchedBytes = useCallback(
    async (ref: FileRef): Promise<FileRef> => {
      if (ref.bytes || ref.path || ref.content || !isRemoteClient || !ref.id) return ref;
      const bytes = await fetchRemoteFileBytes(ref.id);
      return bytes ? { ...ref, bytes } : ref;
    },
    [isRemoteClient, fetchRemoteFileBytes],
  );

  // The universal file-card actions, shared by both chats: Download (save a copy), Open in app
  // (reader), Open in library (save for later), and — on desktop — Open on PC (OS default app).
  const buddyFileActions = useMemo<FileActions>(
    () => ({
      download: async (ref0) => {
        const ref = await withFetchedBytes(ref0);
        // A found PC file carries only a path — read its bytes off disk so "Save a copy" works for it
        // too (in-chat content/bytes save directly).
        const data: Uint8Array | string = ref.path
          ? new Uint8Array(await (await readLocalFile(ref.path)).arrayBuffer())
          : ref.bytes
            ? new Uint8Array(ref.bytes)
            : (ref.content ?? "");
        const saved = await saveNamed(ref.name, data, ref.mime || "application/octet-stream", "Save this file");
        return saved ?? true; // cancel is "handled"
      },
      openInApp: (ref) => {
        if (ref.path) void onOpenLocalFile(ref.path);
        else void withFetchedBytes(ref).then((r) => onUpload(fileFromRef(r)));
      },
      openInLibrary: (ref) => void withFetchedBytes(ref).then((r) => addRefToLibrary(r)),
      ...(isDesktop ? { openOnPC: (ref: FileRef) => void revealRefOnPC(ref) } : {}),
      // "Open as…" — re-route the SAME file through a chosen reader (overrides the extension default).
      openAs: (ref, as) => {
        if (ref.path) void readLocalFile(ref.path).then((f) => onUpload(f, as));
        else void withFetchedBytes(ref).then((r) => onUpload(fileFromRef(r), as));
      },
    }),
    [saveNamed, onOpenLocalFile, onUpload, fileFromRef, addRefToLibrary, revealRefOnPC, withFetchedBytes],
  );

  // Run a local-file search and present the matches as clickable chips. `modelTurns`
  // (the conversational find_files path) bakes a model-facing feedback turn into the
  // result so the buddy can follow up; the direct `/find` path passes none.
  const runFileSearch = async (query: string, modelTurns?: ChatTurn[], preHistory?: ChatTurn[]): Promise<void> => {
    if (!isDesktop) {
      appendBuddy({ role: "tool", text: "🔒 Searching your computer needs the desktop app.", ...(modelTurns ? { turns: [] } : {}) });
      return;
    }
    setBuddyBusy(true);
    setBuddyActivity(`Searching your files for “${query}”…`);
    try {
      const ranked = rankLocalFiles(query, await searchLocalFiles(query, buddyWorkingDir || undefined), 15);
      // The model-facing result of the search, fed back so the buddy can read/open the file next.
      const feedback = modelTurns
        ? formatBuddyToolResult({ tool: "find_files", query }, { files: ranked.map((f) => ({ path: f.path, name: f.name })) })
        : undefined;
      const baked = feedback ? { turns: [...modelTurns!, { role: "user" as const, content: feedback }] } : {};
      if (ranked.length === 0) {
        appendBuddy({ role: "tool", text: `No importable files matched “${query}”.`, ...baked });
      } else {
        lastRefs.current = ranked.map((f) => ({ kind: "file", label: f.name, path: f.path }));
        // Surface each hit as the universal file CARD (not a bare chip): the reader picks an action —
        // Open in app, Open in library, Open on PC, Download — instead of a single click jumping
        // straight into the book reader.
        appendBuddy({
          role: "tool",
          text: `Found ${ranked.length} file${ranked.length === 1 ? "" : "s"} — open one with its buttons:`,
          attachments: ranked.map((f) => ({
            name: f.name,
            mime: "",
            kind: "found" as const,
            path: f.path,
          })),
          ...baked,
        });
      }
      // AUTO-REACT: when the MODEL asked for the search (not the user's /find command), continue the
      // turn so it reads/opens the file it was looking for, instead of stopping until the user says
      // "continue". Mirrors approveRunCommand. The /find path (no modelTurns) just shows the results.
      if (feedback) {
        await dispatchBuddyTurn([...(preHistory ?? []), ...modelTurns!], feedback);
      }
    } catch (err) {
      appendBuddy({
        role: "tool",
        text: `⚠ File search failed: ${err instanceof Error ? err.message : String(err)}`,
        ...(modelTurns ? { turns: [] } : {}),
      });
    } finally {
      setBuddyBusy(false);
      setBuddyActivity("");
    }
  };

  // Approve a buddy-requested find_files: run it, then AUTO-REACT (continue the turn) so the model
  // opens/reads the file it found. Carries the pending transcript + history for the continuation.
  const approveFindFiles = (call: Extract<BuddyToolCall, { tool: "find_files" }>): void => {
    setBuddyPendingTool(undefined);
    const turns = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    void runFileSearch(call.query, turns, preHistory);
  };

  // Approve a buddy-requested shell command: run it (desktop), show the output, and
  // bake the result into history so the model can read it and fix/continue. The
  // model only ever PROPOSES; nothing runs without this explicit approval.
  const approveRunCommand = async (call: Extract<BuddyToolCall, { tool: "run_command" }>): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current; // [{user:driver}, {assistant:run_command JSON}]
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    if (!isDesktop) {
      appendBuddy({ role: "tool", text: "🔒 Running commands needs the desktop app.", turns: [] });
      return;
    }
    setBuddyBusy(true);
    setBuddyActivity(`Running: ${call.command}`);
    let r;
    try {
      // Authenticate gh/git for this command via the env (token never enters the
      // command string or the chat) when a GitHub token is configured; run it in the
      // session's chosen working folder (or the default workspace when unset).
      r = await runCommand(
        call.command,
        settings.keys?.github || undefined,
        buddyWorkingDir || undefined,
        settings.commandShell,
      );
    } catch (err) {
      // Feed the failure back so the buddy explains it + offers a next step (don't dead-end).
      const message = err instanceof Error ? err.message : String(err);
      const fail = toolFailureDirective("run_command", message);
      appendBuddy({ role: "tool", text: `⚠ Couldn't run the command: ${message}`, turns: [...pre, { role: "user", content: fail }] });
      await dispatchBuddyTurn([...preHistory, ...pre], fail);
      return;
    }
    const feedback = formatBuddyToolResult(call, { command: r });
    const summary =
      `$ ${call.command}${r.cwd ? `   (in ${r.cwd})` : ""}\n[exit ${r.code}${r.timedOut ? " · timed out" : ""}]` +
      (r.stdout ? `\n${r.stdout.slice(0, 4000)}` : "") +
      (r.stderr ? `\n⚠ ${r.stderr.slice(0, 2000)}` : "");
    appendBuddy({ role: "tool", text: summary, turns: [...pre, { role: "user", content: feedback }] });
    // App-managed steps: the command IS this step's action — judge it by exit code (the collar).
    if (appManagedActive && buddyWorkflowRef.current) {
      buddyStepEvidenceRef.current.toolResults.push({ call, result: { command: r } });
      await advanceWorkflowAfterTurn(
        { toolResults: buddyStepEvidenceRef.current.toolResults, text: "" },
        (nudge) => dispatchBuddyTurn([...preHistory, ...pre], nudge),
      );
      return;
    }
    // AUTO-REACT: the model reads the output and continues — if it proposes another
    // command, that re-prompts for approval, so the loop stays human-gated.
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };

  // send_email (approval-gated): actually send the mail the buddy composed, then feed the
  // outcome back so it confirms to the reader. Mirrors approveRunCommand.
  const approveSendEmail = async (call: Extract<BuddyToolCall, { tool: "send_email" }>): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    setBuddyBusy(true);
    setBuddyActivity(`Sending email to ${call.to.join(", ")}…`);
    const r = await sendBuddyEmail({
      to: call.to,
      subject: call.subject,
      body: call.body,
      ...(call.cc ? { cc: call.cc } : {}),
      ...(call.bcc ? { bcc: call.bcc } : {}),
    });
    setBuddyBusy(false);
    setBuddyActivity("");
    const result = { email: { sent: !r.error, to: call.to, subject: call.subject, ...(r.id ? { id: r.id } : {}), ...(r.error ? { error: r.error } : {}) } };
    const feedback = formatBuddyToolResult(call, result);
    const summary = r.error ? `⚠ Couldn't send the email: ${r.error}` : `📧 Sent "${call.subject}" to ${call.to.join(", ")}.`;
    appendBuddy({ role: "tool", text: summary, turns: [...pre, { role: "user", content: feedback }] });
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };

  // Execute ONE coding-agent host tool in the agent's worktree `cwd` (Phase 1: autonomous, no
  // per-step click). run_command + write_file are the writers; anything else is declined so the
  // agent adapts. Returns the structured result the worker feeds back into that agent's loop.
  const executeAgentTool = async (
    call: BuddyToolCall,
    cwd: string,
  ): Promise<BuddyToolResultPayload> => {
    if (call.tool === "run_command") {
      const r = await runCommand(call.command, settings.keys?.github || undefined, cwd, settings.commandShell);
      return { command: r };
    }
    if (call.tool === "write_file") {
      try {
        const saved = await writeWorkspaceFile(call.path, call.content, cwd, call.append);
        return { writeFile: { path: saved, ok: true } };
      } catch (err) {
        return { writeFile: { path: call.path, ok: false, error: err instanceof Error ? err.message : String(err) } };
      }
    }
    return { error: `the "${call.tool}" tool isn't available to a coding agent — use run_command (e.g. ls/grep) or write_file in your worktree` };
  };

  // Auto-run the agent's tool (Autonomous workspace) OR queue it for the reader's per-step approval
  // (Phase 2). Queued tools resolve when the reader approves (run) or denies (the agent adapts);
  // siblings keep running while one waits.
  const runOrQueueAgentTool = (call: BuddyToolCall, cwd: string, title: string): Promise<BuddyToolResultPayload> => {
    if (settings.autonomousWorkspace) return executeAgentTool(call, cwd);
    return new Promise<BuddyToolResultPayload>((resolve) => {
      const id = nextAgentApprovalId.current++;
      agentApprovalCtx.current.set(id, { call, cwd, resolve });
      setAgentApprovals((q) => [...q, { id, title, call }]);
    });
  };
  // The coding-agent run + its approval resolvers live on the DESKTOP; on a linked phone, relay the
  // reader's click by id and let the desktop resolve the waiting step.
  const onApproveAgentTool = (id: number): void => {
    if (isRemoteClient) {
      sendAppSync({ type: "vrcmd:chatAgentApprove", id });
      return;
    }
    const ctx = agentApprovalCtx.current.get(id);
    agentApprovalCtx.current.delete(id);
    setAgentApprovals((q) => q.filter((a) => a.id !== id));
    if (ctx) void executeAgentTool(ctx.call, ctx.cwd).then(ctx.resolve);
  };
  const onDenyAgentTool = (id: number): void => {
    if (isRemoteClient) {
      sendAppSync({ type: "vrcmd:chatAgentDeny", id });
      return;
    }
    const ctx = agentApprovalCtx.current.get(id);
    agentApprovalCtx.current.delete(id);
    setAgentApprovals((q) => q.filter((a) => a.id !== id));
    ctx?.resolve({ error: "the reader declined this step — try a different approach or stop here" });
  };

  // Auto-resolve a conflicted merge with the manager (main) model. Reads the 3 merge sides per
  // conflicted file, asks the model to merge them, writes the results back, and lets the Rust side
  // COMPLETE the merge only if nothing is unmerged and no markers remain — otherwise returns false
  // (the caller aborts). Bounded + binary-skipping; any doubt → false, never a bad commit.
  const tryAutoResolveConflicts = async (root: string, files: string[], title: string): Promise<boolean> => {
    try {
      if (files.length === 0 || files.length > 20) return false;
      const versions = await Promise.all(
        files.map(async (file) => ({ file, ...(await gitConflictVersions(root, file)) })),
      );
      // Skip binary (null byte) or very large conflicts — the model can't reliably merge those.
      if (versions.some((v) => (v.ours + v.theirs).includes(String.fromCharCode(0)) || v.ours.length + v.theirs.length > 200_000))
        return false;
      const res = await resolveConflicts(title, versions);
      if (res.error || !res.files || res.files.length !== files.length) return false;
      // Validate the model's output before touching disk; reject any leftover markers.
      if (res.files.some((f) => hasConflictMarkers(f.content))) return false;
      for (const f of res.files) await writeWorkspaceFile(f.file, f.content, root);
      // Rust completes the merge only if no path is unmerged and no markers are staged (code 0).
      const done = await gitCompleteMerge(root, `merge ${title} (auto-resolved ${files.length} conflict${files.length === 1 ? "" : "s"})`);
      return done.code === 0;
    } catch {
      return false;
    }
  };

  // Approved spawn_coding_agents: create a git worktree per task, run the write-capable agents in
  // parallel, then the APP commits + diffs + merges each branch back (cleaning up) and reports.
  const approveSpawnCodingAgents = async (
    call: Extract<BuddyToolCall, { tool: "spawn_coding_agents" }>,
  ): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    const bail = async (note: string): Promise<void> => {
      const feedback = `[spawn_coding_agents unavailable: ${note}]`;
      appendBuddy({ role: "tool", text: `🔒 ${note}`, turns: [...pre, { role: "user", content: feedback }] });
      await dispatchBuddyTurn([...preHistory, ...pre], feedback);
    };
    if (!isDesktop) return bail("coding agents need the desktop app");
    if (!settings.allowCommands)
      return bail("turn on 'run commands & see the screen' (Settings → assistant abilities) to use coding agents");
    if (!buddyWorkingDir)
      return bail("pick a working folder for this chat first (the folder icon) so the agents have a project to work in");

    setBuddyBusy(true);
    setBuddyActivity("Setting up coding agents…");
    const runId = Date.now().toString(36);
    let root: string;
    try {
      root = await gitEnsureRepo(buddyWorkingDir);
    } catch (err) {
      setBuddyBusy(false);
      return bail(`couldn't prepare a git repo: ${err instanceof Error ? err.message : String(err)}`);
    }
    // One worktree+branch per task.
    const created: { title: string; instructions: string; path: string; branch: string; base: string }[] = [];
    try {
      for (let i = 0; i < call.tasks.length; i++) {
        const info = await gitWorktreeCreate(root, agentBranchName(i, runId));
        created.push({ ...call.tasks[i]!, path: info.path, branch: info.branch, base: info.base });
      }
    } catch (err) {
      for (const c of created) await gitWorktreeRemove(root, c.path, c.branch).catch(() => {});
      setBuddyBusy(false);
      return bail(`couldn't create agent worktrees: ${err instanceof Error ? err.message : String(err)}`);
    }

    setBuddyActivity(`Running ${created.length} coding agents…`);
    const run = await runCodingAgents(
      runId,
      created.map((c) => ({ title: c.title, instructions: c.instructions, dir: c.path })),
      (call, cwd, agentIdx) => runOrQueueAgentTool(call, cwd, created[agentIdx]?.title ?? `agent ${agentIdx + 1}`),
    );
    const resultFor = (title: string): string =>
      run.results?.find((r) => r.title === title)?.result ?? "(no summary returned)";

    // App-managed merge: commit each worktree, diff it, merge its branch into the working tree.
    setBuddyActivity("Merging agents' work…");
    const outcomes: NonNullable<BuddyToolResultPayload["codingAgents"]> = [];
    for (const c of created) {
      let merge: "merged" | "resolved" | "conflict" | "failed" = "failed";
      let changedFiles = 0;
      try {
        await gitCommitAll(c.path, `agent: ${c.title}`);
        changedFiles = countChangedFiles(await gitWorktreeDiff(c.path, c.base));
        const m = await gitMergeBranch(root, c.branch);
        if (m.code === 0) merge = "merged";
        else {
          const conflictFiles = parseGitConflicts(`${m.stdout}\n${m.stderr}`);
          // Try the manager's auto-resolution (unless disabled); it either completes the merge or
          // we abort so the working tree stays clean and the branch is left for the reader.
          const resolved =
            conflictFiles.length > 0 && settings.autoResolveConflicts !== false
              ? await tryAutoResolveConflicts(root, conflictFiles, c.title)
              : false;
          if (resolved) merge = "resolved";
          else {
            merge = conflictFiles.length ? "conflict" : "failed";
            await gitMergeAbort(root).catch(() => {});
          }
        }
      } catch {
        merge = "failed";
      }
      if (merge === "merged") await gitWorktreeRemove(root, c.path, c.branch).catch(() => {});
      outcomes.push({ title: c.title, result: resultFor(c.title), merge, ...(changedFiles ? { changedFiles } : {}) });
    }

    setBuddyBusy(false);
    setBuddyActivity("");
    const mergedCount = outcomes.filter((o) => o.merge === "merged" || o.merge === "resolved").length;
    const feedback = formatBuddyToolResult(call, { codingAgents: outcomes });
    appendBuddy({
      role: "tool",
      text: `🤖 Coding agents: ${mergedCount}/${outcomes.length} merged into your working tree.`,
      turns: [...pre, { role: "user", content: feedback }],
    });
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };

  // write_file: save the file the model authored straight into the workspace (the sandboxed folder
  // run_command executes in — NOT the exports folder), then feed the result back so it can run_command
  // it. Saving needs no approval click (it just writes into the sandbox); the dangerous step,
  // run_command, stays gated unless Autonomous workspace is on. Mirrors approveRunCommand.
  const runWriteFile = async (call: Extract<BuddyToolCall, { tool: "write_file" }>): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    if (!isDesktop) {
      appendBuddy({ role: "tool", text: "🔒 Writing files needs the desktop app.", turns: [] });
      return;
    }
    if (!settings.allowCommands) {
      // write_file is advertised with command access on; if it slips through otherwise, degrade by
      // handing the content to the reader to save rather than dead-ending.
      appendBuddy({
        role: "tool",
        text: `🔒 Turn on "Let the assistant run commands" (Settings → assistant abilities) to let me save + run files in the workspace. Meanwhile, here's “${call.path}” to save yourself:`,
      });
      appendBuddy({ role: "assistant", text: "```\n" + call.content.slice(0, 8000) + "\n```" });
      return;
    }
    setBuddyBusy(true);
    setBuddyActivity(`Writing ${call.path}…`);
    let payload: { path: string; ok: boolean; error?: string };
    try {
      const saved = await writeWorkspaceFile(call.path, call.content, buddyWorkingDir || undefined, call.append);
      payload = { path: saved, ok: true };
      // Ledger it (keyed by the workspace-relative path the model used, so it can read_file it back) so
      // the model stays aware of the file across history trimming.
      recordCreatedFile(call.path, call.content ? call.content.split("\n").length : 0, !!call.append);
      // ALWAYS surface the authored file as a universal file card (Open in app / library / on PC /
      // Download), not just a "saved" line — the card reads from the on-disk path so it's correct even
      // for an append (whole file, not the fragment).
      appendBuddy({
        role: "tool",
        text: `📝 ${call.append ? "Appended to" : "Saved"} ${saved}`,
        attachments: [{ name: saved.split(/[\\/]/).pop() || saved, mime: "", kind: createdFileKind(saved), path: saved }],
        turns: [],
      });
      // If the assistant just edited the file open in the code window, show its change live there. (Skip
      // append chunks — call.content is a fragment, not the whole file.)
      const openCode = bookRef.current;
      if (!call.append && openCode?.contentMode === "code" && call.path === codeFileName(openCode)) {
        setCodeDraft(call.content);
        setBook((prev) => (prev && prev.id === openCode.id ? { ...prev, code: call.content } : prev));
        void libraryStore.putBook({ ...openCode, code: call.content }).catch(() => {});
      }
    } catch (err) {
      payload = { path: call.path, ok: false, error: err instanceof Error ? err.message : String(err) };
      appendBuddy({ role: "tool", text: `⚠ Couldn't write ${call.path}: ${payload.error}`, turns: [] });
    }
    const feedback = formatBuddyToolResult(call, { writeFile: payload });
    // App-managed steps: writing the file IS this step's action — judge it by whether it saved.
    if (appManagedActive && buddyWorkflowRef.current) {
      buddyStepEvidenceRef.current.toolResults.push({ call, result: { writeFile: payload } });
      await advanceWorkflowAfterTurn(
        { toolResults: buddyStepEvidenceRef.current.toolResults, text: "" },
        (nudge) => dispatchBuddyTurn([...preHistory, ...pre], nudge),
      );
      return;
    }
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };

  // Edit an EXISTING workspace file in place via search/replace (no whole-file rewrite). Reads the file,
  // applies the edits (each `search` must match exactly once), writes it back. Mirrors runWriteFile.
  const runEditFile = async (call: Extract<BuddyToolCall, { tool: "edit_file" }>): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    if (!isDesktop || !settings.allowCommands) {
      appendBuddy({ role: "tool", text: "🔒 Editing files needs the desktop app + command access (Settings → assistant abilities).", turns: [] });
      return;
    }
    setBuddyBusy(true);
    setBuddyActivity(`Editing ${call.path}…`);
    let payload: { path: string; ok: boolean; applied?: number; summary?: string; error?: string };
    try {
      const file = await readWorkspaceFile(call.path, buddyWorkingDir || undefined);
      if (!file.exists) {
        payload = { path: call.path, ok: false, error: "file not found — write_file it first, or check the path" };
        appendBuddy({ role: "tool", text: `⚠ edit_file: ${call.path} doesn't exist yet.`, turns: [] });
      } else {
        const r = applyFileEdits(file.text, call.edits);
        const summary = summarizeFileEdits(call.path, r);
        if (r.applied > 0) await writeWorkspaceFile(call.path, r.content, buddyWorkingDir || undefined);
        payload = { path: call.path, ok: r.applied > 0, applied: r.applied, summary };
        recordCreatedFile(call.path, r.content.split("\n").length, false);
        appendBuddy({
          role: "tool",
          text: r.failures.length === 0 ? `✏️ Edited ${call.path} (${r.applied} edit${r.applied === 1 ? "" : "s"})` : `✏️ ${call.path}: ${r.applied} applied, ${r.failures.length} failed`,
          attachments: [{ name: call.path.split(/[\\/]/).pop() || call.path, mime: "", kind: createdFileKind(call.path), path: file.path }],
          turns: [],
        });
        // Mirror a live change into the open code window (like runWriteFile).
        const openCode = bookRef.current;
        if (r.applied > 0 && openCode?.contentMode === "code" && call.path === codeFileName(openCode)) {
          setCodeDraft(r.content);
          setBook((prev) => (prev && prev.id === openCode.id ? { ...prev, code: r.content } : prev));
          void libraryStore.putBook({ ...openCode, code: r.content }).catch(() => {});
        }
      }
    } catch (err) {
      payload = { path: call.path, ok: false, error: err instanceof Error ? err.message : String(err) };
      appendBuddy({ role: "tool", text: `⚠ Couldn't edit ${call.path}: ${payload.error}`, turns: [] });
    }
    const feedback = formatBuddyToolResult(call, { editFile: payload });
    if (appManagedActive && buddyWorkflowRef.current) {
      // A file step is satisfied by a SUCCESSFUL edit (writeFile-shaped evidence so the collar's `file`
      // contract reads it the same as a write).
      buddyStepEvidenceRef.current.toolResults.push({ call, result: { writeFile: { path: call.path, ok: payload.ok, ...(payload.error ? { error: payload.error } : {}) } } });
      await advanceWorkflowAfterTurn(
        { toolResults: buddyStepEvidenceRef.current.toolResults, text: "" },
        (nudge) => dispatchBuddyTurn([...preHistory, ...pre], nudge),
      );
      return;
    }
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };

  // Delegate a hard, multi-file coding job to an EXTERNAL agent (Aider) running headless on the same
  // local model, in the workspace; capture its diff and feed a summary back. Mirrors runEditFile's
  // shape (capture pre-context, run, ledger the changed files, react in the workflow or plainly).
  const runDelegateCodingTask = async (call: Extract<BuddyToolCall, { tool: "delegate_coding_task" }>): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    if (!isDesktop || !settings.allowCommands) {
      appendBuddy({ role: "tool", text: "🔒 Delegating coding needs the desktop app + command access (Settings → assistant abilities).", turns: [] });
      return;
    }
    const model = (settings.localServerTextModel ?? "").trim();
    const serverUrl = (settings.localServerTextUrl ?? "").trim();
    const isOllama = (settings.localTextServer ?? "ollama") === "ollama";
    if (!model || !serverUrl || !isOllama) {
      const why = !isOllama ? "the external agent runs against Ollama — switch the chat model to an Ollama server" : "no local Ollama model is connected";
      const payload = { ok: false, installed: true, summary: `[delegate_coding_task can't run: ${why}. Do the change yourself with write_file/edit_file.]` };
      await dispatchBuddyTurn([...preHistory, ...pre], formatBuddyToolResult(call, { delegateCoding: payload }));
      return;
    }
    setBuddyBusy(true);
    setBuddyActivity("Delegating to the coding agent…");
    let payload: { ok: boolean; installed: boolean; summary: string };
    try {
      const editorModel = (settings.subAgentModel ?? "").trim();
      const r = await delegateCodingTask({
        task: call.task,
        backend: settings.codingAgentBackend ?? "aider",
        model,
        ...(editorModel ? { editorModel } : {}),
        textServerUrl: serverUrl,
        ...(call.files ? { files: call.files } : {}),
        ...(call.verify ? { verify: call.verify } : {}),
        ...(buddyWorkingDir ? { cwd: buddyWorkingDir } : {}),
        ...(settings.keys?.github ? { githubToken: settings.keys.github } : {}),
        ...(settings.commandShell ? { shell: settings.commandShell } : {}),
      });
      payload = { ok: r.ok, installed: r.installed, summary: r.summary };
      for (const f of r.files) recordCreatedFile(f, 0, false);
      appendBuddy({
        role: "tool",
        text: r.installed
          ? `🤝 Coding agent ${r.files.length > 0 ? `changed ${r.files.length} file(s)` : "ran"}${r.ok ? "" : " (review needed)"}`
          : "🤝 Aider isn't installed — install it (pipx install aider-chat) to delegate coding jobs.",
        turns: [],
      });
    } catch (err) {
      payload = { ok: false, installed: true, summary: `[delegate_coding_task failed: ${err instanceof Error ? err.message : String(err)}]` };
      appendBuddy({ role: "tool", text: `⚠ Coding delegation failed: ${err instanceof Error ? err.message : String(err)}`, turns: [] });
    }
    const feedback = formatBuddyToolResult(call, { delegateCoding: payload });
    if (appManagedActive && buddyWorkflowRef.current) {
      // Treat the delegated job like a command step for the collar: a clean run (and any verify pass,
      // folded into `ok`) satisfies a command_ok contract; a failure nudges a retry/fix.
      buddyStepEvidenceRef.current.toolResults.push({ call, result: { command: { stdout: payload.summary, stderr: "", code: payload.ok ? 0 : 1 } } });
      await advanceWorkflowAfterTurn(
        { toolResults: buddyStepEvidenceRef.current.toolResults, text: "" },
        (nudge) => dispatchBuddyTurn([...preHistory, ...pre], nudge),
      );
      return;
    }
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };

  // Approve a buddy-requested screenshot: capture the screen, show it, have the
  // vision model describe it, and feed that observation back so the model reacts.
  const approveScreenshot = async (call: Extract<BuddyToolCall, { tool: "screenshot" }>): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    if (!isDesktop) {
      appendBuddy({ role: "tool", text: "🔒 Capturing the screen needs the desktop app.", turns: [] });
      return;
    }
    setBuddyBusy(true);
    setBuddyActivity(call.window ? `Capturing “${call.window}”…` : "Capturing the screen…");
    let observation: string;
    let shotImage: { bytes: ArrayBuffer; mimeType: string } | undefined;
    try {
      const shot = await captureScreen(call.window);
      // Keep a copy for the visible bubble (assessImage transfers its bytes away).
      const display = shot.bytes.slice(0);
      shotImage = { bytes: display, mimeType: shot.mimeType };
      setBuddyActivity("Looking at the screen…");
      const r = await assessImage(shot, call.question);
      if (r.error) throw new Error(r.error);
      observation = r.text ?? "(the vision model returned nothing)";
    } catch (err) {
      // Feed the failure back so the buddy explains it + offers a next step (don't dead-end).
      const message = err instanceof Error ? err.message : String(err);
      const fail = toolFailureDirective("screenshot", message);
      appendBuddy({ role: "tool", text: `⚠ Screenshot failed: ${message}`, turns: [...pre, { role: "user", content: fail }] });
      await dispatchBuddyTurn([...preHistory, ...pre], fail);
      return;
    }
    const feedback = formatBuddyToolResult(call, { observation });
    appendBuddy({
      role: "tool",
      text: `📷 ${observation}`,
      ...(shotImage ? { image: shotImage } : {}),
      turns: [...pre, { role: "user", content: feedback }],
    });
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };

  // DESKTOP side of a phone-relayed host tool: run it with the SAME runtime + working folder the
  // desktop's own handlers use, and return just the result payload (the phone shows it + continues
  // its buddy turn). Reuses searchLocalFiles/runCommand/writeWorkspaceFile/captureScreen+assessImage.
  const runHostToolForRemote = useCallback(
    async (call: BuddyToolCall, cwdOverride?: string): Promise<BuddyToolResultPayload> => {
      // A linked phone relays its OWN chosen working folder (cwdOverride) so commands/files run where
      // the phone pointed them; the desktop's own session folder is the fallback.
      const dir = cwdOverride || buddyWorkingDir || undefined;
      try {
        if (call.tool === "find_files") {
          const ranked = rankLocalFiles(call.query, await searchLocalFiles(call.query, dir), 15);
          return { files: ranked.map((f) => ({ path: f.path, name: f.name })) };
        }
        if (call.tool === "run_command") {
          return { command: await runCommand(call.command, settings.keys?.github || undefined, dir, settings.commandShell) };
        }
        if (call.tool === "write_file") {
          try {
            const saved = await writeWorkspaceFile(call.path, call.content, dir, call.append);
            // If this (possibly phone-relayed) write targets the file open in the code window, keep the
            // open code book's source authoritative HERE — the book change-effect then re-mirrors the
            // latest to the phone's editor (vrsync:book), so its window refreshes. (Skip append chunks.)
            const open = bookRef.current;
            if (!call.append && open?.contentMode === "code" && call.path === codeFileName(open)) {
              setCodeDraft((prev) => (prev === call.content ? prev : call.content));
              setBook((prev) => (prev && prev.id === open.id && prev.code !== call.content ? { ...prev, code: call.content } : prev));
            }
            return { writeFile: { path: saved, ok: true } };
          } catch (err) {
            return { writeFile: { path: call.path, ok: false, error: err instanceof Error ? err.message : String(err) } };
          }
        }
        if (call.tool === "edit_file") {
          const file = await readWorkspaceFile(call.path, dir);
          if (!file.exists) return { editFile: { path: call.path, ok: false, error: "file not found" } };
          const r = applyFileEdits(file.text, call.edits);
          if (r.applied > 0) await writeWorkspaceFile(call.path, r.content, dir);
          return { editFile: { path: call.path, ok: r.applied > 0, applied: r.applied, summary: summarizeFileEdits(call.path, r) } };
        }
        if (call.tool === "delegate_coding_task") {
          const model = (settings.localServerTextModel ?? "").trim();
          const serverUrl = (settings.localServerTextUrl ?? "").trim();
          const isOllama = (settings.localTextServer ?? "ollama") === "ollama";
          if (!model || !serverUrl || !isOllama)
            return { delegateCoding: { ok: false, installed: true, summary: "[delegate_coding_task needs a connected Ollama model on the desktop.]" } };
          const editorModel = (settings.subAgentModel ?? "").trim();
          const r = await delegateCodingTask({
            task: call.task,
            backend: settings.codingAgentBackend ?? "aider",
            model,
            ...(editorModel ? { editorModel } : {}),
            textServerUrl: serverUrl,
            ...(call.files ? { files: call.files } : {}),
            ...(call.verify ? { verify: call.verify } : {}),
            ...(dir ? { cwd: dir } : {}),
            ...(settings.keys?.github ? { githubToken: settings.keys.github } : {}),
            ...(settings.commandShell ? { shell: settings.commandShell } : {}),
          });
          return { delegateCoding: { ok: r.ok, installed: r.installed, summary: r.summary } };
        }
        if (call.tool === "screenshot") {
          const shot = await captureScreen(call.window);
          const r = await assessImage(shot, call.question);
          return { observation: r.error ? `(couldn't read the screen: ${r.error})` : r.text ?? "" };
        }
        return { error: `"${call.tool}" still needs to be run from the desktop app directly.` };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    [buddyWorkingDir, settings.keys, settings.commandShell, settings.localServerTextModel, settings.localServerTextUrl, settings.localTextServer, settings.subAgentModel, settings.codingAgentBackend, assessImage],
  );
  useEffect(() => {
    runHostToolForRemoteRef.current = runHostToolForRemote;
  }, [runHostToolForRemote]);

  // PHONE side: relay a desktop-runtime host tool to the desktop and await its result payload.
  const runHostToolOnDesktop = useCallback(
    (call: BuddyToolCall): Promise<BuddyToolResultPayload> =>
      new Promise<BuddyToolResultPayload>((resolve) => {
        const requestId = ++hostToolReqId.current;
        hostToolPending.current.set(requestId, resolve);
        sendAppSync({ type: "vrcmd:hostTool", requestId, call, ...(buddyWorkingDir ? { cwd: buddyWorkingDir } : {}) });
        setTimeout(() => {
          if (hostToolPending.current.delete(requestId)) {
            resolve({ error: "The desktop didn't respond — check the phone link." });
          }
        }, 600_000);
      }),
    [sendAppSync, buddyWorkingDir],
  );

  // Run a host tool wherever the runtime is: directly on the desktop, or relayed to it from a phone.
  const execHostTool = useCallback(
    (call: BuddyToolCall): Promise<BuddyToolResultPayload> =>
      isRemoteClient ? runHostToolOnDesktop(call) : runHostToolForRemote(call),
    [isRemoteClient, runHostToolOnDesktop, runHostToolForRemote],
  );

  // Run a code block (Python/JS/shell) the assistant wrote and return its output — used by the chat
  // "▶ Run" button. Writes the code to a file then runs it with the matching interpreter, on the
  // DESKTOP (relayed from a phone via execHostTool). Gated by the allow-commands setting at the
  // call site, and the click itself is the user's go-ahead (like Save).
  const onRunCode = useCallback(
    async (lang: string, code: string, filename?: string): Promise<{ stdout?: string; stderr?: string; code?: number; error?: string; cwd?: string }> => {
      const l = (lang || "").toLowerCase();
      const ext = l === "python" || l === "py" ? "py" : l === "js" || l === "javascript" || l === "node" ? "js" : l === "sh" || l === "bash" || l === "shell" ? "sh" : undefined;
      if (!ext) return { error: `Can't run "${lang}" code here — try Python, JavaScript, or a shell script.` };
      const kind = ext === "py" ? "python" : ext === "js" ? "node" : "sh";
      // Resolve a WORKING interpreter (python3/python/py/…), not a hardcoded `python` that may not
      // exist. On the desktop a miss is a clear "install X" message; on a phone we relay to the
      // desktop with the plain name (its resolution happens there next time we wire it through).
      let interp: string = kind;
      if (isDesktop) {
        const resolved = await whichInterpreter(kind);
        if (!resolved) {
          const label = kind === "python" ? "Python" : kind === "node" ? "Node.js" : "a shell (sh/bash)";
          return { error: `No ${label} interpreter found on this computer. Install ${label} and restart the app (make sure it's on your PATH) — or ask me to run it as a command.` };
        }
        interp = resolved;
      }
      const safe = filename && /^[\w./-]{1,80}$/.test(filename) && filename.toLowerCase().endsWith(`.${ext}`) ? filename : `vr_run.${ext}`;
      const w = await execHostTool({ tool: "write_file", path: safe, content: code });
      if (w.error) return { error: w.error };
      if (w.writeFile && !w.writeFile.ok) return { error: w.writeFile.error ?? "couldn't write the file" };
      // Run by RELATIVE name (run_command's cwd is the same workspace write_file saved into), and
      // unquoted — `safe` is regex-restricted to word chars/dots/slashes (no spaces). This avoids
      // quoting an ABSOLUTE path, which on Windows cmd used to mangle into a doubled, broken path.
      const r = await execHostTool({ tool: "run_command", command: `${interp} ${safe}` });
      if (r.error) return { error: r.error };
      return r.command
        ? { stdout: r.command.stdout, stderr: r.command.stderr, code: r.command.code, ...(r.command.cwd ? { cwd: r.command.cwd } : {}) }
        : { error: "no output" };
    },
    [execHostTool],
  );

  // The exact source of a code book — the byte-accurate `code` field, falling back to re-joining the
  // segmented pages for legacy books saved before that field existed.
  const codeSourceOf = useCallback(
    (b: BookSource): string =>
      b.code ?? b.pages.flatMap((p) => p.paragraphs.map((para) => para.text)).join("\n\n"),
    [],
  );
  // A safe, run_command-findable filename for the open code book (its title, sanitised, at the
  // working-folder root so `python <name>` finds it). Falls back to a generic name.
  const codeFileName = useCallback((b: BookSource): string => {
    const safe = (b.title || "code").trim().replace(/[^\w.-]+/g, "_").slice(0, 80);
    return safe.replace(/^_+|_+$/g, "") || "code.txt";
  }, []);

  // Load the editor when a (different) code book opens; clear it otherwise. Gated on the book id so
  // persisting an edit back into `book` (same id) doesn't yank the draft out from under the typist.
  useEffect(() => {
    if (book?.contentMode === "code") setCodeDraft(codeSourceOf(book));
    else setCodeDraft("");
    setCodeRunOutput(undefined);
    setCodeRunning(false);
    setCodePreviewOpen(false); // start a freshly-opened code book on the source, not the render
  }, [book?.id, book?.contentMode]);

  // PHONE: when the desktop mirrors a new version of the OPEN code book — a buddy edit, or a
  // desktop-side edit to the same file — refresh the editor to match. The desktop owns the source and
  // our own edits round-trip through it, so an incoming value equal to what we already show is a no-op
  // (no cursor jump); only a genuinely different (newer) source replaces the draft.
  useEffect(() => {
    if (!isRemoteClient || book?.contentMode !== "code") return;
    const src = codeSourceOf(book);
    setCodeDraft((prev) => (prev === src ? prev : src));
  }, [isRemoteClient, book?.code, book?.contentMode, codeSourceOf, book]);

  // Edit in the code window: keep the live draft, then debounce-persist to the library AND write the
  // file into the workspace so a run (and, later, the assistant) sees the latest source.
  const onCodeDraftChange = useCallback(
    (text: string) => {
      setCodeDraft(text);
      const b = bookRef.current;
      if (!b || b.contentMode !== "code") return;
      const id = b.id;
      if (codeSaveTimer.current) clearTimeout(codeSaveTimer.current);
      codeSaveTimer.current = setTimeout(() => {
        setBook((prev) => (prev && prev.id === id ? { ...prev, code: text } : prev));
        void libraryStore.putBook({ ...b, code: text }).catch(() => {});
        if ((isDesktop || isRemoteClient) && settings.allowCommands) {
          void execHostTool({ tool: "write_file", path: codeFileName(b), content: text }).catch(() => {});
        }
      }, 700);
    },
    [libraryStore, isDesktop, isRemoteClient, settings.allowCommands, execHostTool, codeFileName],
  );

  // ▶ Run the code book: write the current draft to the workspace and run it with the matching
  // interpreter (on the desktop, relayed from a phone), then show the output under the editor.
  const runCodeBook = useCallback(async () => {
    const b = bookRef.current;
    if (!b || b.contentMode !== "code") return;
    setCodeRunning(true);
    setCodeRunOutput(undefined);
    try {
      const lang = b.language || codeFileName(b).split(".").pop() || "";
      const out = await onRunCode(lang, codeDraft, codeFileName(b));
      setCodeRunOutput(out);
    } catch (err) {
      setCodeRunOutput({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setCodeRunning(false);
    }
  }, [onRunCode, codeDraft, codeFileName]);

  // The code file currently open in the editable code window (workspace name + title + language), so a
  // buddy turn can edit/run THAT file in place instead of re-opening a fresh code book. Undefined unless
  // a code book is open.
  const openCodeContext = useCallback((): { name: string; title: string; language?: string } | undefined => {
    const b = bookRef.current;
    if (b?.contentMode !== "code") return undefined;
    return { name: codeFileName(b), title: b.title || "code", ...(b.language ? { language: b.language } : {}) };
  }, [codeFileName]);

  // PHONE side, unified: a desktop-runtime host tool the phone's buddy hit runs ON the desktop via the
  // relay, then the result feeds back into THIS phone's buddy turn exactly like the desktop handlers.
  const runBuddyHostToolRemote = async (call: BuddyToolCall): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    setBuddyBusy(true);
    setBuddyActivity(
      call.tool === "find_files"
        ? "Searching the desktop's files…"
        : call.tool === "run_command"
          ? `Running on the desktop: ${call.command}`
          : call.tool === "write_file"
            ? `Writing ${call.path} on the desktop…`
            : "Running on the desktop…",
    );
    try {
      const payload = await runHostToolOnDesktop(call);
      const feedback = formatBuddyToolResult(call, payload);
      const baked = pre.length ? { turns: [...pre, { role: "user" as const, content: feedback }] } : {};
      if (payload.files?.length) {
        appendBuddy({
          role: "tool",
          text:
            `Found ${payload.files.length} file${payload.files.length === 1 ? "" : "s"} on the desktop:\n` +
            payload.files.map((f, i) => `${i + 1}. ${f.name}`).join("\n"),
          ...baked,
        });
      } else {
        appendBuddy({ role: "tool", text: feedback.slice(0, 4000), ...baked });
      }
      if (pre.length) await dispatchBuddyTurn([...preHistory, ...pre], feedback);
    } catch (err) {
      appendBuddy({ role: "tool", text: `⚠ ${err instanceof Error ? err.message : String(err)}`, turns: [] });
    } finally {
      setBuddyBusy(false);
      setBuddyActivity("");
    }
  };
  /** Host tools that need the DESKTOP runtime — relayed when a phone drives the buddy. */
  const isDesktopRuntimeTool = (call: BuddyToolCall): boolean =>
    call.tool === "find_files" || call.tool === "run_command" || call.tool === "write_file" || call.tool === "edit_file" || call.tool === "delegate_coding_task" || call.tool === "screenshot";
  /** Run a desktop-runtime host tool — locally on the desktop, or via the relay on a linked phone. */
  const runHostToolDispatch = (call: BuddyToolCall): void => {
    if (isRemoteClient && isDesktopRuntimeTool(call)) {
      void runBuddyHostToolRemote(call);
      return;
    }
    if (call.tool === "find_files") approveFindFiles(call);
    else if (call.tool === "screenshot") void approveScreenshot(call);
    else if (call.tool === "write_file") void runWriteFile(call);
    else if (call.tool === "edit_file") void runEditFile(call);
    else if (call.tool === "delegate_coding_task") void runDelegateCodingTask(call);
    else if (call.tool === "run_command") void approveRunCommand(call);
  };

  // Run an approved generate_image call: render it, show it, and feed the outcome back.
  // Shared by the approval modal and full-autonomy auto-run.
  const approveGenerateImage = async (call: Extract<BuddyToolCall, { tool: "generate_image" }>): Promise<void> => {
    if (buddyRenderingRef.current) return; // a render is already in flight — drop the duplicate approval
    buddyRenderingRef.current = true;
    setBuddyPendingTool(undefined);
    // Low-VRAM: spin up the app-managed engine now if it was deferred at boot (no-op otherwise).
    await ensureRenderEngineReady();
    // Capture the model-facing context up to this image call so a multi-step PLAN can AUTO-REACT after
    // the render (mirrors approveRunCommand) instead of halting for the reader to type "continue".
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    setBuddyBusy(true);
    setBuddyActivity("Generating the image…");
    let out: Awaited<ReturnType<typeof chatTool>>;
    try {
      out = await chatTool(call, {
        onProgress: (f) => setBuddyActivity(`Generating the image… ${Math.round(f * 100)}%`),
      });
    } finally {
      // Release the duplicate-render guard the moment the RENDER finishes — BEFORE any follow-up turn,
      // so a full-autonomy queue's next auto-approved image isn't dropped as a "duplicate".
      buddyRenderingRef.current = false;
    }
    setBuddyActivity("");
    const imageFeedback = formatToolResult(call, {
      image: { ok: Boolean(out.image), ...(out.error ? { error: out.error } : {}) },
    });
    // A working checklist with steps left → advance the QUEUE: feed the render result back and let the
    // model tick the current step + start the next one, so the plan runs to completion on its own (each
    // next image still gets its own approval/gate). A one-shot image (no plan) just shows + stops, as before.
    const plan = buddyPlanRef.current;
    // Tag a render with WHICH checklist + step it belongs to, so a SECOND batch of images later in the
    // same chat can be told apart from this one — the model only ever sees these text tags (never the
    // image), so without them it reads earlier "image rendered" lines and ticks the new steps off as
    // already done. At render time the image is for the ▸ current (first unfinished) step.
    let taggedImageFeedback = imageFeedback;
    let tagCaption = ""; // a VISIBLE label on the render so the reader sees which checklist/step it's from
    if (!out.error && plan && plan.steps.length > 0) {
      const idx = plan.steps.findIndex((s) => s.status !== "done");
      const stepNo = idx >= 0 ? idx + 1 : plan.steps.length;
      const where = plan.goal ? `the checklist “${plan.goal}”` : "the checklist";
      taggedImageFeedback = `${imageFeedback} — this is step ${stepNo} of ${plan.steps.length} of ${where}.`;
      const goalLabel = plan.goal ? ` · ${plan.goal.length > 50 ? `${plan.goal.slice(0, 50).trim()}…` : plan.goal}` : "";
      tagCaption = `🖼 Step ${stepNo} of ${plan.steps.length}${goalLabel}`;
    } else if (!out.error && call.prompt) {
      // One-shot image (no checklist): still label it with what it depicts.
      tagCaption = `🖼 ${call.prompt.length > 60 ? `${call.prompt.slice(0, 60).trim()}…` : call.prompt}`;
    }
    const continueQueue = !out.error && planHasPendingStep(plan);
    const feedback = continueQueue ? planQueueResumeFeedback(taggedImageFeedback, plan!) : taggedImageFeedback;
    appendBuddy({
      role: "tool",
      text: out.error ? `⚠ Image generation failed: ${out.error}` : tagCaption,
      ...(out.image ? { image: out.image, attachments: [imageAttachment(call.prompt, out.image)] } : {}),
      turns: [...pre, { role: "user", content: feedback }],
    });
    // App-managed steps: the render IS this step's action — judge the step from whether an image came
    // back (the collar), then advance/retry. No legacy queue feedback; the executor drives the next step.
    if (appManagedActive && buddyWorkflowRef.current) {
      buddyStepEvidenceRef.current.toolResults.push({
        call,
        result: { image: { ok: Boolean(out.image), ...(out.error ? { error: out.error } : {}) } },
      });
      await advanceWorkflowAfterTurn(
        { toolResults: buddyStepEvidenceRef.current.toolResults, text: "" },
        (nudge) => dispatchBuddyTurn([...preHistory, ...pre], nudge),
      );
      return;
    }
    if (continueQueue) {
      await dispatchBuddyTurn([...preHistory, ...pre], feedback);
    } else {
      setBuddyBusy(false);
    }
  };

  /** Resolve a generate_video `source` to image bytes: a file path → read it; otherwise (last / library)
   * the most recent image shown in the chat. Copies the bytes so the worker transfer can't detach a
   * still-displayed image. Throws a clear message when there's nothing to animate. */
  const resolveVideoSource = async (source?: { kind: "last" | "library" | "file" | "text"; ref?: string }): Promise<{ bytes: ArrayBuffer; mimeType: string }> => {
    if (source?.kind === "file" && source.ref) {
      const f = await readLocalFile(source.ref);
      return { bytes: await f.arrayBuffer(), mimeType: f.type || "image/png" };
    }
    // "last" (the default) and "library" both fall back to the most recent image shown in the chat.
    for (let i = buddyMessagesRef.current.length - 1; i >= 0; i--) {
      const img = buddyMessagesRef.current[i]?.image;
      if (img && "bytes" in img && img.bytes) return { bytes: img.bytes.slice(0), mimeType: img.mimeType };
    }
    throw new Error("there's no image to animate yet — generate or open an image first, then ask to animate it");
  };

  // Animate an existing image into a short video (image-to-video) via the local ComfyUI engine. Mirrors
  // approveGenerateImage: resolve the source image + model files on the host, render in the worker (which
  // frees the chat LLM first), then show the clip + feed the outcome back.
  const approveGenerateVideo = async (call: Extract<BuddyToolCall, { tool: "generate_video" }>): Promise<void> => {
    if (buddyRenderingRef.current) return;
    buddyRenderingRef.current = true;
    setBuddyPendingTool(undefined);
    await ensureRenderEngineReady();
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    setBuddyBusy(true);
    const textToVideo = call.source?.kind === "text";
    setBuddyActivity(textToVideo ? "Generating the video…" : "Animating the image…");
    let out: Awaited<ReturnType<typeof chatVideo>>;
    try {
      // Text-to-video has no source frame; image-to-video resolves the image to animate.
      const src = textToVideo ? undefined : await resolveVideoSource(call.source);
      // The buddy may name a model (e.g. "make an LTX video"); otherwise use the one chosen in Settings.
      // Settings overrides win over the catalog default (a swapped component / a fixed broken download),
      // and the Settings render params drive the graph's size/length/sampler choices.
      const models = resolveVideoModelFiles(call.model ?? settings.videoModel, settings.videoFiles);
      // Render params are stored per model family — pick the selected model's set (frames/fps/etc).
      out = await chatVideo(call, src, models, settings.videoParams?.[models.kind], {
        onProgress: (f) => setBuddyActivity(`${textToVideo ? "Generating the video" : "Animating the image"}… ${Math.round(f * 100)}%`),
      });
    } catch (err) {
      out = { error: err instanceof Error ? err.message : String(err) };
    } finally {
      buddyRenderingRef.current = false;
    }
    setBuddyActivity("");
    const feedback = formatToolResult(call, { video: { ok: Boolean(out.video), ...(out.error ? { error: out.error } : {}) } });
    appendBuddy({
      role: "tool",
      text: out.error
        ? `⚠ Video generation failed: ${out.error}`
        : `🎬 ${call.prompt.length > 60 ? `${call.prompt.slice(0, 60).trim()}…` : call.prompt}`,
      ...(out.video ? { video: out.video, attachments: [videoAttachment(call.prompt, out.video)] } : {}),
      turns: [...pre, { role: "user", content: feedback }],
    });
    if (appManagedActive && buddyWorkflowRef.current) {
      buddyStepEvidenceRef.current.toolResults.push({ call, result: { video: { ok: Boolean(out.video), ...(out.error ? { error: out.error } : {}) } } });
      await advanceWorkflowAfterTurn(
        { toolResults: buddyStepEvidenceRef.current.toolResults, text: "" },
        (nudge) => dispatchBuddyTurn([...preHistory, ...pre], nudge),
      );
      return;
    }
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };


  // send and the auto-react continuation after an approved command. `userBubbleText`
  // Natural-language planning: the model emitted plan_task; research + build the plan
  // in the worker (no approval click — it's a safe host op), show it, and continue the
  // conversation so the assistant can offer to set reminders / start the first step.
  const runPlanTask = async (request: string): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    setBuddyBusy(true);
    setBuddyActivity("Researching the task…");
    // If this chat is already working a task, re-plan THAT plan in place (keep its id, so the
    // worker replaces it instead of forking a duplicate) and feed the existing plan into the
    // request so the re-plan is informed — mirrors planOneTask's enriched sourceText.
    const planId = activeTaskPlanId();
    const activePlan = planId ? taskPlansRef.current.find((p) => p.id === planId) : undefined;
    const sourceText = activePlan
      ? [activePlan.title, activePlan.summary, activePlan.deadlineIso ? `Hard deadline: ${activePlan.deadlineIso}.` : "", request]
          .filter(Boolean)
          .join(" ")
      : request;
    const res = await planTask({
      source: activePlan ? activePlan.source : { kind: "typed", text: request },
      sourceText,
      ...(activePlan ? { planId: activePlan.id } : {}),
      allowFiles: true, // the reader typed this plan request — let the planner search/read their files
      onProgress: (phase) => setBuddyActivity(phase === "plan" ? "Building the plan…" : "Researching the task…"),
    });
    setBuddyBusy(false);
    setBuddyActivity("");
    if (!res.ok || !res.plan) {
      // Feed the failure back so the buddy explains it + offers a next step (don't dead-end).
      const message = res.error ?? "unknown error";
      const fail = toolFailureDirective("plan_task", message);
      appendBuddy({ role: "tool", text: `⚠ Couldn't plan that: ${message}`, turns: [...pre, { role: "user", content: fail }] });
      await dispatchBuddyTurn([...preHistory, ...pre], fail);
      return;
    }
    // Bind this plan to the chat it was planned in, so work continues here and the Tasks panel's
    // "open in chat" reuses this very session. Re-asserted on every (re-)plan so the link can't
    // drift. Name the chat after the task, but never clobber a label the reader set themselves.
    const session = activeBuddyIdRef.current;
    let plan = res.plan;
    if (session) {
      plan = { ...plan, sessionId: session };
      await upsertTaskPlan(libraryStore, plan);
      setBuddySessions((prev) => {
        const next = prev.map((s) =>
          s.id === session && !s.label ? { ...s, label: sessionLabelForPlan(plan) } : s,
        );
        persistSessions(next);
        return next;
      });
    }
    refreshTaskPlans();
    const summary =
      `📋 Planned: ${plan.title}${plan.deadlineIso ? ` (deadline ${plan.deadlineIso})` : ""}\n` +
      plan.steps
        .map(
          (s, i) =>
            `${i + 1}. ${s.title}${s.actor === "ai_prep" ? " — I can prep this" : ""}${s.dueIso ? ` (by ${s.dueIso})` : ""}`,
        )
        .join("\n");
    const feedback =
      `[plan_task done — saved a ${plan.steps.length}-step plan "${plan.title}"` +
      (plan.deadlineIso ? `, deadline ${plan.deadlineIso}` : "") +
      `. Steps: ${plan.steps.map((s) => `${s.title} [${s.actor}]`).join("; ")}. Briefly confirm the plan to the ` +
      "reader and offer to set the reminders (create the dated Tasks/Calendar events) or start the first step.]";
    appendBuddy({ role: "tool", text: summary, turns: [...pre, { role: "user", content: feedback }] });
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };

  // Run a delegated subtask: an ISOLATED, read-only sub-agent turn (its own tool loop, empty
  // history), then feed only its concise result back to the parent conversation. Reuses the
  // normal buddy turn — the sub-agent can't change anything (read-only by instruction).
  const runDelegate = async (task: string): Promise<void> => {
    setBuddyPendingTool(undefined);
    const pre = pendingBuddyTranscript.current;
    const preHistory = pendingBuddyHistory.current;
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
    setBuddyBusy(true);
    setBuddyActivity(`Delegating: ${task.slice(0, 60)}…`);
    const sub = await buddyChat([], buildDelegatePrompt(task), buddyPersona, library, () => {});
    setBuddyBusy(false);
    setBuddyActivity("");
    const answer = sub.text || sub.error || "(the sub-agent returned nothing usable)";
    appendBuddy({ role: "tool", text: `🔹 Delegated subtask: ${task}\n\n${answer}` });
    const feedback = `[delegate done — the sub-agent's result for "${task}":]\n${answer}\nUse this to continue your answer.`;
    await dispatchBuddyTurn([...preHistory, ...pre], feedback);
  };

  // APP-MANAGED-STEPS EXECUTOR. Judge the active step against its DoneWhen contract using ONLY the
  // observed `evidence` (the collar), then drive the workflow: advance/retry → re-dispatch the next or
  // same step via `continueWith`; park/finish/abort → stop. Returns true when it handled the turn, so
  // the caller skips the legacy model-driven chaining. The model never ticks steps; the app does.
  const advanceWorkflowAfterTurn = async (
    evidence: { toolResults: { call: BuddyToolCall; result: BuddyToolResultPayload }[]; text: string },
    continueWith: (nudge: string) => Promise<unknown>,
  ): Promise<boolean> => {
    const wf = buddyWorkflowRef.current;
    if (!wf) return false;
    const step = activeStep(wf);
    if (!step) {
      setBuddyBusy(false);
      return true;
    }
    // G5 — a `files` step is judged on whether the declared deliverables ACTUALLY landed on disk (and
    // are non-empty), not just that a write tool ran. Verify here (host I/O) and fold it into the evidence.
    let evi: typeof evidence & { filesPresent?: { path: string; ok: boolean }[] } = evidence;
    if (step.doneWhen.kind === "files" && isDesktop) {
      const checks = await Promise.all(
        step.doneWhen.paths.map(async (p) => {
          try {
            const r = await readWorkspaceFile(p, buddyWorkingDir || undefined);
            return { path: p, ok: r.exists && r.text.trim().length > 0 };
          } catch {
            return { path: p, ok: false };
          }
        }),
      );
      evi = { ...evidence, filesPresent: checks };
    }
    const outcome = evaluateStep(step, evi);
    const adv = advanceWorkflow(wf, outcome);
    applyWorkflow(adv.workflow);
    buddyStepEvidenceRef.current = { toolResults: [], text: "" }; // fresh evidence for whatever runs next
    if (adv.action === "advance" || adv.action === "skip") {
      if (adv.action === "skip")
        appendBuddy({ role: "tool", text: `⚠ Skipped “${step.instruction}” after ${step.maxAttempts} tries — moving on.`, turns: [] });
      // Tell the model the PRIOR step is settled and give the next step's position, so it stops
      // "announcing the transition" (the confused "I already did X, moving on") — its prior tool call
      // is still in context. Ask for the tool only, no recap.
      const total = adv.workflow.steps.length;
      const n = adv.workflow.steps.findIndex((s) => s.id === adv.next!.id) + 1;
      await continueWith(
        `[✓ Previous step done. Now do ONLY step ${n} of ${total}: ${adv.next!.instruction}. Call its tool and stop — don't recap or explain.]`,
      );
      return true;
    }
    if (adv.action === "retry") {
      await continueWith(
        `[Your last attempt didn't satisfy this step${outcome.reason ? ` (${outcome.reason})` : ""}. Do it again now: ${step.instruction}. Just call the tool — no commentary.]`,
      );
      return true;
    }
    // Terminal — stop the run.
    if (adv.action === "finish") appendBuddy({ role: "tool", text: "✓ All steps done.", turns: [] });
    else if (adv.action === "abort")
      appendBuddy({ role: "tool", text: `⚠ Stopped — couldn't finish “${step.instruction}”${step.note ? ` (${step.note})` : ""}.`, turns: [] });
    else if (adv.action === "park" && step.doneWhen.kind !== "user_reply")
      appendBuddy({ role: "tool", text: `⏸ Stuck on “${step.instruction}”${step.note ? ` — ${step.note}` : ""}. Tell me how to proceed.`, turns: [] });
    setBuddyBusy(false);
    return true;
  };

  // (when set) is shown as the reader's message; a continuation passes none — its
  // "input" is the tool feedback, recorded in the visible result above it.
  const dispatchBuddyTurn = async (
    history: ChatTurn[],
    userText: string,
    userBubbleText?: string,
  ): Promise<string | undefined> => {
    const seq = ++buddyTurnSeq.current; // guard: ignore if Clear/cancel supersedes it
    // Make sure the worker has THIS session's current file ledger before the turn builds its prompt
    // (ordered before the buddyChat send below), so the model sees what it's written regardless of init
    // timing or a session switch.
    setFileLedger(createdFilesRef.current);
    // G4 — push the workspace project guide (AGENTS.md, else CONVENTIONS.md) so durable per-project
    // conventions ride every turn. Desktop only (the model can read/update it via read_file/write_file).
    if (isDesktop && !isRemoteClient) {
      try {
        let g = await readWorkspaceFile("AGENTS.md", buddyWorkingDir || undefined);
        if (!g.exists) g = await readWorkspaceFile("CONVENTIONS.md", buddyWorkingDir || undefined);
        setProjectGuide(g.exists ? g.text : "");
      } catch {
        setProjectGuide("");
      }
    }
    if (userBubbleText !== undefined) {
      appendBuddy({ role: "user", text: userBubbleText });
      buddyQueueAdvanceRef.current = { count: 0, noProgress: 0 }; // fresh user turn → reset the chain budget
      // App-managed steps: a fresh reader message resumes a PARKED workflow. If it was waiting on the
      // reader (a user_reply step), their answer satisfies that step → advance past it; otherwise just
      // re-activate the blocked step to retry it with their new input.
      if (appManagedActive && workflowParked(buddyWorkflowRef.current)) {
        const wf = buddyWorkflowRef.current!;
        const blocked = wf.steps.find((s) => s.status === "blocked");
        if (blocked?.doneWhen.kind === "user_reply") {
          const reactivated = { ...wf, steps: wf.steps.map((s) => (s === blocked ? { ...s, status: "active" as const } : s)) };
          applyWorkflow(advanceWorkflow(reactivated, { done: true }).workflow);
        } else {
          applyWorkflow(resumeWorkflow(wf));
        }
        buddyStepEvidenceRef.current = { toolResults: [], text: "" };
      }
    }
    // Done-steps before this turn, to tell whether the turn made progress on the checklist.
    const doneAtStart = countDonePlanSteps(buddyPlanRef.current);
    setBuddyBusy(true);
    setBuddyStreaming("");
    buddyStreamingRef.current = "";
    setBuddyThinking("");
    setBuddyActivity("");
    setBuddySteps([]);
    setBuddyPendingTool(undefined);
    let openedBook = false;
    const res = await buddyChat(history, userText, buddyPersona, library, (e) => {
      if (e.kind === "token") {
        buddyStreamingRef.current += e.text;
        setBuddyStreaming(buddyStreamingRef.current);
        setBuddyActivity(""); // visible text replaces any "Reasoning…" status
      } else if (e.kind === "thinking") setBuddyThinking(e.text);
      else if (e.kind === "activity") setBuddyActivity(e.text);
      else if (e.kind === "usage") setBuddyUsage(e.usage);
      else if (e.kind === "plan") {
        if (appManagedActive) {
          // App-managed: the model just COMPILED (or re-compiled) the plan via set_plan. Turn it into a
          // workflow with per-step DoneWhen contracts; from here the APP runs it and ticks steps from
          // evidence. applyWorkflow mirrors the read-only plan projection into buddyPlan + persists.
          applyWorkflow(compileWorkflow(e.plan));
          buddyStepEvidenceRef.current = { toolResults: [], text: "" };
        } else {
          // Legacy model-driven path: keep the model's checklist as the live plan.
          // Update the ref SYNCHRONOUSLY (not just via setBuddyPlan's render) so a full-autonomy queue's
          // FIRST auto-approved image — which can fire before React commits — already sees the fresh
          // checklist and keeps the queue advancing instead of halting after step 1.
          buddyPlanRef.current = e.plan;
          setBuddyPlan(e.plan);
          // Persist the working checklist per session (desktop owns the store; never on a phone or in
          // incognito). activeBuddyIdRef is the live session this turn runs for.
          if (!isRemoteClient && !settings.incognitoRemote)
            void libraryStore.putMemo?.(planMemoKey(activeBuddyIdRef.current), JSON.stringify(e.plan)).catch(() => {});
        }
      } else if (e.kind === "tool") {
        // Keep any prose the model said before this tool call (a briefing) as its own message.
        const said = stripToolCallJson(buddyStreamingRef.current).trim();
        if (said) {
          appendBuddy({ role: "assistant", text: said });
          buddyStreamingRef.current = "";
          setBuddyStreaming("");
        }
        const c = e.call;
        const label =
          c.tool === "search_books" ? `Searching Project Gutenberg for “${c.query}”…`
          : c.tool === "random_books" ? "Pulling some classics off the shelf…"
          : c.tool === "search_web" ? `Searching for “${c.query}”…`
          : c.tool === "read_url" ? `Reading ${c.url}…`
          : c.tool === "search_images" ? `Looking for images of “${c.query}”…`
          : c.tool === "calculate" ? "Calculating…"
          : c.tool === "remember" || c.tool === "forget" ? "Updating memory…"
          : c.tool === "set_visual_style" ? "Updating the visual settings…"
          : c.tool === "update_setting" ? "Updating a setting…"
          : c.tool === "open_library_book" ? "Opening from your library…"
          : c.tool === "open_pasted_text" ? "Opening your text…"
          : c.tool === "remove_library_book" ? "Removing from your library…"
          : c.tool === "generate_image" ? "Preparing an image…"
          : c.tool === "find_files" ? "Searching your files…"
          : c.tool === "read_file" ? "Reading a file…"
          : c.tool === "run_command" ? "Proposing a command…"
          : c.tool === "screenshot" ? "Asking to see your screen…"
          : c.tool === "gmail_search" ? "Searching your email…"
          : c.tool === "read_email" ? "Reading an email…"
          : c.tool === "read_attachment" ? "Reading an attachment…"
          : c.tool === "list_events" ? "Checking your calendar…"
          : c.tool === "create_event" ? "Adding a calendar event…"
          : c.tool === "list_tasks" ? "Checking your to-dos…"
          : c.tool === "create_task" ? "Adding a to-do to Google Tasks…"
          : c.tool === "add_task_group" ? "Adding a task with its sub-tasks…"
          : c.tool === "schedule_task" ? "Scheduling a task…"
          : c.tool === "mark_step_done" || c.tool === "update_task_step" ? "Updating the plan…"
          : c.tool === "open_web_text" ? "Fetching the text and opening it…"
          : c.tool === "set_plan" ? "Planning the steps…"
          : c.tool === "complete_step" ? "Checking off a step…"
          : "Working…";
        setBuddyActivity(label);
        setBuddySteps((prev) => [...prev, label.replace(/…$/, "")]); // keep a visible trace of each step
      } else if (e.kind === "settings") {
        // set_visual_style fields + a generic update_setting patch both land here; App
        // owns ReaderSettings, so committing via setSettings runs the normal tune-vs-
        // rebuild machinery (a mature-mode flip re-inits; a quality tweak tunes in place).
        setSettings((s) => ({
          ...s,
          ...(e.style ? { imageStyle: e.style.id } : {}),
          ...(e.pagesPerImage !== undefined ? { pagesPerImage: e.pagesPerImage } : {}),
          ...(e.illustrateAfter !== undefined ? { illustrateAfter: e.illustrateAfter } : {}),
          ...(e.patch ?? {}),
        }));
        const parts = [
          ...(e.style ? [`art style: ${e.style.label}`] : []),
          ...(e.pagesPerImage !== undefined
            ? [e.pagesPerImage === "chapter" ? "one image per chapter" : `one image per ${e.pagesPerImage} page(s)`]
            : []),
          ...(e.illustrateAfter !== undefined
            ? [e.illustrateAfter === "chapter" ? "illustrate as you read" : "illustrate after the whole book"]
            : []),
        ];
        if (e.summary) appendBuddy({ role: "tool", text: `⚙ ${e.summary}` });
        else appendBuddy({ role: "tool", text: `🎨 ${parts.join(" · ")}` });
      } else if (e.kind === "libraryChanged") {
        void libraryStore.listBooks().then(setLibrary).catch(() => {});
      } else if (e.kind === "scheduledChanged") {
        refreshScheduled();
      } else if (e.kind === "alertsChanged") {
        refreshAlerts();
      } else if (e.kind === "skillProposed") {
        // Offer the distilled skill — the reader is the value judge (never saved silently).
        setPendingSkill(e.skill);
      } else if (e.kind === "opened") {
        // Don't yank a book open AGAIN if it's already the one showing — for ANY book type, the
        // buddy can re-emit an open for what's already open (a code file being edited, a web page
        // it just opened, a pasted doc, a spreadsheet, a story), and re-opening discards unsaved
        // state + restarts generation ("keeps force opening"). Guard by id, and update bookRef
        // SYNCHRONOUSLY when we open so a re-emit LATER IN THE SAME TURN is caught too (bookRef
        // otherwise only refreshes on the next render, so a tool-loop re-emit slipped through).
        if (bookRef.current?.id === e.book.id) {
          setShowChat(true);
        } else {
          openedBook = true;
          buddyHandoff.current = [...buddyMessages, { role: "user" as const, text: userBubbleText ?? userText, at: Date.now() }]
            .slice(-12)
            .map(({ turns: _turns, ...m }) => m);
          bookRef.current = e.book; // dedupe a same-turn re-emit before the render refreshes the ref
          openBook(e.book);
          if (e.visuals) startGeneration();
          setShowChat(true);
        }
      } else if (e.kind === "storyBeat") {
        // A continue_story beat grew the OPEN story IN the worker (the engine appended a
        // span). Grow the reader WITHOUT re-opening — a re-open would dispose + rebuild the
        // engine and undo the append. The new beat's image arrives via the normal `update`
        // events the engine already posts. Persist the grown book and scroll to the new beat.
        setBook(e.book);
        void libraryStore
          .putBook(e.book)
          .then(() => libraryStore.listBooks())
          .then(setLibrary)
          .catch(() => {});
        const chapter = e.book.chapters[e.book.chapters.length - 1];
        const paraId = chapter
          ? e.book.pages.find((p) => p.chapterId === chapter.id)?.paragraphs[0]?.id
          : undefined;
        if (paraId) {
          // Let React paint the new paragraphs, then bring the new beat into view.
          setTimeout(() => {
            try {
              document
                .querySelector(`[data-paragraph-id="${CSS.escape(paraId)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            } catch {
              /* CSS.escape unavailable / node gone — non-fatal */
            }
          }, 60);
        }
      } else if (e.kind === "storyConfig") {
        // Role-play / cadence changed (no new beat) — persist the book's storyConfig so it
        // survives a reopen. setBook keeps the open reader's copy current; no scroll.
        setBook(e.book);
        void libraryStore.putBook(e.book).catch(() => {});
      } else if (e.kind === "documentCreated") {
        // create_document: surface the document as downloadable file cards IN THE CHAT (PDF / Word /
        // Markdown) — NOT a full-screen reader takeover — and auto-save the Markdown source to the
        // workspace so the buddy can read_file / revise it. The reader opens only on the card's button.
        setBuddyActivity("");
        const doc = e;
        void (async () => {
          const blocks = markdownToBlocks(doc.content);
          const stem =
            (doc.title || "document").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "document";
          // Build all three formats up-front so each card's Download — and a linked phone's on-demand
          // relay fetch (by the card's id) — has real bytes. Markdown is the source; PDF + Word render.
          let pdfBytes: Uint8Array | undefined;
          let docxBytes: Uint8Array | undefined;
          try { pdfBytes = await blocksToPdf(doc.title, blocks); } catch { /* PDF best-effort */ }
          try { docxBytes = blocksToDocx(doc.title, blocks); } catch { /* Word best-effort */ }
          const mdBytes = new TextEncoder().encode(doc.content);
          const toBuf = (u: Uint8Array): ArrayBuffer => {
            const b = new ArrayBuffer(u.byteLength);
            new Uint8Array(b).set(u);
            return b;
          };
          const cards: Record<"pdf" | "docx" | "md", FileRef | undefined> = {
            pdf: pdfBytes ? { id: `${doc.id}-pdf`, name: `${stem}.pdf`, mime: PDF_MIME, kind: "export", bytes: toBuf(pdfBytes) } : undefined,
            docx: docxBytes ? { id: `${doc.id}-docx`, name: `${stem}.docx`, mime: DOCX_MIME, kind: "export", bytes: toBuf(docxBytes) } : undefined,
            md: { id: `${doc.id}-md`, name: `${stem}.md`, mime: "text/markdown", kind: "doc", content: doc.content, bytes: toBuf(mdBytes) },
          };
          // Order the cards with the requested format first (Markdown stands in for an html request).
          const first: "pdf" | "docx" | "md" = doc.format === "docx" ? "docx" : doc.format === "md" || doc.format === "html" ? "md" : "pdf";
          const order: ("pdf" | "docx" | "md")[] = [first, ...(["pdf", "docx", "md"] as const).filter((f) => f !== first)];
          const attachments = order.map((f) => cards[f]).filter((r): r is FileRef => !!r);
          appendBuddy({
            role: "tool",
            text: `📄 **${doc.title}** is ready — download it as PDF, Word, or Markdown (or open it in the reader):`,
            attachments,
            turns: [],
          });
          // Auto-save the Markdown SOURCE to the workspace (desktop) + ledger so the buddy can
          // read_file / revise it later. Best-effort: a miss doesn't break the card.
          if (isDesktop) {
            try {
              await writeWorkspaceFile(doc.path, doc.content);
              recordCreatedFile(doc.path, doc.content.split("\n").length, false);
            } catch {
              /* workspace write best-effort */
            }
          }
        })();
      } else {
        setBuddyActivity("");
        // App-managed steps: record each auto-run tool's outcome as EVIDENCE for the current step (the
        // collar reads this, not the model's claim). Host tools (image/file/command) suspend the turn
        // and add their own evidence in the approve* handlers; here we only see auto-run results, for
        // which "ran without error" is what a tool_ok contract needs.
        if (appManagedActive && e.kind === "toolResult" && buddyWorkflowRef.current)
          buddyStepEvidenceRef.current.toolResults.push({ call: e.call, result: e.error ? { error: e.error } : {} });
        // The agent just read/wrote the calendar or tasks — reflect it in the app's views.
        if (e.kind === "toolResult" && (e.call.tool === "create_event" || e.call.tool === "list_events")) refreshCalendar();
        if (e.kind === "toolResult" && (e.call.tool === "add_task_group" || e.call.tool === "create_task" || e.call.tool === "add_task_steps" || e.call.tool === "mark_step_done" || e.call.tool === "update_task_step")) refreshTaskPlans();
        const typed = userBubbleText ?? "";
        if (e.openedImage) {
          // open_image: show the picture file inline in the chat (the bytes rode home base64-encoded).
          const img = e.openedImage;
          appendBuddy({
            role: "tool",
            text: `🖼 ${img.name}`,
            image: { bytes: base64ToBytes(img.base64), mimeType: img.mimeType },
          });
        } else if (e.hits?.length) {
          appendBuddy({
            role: "tool",
            text: `Results for “${"query" in e.call ? e.call.query : ""}”:`,
            links: e.hits.map((h) => ({ url: h.link, ...(h.title ? { title: h.title } : {}) })),
          });
        } else if (e.books?.length) {
          appendBuddy({
            role: "tool",
            text:
              e.call.tool === "random_books"
                ? "Off the classics shelf:"
                : `Project Gutenberg matches for “${"query" in e.call ? e.call.query : ""}”:`,
            links: e.books.map((b) => ({
              url: b.pageUrl ?? b.textUrl,
              title: b.author ? `${b.title} — ${b.author}` : b.title,
            })),
          });
        } else if (e.imageHits?.length) {
          // All hits as a thumbnail gallery (tap to enlarge); keep lastRefs so
          // "show #N" still works for an even bigger view of one.
          const hits = e.imageHits.slice(0, 8);
          lastRefs.current = e.imageHits.map((h) => ({ kind: "image", label: h.title ?? "image", url: h.link }));
          appendBuddy({
            role: "tool",
            text:
              hits.length > 1
                ? `Found ${hits.length} images — tap any to enlarge:`
                : `Found: ${hits[0]!.title ?? "image"} (tap to enlarge)`,
            gallery: hits.map((h) => ({
              thumb: h.thumbnailLink ?? h.link,
              full: h.link,
              ...(h.title ? { title: h.title } : {}),
            })),
          });
        } else if (e.calc) {
          appendBuddy({ role: "tool", text: `🧮 ${e.calc.expression} = ${e.calc.result}` });
        } else if (e.wolfram) {
          appendBuddy({ role: "tool", text: `🔢 Wolfram|Alpha — ${e.wolfram.query}:\n${e.wolfram.answer}` });
        } else if (e.memory) {
          appendBuddy({
            role: "tool",
            text: `🧠 ${e.memory.action === "remembered" ? "Remembered" : "Forgot"}: “${e.memory.note}”`,
          });
          refreshMemories(); // keep the Memory panel + list current with the buddy's own edits
        } else if (e.removed) {
          appendBuddy({ role: "tool", text: `🗑 Removed “${e.removed}” from the library.` });
        } else if (e.call.tool === "search_images") {
          appendBuddy({ role: "tool", text: imageSearchMiss(e.call.query, e.error, hasSearchKey) });
        } else if (typed.startsWith("/") && e.error) {
          appendBuddy({ role: "tool", text: `⚠ ${e.error}` });
        } else if (
          typed.startsWith("/") &&
          (e.call.tool === "search_books" || e.call.tool === "random_books" || e.call.tool === "search_web")
        ) {
          appendBuddy({ role: "tool", text: "🔍 No results." });
        }
      }
    }, buddyWorkingDir || undefined, activeTaskPlanId(), openCodeContext(), buddyPlanRef.current, appManagedActive);
    if (buddyTurnSeq.current !== seq) return;
    setBuddyBusy(false);
    setBuddyStreaming("");
    setBuddyThinking("");
    setBuddyActivity("");
    if (res.error) {
      appendBuddy({ role: "tool", text: `⚠ ${res.error}`, turns: [] });
      return;
    }
    // App-managed + the active step is a TOOL step → the model's between-step prose is the confused
    // "I already called generate for the goat, so I'll move on to the chicken" narration that comes
    // from seeing its own just-made tool call in context. The app advances from observed evidence, not
    // these words, so DON'T render them (they're noise). On a tool step the only legitimate output is
    // the tool call itself (which arrives via pendingTool, below). Answer steps (text/narration/reply)
    // and legacy non-app-managed mode keep their prose — there it IS the deliverable.
    const appManagedStep = appManagedActive ? activeStep(buddyWorkflowRef.current) : undefined;
    const suppressProse = !!appManagedStep && isToolContract(appManagedStep.doneWhen.kind);
    if (res.pendingTool) {
      // Persist any plain-text the model wrote BEFORE this tool — its "✓ finished X, ▸ now Y" per-step
      // narration — so that progress note stays documented in the chat instead of vanishing when the
      // tool (e.g. a render) suspends the turn. turns:[] keeps it display-only (it's already in the
      // transcript captured below, so the model's history never double-counts it).
      const narration = buddyStreamingRef.current.trim();
      if (narration && !suppressProse) appendBuddy({ role: "assistant", text: narration, turns: [] });
      // Record the exact context up to this tool call so an approved run_command can
      // auto-react. `userText` is in `history` for a continuation; not for a typed turn.
      pendingBuddyHistory.current = history;
      pendingBuddyTranscript.current = [{ role: "user", content: userText }, ...res.transcript];
      if (res.pendingTool.tool === "find_files" && (fileAccessGranted.current || settings.autonomousFileSearch || settings.fullAutonomy)) {
        runHostToolDispatch(res.pendingTool);
      } else if (res.pendingTool.tool === "screenshot" && (screenCaptureGranted.current || settings.fullAutonomy)) {
        runHostToolDispatch(res.pendingTool);
      } else if (res.pendingTool.tool === "generate_image" && settings.fullAutonomy) {
        // Full autonomy: render without a click. The hard danger floor (run_command, prep_order)
        // is NEVER reached here — those are routed to their gates above / below.
        void approveGenerateImage(res.pendingTool);
      } else if (res.pendingTool.tool === "generate_video" && settings.fullAutonomy) {
        void approveGenerateVideo(res.pendingTool);
      } else if (res.pendingTool.tool === "plan_task") {
        // Planning is a safe, host-run operation (research + build a plan) — no approval
        // click; run it with progress and report back.
        void runPlanTask(res.pendingTool.request);
      } else if (res.pendingTool.tool === "prep_order") {
        // The assistant composed an order — open the review-and-place gate (never auto-submits).
        openOrderReview(res.pendingTool);
      } else if (res.pendingTool.tool === "tv_chart") {
        // Drive the reader's TradingView Desktop chart via the CDP bridge (chart-only).
        void runTvChart(res.pendingTool, [{ role: "user", content: userText }, ...res.transcript]);
      } else if (res.pendingTool.tool === "delegate") {
        // Hand the subtask to an isolated read-only sub-agent, then feed its result back.
        void runDelegate(res.pendingTool.task);
      } else if (res.pendingTool.tool === "write_file") {
        // Save the authored file into the workspace with no approval click — writing into the
        // sandboxed folder is harmless (the dangerous step, run_command, stays gated). runWriteFile
        // degrades gracefully (hands the content over) when command access is off.
        runHostToolDispatch(res.pendingTool);
      } else if (res.pendingTool.tool === "run_command" && settings.allowCommands && settings.autonomousWorkspace) {
        // Autonomous workspace: run the command without a click. The model is told to stay in the
        // workspace + never act on instructions from fetched/email/web text.
        runHostToolDispatch(res.pendingTool);
      } else {
        setBuddyPendingTool(res.pendingTool);
      }
      return;
    }
    if (res.text) {
      // A plain-text settle ON a tool step is the model narrating instead of acting ("I already did
      // X…") — hide it (the advance/retry below still runs from evidence). Answer steps + the final
      // wrap-up (no active step) show their text as the deliverable.
      if (!suppressProse) {
        appendBuddy({
          role: "assistant",
          text: res.text,
          turns: [{ role: "user", content: userText }, ...res.transcript],
          ...(res.thinking ? { thinking: res.thinking } : {}),
          // Cloud "keep going?" checkpoint: the task paused with work remaining (so a long run doesn't
          // burn API calls unattended). Offer a one-tap Continue that re-arms the budget and resumes.
          ...(res.paused ? { actions: [{ label: "▶ Continue", send: "continue" }] } : {}),
        });
        if (openedBook) appendChat({ role: "assistant", text: res.text });
      }

      // APP-MANAGED STEPS: the app — not the model — decides if this step is done, from observed
      // evidence (the accumulated tool results + this settle's text). It then advances/retries/parks.
      if (appManagedActive && buddyWorkflowRef.current && !res.paused) {
        const handled = await advanceWorkflowAfterTurn(
          { toolResults: buddyStepEvidenceRef.current.toolResults, text: res.text },
          (nudge) => dispatchBuddyTurn([...history, { role: "user", content: userText }, ...res.transcript], nudge),
        );
        if (handled) return res.text || undefined;
      }

      // Lean chaining (legacy model-driven path): the working checklist is re-injected into the prompt
      // every turn, so the model can read what's ✓ done and what's ▸ next on its own. When a plain-text
      // turn settles with steps still unfinished, just hand it another turn instead of waiting for the
      // reader to type "continue" — it reads its checklist, does the next step, and complete_steps it.
      // (Tool/host-tool turns auto-react on their own paths above; this only fires on a plain-text settle.)
      const plan = buddyPlanRef.current;
      if (!res.paused && planHasPendingStep(plan)) {
        const adv = buddyQueueAdvanceRef.current;
        adv.count += 1;
        adv.noProgress = countDonePlanSteps(plan) > doneAtStart ? 0 : adv.noProgress + 1;
        const cap = Math.max(20, plan!.steps.length * 2 + 5);
        // Stop if the chain has run long (cap) or stalled: a step that's really a question to the
        // reader ticks nothing, so after one tolerated no-progress turn we halt and let them answer.
        if (adv.count <= cap && adv.noProgress <= 1) {
          await dispatchBuddyTurn(
            [...history, { role: "user", content: userText }, ...res.transcript],
            "[Your checklist still has unfinished steps. Read it above, do the ▸ current step, then complete_step, " +
              "and keep going on your own — don't wait for me. But if the current step is waiting on my answer to " +
              "something you already asked, just stop and wait — don't repeat the question.]",
          );
          return res.text || undefined;
        }
        if (adv.count > cap) {
          appendBuddy({ role: "tool", text: "Paused — say “continue” to keep working the checklist.", turns: [] });
        }
      }
    }
    return res.text || undefined;
  };

  const onBuddySend = useCallback(
    async (text: string) => {
      // `/story {json}` — starting a story as you go. Show a friendly bubble (not the raw JSON) and
      // run it against an EMPTY history so the writer's context is clean (the same guarantee the
      // desktop's Story button gives locally). This is the path a PHONE-relayed story start lands on
      // (vrcmd:chatSend "/story …"), so mobile gets the clean-context behaviour too.
      const story = text.trim();
      if (story.startsWith("/story ")) {
        let bubble = "✍️ Starting a story…";
        try {
          const payload = JSON.parse(story.slice("/story ".length)) as { opening?: string };
          const op = typeof payload.opening === "string" ? payload.opening : "";
          if (op) bubble = `✍️ Starting a story — ${op.slice(0, 80)}${op.length > 80 ? "…" : ""}`;
        } catch {
          /* malformed payload — the generic bubble is fine; the worker reports the parse error */
        }
        await dispatchBuddyTurn([], story, bubble);
        return;
      }
      // `/find` is a MAIN-THREAD command (desktop only) — filesystem access never
      // routes through the LLM worker, so no web page / book text can trigger it.
      const find = /^\/find\s+(.+)$/i.exec(text.trim());
      if (find) {
        appendBuddy({ role: "user", text });
        await runFileSearch(find[1]!.trim());
        return;
      }
      // "open #2" / "show 3" — act on the last numbered list (files or images) the
      // buddy showed, instead of re-searching or guessing.
      const refMatch = /^(?:\/open|open|show|display|view)\s+(?:number\s+|the\s+)?#?(\d+)\b/i.exec(text.trim());
      if (refMatch && lastRefs.current.length) {
        appendBuddy({ role: "user", text });
        const n = Number(refMatch[1]);
        const ref = lastRefs.current[n - 1];
        if (!ref) {
          appendBuddy({ role: "tool", text: `There's no #${n} in the last list (it had ${lastRefs.current.length}).` });
        } else if (ref.kind === "file" && ref.path) {
          appendBuddy({ role: "tool", text: `Opening #${n}: ${ref.label}…` });
          void onOpenLocalFile(ref.path);
        } else if (ref.kind === "image" && ref.url) {
          appendBuddy({
            role: "tool",
            text: `#${n}: ${ref.label}`,
            gallery: [{ thumb: ref.url, full: ref.url, title: ref.label }],
          });
        }
        return;
      }
      // A pasted/typed image link (bare, or "show me the image at <link>") just gets
      // DISPLAYED inline — not opened as a book/article or re-searched.
      const directImg = pastedImageUrl(text);
      if (directImg) {
        appendBuddy({ role: "user", text });
        appendBuddy({ role: "tool", text: "Here's that image:", gallery: [{ thumb: directImg, full: directImg }] });
        return;
      }
      // A pasted bare (non-image) link.
      const url = text.trim();
      if (/^https?:\/\/\S+$/i.test(url)) {
        appendBuddy({ role: "user", text });
        appendBuddy({
          role: "tool",
          text: "I see a link — what would you like to do with it?",
          actions: [
            { label: "📖 Open & read", send: `/open ${url}` },
            { label: "🔬 Open as technical", send: `/open ${url} technical` },
            { label: "💬 Just discuss it", send: `Tell me about this link: ${url}` },
          ],
        });
        return;
      }
      await dispatchBuddyTurn(chatTurnsOf(buddyMessages), text, text);
    },
    [buddyMessages, buddyChat, buddyPersona, library, openBook, startGeneration, libraryStore, hasSearchKey],
  );
  const onBuddySendText = useCallback((text: string) => void onBuddySend(text), [onBuddySend]);

  // "Story as you go": start a brand-new illustrated story the user co-writes — the same
  // deterministic /story path the chat composer's ✍️ Story button uses, but reachable from the
  // header next to "Open book…" (which only opens an EXISTING file). Surfacing the chat makes the
  // workflow visible even when a book is already open.
  // "Story as you go": open the setup modal (workflow + cast + characters), seeded from the souls so
  // a "You & me" story already knows the played names + looks. Replaces the old window.prompt.
  const [showStorySetup, setShowStorySetup] = useState(false);
  const [storySetupSeed, setStorySetupSeed] = useState<{ self: { name: string; note?: string }; user: { name: string; note?: string } }>({
    self: { name: "" },
    user: { name: "" },
  });
  const startStoryAsYouGo = useCallback(async () => {
    const [selfName, selfNotes, userName, userNotes] = await Promise.all([
      loadSoulName(libraryStore, "self"),
      loadSoul(libraryStore, "self"),
      loadSoulName(libraryStore, "user"),
      loadSoul(libraryStore, "user"),
    ]).catch(() => ["", [], "", []] as [string, SoulNote[], string, SoulNote[]]);
    setStorySetupSeed({
      self: { name: selfName, ...(selfNotes[0]?.text ? { note: selfNotes.map((n) => n.text).join("; ").slice(0, 200) } : {}) },
      user: { name: userName, ...(userNotes[0]?.text ? { note: userNotes.map((n) => n.text).join("; ").slice(0, 200) } : {}) },
    });
    setShowStorySetup(true);
  }, [libraryStore]);
  // Dispatch the setup as a deterministic /story call (carrying the cast/roleplay as JSON) through the
  // normal buddy turn, with a friendly chat bubble instead of the raw payload.
  const startStoryFromSetup = useCallback(
    (payload: StoryStartPayload) => {
      setShowStorySetup(false);
      setShowChat(true);
      const bubble = `✍️ Starting a story — ${payload.opening.slice(0, 80)}${payload.opening.length > 80 ? "…" : ""}`;
      const command = `/story ${JSON.stringify(payload)}`;
      // Remember where we came from so exiting the story returns us there (history intact).
      storyReturnSessionRef.current = activeBuddyIdRef.current;
      // On a linked phone the session + engine live on the DESKTOP. Relay the story start the same way
      // a normal message relays (the desktop owns session creation and runs the turn, then mirrors the
      // opened book + each beat back): make a fresh session, then send the /story command into it. This
      // gives mobile the same clean dedicated chat as desktop, and the book/beats sync back via vrsync.
      if (isRemoteClient) {
        sendAppSync({ type: "vrcmd:chatNew" });
        sendAppSync({ type: "vrcmd:chatSend", text: command });
        return;
      }
      // Open the story in a FRESH, dedicated book-only chat. A clean (empty) writer context is what
      // makes the model reliably reply with beat prose — which the worker then lands in the book —
      // instead of conversational filler inherited from whatever chat we were just in.
      const sid = `${BUDDY_CHAT_ID}-${Date.now().toString(36)}`;
      const label = `Story · ${payload.title || payload.opening.slice(0, 24)}`.slice(0, 60);
      resetBuddyView();
      setBuddySessions((prev) => {
        const next = [...prev, { id: sid, workingDir: "", label }];
        persistSessions(next);
        return next;
      });
      setActiveBuddyId(sid);
      activeBuddyIdRef.current = sid; // synchronous: the dispatch below must run against the new session
      setBuddyMessages([]);
      void libraryStore.putMemo?.("buddy-active-session", sid).catch(() => {});
      void dispatchBuddyTurn([], command, bubble); // empty history → clean story context
    },
    // resetBuddyView is intentionally omitted — it's defined later in this component; referencing it
    // in the dep array would evaluate before initialization (TDZ). It's stable, so this is safe.
    [buddyMessages, isRemoteClient, libraryStore, persistSessions],
  );

  // Attach a file to the next buddy message. Documents (PDF/Word/Excel/CSV/text/EPUB) are
  // extracted to text via the same importer the "Open a document" path uses; images are held
  // for the vision model to describe at send time. All in the main thread — no new worker wiring.
  const onAttachBuddyFile = useCallback(async (file: File) => {
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const looksImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
    setBuddyAttachments((a) => [...a, { id, name: file.name, kind: looksImage ? "image" : "doc", status: "reading" }]);
    try {
      const imported = await importBookFile(file);
      setBuddyAttachments((a) =>
        a.map((x) => {
          if (x.id !== id) return x;
          if (imported.kind === "image") {
            return { id, name: file.name, kind: "image", status: "ready", image: { bytes: imported.bytes, mimeType: imported.mimeType } };
          }
          const raw =
            imported.kind === "book"
              ? imported.book.pages.flatMap((p) => p.paragraphs.map((par) => par.text)).join("\n")
              : imported.text;
          const text = (raw ?? "").trim();
          const name = imported.kind === "book" ? imported.book.title : imported.title || file.name;
          if (!text) return { id, name, kind: "doc", status: "error", error: "No readable text in this file." };
          return { id, name, kind: "doc", status: "ready", text: text.slice(0, ATTACH_DOC_MAX_CHARS) };
        }),
      );
    } catch (e) {
      setBuddyAttachments((a) =>
        a.map((x) => (x.id === id ? { ...x, status: "error", error: e instanceof Error ? e.message : String(e) } : x)),
      );
    }
  }, []);

  const onRemoveBuddyAttachment = useCallback((id: string) => {
    setBuddyAttachments((a) => a.filter((x) => x.id !== id));
  }, []);

  // Run a turn with PREPARED attachments (docs inline as labeled text blocks, images via the vision
  // model using the typed message as the question). The model gets the full content; the chat shows
  // each attached IMAGE inline (so the reader sees what they sent) plus the typed question, while a
  // big doc stays a "📎 filename" chip so it doesn't flood the transcript. Shared by the desktop UI
  // and a phone-relayed send (vrcmd:chatSend) — the attachments are already extracted either way.
  const runBuddyTurnWithAttachments = useCallback(
    async (text: string, atts: ChatSendAttachment[]) => {
      markUserRequest();
      if (atts.length === 0) {
        onBuddySendText(text);
        return;
      }
      const userText = text.trim() || "Please look at the attached file(s) and help me with them.";
      const parts: string[] = [];
      for (const att of atts) {
        if (att.kind === "image" && att.image) {
          // Show the picture the reader attached, inline in the chat (display-only — the full
          // content is folded into `combined` for this turn, so it carries no model turn of its own).
          appendBuddy({ role: "user", text: `🖼 ${att.name}`, image: { bytes: att.image.bytes.slice(0), mimeType: att.image.mimeType }, turns: [] });
          const r = await assessImage({ bytes: att.image.bytes.slice(0), mimeType: att.image.mimeType }, userText);
          parts.push(
            r.text
              ? `[Attached image "${att.name}" — what it shows]\n${r.text}`
              : `[Attached image "${att.name}" — couldn't read it: ${r.error ?? "no vision-capable model is set"}]`,
          );
        } else if (att.kind === "doc" && att.text) {
          appendBuddy({ role: "user", text: `📎 ${att.name}`, turns: [] });
          parts.push(`[Attached file "${att.name}"]\n${att.text}`);
        }
      }
      const combined = parts.length ? `${parts.join("\n\n")}\n\n${userText}` : userText;
      // The attachment bubbles are already shown above; pass the typed question as its own bubble.
      await dispatchBuddyTurn(chatTurnsOf(buddyMessages), combined, userText);
    },
    [assessImage, onBuddySendText, buddyMessages],
  );
  // Panel "send": gather the ready attachments. On a linked PHONE the turn runs on the DESKTOP (it
  // has the models + the working folder) — relay the message AND its (already-extracted) attachments,
  // and the result/stream flow back via the chat mirror. On the desktop, run the turn locally.
  const onBuddySendWithAttachments = useCallback(
    async (text: string) => {
      const ready = buddyAttachments.filter((x) => x.status === "ready");
      const atts: ChatSendAttachment[] = ready.map((a) =>
        a.kind === "image" && a.image
          ? { name: a.name, kind: "image", image: { bytes: a.image.bytes.slice(0), mimeType: a.image.mimeType } }
          : { name: a.name, kind: "doc", ...(a.text ? { text: a.text } : {}) },
      );
      if (atts.length) setBuddyAttachments([]); // consumed the ready chips (a still-reading one stays)
      if (isRemoteClient) {
        if (text.trim() || atts.length) sendAppSync({ type: "vrcmd:chatSend", text, ...(atts.length ? { attachments: atts } : {}) });
        return;
      }
      await runBuddyTurnWithAttachments(text, atts);
    },
    [isRemoteClient, sendAppSync, buddyAttachments, runBuddyTurnWithAttachments],
  );
  // Persona is part of the chat the desktop owns: on a linked phone, relay the change so the desktop
  // applies it (and the mirror reflects it); on the desktop, set it locally.
  const onBuddyPersonaChange = useCallback(
    (persona: BuddyPersona) => {
      if (isRemoteClient) sendAppSync({ type: "vrcmd:chatPersona", persona });
      else setBuddyPersona(persona);
    },
    [isRemoteClient, sendAppSync],
  );

  // Scheduled-task runner: while the app is open, every ~minute fire the FIRST due task
  // into the buddy chat (so the assistant executes its instruction), then advance its
  // schedule. One per tick, and never while a turn is in flight, so it can't stampede.
  const buddyBusyRef = useRef(buddyBusy);
  buddyBusyRef.current = buddyBusy;
  useEffect(() => {
    if (isRemoteClient) return; // the desktop runs scheduled tasks (it owns the chat + the data)
    const id = setInterval(() => {
      if (buddyBusyRef.current) return;
      void (async () => {
        const tasks = await loadScheduledTasks(libraryStore);
        const due = dueScheduledTasks(tasks);
        if (due.length === 0) return;
        const task = due[0]!;
        // Advance first (so a slow turn can't double-fire), then run it.
        await upsertScheduledTask(libraryStore, advanceSchedule(task)).catch(() => {});
        refreshScheduled();
        logActionRef.current("scheduled_run", `Ran scheduled: ${task.title}`);
        onBuddySendText(`⏰ Scheduled task “${task.title}”. Do this now: ${task.prompt}`);
      })();
    }, 60_000);
    return () => clearInterval(id);
  }, [libraryStore, onBuddySendText, refreshScheduled, isRemoteClient]);

  // Remote bus (phone↔Google↔desktop): when enabled + Google's connected, poll the user's
  // Google Tasks for "VR:" commands they added from their phone, run each through the buddy,
  // write the answer back into the task, and mark it done. Reuses the existing buddy turn —
  // no server, no always-on daemon (the app must be open). One command per tick, never while
  // a turn is in flight, deduped so a slow run can't double-fire.
  const busProcessed = useRef<Set<string>>(new Set());
  const busPollingRef = useRef(false);
  useEffect(() => {
    if (isRemoteClient || !googleConnected || !settings.remoteBus) return; // desktop owns the bus
    const id = setInterval(() => {
      if (busPollingRef.current || buddyBusyRef.current) return;
      busPollingRef.current = true;
      void (async () => {
        const r = await remoteBusList();
        const cmd = r.commands?.find((c) => !busProcessed.current.has(c.id));
        if (!cmd) return;
        busProcessed.current.add(cmd.id);
        const answer = await dispatchBuddyTurn(chatTurnsOf(buddyMessages), cmd.text, `📱 ${cmd.text}`);
        await remoteBusReply(cmd.id, answer ?? "(done — see the desktop app)").catch(() => {});
      })()
        .catch(() => {})
        .finally(() => {
          busPollingRef.current = false;
        });
    }, 45_000);
    return () => clearInterval(id);
  }, [isRemoteClient, googleConnected, settings.remoteBus, remoteBusList, remoteBusReply, buddyMessages]);

  // Price-alert runner: every ~minute, pull fresh indicators for each watched symbol,
  // evaluate the alerts, fire a notification on a trigger, and persist the new state
  // (one-shot thresholds disable; VWAP-cross keeps watching). Runs while the app is open.
  const notifyAlert = useCallback(
    (title: string, body: string) => {
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body });
      } catch {
        /* notifications optional */
      }
      noteAction(`🔔 ${title}: ${body}`);
    },
    [noteAction],
  );
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        const enabled = (await loadPriceAlerts(libraryStore)).filter((a) => a.enabled);
        if (enabled.length === 0) return;
        const symbols = [...new Set(enabled.map((a) => a.symbol))];
        for (const sym of symbols) {
          const r = await marketIndicators(sym);
          if (!r.indicators) continue;
          for (const a of enabled.filter((x) => x.symbol === sym)) {
            const res = evaluateAlert(a, r.indicators);
            const advanced = advanceAlert(a, res, new Date().toISOString());
            if (advanced !== a) await upsertPriceAlert(libraryStore, advanced).catch(() => {});
            if (res.fired) notifyAlert(`${a.symbol}`, res.message ?? describeAlert(a));
          }
        }
        refreshAlerts();
      })();
    }, 60_000);
    return () => clearInterval(id);
  }, [libraryStore, marketIndicators, notifyAlert, refreshAlerts]);
  // Approved buddy render: the worker's chatTool path serves both chats (the
  // buddy's generate_image call has the identical shape by design).
  const onApproveBuddyTool = useCallback(async () => {
    const call = buddyPendingTool;
    if (call && isDesktopRuntimeTool(call)) {
      // find_files / run_command / write_file / screenshot — local on the desktop, relayed on a phone.
      runHostToolDispatch(call);
      return;
    }
    if (call?.tool === "send_email") {
      void approveSendEmail(call);
      return;
    }
    if (call?.tool === "spawn_coding_agents") {
      void approveSpawnCodingAgents(call);
      return;
    }
    if (call?.tool === "generate_video") {
      await approveGenerateVideo(call);
      return;
    }
    if (!call || call.tool !== "generate_image") return;
    await approveGenerateImage(call);
  }, [buddyPendingTool, chatTool]);
  // On a linked PHONE the turn (and its pending tool) lives on the DESKTOP — relay the approval intent;
  // the desktop runs the real handler against its own pending tool. Same for "allow always" + dismiss.
  const onApproveBuddyPendingTool = useCallback(() => {
    if (isRemoteClient) sendAppSync({ type: "vrcmd:chatApproveTool", always: false });
    else void onApproveBuddyTool();
  }, [isRemoteClient, sendAppSync, onApproveBuddyTool]);
  // "Allow this session": grant the pending capability (file search OR screen
  // capture) so later same-kind calls run without re-prompting, then run this one.
  const onAllowBuddyAlways = useCallback(() => {
    if (isRemoteClient) {
      sendAppSync({ type: "vrcmd:chatApproveTool", always: true });
      return;
    }
    const call = buddyPendingTool;
    if (call?.tool === "find_files") {
      fileAccessGranted.current = true;
      runHostToolDispatch(call);
    } else if (call?.tool === "screenshot") {
      screenCaptureGranted.current = true;
      runHostToolDispatch(call);
    }
  }, [isRemoteClient, sendAppSync, buddyPendingTool]);
  const onDismissBuddyPendingTool = useCallback(() => {
    if (isRemoteClient) {
      sendAppSync({ type: "vrcmd:chatDismissTool" });
      return;
    }
    setBuddyPendingTool(undefined);
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
  }, [isRemoteClient, sendAppSync]);
  // Dismiss the working checklist. On a phone the desktop owns it (and re-mirrors via ChatLive), so
  // relay the clear there; clear locally too for an instant response.
  const onDismissPlan = useCallback(() => {
    setBuddyPlan(undefined);
    if (isRemoteClient) {
      sendAppSync({ type: "vrcmd:chatPlanClear" });
      return;
    }
    void libraryStore.deleteMemo?.(planMemoKey(activeBuddyIdRef.current)).catch(() => {});
  }, [isRemoteClient, sendAppSync, libraryStore]);
  const onClearBuddy = useCallback(() => {
    if (isRemoteClient) {
      sendAppSync({ type: "vrcmd:chatClear" }); // the desktop owns the chat — clear it there
      return;
    }
    buddyTurnSeq.current++;
    buddyCancel();
    setBuddyBusy(false);
    setBuddyStreaming("");
    setBuddyActivity("");
    setBuddyMessages([]);
    setBuddyPlan(undefined);
    buddyPlanRef.current = undefined; // synchronous — don't let a stale checklist survive the clear
    setBuddyWorkflow(undefined);
    buddyWorkflowRef.current = undefined;
    buddyStepEvidenceRef.current = { toolResults: [], text: "" };
    setBuddyPendingTool(undefined);
    createdFilesRef.current = [];
    setFileLedger([]);
    void libraryStore.deleteChatHistory?.(activeBuddyId);
    void libraryStore.deleteMemo?.(planMemoKey(activeBuddyId)).catch(() => {});
    void libraryStore.deleteMemo?.(workflowMemoKey(activeBuddyId)).catch(() => {});
    void libraryStore.deleteMemo?.(ledgerMemoKey(activeBuddyId)).catch(() => {});
  }, [isRemoteClient, sendAppSync, libraryStore, buddyCancel, activeBuddyId, setFileLedger]);
  // Stop: the turn runs on the DESKTOP (under its worker request id the phone doesn't have), so a
  // linked phone relays the stop; the desktop aborts its in-flight buddy round.
  const onBuddyCancel = useCallback(() => {
    if (isRemoteClient) sendAppSync({ type: "vrcmd:chatCancel" });
    else buddyCancel();
  }, [isRemoteClient, sendAppSync, buddyCancel]);

  // Reset the live conversation view when moving between sessions.
  const resetBuddyView = useCallback(() => {
    buddyTurnSeq.current++;
    buddyCancel();
    setBuddyBusy(false);
    setBuddyStreaming("");
    buddyStreamingRef.current = "";
    setBuddyThinking("");
    setBuddyActivity("");
    setBuddySteps([]);
    // ISOLATE the conversation immediately: the switch/new/delete callers load the target session's
    // history + plan ASYNCHRONOUSLY, so without clearing here the PREVIOUS window's messages + checklist
    // stay live during the load gap — the model then sees the old chat (e.g. "those 5 images are already
    // generated") and reports the new task as already done. Clear the ref synchronously too (the
    // render-time sync at the top of the component otherwise lags a tick behind this state update).
    setBuddyMessages([]);
    setBuddyPlan(undefined); // the new session's plan loads in (or stays empty); don't flash the old one
    buddyPlanRef.current = undefined;
    setBuddyWorkflow(undefined); // app-managed workflow is per-session too — don't leak it across a switch
    buddyWorkflowRef.current = undefined;
    buddyStepEvidenceRef.current = { toolResults: [], text: "" };
    setBuddyPendingTool(undefined);
    // The context-usage badge is per-conversation — clear it on a session switch so it doesn't show
    // the previous window's % (it repopulates from the new session's next turn).
    setBuddyUsage(undefined);
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
  }, [buddyCancel]);
  const onSwitchBuddySession = useCallback(
    (id: string) => {
      if (id === activeBuddyId) return;
      if (isRemoteClient) {
        sendAppSync({ type: "vrcmd:chatSwitch", id }); // switch on the desktop; mirror reflects it
        return;
      }
      resetBuddyView();
      void libraryStore.putMemo?.("buddy-active-session", id).catch(() => {});
      void libraryStore.getChatHistory?.(id).then((hist) => {
        setActiveBuddyId(id);
        setBuddyMessages(hist ?? []);
      });
      void loadBuddyPlan(id).then((p) => {
        buddyPlanRef.current = p; // keep the ref in step with the loaded session's plan, not a render behind
        setBuddyPlan(p);
      });
      void loadBuddyWorkflow(id).then((w) => {
        buddyWorkflowRef.current = w; // restore the app-managed workflow for the switched-to session
        setBuddyWorkflow(w);
      });
      void loadFileLedger(id).then((files) => {
        createdFilesRef.current = files; // restore the switched-to session's file ledger
        setFileLedger(files);
      });
    },
    [isRemoteClient, sendAppSync, activeBuddyId, libraryStore, resetBuddyView, loadBuddyPlan, loadBuddyWorkflow, loadFileLedger, setFileLedger],
  );
  switchBuddyRef.current = onSwitchBuddySession; // so onExitBook (defined earlier) can restore a session
  const onNewBuddySession = useCallback(() => {
    if (isRemoteClient) {
      sendAppSync({ type: "vrcmd:chatNew" }); // create on the desktop; the mirror brings it back
      return;
    }
    const id = `${BUDDY_CHAT_ID}-${Date.now().toString(36)}`;
    resetBuddyView();
    setBuddySessions((prev) => {
      const next = [...prev, { id, workingDir: "" }];
      persistSessions(next);
      return next;
    });
    setActiveBuddyId(id);
    setBuddyMessages([]);
    createdFilesRef.current = []; // a brand-new session starts with an empty file ledger
    setFileLedger([]);
    void libraryStore.putMemo?.("buddy-active-session", id).catch(() => {});
  }, [isRemoteClient, sendAppSync, libraryStore, persistSessions, resetBuddyView, setFileLedger]);
  const onDeleteBuddySession = useCallback(
    (id: string) => {
      if (isRemoteClient) {
        sendAppSync({ type: "vrcmd:chatDelete", id }); // delete on the desktop; mirror reflects it
        return;
      }
      setBuddySessions((prev) => {
        if (prev.length <= 1) return prev; // keep at least one session
        const next = prev.filter((s) => s.id !== id);
        persistSessions(next);
        void libraryStore.deleteChatHistory?.(id).catch(() => {});
        void libraryStore.deleteMemo?.(planMemoKey(id)).catch(() => {});
        void libraryStore.deleteMemo?.(ledgerMemoKey(id)).catch(() => {});
        if (id === activeBuddyId) {
          const fallback = next[0]!.id;
          resetBuddyView();
          void libraryStore.putMemo?.("buddy-active-session", fallback).catch(() => {});
          void libraryStore.getChatHistory?.(fallback).then((hist) => {
            setActiveBuddyId(fallback);
            setBuddyMessages(hist ?? []);
          });
          void loadBuddyPlan(fallback).then((p) => {
            buddyPlanRef.current = p;
            setBuddyPlan(p);
          });
          void loadBuddyWorkflow(fallback).then((w) => {
            buddyWorkflowRef.current = w;
            setBuddyWorkflow(w);
          });
          void loadFileLedger(fallback).then((files) => {
            createdFilesRef.current = files;
            setFileLedger(files);
          });
        }
        return next;
      });
    },
    [isRemoteClient, sendAppSync, activeBuddyId, libraryStore, persistSessions, resetBuddyView, loadBuddyPlan],
  );
  // Open a task in its own preloaded chat session (reuses multi-session): switch to the
  // plan's session (creating one the first time), seed it with the current step + links.
  const openTaskInChat = useCallback(
    async (planId: string) => {
      const plan = (await loadTaskPlans(libraryStore)).find((p) => p.id === planId);
      if (!plan) return;
      setShowTasks(false);
      let sessionId = plan.sessionId;
      if (!sessionId || !buddySessions.some((s) => s.id === sessionId)) {
        const sid = `${BUDDY_CHAT_ID}-${Date.now().toString(36)}`;
        sessionId = sid;
        setBuddySessions((prev) => {
          // Name the task's dedicated chat after the task, so the session list reads as the task.
          const next = [...prev, { id: sid, workingDir: "", label: sessionLabelForPlan(plan) }];
          persistSessions(next);
          return next;
        });
        await upsertTaskPlan(libraryStore, { ...plan, sessionId: sid });
        refreshTaskPlans();
      }
      resetBuddyView();
      setActiveBuddyId(sessionId);
      void libraryStore.putMemo?.("buddy-active-session", sessionId).catch(() => {});
      const ready = plan.steps.find((s) => s.status === "ready") ?? plan.steps.find((s) => s.status !== "done");
      const questions = plan.clarifyingQuestions ?? [];
      const primer = [
        `📋 ${plan.title}${plan.deadlineIso ? ` — due ${plan.deadlineIso}` : ""}`,
        plan.summary,
        questions.length
          ? `❔ Before I finalize this, I need a few things from you:\n${questions.map((q) => `• ${q}`).join("\n")}`
          : "",
        ready ? `Current step: ${ready.title}${ready.detail ? ` — ${ready.detail}` : ""}` : "All steps are done. 🎉",
        ready?.links.length ? `Links: ${ready.links.map((l) => l.url).join("  ")}` : "",
        questions.length ? "Answer above and I'll refine the plan; or ask me to help with this step." : "Ask me to help with this step.",
      ].filter(Boolean);
      // The primer is shown to the reader only; the MODEL gets this same task context from the
      // system prompt's ACTIVE TASK block (tasksIndexBlock) on every turn — see the worker's
      // buildBuddySystemPrompt({ activeTask }) path, reached now that activeTaskPlanId() resolves
      // reliably. We deliberately do NOT seed it into history: a leading assistant/tool turn would
      // be rejected by providers (e.g. Anthropic requires the first message to be "user").
      setBuddyMessages([{ role: "tool", text: primer.join("\n"), at: Date.now() }]);
    },
    [libraryStore, buddySessions, persistSessions, resetBuddyView, refreshTaskPlans],
  );

  // DESKTOP side: run a Tasks/Calendar action the phone relayed (vrcmd:planner). Each maps to the
  // SAME handler the desktop UI uses, so the result persists + re-mirrors to the phone via
  // vrsync:planner. Kept in a ref (plannerCommandRef) so the early-registered relay handler reaches it.
  const runPlannerCommand = useCallback(
    (c: PlannerCommand) => {
      switch (c.action) {
        case "createTask":
          void onCreateTask(c.title, c.dueIso, c.recurrence, c.planNow);
          break;
        case "scanNow":
          void scanNow();
          break;
        case "planPending":
          void planAllPending();
          break;
        case "planTask":
          void planOneTask(c.id);
          break;
        case "openTask":
          void openTaskInChat(c.id);
          break;
        case "advanceStep":
          void onAdvanceTaskStep(c.planId, c.stepId);
          break;
        case "toggleStep":
          void onToggleStepDone(c.planId, c.stepId, c.done);
          break;
        case "completeTask":
          void onCompleteTask(c.planId, c.complete);
          break;
        case "ignoreTask":
          void ignoreTask(c.id);
          break;
        case "addDetails":
          void onAddTaskDetails(c.planId, c.text);
          break;
        case "deleteTask":
          void removeTask(c.id);
          break;
        case "restoreTask":
          void restoreTask(c.id);
          break;
        case "deleteForever":
          void deleteTaskForever(c.id);
          break;
        case "calShift":
          shiftCalendarMonth(c.delta);
          break;
        case "createEvent":
          void onCreateCalendarEvent(c.ev);
          break;
      }
    },
    [
      onCreateTask,
      scanNow,
      planAllPending,
      planOneTask,
      openTaskInChat,
      onAdvanceTaskStep,
      onToggleStepDone,
      onCompleteTask,
      ignoreTask,
      onAddTaskDetails,
      removeTask,
      restoreTask,
      deleteTaskForever,
      shiftCalendarMonth,
      onCreateCalendarEvent,
    ],
  );
  useEffect(() => {
    plannerCommandRef.current = runPlannerCommand;
  }, [runPlannerCommand]);

  // DESKTOP side: run a landing-page chat action the phone relayed (vrcmd:chat*). Each maps to the
  // SAME handler the desktop UI uses — and since we're the desktop (isRemoteClient is false), those
  // handlers take their LOCAL branch (run the turn / mutate sessions), then the chat mirror re-pushes
  // the result to the phone. Kept in a ref (chatCommandRef) so the early-registered relay reaches it.
  const runChatCommand = useCallback(
    (c: CmdToDesktop) => {
      switch (c.type) {
        case "vrcmd:chatSend":
          void runBuddyTurnWithAttachments(c.text, c.attachments ?? []);
          break;
        case "vrcmd:chatSwitch":
          onSwitchBuddySession(c.id);
          break;
        case "vrcmd:chatNew":
          onNewBuddySession();
          break;
        case "vrcmd:chatDelete":
          onDeleteBuddySession(c.id);
          break;
        case "vrcmd:chatDeleteMessage":
          // Delete the message HERE (we own the chat store); the persistence effect writes it and the
          // chat mirror re-pushes — so a phone-side delete sticks instead of being clobbered back in.
          setBuddyMessages((prev) => prev.filter((_, i) => i !== c.index));
          break;
        case "vrcmd:chatRename":
          onRenameBuddySession(c.id, c.label);
          break;
        case "vrcmd:chatPersona":
          setBuddyPersona(normalizeBuddyPersona(c.persona));
          break;
        case "vrcmd:chatClear":
          onClearBuddy();
          break;
        case "vrcmd:chatCancel":
          buddyCancel();
          break;
        case "vrcmd:chatApproveTool":
          if (c.always) onAllowBuddyAlways();
          else onApproveBuddyPendingTool();
          break;
        case "vrcmd:chatDismissTool":
          onDismissBuddyPendingTool();
          break;
        case "vrcmd:chatAgentApprove":
          onApproveAgentTool(c.id);
          break;
        case "vrcmd:chatAgentDeny":
          onDenyAgentTool(c.id);
          break;
        default:
          break;
      }
    },
    [runBuddyTurnWithAttachments, onSwitchBuddySession, onNewBuddySession, onDeleteBuddySession, onRenameBuddySession, onClearBuddy, buddyCancel, onAllowBuddyAlways, onApproveBuddyPendingTool, onDismissBuddyPendingTool],
  );
  useEffect(() => {
    chatCommandRef.current = runChatCommand;
  }, [runChatCommand]);

  // Stable per-index delete handlers (memoised bubbles take the SAME function).
  const onDeleteBuddyMessage = useCallback(
    (index: number) => {
      if (isRemoteClient) {
        // The desktop owns the chat store; relay the delete so it sticks (a phone-local delete is
        // re-clobbered by the next vrsync:chat mirror push).
        sendAppSync({ type: "vrcmd:chatDeleteMessage", index });
        return;
      }
      setBuddyMessages((prev) => prev.filter((_, i) => i !== index));
    },
    [isRemoteClient, sendAppSync],
  );
  const onDeleteChatMessage = useCallback((index: number) => {
    setChatMessages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /** Replacement history after a compact: ONE visible summary message whose
   * model-facing turns hand the brief to the model as established context. */
  const compactedMessage = (summary: string): StoredChatMessage => ({
    role: "tool",
    at: Date.now(),
    text: `📜 Conversation compacted — continuing from this summary:\n\n${summary}`,
    turns: [
      { role: "user", content: `[Summary of our conversation so far — continue from this context]\n${summary}` },
      { role: "assistant", content: "Got it — I have the context from the summary." },
    ],
  });
  const onCompactBuddy = useCallback(async () => {
    if (buddyBusy || buddyMessages.length < 4) return;
    setBuddyBusy(true);
    setBuddyActivity("Compacting the conversation…");
    const res = await summarize(chatTurnsOf(buddyMessages));
    setBuddyBusy(false);
    setBuddyActivity("");
    if (res.text) setBuddyMessages([compactedMessage(res.text)]);
    else appendBuddy({ role: "tool", text: `⚠ Compact failed: ${res.error}`, turns: [] });
  }, [buddyBusy, buddyMessages, summarize]);
  const onCompactChat = useCallback(async () => {
    if (chatBusy || chatMessages.length < 4) return;
    setChatBusy(true);
    setChatActivity("Compacting the conversation…");
    const res = await summarize(chatTurnsOf(chatMessages));
    setChatBusy(false);
    setChatActivity("");
    if (res.text) setChatMessages([compactedMessage(res.text)]);
    else appendChat({ role: "tool", text: `⚠ Compact failed: ${res.error}`, turns: [] });
  }, [chatBusy, chatMessages, summarize]);
  const onCompactBuddyClick = useCallback(() => void onCompactBuddy(), [onCompactBuddy]);
  const onCompactChatClick = useCallback(() => void onCompactChat(), [onCompactChat]);

  // G7 — auto-compaction. A long multi-step job silently loses its early decisions once the
  // history outgrows a small local window and the worker trims the oldest turns. Before that
  // happens, fold the OLDER turns into a brief and keep the most recent ones verbatim — the
  // same flow the manual Compact button uses, but fired automatically when usage crosses ~0.8
  // of the model's window. The file ledger + plan persist separately, so they survive intact.
  const autoCompactingRef = useRef(false);
  const onAutoCompactBuddy = useCallback(async () => {
    if (autoCompactingRef.current || buddyBusy) return;
    const msgs = buddyMessagesRef.current;
    const keepRecent = 6;
    if (msgs.length <= keepRecent + 1) return; // nothing meaningful to summarize away
    const older = msgs.slice(0, msgs.length - keepRecent);
    const recent = msgs.slice(msgs.length - keepRecent);
    autoCompactingRef.current = true;
    setBuddyBusy(true);
    setBuddyActivity("Compacting earlier conversation to stay within context…");
    const res = await summarize(chatTurnsOf(older));
    setBuddyBusy(false);
    setBuddyActivity("");
    if (res.text) {
      setBuddyMessages([compactedMessage(res.text), ...recent]);
      // Drop the stale usage donut: it reflected the pre-compaction history. The next turn
      // recomputes it — and clearing it stops this effect from re-firing on the old value.
      setBuddyUsage(undefined);
    }
    autoCompactingRef.current = false;
  }, [buddyBusy, summarize]);
  useEffect(() => {
    if (isRemoteClient || buddyBusy || autoCompactingRef.current) return;
    if (shouldAutoCompact(buddyUsage, buddyMessages.length)) void onAutoCompactBuddy();
  }, [buddyUsage, buddyBusy, buddyMessages.length, isRemoteClient, onAutoCompactBuddy]);
  const buddyPanelMessages = useMemo(
    () =>
      buddyMessages.map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.image ? { image: m.image } : {}),
        ...(m.video ? { video: m.video } : {}),
        ...(m.links ? { links: m.links } : {}),
        ...(m.gallery ? { gallery: m.gallery } : {}),
        ...(m.files ? { files: m.files } : {}),
        ...(m.attachments ? { attachments: m.attachments } : {}),
        ...(m.actions ? { actions: m.actions } : {}),
        ...(m.thinking ? { thinking: m.thinking } : {}),
      })),
    [buddyMessages],
  );

  // On-image description: the EXACT prompt the image was rendered from (persisted
  // with it, so it never shifts as the bible grows — and doubles as prompt
  // troubleshooting). Until the render lands, fall back to the unit's STORED scene
  // prompt from the bible — also static once written. Never live-resolved names.
  const imageCaption = useMemo(() => {
    const rendered = results.get(unitIndex)?.prompt?.trim();
    if (rendered) return rendered;
    if (!bible || !units || !book) return undefined;
    const unitPage = units.book.pages[unitIndex];
    if (!unitPage) return undefined;
    const chapterIdx = book.chapters.find((c) => c.id === unitPage.chapterId)?.index ?? 0;
    const ev = resolveKeyEvent(bible, chapterIdx, unitPage.pageRange ?? [unitIndex, unitIndex]);
    const stored = ev ? composeScenePrompt(ev.imagePrompt) : "";
    return stored || undefined;
  }, [results, unitIndex, book, bible, units]);

  // Bloom target: reveal the illustration only as the reader progresses through the
  // page, holding any depicted spoiler until they reach its paragraph (core/reveal).
  const paraCount = activePage?.paragraphs.length ?? 1;
  const pageProgress = Math.min(
    1,
    Math.max(0, ((paragraphIndexFromId(activeParagraphId) ?? 0) + activeParagraphProgress) / paraCount),
  );
  const hasPageSpoiler = pageSpoilerIds.length > 0;

  // For a multi-page (or chapter) unit the single illustration reveals gradually
  // across the whole unit — fully revealed at its end (revealPoint 1). A 1-page
  // unit keeps the per-page, spoiler-aware reveal.
  const singlePage = pagesPerImage === 1;
  const unitProgress = useMemo(() => {
    if (singlePage || !units || !book) return pageProgress;
    const first = units.pageToUnit.indexOf(unitIndex);
    const count = units.unitPageCount[unitIndex] || 1;
    const pos = Math.max(0, activePageIndex - Math.max(0, first));
    return Math.min(1, Math.max(0, (pos + pageProgress) / count));
  }, [singlePage, units, book, unitIndex, activePageIndex, pageProgress]);

  const rawBloom = !activePage
    ? 0
    : singlePage
      ? computeBloomTarget(
          pageProgress,
          spoilerRevealPoint(
            latestSpoilerParagraphIndex(activePage, pageSpoilerIds, bible?.spoilers ?? []),
            hasPageSpoiler,
            paraCount,
          ),
          hasPageSpoiler,
        )
      : // Multi-page/chapter unit: reveal across the unit but reach full clarity at
        // ~80% (not only at the very end) unless this page depicts a spoiler.
        computeBloomTarget(unitProgress, hasPageSpoiler ? 1 : 0.8, true);

  // Monotonic reveal: an illustration only ever reveals MORE as you read its unit —
  // scrolling back up must not re-blur it. Ratchet to the max seen for this unit,
  // resetting when the reader moves to a new unit (so a fresh page starts blurred).
  const bloomRatchet = useRef({ unit: unitIndex, max: 0 });
  const unitChanged = bloomRatchet.current.unit !== unitIndex;
  const bloom = monotonicBloom(bloomRatchet.current.max, rawBloom, unitChanged);
  bloomRatchet.current = { unit: unitIndex, max: bloom };

  // Skipped units (front/back matter) count as "done" for the whole-book progress.
  const settledCount = useMemo(
    () => [...results.values()].filter((r) => r.status === "ready" || r.status === "skipped").length,
    [results],
  );
  const totalUnits = units?.unitCount ?? (book?.pages.length ?? 0);
  // Rough ETA for the remaining images (two render concurrently in the buffer).
  const remainingEta =
    avgRenderMs > 0 && totalUnits > settledCount
      ? ` (${formatLeft((avgRenderMs * (totalUnits - settledCount)) / 2)})`
      : "";

  // ---- Workflow bar: what the app is working on right now (always visible) ----
  // The "Redo…" dropdown (a native <details>); close it after picking an item.
  const redoMenuRef = useRef<HTMLDetailsElement | null>(null);
  const closeRedoMenu = useCallback(() => {
    if (redoMenuRef.current) redoMenuRef.current.open = false;
  }, []);

  // "Paint forward": ask which page to start from, then repaint from there to the
  // end with the CURRENT settings — everything before the chosen page is kept.
  const onPaintForward = useCallback(() => {
    if (!book || !units) return;
    const suggested = activePageIndex + 1; // 1-based, default to where the reader is
    const answer = prompt(
      `Repaint from which page to the end, using the current image settings?\n\n` +
        `Pages before it are KEPT as they are. (1–${book.pages.length})`,
      String(suggested),
    );
    if (answer === null) return;
    const pageNum = Math.floor(Number(answer));
    if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > book.pages.length) {
      noteAction(`✗ "${answer}" isn't a page number between 1 and ${book.pages.length}.`);
      return;
    }
    const fromUnit = units.pageToUnit[pageNum - 1] ?? 0;
    paintForward(fromUnit);
    noteAction(
      `✓ Painting forward from page ${pageNum} — earlier pages kept; the rest repaints with the current settings${remainingEta}.`,
    );
  }, [book, units, activePageIndex, paintForward, noteAction, remainingEta]);

  // ---- Export an illustrated copy -------------------------------------------
  const exportMenuRef = useRef<HTMLDetailsElement | null>(null);
  // How many units actually have a rendered illustration (drives the menu state).
  const illustratedCount = useMemo(
    // `evicted` units ARE rendered (bytes just dropped from memory to bound RAM) — count them.
    () =>
      [...results.values()].filter(
        (r) => r.status === "ready" && (r.image || r.sourceUrl || r.evicted),
      ).length,
    [results],
  );
  // Gather every rendered illustration keyed by the ORIGINAL page it sits on (a
  // unit's first page), reading the bytes out of the session's in-memory results.
  const gatherExportImages = useCallback(async (): Promise<ExportImages> => {
    const map = new Map<number, ExportImage>();
    const pageToUnit = units?.pageToUnit;
    const firstPageOfUnit = new Map<number, number>();
    if (pageToUnit) {
      pageToUnit.forEach((u, page) => {
        if (!firstPageOfUnit.has(u)) firstPageOfUnit.set(u, page);
      });
    }
    for (const [unitIndex, result] of results) {
      if (result.status !== "ready") continue;
      // Resident bytes, or — for an image windowed out of memory — reload it from the
      // IndexedDB cache so the export is COMPLETE regardless of what's currently resident.
      let bytes: ArrayBuffer | undefined;
      let mimeType: string | undefined;
      if (result.image) {
        bytes = "blob" in result.image ? await result.image.blob.arrayBuffer() : result.image.bytes;
        mimeType = result.image.mimeType;
      } else if (result.evicted && result.requestId) {
        const stored = await libraryStore.getImage(result.requestId);
        if (stored) ({ bytes, mimeType } = stored);
      }
      if (!bytes || !mimeType) continue; // hotlink-only figures / not embeddable
      const page = firstPageOfUnit.get(unitIndex) ?? unitIndex;
      map.set(page, {
        bytes,
        mimeType,
        ...(result.prompt ? { caption: displayCaption(result.prompt) } : {}),
      });
    }
    return map;
  }, [results, units, libraryStore]);

  const onExport = useCallback(
    async (format: "html" | "epub") => {
      if (!book) return;
      if (exportMenuRef.current) exportMenuRef.current.open = false;
      try {
        const images = await gatherExportImages();
        const styleNote = `Illustrated with Visual Reader · ${getImageStyle(settings.imageStyle).label} style · ${images.size} image${images.size === 1 ? "" : "s"}`;
        const opts = { styleNote };
        const data = format === "html" ? buildIllustratedHtml(book, images, opts) : buildIllustratedEpub(book, images, opts);
        const mime = format === "html" ? "text/html" : "application/epub+zip";
        const result = await saveNamed(exportFilename(book.title, format), data, mime, `Illustrated ${format.toUpperCase()}`);
        if (result === undefined) return; // cancelled
        const where = typeof result === "string" ? ` to ${result}` : " (check your downloads)";
        noteAction(`✓ Exported ${format.toUpperCase()} with ${images.size} illustration${images.size === 1 ? "" : "s"}${where}.`);
      } catch (err) {
        setLocalError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [book, gatherExportImages, settings.imageStyle, noteAction, saveNamed],
  );

  // The in-book chat's export_book tool: export the current book and feed the
  // outcome back so the chat can confirm it (reuses the Export menu's machinery).
  const runChatExport = async (format: "html" | "epub", modelTurns: ChatTurn[]): Promise<void> => {
    if (!book) return;
    setChatBusy(true);
    setChatActivity(`Exporting as ${format.toUpperCase()}…`);
    let payload: ToolResultPayload;
    try {
      const images = await gatherExportImages();
      const opts = {
        styleNote: `Illustrated with Visual Reader · ${getImageStyle(settings.imageStyle).label} style · ${images.size} image${images.size === 1 ? "" : "s"}`,
      };
      const base = safeFileName(book.title);
      const saved =
        format === "html"
          ? await saveExportFile(`${base}.html`, buildIllustratedHtml(book, images, opts), "text/html")
          : await saveExportFile(`${base}.epub`, buildIllustratedEpub(book, images, opts), "application/epub+zip");
      payload = {
        export: { ok: true, format, where: typeof saved === "string" ? saved : "your downloads", images: images.size },
      };
    } catch (err) {
      payload = { export: { ok: false, format, where: "", images: 0, error: err instanceof Error ? err.message : String(err) } };
    }
    setChatBusy(false);
    setChatActivity("");
    const e = payload.export!;
    appendChat({
      role: "tool",
      text: e.ok
        ? `⤓ Exported as ${format.toUpperCase()} with ${e.images} illustration${e.images === 1 ? "" : "s"}${e.where !== "your downloads" ? ` → ${e.where}` : " (check your downloads)"}`
        : `⚠ Export failed: ${e.error}`,
      turns: [...modelTurns, { role: "user", content: formatToolResult({ tool: "export_book", format }, payload) }],
    });
  };

  // The in-book chat's export_data tool: save the open spreadsheet as a real .xlsx
  // (the whole workbook when multi-sheet, optionally with a live formula totals row)
  // or .csv, and feed the outcome back so the chat confirms it.
  const runChatDataExport = async (
    format: "xlsx" | "csv",
    totals: "sum" | "average" | "min" | "max" | "count" | undefined,
    analyze: boolean,
    chart: "bar" | "line" | "pie" | undefined,
    modelTurns: ChatTurn[],
  ): Promise<void> => {
    if (!book?.data) return;
    setChatBusy(true);
    setChatActivity(`Saving as ${format.toUpperCase()}…`);
    let payload: ToolResultPayload;
    try {
      const base = safeFileName(book.title || "data");
      let saved: string | true;
      if (format === "csv") {
        saved = await saveExportFile(`${base}.csv`, dataTableToCsv(book.data), "text/csv");
      } else {
        const bytes = buildSpreadsheetXlsx(book.data, book.dataSheets, { ...(totals ? { totals } : {}), analyze, ...(chart ? { chart } : {}) });
        saved = await saveExportFile(`${base}.xlsx`, bytes, XLSX_MIME);
      }
      payload = {
        dataExport: {
          ok: true,
          format,
          where: typeof saved === "string" ? saved : "your downloads",
          ...(totals ? { totals } : {}),
          ...(analyze && format === "xlsx" ? { analyze: true } : {}),
          ...(chart && format === "xlsx" ? { chart } : {}),
        },
      };
    } catch (err) {
      payload = { dataExport: { ok: false, format, where: "", error: err instanceof Error ? err.message : String(err) } };
    }
    setChatBusy(false);
    setChatActivity("");
    const e = payload.dataExport!;
    appendChat({
      role: "tool",
      text: e.ok
        ? `⤓ Saved as ${format.toUpperCase()}${e.totals ? ` with a live ${e.totals} totals row` : ""}${e.analyze ? " + an Analysis sheet of live formulas" : ""}${e.chart ? ` + an embedded ${e.chart} chart` : ""}${e.where !== "your downloads" ? ` → ${e.where}` : " (check your downloads)"}`
        : `⚠ Export failed: ${e.error}`,
      turns: [...modelTurns, { role: "user", content: formatToolResult({ tool: "export_data", format, ...(totals ? { totals } : {}), ...(analyze ? { analyze: true } : {}), ...(chart ? { chart } : {}) }, payload) }],
    });
  };

  // The in-book chat's set_cell / add_formula_column tools: author a value or formula
  // into the open spreadsheet (the primary table), persist it, and sync it to the chat.
  const runChatDataEdit = (
    call:
      | { tool: "set_cell"; ref: string; value?: string | number; formula?: string }
      | { tool: "add_formula_column"; name: string; formula: string },
    modelTurns: ChatTurn[],
  ): void => {
    if (!book?.data) return;
    const multi = !!(book.dataSheets && book.dataSheets.length > 1);
    const sheetIndex = multi ? 0 : null;
    const target = multi ? book.dataSheets![0]!.table : book.data;
    let summary = "";
    let error = "";
    if (call.tool === "set_cell") {
      const at = parseA1(target, call.ref);
      if (!at) {
        error = `"${call.ref}" isn't an editable data cell in this sheet`;
      } else {
        const raw = call.formula !== undefined ? `=${call.formula}` : String(call.value ?? "");
        mutateBookTable(sheetIndex, (t) => setTableCell(t, at.row, at.col, raw));
        summary = call.formula !== undefined ? `Set ${call.ref} to =${call.formula}` : `Set ${call.ref} to ${call.value ?? ""}`;
      }
    } else {
      mutateBookTable(sheetIndex, (t) => setColumnFormula(addColumn(t, call.name), t.columns.length, call.formula));
      summary = `Added a computed column “${call.name}” = ${call.formula}`;
    }
    const payload: ToolResultPayload = { dataEdit: error ? { ok: false, error } : { ok: true, summary } };
    appendChat({
      role: "tool",
      text: error ? `⚠ ${error}` : `✎ ${summary}`,
      turns: [...modelTurns, { role: "user", content: formatToolResult(call, payload) }],
    });
  };

  // Save just the illustration the reader is currently looking at.
  const onSaveCurrentImage = useCallback(async () => {
    const result = results.get(unitIndex);
    if (!book || result?.status !== "ready") return;
    try {
      // Normally resident (the reader's unit is always in the retained window); fall back
      // to the IndexedDB cache if it was momentarily windowed out.
      let bytes: ArrayBuffer | undefined;
      let mimeType: string | undefined;
      if (result.image) {
        bytes = "blob" in result.image ? await result.image.blob.arrayBuffer() : result.image.bytes;
        mimeType = result.image.mimeType;
      } else if (result.requestId) {
        const stored = await libraryStore.getImage(result.requestId);
        if (stored) ({ bytes, mimeType } = stored);
      }
      if (!bytes || !mimeType) return;
      const ext = /jpe?g/i.test(mimeType) ? "jpg" : /webp/i.test(mimeType) ? "webp" : "png";
      const saved = await saveExportFile(
        `${safeFileName(book.title)} - image ${unitIndex + 1}.${ext}`,
        new Uint8Array(bytes),
        mimeType,
      );
      const where = typeof saved === "string" ? ` to ${saved}` : " (check your downloads)";
      noteAction(`✓ Saved image ${unitIndex + 1}${where}.`);
    } catch (err) {
      setLocalError(`Couldn't save the image: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [book, results, unitIndex, noteAction, libraryStore]);

  // Gaps to fill = story units whose illustration failed or never finished. (Pages with
  // a ready or skipped result, or one still rendering, don't count.) Drives the
  // "Complete book" button's badge.
  const gapCount = useMemo(() => {
    if (!units || !book) return 0;
    let n = 0;
    for (let u = 0; u < totalUnits; u++) {
      const chapterId = units.book.pages[u]?.chapterId;
      const isStory = chapterId ? book.chapters.find((c) => c.id === chapterId)?.isStory !== false : true;
      if (!isStory) continue;
      const status = results.get(u)?.status;
      // A failed illustration is always a gap. An un-started one counts only when
      // generation isn't running (otherwise it's just not its turn yet).
      if (status === "error") n++;
      else if (!generating && (status === undefined || status === "queued")) n++;
    }
    return n;
  }, [results, units, book, totalUnits, generating]);

  // The unit currently being painted (lowest in-flight index), with its progress.
  const painting = useMemo(() => {
    let best: { unit: number; progress?: number } | undefined;
    for (const [idx, r] of results) {
      if (r.status !== "rendering") continue;
      if (!best || idx < best.unit) {
        best = { unit: idx, ...(r.progress !== undefined ? { progress: r.progress } : {}) };
      }
    }
    return best;
  }, [results]);
  // Where that unit lives: its chapter title + original page range.
  const paintingWhere = useMemo(() => {
    if (!painting || !units || !book) return "";
    const unitPage = units.book.pages[painting.unit];
    if (!unitPage) return "";
    const chapter = book.chapters.find((c) => c.id === unitPage.chapterId);
    const range = unitPage.pageRange;
    const pages = range ? (range[0] === range[1] ? `p. ${range[0] + 1}` : `p. ${range[0] + 1}–${range[1] + 1}`) : "";
    return [chapter?.title, pages].filter(Boolean).join(" · ");
  }, [painting, units, book]);
  // The chapter currently being read/analysed (story chapters only, in order).
  const readingChapter = useMemo(() => {
    if (!book || workflow.bibleTotal === 0 || workflow.bibleDone >= workflow.bibleTotal) return "";
    const storyChapters = book.chapters.filter((c) => c.isStory !== false);
    return storyChapters[workflow.bibleDone]?.title ?? "";
  }, [book, workflow]);

  const readDone = workflow.bibleTotal > 0 && workflow.bibleDone >= workflow.bibleTotal;
  const promptsDone =
    readDone && (workflow.promptsTotal === 0 || workflow.promptsDone >= workflow.promptsTotal);
  const paintDone = totalUnits > 0 && settledCount >= totalUnits;
  // Which stage is ACTIVE right now (one at a time; painting overlaps reading, so
  // prefer showing the earliest unfinished stage the engine is actually inside).
  const stage: "read" | "prompts" | "paint" | "done" | "idle" = !generating
    ? "idle"
    : !readDone
      ? "read"
      : !promptsDone
        ? "prompts"
        : painting || !paintDone
          ? "paint"
          : "done";

  // The buddy chat is rendered in two places that share the same wiring: as the home-screen hero
  // (no book) and as the always-present bottom dock beneath an open book. Extracted so the ~60
  // props live once. `fill` makes it stretch to the dock's height; history collapse is dock-only.
  const renderBuddyChat = (
    fill: boolean,
    historyCollapsed?: boolean,
    onToggleHistory?: () => void,
  ) => (
    <ChatBuddyPanel
      {...(fill ? { fill: true } : {})}
      {...(historyCollapsed !== undefined ? { historyCollapsed } : {})}
      {...(onToggleHistory ? { onToggleHistory } : {})}
      messages={buddyPanelMessages}
      {...(buddyStreaming ? { streamingText: buddyStreaming } : {})}
      {...(buddyThinking ? { thinking: buddyThinking } : {})}
      busy={buddyBusy}
      {...(buddyActivity ? { activity: buddyActivity } : {})}
      {...(buddySteps.length ? { steps: buddySteps } : {})}
      {...(buddyPlan ? { plan: buddyPlan, onDismissPlan } : {})}
      {...(buddyPendingTool ? { pendingTool: buddyPendingTool } : {})}
      persona={buddyPersona}
      onPersonaChange={onBuddyPersonaChange}
      sessions={buddySessions.map((s, i) => ({
        id: s.id,
        label: s.label || (s.workingDir ? lastPathSegment(s.workingDir) : `Chat ${i + 1}`),
      }))}
      activeSessionId={activeBuddyId}
      onSwitchSession={onSwitchBuddySession}
      onNewSession={onNewBuddySession}
      onRenameSession={onRenameBuddySession}
      onDeleteSession={onDeleteBuddySession}
      onSend={onBuddySendWithAttachments}
      onStartStory={() => void startStoryAsYouGo()}
      onAttachFile={onAttachBuddyFile}
      attachments={buddyAttachments.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        status: a.status,
        ...(a.error ? { error: a.error } : {}),
      }))}
      onRemoveAttachment={onRemoveBuddyAttachment}
      onApprovePendingTool={onApproveBuddyPendingTool}
      onApprovePendingToolAlways={onAllowBuddyAlways}
      onDismissPendingTool={onDismissBuddyPendingTool}
      agentApprovals={agentApprovals}
      onApproveAgentTool={onApproveAgentTool}
      onDenyAgentTool={onDenyAgentTool}
      onCancel={onBuddyCancel}
      onClearHistory={onClearBuddy}
      onDeleteMessage={onDeleteBuddyMessage}
      onCompact={onCompactBuddyClick}
      desktop={isDesktop}
      {...(isDesktop && (settings.localTextBackend === "bundled" || settings.localTextBackend === "server")
        ? { onLoadModel: warmLlm }
        : {})}
      {...((isDesktop || isRemoteClient) && settings.allowCommands
        ? {
            workingDir: buddyWorkingDir,
            onSetWorkingDir: setWorkingDir,
            // The native folder-picker dialog is desktop-only; the phone types the path (it's
            // relayed with each command/file tool so they run in that folder on the desktop).
            ...(isDesktop ? { onPickFolder: pickFolder } : {}),
          }
        : {})}
      onOpenLocalFile={onOpenLocalFile}
      onSaveFile={onSaveChatFile}
      fileActions={buddyFileActions}
      {...((isDesktop || isRemoteClient) && settings.allowCommands ? { onRunCode } : {})}
      onSaveProject={onSaveProject}
      onBuildDocument={onBuildDocument}
      {...(buddyUsage ? { contextUsage: buddyUsage } : {})}
    />
  );

  // The story dock's control row (workflow + cadence + manual illustrate) — shown above the chat
  // when an open book is a "story as you go".
  const storyControlsRow = book?.kind === "story" && (
    <div style={styles.storyControls}>
      <select
        style={styles.storyControlSelect}
        value={book.storyConfig?.mode ?? "direct"}
        onChange={(e) => storySetMode(e.target.value as "direct" | "roleplay")}
        title="Workflow — Roleplay (you steer, the assistant plays the scene) or Direct (you direct, it narrates)"
      >
        <option value="roleplay">🎭 Roleplay</option>
        <option value="direct">✍️ Direct</option>
      </select>
      <select
        style={styles.storyControlSelect}
        value={(() => {
          const c = book.storyConfig?.cadence;
          return !c || c.mode === "per-response" ? "per-response" : c.mode === "manual" ? "manual" : "every-n";
        })()}
        onChange={(e) => {
          const v = e.target.value as "per-response" | "every-n" | "manual";
          storySetCadence(v, v === "every-n" ? 3 : undefined);
        }}
        title="How often a beat auto-illustrates"
      >
        <option value="per-response">🖼 Every beat</option>
        <option value="every-n">Every 3 beats</option>
        <option value="manual">Manual only</option>
      </select>
      <button
        style={styles.button}
        onClick={() => storyRenderLatest()}
        title="Illustrate (or redraw) the most recent beat now"
      >
        ↻ Illustrate
      </button>
    </div>
  );

  return (
    <div style={styles.shell}>
      <style>{KEYFRAMES}</style>
      {/* PRIVACY CURTAIN: while a phone drives this desktop in incognito, the engine runs here but the
          desktop's own screen stays hidden so a bystander can't see the remote session. Kept DISCREET on
          purpose — it looks like the app sitting idle (no lock, no "incognito" banner advertising that
          something is hidden), with only a tiny corner dot the owner recognises (and can click to exit).
          Never on the phone itself (isRemoteClient) — it shows normally. Also exit from the phone. */}
      {!isRemoteClient && settings.incognitoRemote && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 99999,
            background: "#11131a",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Innocuous idle look — a faint wordmark like a resting screen, nothing that reveals a session. */}
          <div style={{ opacity: 0.05, fontSize: 40, fontWeight: 700, letterSpacing: 1, userSelect: "none" }}>
            Visual Reader
          </div>
          <button
            type="button"
            title="Incognito remote session active — click to exit"
            aria-label="Exit incognito"
            onClick={() => onSettingsChange({ ...settings, incognitoRemote: false })}
            style={{
              position: "fixed",
              bottom: 10,
              right: 12,
              width: 8,
              height: 8,
              padding: 0,
              borderRadius: "50%",
              border: "none",
              background: "rgba(120,160,255,0.45)",
              cursor: "pointer",
            }}
          />
        </div>
      )}
      <header style={styles.header}>
        <div style={styles.headerRow}>
        <strong>Visual Reader</strong>
        <div style={styles.headerControls}>
          {book && (
            <button
              style={styles.button}
              onClick={onExitBook}
              title="Close this book and return to the home screen (the book stays in your library)"
            >
              ← Exit book
            </button>
          )}
          {book && (
            // VIEW-AS drop-down: the app best-guesses how to show this, but the reader decides. Only
            // "Story" gets the illustration window; the rest show the text/data/code full-screen.
            <select
              style={styles.viewAsSelect}
              value={viewAs}
              onChange={(e) => setViewAs(e.target.value as BookViewCategory)}
              title="How to view this document — only “Story” shows the illustration window; the others show the text full-screen. The app guesses; you can change it."
            >
              <option value="story">📖 Story (illustrated)</option>
              <option value="document">📄 Document</option>
              <option value="text">🅣 Plain text</option>
              {(book.data || (book.dataSheets && book.dataSheets.length > 0)) && <option value="data">▦ Data / sheet</option>}
              {(book.contentMode === "code" || book.code) && <option value="code">⟨⟩ Code</option>}
            </select>
          )}
          <button
            style={toolbarOpen ? { ...styles.button, borderColor: "rgba(120,160,255,0.6)", color: "#acc4ff" } : styles.button}
            onClick={() => setToolbarOpen((v) => !v)}
            title="Show or hide the toolbar — collapse it to reclaim screen space, especially on a phone"
            aria-expanded={toolbarOpen}
          >
            {toolbarOpen ? "▾ Tools" : "▸ Tools"}
          </button>
          {toolbarOpen && (
          <>
          {book?.contentMode === "code" && (
            <button
              style={styles.button}
              onClick={() => setCodeEditMode((v) => !v)}
              title="Switch between the full-screen code editor (run / test / edit) and the illustrated reading view"
            >
              {codeEditMode ? "📖 Read view" : "✏️ Edit code"}
            </button>
          )}
          {bookHasHtml && (
            <button
              style={articleLayout ? { ...styles.button, borderColor: "rgba(90,209,155,0.6)", color: "#9be8c0" } : styles.button}
              onClick={() => setArticleLayout((v) => !v)}
              title="Toggle between the original article layout (headings, images, lists) and clean reader text"
            >
              {articleLayout ? "📄 Original layout" : "📄 Clean text"}
            </button>
          )}
          {library.length > 0 && (
            <button
              style={styles.button}
              onClick={() => setShowLibrary(true)}
              title="Your opened books — switch, remove, or carry a bible forward for a series"
            >
              Library ({library.length})
            </button>
          )}
          <label
            style={styles.upload}
            title="Open a book or document — EPUB, PDF, Word, Excel, CSV, RTF, JSON, text, Markdown, HTML — or drop an image to transform it"
          >
            Open book…
            <input
              type="file"
              accept={IMPORT_ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
            />
          </label>
          <button
            style={styles.button}
            onClick={() => void startStoryAsYouGo()}
            title="Write a brand-new illustrated story you co-write as you go — no file needed. Saved to your library to keep building."
          >
            ✍️ Story
          </button>
          <button
            style={styles.button}
            onClick={() => setShowPasteText(true)}
            title="Paste any text (an article, a chapter, a paper) and read/illustrate it like a book"
          >
            Paste text
          </button>
          <button
            style={styles.button}
            onClick={() => {
              setPolishInitial(undefined);
              setShowPolish(true);
            }}
            title="Summarize, condense, rewrite, or proofread a document — faithfully, with no illustration"
          >
            ✍ Polish doc
          </button>
          <button
            style={styles.button}
            onClick={() => void openSkills()}
            title="The assistant's skills — durable how-to playbooks it keeps across every chat (view, edit, or import a .md)"
          >
            🧠 Skills
          </button>
          <button
            style={styles.button}
            onClick={() => void openMemories()}
            title="What the assistant remembers about you — durable notes it keeps across every chat (view, add, edit, or delete)"
          >
            💭 Memory
          </button>
          <button
            style={styles.button}
            onClick={() => void openSoul("self")}
            title="The assistant's own identity — its persona, voice, and look. It speaks and behaves as this character in every chat (and plays itself in a story)."
          >
            🪞 Soul
          </button>
          <button
            style={styles.button}
            onClick={() => void openSoul("user")}
            title="Who you are — your own character's look & personality, so the assistant can portray you when you play yourself."
          >
            👤 You
          </button>
          <button
            style={styles.button}
            onClick={() => void openTasks()}
            title="Your planned multi-step tasks — research, steps, deadlines, prepped docs. Ask the assistant to “plan …” anything."
          >
            📋 Tasks{planningCount ? " · planning…" : ""}
          </button>
          <button
            style={styles.button}
            onClick={openCalendar}
            disabled={!googleConnected}
            title={
              googleConnected
                ? "Your calendar — Google events from all your calendars plus your planned task deadlines, in one month view"
                : "Connect Google to see your calendar here"
            }
          >
            📅 Calendar
          </button>
          <button
            style={styles.button}
            onClick={() => openStocks()}
            title="Markets — a TradingView chart for any ticker plus a quote, and the assistant's analysis/ideas"
          >
            📈 Markets
          </button>
          {isDesktop && (
            <button
              style={styles.button}
              onClick={() => openBrowser()}
              title="Browse — read any web page (text + links) in the app, then illustrate it or ask the assistant about it"
            >
              🌐 Browse
            </button>
          )}
          {isDesktop && (
            <button
              style={remoteLink?.running ? { ...styles.button, borderColor: "rgba(90,209,155,0.6)", color: "#9be8c0" } : styles.button}
              onClick={() => void openRemoteLink()}
              title="Link a phone on your Wi-Fi to drive the assistant (experimental — see REMOTE-LINK.md)"
            >
              {remoteLink?.running ? "🔗 Phone linked" : "🔗 Link phone"}
            </button>
          )}
          <button
            style={styles.button}
            onClick={() => {
              refreshScheduled();
              setShowScheduled(true);
            }}
            title="Scheduled tasks — recurring actions the assistant runs on a cadence while the app is open"
          >
            ⏰ Scheduled{scheduledTasks.some((t) => t.enabled) ? ` · ${scheduledTasks.filter((t) => t.enabled).length}` : ""}
          </button>
          <button style={styles.button} onClick={() => openBook(loadSampleBook())}>
            Load sample
          </button>
          <button
            style={styles.button}
            onClick={() => setShowTestImage(true)}
            title="Type anything and render one image with the current model + style — a quick way to test providers, styles, and LoRAs"
          >
            Test image
          </button>
          <button
            style={styles.button}
            onClick={() => {
              setPhotoInitial(undefined);
              setShowPhoto(true);
            }}
            title="Start from a photo and reimagine it with your image model — your local engine, or Gemini/OpenAI native image"
          >
            🖼 Photo
          </button>
          {book && book.kind !== "story" && (
            <button
              style={styles.button}
              onClick={() => setShowChat(true)}
              title="Chat about what you're reading — it knows the book (spoiler-safely), can search the web, and can generate images"
            >
              Chat
            </button>
          )}
          {book && viewAs === "story" && !generating && (
            <button
              style={styles.buttonPrimary}
              onClick={() => {
                startGeneration();
                noteAction("✓ Started — reading the book, then writing prompts, then painting. Anything from past sessions is reused.");
              }}
              title="Read the book, write its illustration prompts, and start painting — reusing anything generated in past sessions"
            >
              ▶ Start illustrating
            </button>
          )}
          {book && (generating || results.size > 0) && (
            <button
              style={gapCount > 0 ? styles.buttonPrimary : styles.button}
              onClick={() => {
                completeBook();
                noteAction(
                  gapCount > 0
                    ? `✓ Completing the book — filling ${gapCount} unfinished illustration${gapCount === 1 ? "" : "s"} (plus any missing analysis/prompts). Finished images are kept.`
                    : "✓ Completing the book — filling any missing analysis, prompts, or illustrations. Finished images are kept.",
                );
              }}
              title="Fill the gaps: chapters not yet analysed, missing prompts, and failed or unfinished illustrations — without redoing finished images."
            >
              ⤢ Complete book{gapCount > 0 ? ` (${gapCount})` : ""}
            </button>
          )}
          {book && (generating || paused.bible || paused.images) && (
            <>
              {(paused.bible || paused.images) && (
                <button
                  style={styles.buttonPrimary}
                  onClick={() => {
                    resume();
                    noteAction("✓ Resumed reading and painting.");
                  }}
                  title="Resume both reading (analysis + prompts) and painting"
                >
                  ▶ Resume all
                </button>
              )}
              <button
                style={paused.bible ? styles.buttonPrimary : styles.button}
                onClick={() => {
                  if (paused.bible) {
                    resumeBible();
                    noteAction("✓ Resumed reading (analysis + prompts).");
                  } else {
                    pauseBible();
                    noteAction("⏸ Reading paused — painting continues. Frees the text model/GPU.");
                  }
                }}
                title={
                  paused.bible
                    ? "Resume reading the book (analysis + prompt writing)"
                    : "Pause reading (analysis + prompt writing) — frees the GPU; painting continues"
                }
              >
                {paused.bible ? "▶ Reading" : "⏸ Reading"}
              </button>
              <button
                style={paused.images ? styles.buttonPrimary : styles.button}
                onClick={() => {
                  if (paused.images) {
                    resumeImages();
                    noteAction("✓ Resumed painting.");
                  } else {
                    pauseImages();
                    noteAction("⏸ Painting paused — reading continues. Frees the image GPU.");
                  }
                }}
                title={
                  paused.images
                    ? "Resume painting illustrations"
                    : "Pause painting — frees the GPU (cancels the in-flight image); reading continues"
                }
              >
                {paused.images ? "▶ Painting" : "⏸ Painting"}
              </button>
            </>
          )}
          {book && (generating || results.get(unitIndex)?.status === "ready") && (
            <details style={styles.menu} ref={redoMenuRef}>
              <summary style={styles.menuSummary} title="Redo part of the workflow — each option says exactly what it redoes and what it keeps">
                ↻ Redo…
              </summary>
              <div style={styles.menuList}>
                <button
                  style={styles.menuItem}
                  onClick={() => {
                    closeRedoMenu();
                    regenerateImage(unitIndex);
                    noteAction(`✓ Repainting this illustration (image ${unitIndex + 1}) — everything else untouched.`);
                  }}
                >
                  <b>This image</b>
                  <small>Repaint only the illustration you’re on. Keeps everything else.</small>
                </button>
                <button
                  style={styles.menuItem}
                  onClick={() => {
                    if (!confirm("Repaint EVERY illustration in the book?\n\nKeeps: story analysis + prompts.\nRedoes: all images (uses the current image model/style/quality).")) return;
                    closeRedoMenu();
                    regenerateAllImages();
                    noteAction("✓ Repainting all illustrations — story analysis and prompts kept.");
                  }}
                >
                  <b>All images</b>
                  <small>Repaint every illustration with the current image settings. Keeps analysis + prompts.</small>
                </button>
                <button
                  style={styles.menuItem}
                  onClick={() => {
                    closeRedoMenu();
                    rebuildPrompts();
                    noteAction("✓ Rewriting illustration prompts — analysis kept; images stay until repainted.");
                  }}
                >
                  <b>Prompts</b>
                  <small>Rewrite the illustration prompts (e.g. after editing characters). Keeps analysis; images stay until repainted.</small>
                </button>
                <button
                  style={styles.menuItem}
                  onClick={() => {
                    if (!confirm("Re-read the WHOLE book?\n\nKeeps: existing images (until you repaint).\nRedoes: story analysis (characters, places, world style) AND all prompts — uses the current text model.")) return;
                    closeRedoMenu();
                    regenerateStoryboard();
                    noteAction("✓ Re-reading the book — analysis and prompts rebuilt; images kept until repainted.");
                  }}
                >
                  <b>Story analysis (re-read book)</b>
                  <small>Re-run the whole text analysis + prompts with the current text model. Keeps images.</small>
                </button>
                <button
                  style={styles.menuItem}
                  onClick={() => {
                    closeRedoMenu();
                    onPaintForward();
                  }}
                >
                  <b>Paint forward…</b>
                  <small>
                    Repaint from a page you choose to the end with the current settings — everything
                    before it is kept. (For new settings without redoing finished pages.)
                  </small>
                </button>
              </div>
            </details>
          )}
          {book && (
            <button
              style={styles.button}
              onClick={onToggleContentMode}
              title={
                isTechnical
                  ? "This book is analysed as TECHNICAL (concepts, structures, data, real figures). Click to switch to Story mode — then run ↻ Redo → Story analysis."
                  : "This book is analysed as a STORY (characters, scenes). Click to switch to Technical mode — then run ↻ Redo → Story analysis."
              }
            >
              {isTechnical ? "🔬 Technical" : "📖 Story"}
            </button>
          )}
          {book && !isTechnical && (
            <button
              style={styles.button}
              onClick={() => setShowCharacters(true)}
              title="View and correct each character's appearance in the Visual Bible"
            >
              Characters{bible ? ` (${bible.characters.length})` : ""}
            </button>
          )}
          {book && isTechnical && (
            <button
              style={styles.button}
              onClick={() => setShowData(true)}
              title="Every dataset extracted from this book — real values, charted by the app"
            >
              Data{bible ? ` (${bible.datasets?.length ?? 0})` : ""}
            </button>
          )}
          {book && (
            <details style={styles.menu} ref={exportMenuRef}>
              <summary
                style={styles.menuSummary}
                title="Keep a copy of this illustrated book (text + the images rendered so far)"
              >
                ⤓ Export…
              </summary>
              <div style={styles.menuList}>
                <button
                  style={styles.menuItem}
                  disabled={illustratedCount === 0}
                  onClick={() => void onExport("html")}
                >
                  <b>Illustrated HTML{illustratedCount ? ` (${illustratedCount})` : ""}</b>
                  <small>One self-contained web page — text with the images inline. Opens anywhere.</small>
                </button>
                <button
                  style={styles.menuItem}
                  disabled={illustratedCount === 0}
                  onClick={() => void onExport("epub")}
                >
                  <b>EPUB ebook{illustratedCount ? ` (${illustratedCount})` : ""}</b>
                  <small>A real ebook with the illustrations embedded — for e-readers / Apple Books.</small>
                </button>
                <button
                  style={styles.menuItem}
                  disabled={results.get(unitIndex)?.status !== "ready" || !results.get(unitIndex)?.image}
                  onClick={() => void onSaveCurrentImage()}
                >
                  <b>Save this image</b>
                  <small>Save the illustration you’re looking at as a picture file.</small>
                </button>
                <button style={styles.menuItem} onClick={() => { if (exportMenuRef.current) exportMenuRef.current.open = false; exportBible(); }}>
                  <b>Visual Bible (JSON)</b>
                  <small>The analysis + AI rules, for editing or reuse on another book.</small>
                </button>
              </div>
            </details>
          )}
          {book && (
            <button
              style={styles.button}
              onClick={() => setShowImport(true)}
              title="Import a Visual Bible JSON (from an export or an external AI) onto this book"
            >
              ⤒ Import bible
            </button>
          )}
          <SettingsPanel
            value={settings}
            onChange={onSettingsChange}
            isDesktop={isDesktop}
            remote={isRemoteClient}
            {...(isDesktop
              ? { onSoftwareUpdate }
              : isRemoteClient
                ? { onSoftwareUpdate: onSoftwareUpdateRemote }
                : {})}
            {...(isDesktop ? { onRestartApp } : isRemoteClient ? { onRestartApp: onRestartAppRemote } : {})}
            {...(!isRemoteClient ? { onExportData, onImportData } : {})}
            installedModels={installedModels}
            installedTextEncoders={installedTextEncoders}
            installedVaes={installedVaes}
            installedDiffusionModels={installedDiffusionModels}
            installedUpscalers={installedUpscalers}
            installedLtxTextEncoders={installedLtxTextEncoders}
            onDownloadModel={onDownloadModel}
            onDownloadModelUrl={onDownloadModelUrl}
            onDownloadVideoModel={onDownloadVideoModel}
            downloadProgress={modelProgress}
            downloadStage={downloadStage}
            engineStatus={engineStatus}
            installedLoras={installedLoras}
            loraFamilies={loraFamilyMap}
            onDownloadStyleLora={onDownloadStyleLora}
            onConnectLocalServer={onConnectLocalServer}
            connectingLocal={connectingLocal}
            textModels={textModels}
            {...(textModelContext ? { textModelContext } : {})}
            onConnectLocalTextServer={onConnectLocalTextServer}
            connectingLocalText={connectingLocalText}
            onPullTextModel={onPullTextModel}
            pullProgress={pullProgress}
            onTestSubAgentEndpoint={onTestSubAgentEndpoint}
            googleConnected={googleConnected}
            {...(googleEmail ? { googleEmail } : {})}
            onConnectGoogle={onConnectGoogle}
            onDisconnectGoogle={onDisconnectGoogle}
          />
          </>
          )}
        </div>
        </div>
        {book && viewAs === "story" && (
          <WorkflowBar
            stage={stage}
            paused={paused}
            workflow={workflow}
            readingChapter={readingChapter}
            painting={painting}
            paintingWhere={paintingWhere}
            settledCount={settledCount}
            totalUnits={totalUnits}
            actionNote={actionNote}
            detail={localError || status || bibleStatus}
          />
        )}
      </header>

      {/* Everything between the (fixed-height) header and the bottom chat dock scrolls here. */}
      <div style={styles.contentScroll}>

      {!settings.configured && !isRemoteClient && (
        <FirstRunWizard current={settings} onComplete={setSettings} isDesktop={isDesktop} />
      )}

      {/* On a linked phone the engine lives on the desktop — show the link, not a "set up a model"
          nag or local-provider badges (those reflect a model the phone will never run). */}
      {isRemoteClient ? (
        // On a linked phone, show the link badge AND the desktop's mirrored model tags + GPU VRAM,
        // so the phone can see which image/LLM models are active and what the GPU is doing.
        <ProviderBadges
          providers={remoteProviders}
          engineStatus={engineStatus}
          vram={remoteVram}
          hideImage={settings.imageProvider === "local"}
        >
          <span style={{ ...styles.badge, ...styles.badgeOk }} title="This phone is mirroring your desktop over the LAN; the engine runs there.">
            🔗 Linked to {remoteHost ?? "your desktop"} — engine runs on the desktop
          </span>
          {settings.imageProvider === "local" && (
            // The local image engine can't be reached FROM the phone (it's on the desktop) — a compact
            // red pill instead of the phone fruitlessly probing its own 127.0.0.1 and surfacing a
            // misleading "couldn't reach ComfyUI / CORS" error.
            <span
              style={{ ...styles.badge, ...styles.badgeErr }}
              title={`The local image engine (${localEngineName}) runs on your desktop — this phone can't reach it directly, so renders happen on the desktop and stream here.`}
            >
              ⚠ {localEngineName} · on desktop
            </span>
          )}
        </ProviderBadges>
      ) : (
        <ProviderBadges providers={providers} engineStatus={engineStatus} vram={effectiveVram} />
      )}

      {/* Status center: what the app is doing right now + the queue behind it (task planning keeps
          running after you leave the Tasks window, so this is how you keep an eye on it). */}
      <ActivityCenter activities={activities} />
      {/* App-wide download indicator: every in-flight model/video/LoRA download + Ollama text-model pull,
          folded into one floating panel so a big download stays visible after you leave Settings. */}
      <DownloadStatus
        modelProgress={modelProgress}
        downloadStage={downloadStage}
        pullProgress={pullProgress}
        labelFor={downloadLabelFor}
        hideKey={isVideoChildFile}
      />
      {actionHistory.length > 0 && (
        <button
          style={{ ...styles.badge, ...styles.badgeOk, cursor: "pointer" }}
          title="What the assistant did (scans, planning, scheduled tasks) since you last looked"
          onClick={() => {
            setPanelNewSince(actionsViewedAt); // highlight entries newer than the PREVIOUS view
            setShowActionHistory(true);
            void markActionsViewed(libraryStore).catch(() => {});
            setActionsViewedAt(Date.now()); // badge now reads 0 new
          }}
        >
          🗒️ Activity{unseenCount(actionHistory, actionsViewedAt) > 0 ? ` (${unseenCount(actionHistory, actionsViewedAt)} new)` : ""}
        </button>
      )}

      {!book && (status || localError) && (
        <div style={styles.status}>{localError || status}</div>
      )}

      {!book && !status && !localError && (
        <div style={styles.empty}>
          Ask the assistant below anything — or have it find &amp; illustrate a book. You can also
          open your own file (EPUB, PDF, Word, and more), transform a photo, or load the sample.
          <span style={{ opacity: 0.55 }}> No API keys? It still runs, with placeholder art, so you can see the whole flow.</span>
        </div>
      )}

      {/* Home screen (no book open): the assistant chat is the hero, centered. With a book open the
          chat instead docks at the bottom of the page (below the reader) — see the dock after this
          scroll region. */}
      {!book && (
        <section style={styles.buddySection}>{renderBuddyChat(false)}</section>
      )}

      {book && viewAs === "code" && codeEditMode ? (
        // Code books open as a full-screen, editable code workspace: edit the source in place, then
        // ▶ Run it (writes the draft to the workspace and runs it on the desktop / relayed from a
        // phone). The illustrated reading view is still one click away ("📖 Read view" in the header).
        <section style={styles.codeWorkspace}>
          <div style={styles.codeToolbar}>
            <span style={styles.codeToolbarTitle}>
              💻 {book.title || "Code"}
              {book.language ? ` · ${book.language}` : ""}
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {markupPreviewKind(book, codeDraft) && (
                <button
                  type="button"
                  style={
                    codePreviewOpen
                      ? { ...styles.button, borderColor: "rgba(122,162,255,0.6)", color: "#bcd0ff" }
                      : styles.button
                  }
                  onClick={() => setCodePreviewOpen((v) => !v)}
                  title="Render this HTML/SVG page in-app — toggle back to edit the source"
                >
                  {codePreviewOpen ? "✏️ Edit" : "👁 Preview"}
                </button>
              )}
              {bible && (
                <button
                  type="button"
                  style={
                    codeAnalysisOpen
                      ? { ...styles.button, borderColor: "rgba(122,162,255,0.6)", color: "#bcd0ff" }
                      : styles.button
                  }
                  onClick={() => setCodeAnalysisOpen((v) => !v)}
                  title="Show the code analysis — glossary of symbols, module map, and the current illustration — beside the editor"
                >
                  📊 Analysis
                </button>
              )}
              {(isDesktop || isRemoteClient) && settings.allowCommands && (
                <button
                  type="button"
                  style={codeRunning ? { ...styles.button, opacity: 0.6 } : styles.button}
                  onClick={() => void runCodeBook()}
                  disabled={codeRunning}
                  title="Write the current code into the workspace and run it (Python / JavaScript / shell)"
                >
                  {codeRunning ? "Running…" : "▶ Run"}
                </button>
              )}
            </div>
          </div>
          <div style={styles.codeBody}>
            <div style={styles.codeMain}>
              {codePreviewOpen && markupPreviewKind(book, codeDraft) ? (
                // Sandboxed in-app render: scripts run so a coded page actually works, but it has no
                // same-origin access (can't touch the app, cookies, or storage). Renders on the phone too.
                <iframe
                  title={`Preview of ${book.title || "page"}`}
                  srcDoc={codeDraft}
                  sandbox="allow-scripts allow-forms allow-popups allow-modals"
                  style={styles.codePreview}
                />
              ) : (
                <textarea
                  value={codeDraft}
                  onChange={(e) => onCodeDraftChange(e.target.value)}
                  spellCheck={false}
                  wrap="off"
                  style={styles.codeEditor}
                  aria-label={`Edit ${book.title || "code"}`}
                />
              )}
              {codeRunOutput && (
                <pre style={styles.codeOutput}>
                  {codeRunOutput.error
                    ? `⚠ ${codeRunOutput.error}`
                    : `[exit ${codeRunOutput.code ?? "?"}]${codeRunOutput.cwd ? `  (in ${codeRunOutput.cwd})` : ""}` +
                      (codeRunOutput.stdout ? `\n${codeRunOutput.stdout}` : "") +
                      (codeRunOutput.stderr ? `\n⚠ ${codeRunOutput.stderr}` : "")}
                </pre>
              )}
            </div>
            {codeAnalysisOpen && bible && (
              <aside style={styles.codeAnalysis}>
                <div style={styles.codeAnalysisHead}>📊 Code analysis</div>
                {(generating || results.get(unitIndex)) && (
                  <div style={{ marginBottom: 12 }}>
                    <ImagePanel
                      result={results.get(unitIndex)}
                      bloom={bloom}
                      pageKey={unitIndex}
                      awaitingStart={!generating}
                    />
                  </div>
                )}
                {bible.glossary.length > 0 && (
                  <div style={styles.codeAnalysisGroup}>
                    <div style={styles.codeAnalysisLabel}>Symbols ({bible.glossary.length})</div>
                    {bible.glossary.slice(0, 80).map((g) => (
                      <div key={g.term} style={styles.codeAnalysisItem}>
                        <strong>{g.term}</strong>
                        {g.definition ? ` — ${g.definition}` : ""}
                      </div>
                    ))}
                  </div>
                )}
                {bible.environments.length > 0 && (
                  <div style={styles.codeAnalysisGroup}>
                    <div style={styles.codeAnalysisLabel}>Modules ({bible.environments.length})</div>
                    {bible.environments.slice(0, 60).map((e) => (
                      <div key={e.id} style={styles.codeAnalysisItem}>
                        <strong>{e.name}</strong>
                        {e.description?.[0] ? ` — ${e.description[0]}` : ""}
                      </div>
                    ))}
                  </div>
                )}
                <div style={styles.codeAnalysisHint}>
                  Switch to “📖 Read view” (header) for the full inline diagrams &amp; illustrations.
                </div>
              </aside>
            )}
          </div>
        </section>
      ) : book && (viewAs === "document" || viewAs === "text") ? (
        // DOCUMENT / PLAIN-TEXT view: the text full-screen in its actual formatting — NO illustration
        // window (that's reserved for the Story view). The buddy chat still docks beneath it.
        <main style={styles.readerDoc}>
          <DocumentReader book={book} plain={viewAs === "text"} articleHtml={bookHasHtml && articleLayout} />
        </main>
      ) : book ? (
        <main style={book.data || (book.dataSheets && book.dataSheets.length) ? styles.readerData : narrow ? styles.readerNarrow : wideImageColumn ? styles.readerWide : styles.reader}>
          <ReaderColumn
            book={book}
            pageToUnit={units?.pageToUnit}
            unitIndex={unitIndex}
            pagesPerImage={pagesPerImage}
            registerParagraph={registerParagraph}
            dataEdit={dataEdit}
            dataOpen={dataPreviewOpen}
            onDataToggle={setDataPreviewOpen}
            onAddAnalysisSheet={addAnalysisSheet}
            saveNamed={saveNamed}
            {...(technicalSupport ? { technical: technicalSupport } : {})}
            layoutHtml={articleLayout}
          />

          {viewAs === "story" && (
          <aside style={styles.aside}>
            <div style={styles.panel}>
              {/* The illustration window — Story view only. (A Document/Text/Data/Code view renders
                  full-screen without it; see the document branch above.) */}
              {!isTechnical &&
                (panelsPerView > 1 && units ? (
                  <PanelGrid
                    panels={panelGroup(
                      units.book.pages.map((p) => p.chapterId),
                      unitIndex,
                      panelsPerView,
                    ).map((u) => ({ unitIndex: u, result: results.get(u) }))}
                    currentUnit={unitIndex}
                    bloom={bloom}
                    direction={settings.imageStyle === "manga" ? "rtl" : "ltr"}
                    pageKey={unitIndex}
                  />
                ) : (
                  <ImagePanel
                    result={results.get(unitIndex)}
                    bloom={bloom}
                    pageKey={unitIndex}
                    awaitingStart={!generating}
                  />
                ))}
              {!isTechnical && imageCaption && (
                <div style={styles.imageDescription}>
                  {displayCaption(imageCaption)}
                  {displayCaption(imageCaption) !== imageCaption && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: "pointer", fontSize: 11, opacity: 0.6 }}>
                        Full prompt (as sent to the model)
                      </summary>
                      <div style={{ fontSize: 11, opacity: 0.7 }}>{imageCaption}</div>
                    </details>
                  )}
                </div>
              )}
              {/* Story "lock the look": pin THIS beat's image as a character's IP-Adapter
                  reference, so every later beat matches the face you actually liked — the
                  fix for "consistent but arbitrary". A deliberate one-click capture (the app
                  doesn't auto-capture); future renders pick it up, so regenerate a past beat
                  to re-illustrate it with the locked look. */}
              {book.kind === "story" && !isTechnical && bible && bible.characters.length > 0 && results.get(unitIndex)?.image && (
                <div style={styles.lockLook}>
                  <span style={styles.lockLookLabel}>📌 Lock this look as:</span>
                  <div style={styles.lockLookRow}>
                    {bible.characters.map((c) => (
                      <button
                        key={c.id}
                        style={styles.lockLookButton}
                        title={`Use this image as ${c.name}'s reference — future beats will match it (regenerate a beat to re-illustrate with it)`}
                        onClick={() => {
                          void (async () => {
                            const img = results.get(unitIndex)?.image;
                            if (!img) return;
                            // The display image is raw bytes OR a host-converted Blob; get bytes
                            // either way, COPYING so the capture never disturbs the shown image.
                            const bytes = "bytes" in img ? img.bytes.slice(0) : await img.blob.arrayBuffer();
                            addCharacterReference(c.id, { bytes, mimeType: img.mimeType });
                            noteAction(`✓ Locked this image as ${c.name}'s look — future beats will match it. Regenerate a beat to re-illustrate it with the new reference.`);
                          })();
                        }}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div style={styles.caption}>
                {pagesPerImage === "chapter"
                  ? `Chapter ${unitIndex + 1} of ${totalUnits}`
                  : `Page ${activePageIndex + 1} of ${book.pages.length}${
                      singlePage ? "" : ` · image ${unitIndex + 1}/${totalUnits}`
                    }`}
                {bible
                  ? book.contentMode === "code"
                    ? ` · ${bible.glossary.length} symbols · ${bible.environments.length} modules tracked`
                    : book.contentMode === "technical"
                      ? ` · ${bible.glossary.length} concepts · ${bible.environments.length} structures tracked`
                      : ` · ${bible.characters.length} characters tracked`
                  : ""}
              </div>
            </div>
          </aside>
          )}
        </main>
      ) : null}

      </div>{/* end contentScroll */}

      {/* With a book open the assistant chat docks at the BOTTOM of the page, full width, beneath the
          reader. Its input bar is always visible; the message history expands/collapses (caret in the
          panel header). A "story as you go" book also gets its workflow/cadence controls here. */}
      {book && (
        <section style={chatHistoryOpen ? { ...styles.chatDock, height: "min(62vh, 560px)" } : styles.chatDock}>
          {storyControlsRow}
          {renderBuddyChat(true, !chatHistoryOpen, () => setChatHistoryOpen((v) => !v))}
        </section>
      )}

      {showCharacters && (
        <CharacterBible
          bible={bible}
          onSave={(id, patch) => updateCharacter(id, patch)}
          onAddReference={addCharacterReference}
          onRemoveReference={removeCharacterReference}
          getReferenceImage={getCharacterReference}
          onClose={() => setShowCharacters(false)}
        />
      )}

      {showData && book && (
        <DataModal
          datasets={bible?.datasets ?? []}
          chapterTitles={book.chapters.map((c) => c.title || `Chapter ${c.index + 1}`)}
          onClose={() => setShowData(false)}
        />
      )}

      {showImport && book && (
        <ImportBibleModal
          bookId={book.id}
          onImport={importBible}
          result={importResult}
          onClose={() => {
            clearImportResult();
            setShowImport(false);
          }}
        />
      )}

      {showTestImage && (
        <TestImageModal onRender={onTestRender} onAddToChat={onAddImageToChat} onClose={() => setShowTestImage(false)} />
      )}

      {showPhoto && (
        <PhotoTransformModal
          {...(photoInitial ? { initial: photoInitial } : {})}
          onRender={onTestRender}
          onAddToChat={onAddImageToChat}
          onExtractText={(img) => void extractTextFromImage(img)}
          onClose={() => {
            setShowPhoto(false);
            setPhotoInitial(undefined);
          }}
        />
      )}

      {showChat && book && book.kind !== "story" && (
        <ChatPanel
          title={book.title}
          messages={chatPanelMessages}
          {...(chatStreaming ? { streamingText: chatStreaming } : {})}
          {...(chatThinking ? { thinking: chatThinking } : {})}
          busy={chatBusy}
          {...(chatActivity ? { activity: chatActivity } : {})}
          {...(chatPendingTool ? { pendingTool: chatPendingTool } : {})}
          allowSpoilers={isTechnical || allowSpoilers}
          technical={isTechnical}
          onSend={onChatSendText}
          onApprovePendingTool={onApprovePendingTool}
          onDismissPendingTool={onDismissPendingTool}
          onToggleSpoilers={setAllowSpoilers}
          onCancel={chatCancel}
          onClose={onCloseChat}
          onClearHistory={onClearChat}
          onDeleteMessage={onDeleteChatMessage}
          onCompact={onCompactChatClick}
          onSaveFile={onSaveChatFile}
          fileActions={buddyFileActions}
          desktop={isDesktop}
          {...((isDesktop || isRemoteClient) && settings.allowCommands ? { onRunCode } : {})}
          onSaveProject={onSaveProject}
          onBuildDocument={onBuildDocument}
          onDownloadData={onDownloadData}
          {...(chatUsage ? { contextUsage: chatUsage } : {})}
        />
      )}

      {showPasteText && (
        <PasteTextModal
          initial={pasteInitial}
          onCreate={(title, text, mode) => {
            try {
              // Library provenance: did this text come from a file or a raw paste?
              const provenance = pasteInitial ? "Imported file" : "Pasted text";
              const created =
                mode === "code" ? bookFromCode(title, text, undefined, provenance) : bookFromText(title, text, mode, provenance);
              // Carry the structured view onto the book: a spreadsheet/tabular grid (chat
              // analyze_data + the table card) or a nested-JSON tree (the tree card).
              openBook({
                ...created,
                ...(pasteInitial?.data ? { data: pasteInitial.data } : {}),
                ...(pasteInitial?.dataSheets ? { dataSheets: pasteInitial.dataSheets } : {}),
                ...(pasteInitial?.tree !== undefined ? { tree: pasteInitial.tree } : {}),
              });
              setShowPasteText(false);
              setPasteInitial(undefined);
            } catch (err) {
              setLocalError(err instanceof Error ? err.message : String(err));
            }
          }}
          onPolish={(title, text) => {
            setShowPasteText(false);
            setPasteInitial(undefined);
            setPolishInitial({ title, text });
            setShowPolish(true);
          }}
          onClose={() => {
            setShowPasteText(false);
            setPasteInitial(undefined);
          }}
        />
      )}

      {showPolish && (
        <DocumentPolishPanel
          {...(polishInitial ? { initial: polishInitial } : {})}
          presets={POLISH_PRESETS}
          onUnderstand={(a) =>
            polishText({
              stage: "understand",
              freeText: a.freeText,
              source: a.source,
              ...(a.mode ? { mode: a.mode } : {}),
            }).result
          }
          onProduce={(a) => {
            const { requestId, result } = polishText({
              stage: "produce",
              freeText: a.freeText,
              source: a.source,
              confirmedPlan: a.confirmedPlan,
              onToken: a.onToken,
              ...(a.mode ? { mode: a.mode } : {}),
            });
            return { cancel: () => polishCancel(requestId), result };
          }}
          onSaveFile={onSaveChatFile}
          {...((isDesktop || isRemoteClient) && settings.allowCommands ? { onRunCode } : {})}
          onClose={() => {
            setShowPolish(false);
            setPolishInitial(undefined);
          }}
        />
      )}

      {showLibrary && (
        <LibraryPanel
          books={library}
          {...(book ? { currentId: book.id } : {})}
          onOpen={(id) => {
            void onPickBook(id);
            setShowLibrary(false);
          }}
          onRemove={onRemoveBook}
          onCarryOver={(fromId) => {
            carryOverBible(fromId);
            setShowLibrary(false);
          }}
          onClose={() => setShowLibrary(false)}
        />
      )}

      {showSkills && (
        <SkillsPanel
          skills={skills}
          limits={{ name: MAX_SKILL_NAME_CHARS, description: MAX_SKILL_DESC_CHARS, body: MAX_SKILL_BODY_CHARS }}
          onSave={async (name, description, body) => {
            if (isRemoteClient) {
              // The desktop owns the store; relay the save + show it optimistically — the desktop
              // saves it and re-mirrors vrsync:skills.
              setSkills((prev) => {
                const at = prev.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
                return at >= 0
                  ? prev.map((s, i) => (i === at ? { ...s, description, body, at: Date.now() } : s))
                  : [...prev, { name, description, body, at: Date.now() }];
              });
              sendAppSync({ type: "vrcmd:skillSave", name, description, body });
              return;
            }
            await saveSkill(libraryStore, { name, description, body });
            refreshSkills();
          }}
          onDelete={async (name) => {
            if (isRemoteClient) {
              setSkills((prev) => prev.filter((s) => s.name.toLowerCase() !== name.toLowerCase()));
              sendAppSync({ type: "vrcmd:skillDelete", name });
              return;
            }
            await forgetSkill(libraryStore, name);
            refreshSkills();
          }}
          onClose={() => setShowSkills(false)}
        />
      )}

      {showMemories && (
        <MemoriesPanel
          notes={memories}
          limits={{ note: MAX_NOTE_CHARS, max: MAX_MEMORY_NOTES }}
          onSave={async (notes) => {
            if (isRemoteClient) {
              // The desktop owns the store; relay the edited list and show it optimistically — the
              // desktop saves it and re-mirrors vrsync:memories.
              setMemories(notes);
              sendAppSync({ type: "vrcmd:memory", notes });
              return;
            }
            const saved = await saveMemory(libraryStore, notes);
            setMemories(saved);
          }}
          onClose={() => setShowMemories(false)}
        />
      )}

      {showSoul && (
        <SoulPanel
          variant={showSoul}
          name={showSoul === "self" ? selfSoulName : userSoulName}
          notes={showSoul === "self" ? selfSoulNotes : userSoulNotes}
          images={showSoul === "self" ? selfSoulImages : userSoulImages}
          limits={{ note: MAX_SOUL_NOTE_CHARS, max: MAX_SOUL_NOTES, name: MAX_SOUL_NAME_CHARS }}
          onSaveNotes={async (notes) => {
            const kind = showSoul;
            const saved = await saveSoul(libraryStore, kind, notes);
            setSoulNotes(kind, saved);
          }}
          onSaveName={async (name) => {
            const kind = showSoul;
            await saveSoulName(libraryStore, kind, name);
            setSoulName(kind, name.trim().slice(0, MAX_SOUL_NAME_CHARS));
          }}
          onSaveImages={async (imgs) => {
            const kind = showSoul;
            await saveSoulImages(libraryStore, kind, imgs);
            setSoulImagesState(kind, imgs);
          }}
          onClose={() => setShowSoul(undefined)}
        />
      )}

      {showStorySetup && (
        <StorySetupModal
          self={storySetupSeed.self}
          user={storySetupSeed.user}
          onStart={startStoryFromSetup}
          onClose={() => setShowStorySetup(false)}
        />
      )}

      {showTasks && (
        // On a linked phone, every action is RELAYED to the desktop (which owns the planner data and
        // re-mirrors the result); on the desktop they run locally as before.
        <TasksPanel
          plans={taskPlans}
          planning={planningCount}
          creatingTask={creatingTask}
          onCreateTask={
            isRemoteClient
              ? (title, dueIso, recurrence, planNow) =>
                  sendPlanner({ action: "createTask", title, planNow: planNow ?? true, ...(dueIso ? { dueIso } : {}), ...(recurrence ? { recurrence } : {}) })
              : (title, dueIso, recurrence, planNow) => void onCreateTask(title, dueIso, recurrence, planNow)
          }
          {...(googleConnected
            ? { onScanNow: isRemoteClient ? () => sendPlanner({ action: "scanNow" }) : () => void scanNow(), scanning: scanningNow }
            : {})}
          onPlanPending={isRemoteClient ? () => sendPlanner({ action: "planPending" }) : () => void planAllPending()}
          planningPending={planningCount > 0}
          {...(scanMessage ? { scanMessage } : {})}
          {...(planMessage ? { planMessage } : {})}
          onPlanTask={isRemoteClient ? (id) => sendPlanner({ action: "planTask", id }) : (id) => void planOneTask(id)}
          onOpenTask={isRemoteClient ? (id) => sendPlanner({ action: "openTask", id }) : (id) => void openTaskInChat(id)}
          onAdvanceStep={isRemoteClient ? (planId, stepId) => sendPlanner({ action: "advanceStep", planId, stepId }) : onAdvanceTaskStep}
          onToggleStepDone={
            isRemoteClient ? (planId, stepId, done) => sendPlanner({ action: "toggleStep", planId, stepId, done }) : onToggleStepDone
          }
          onCompleteTask={
            isRemoteClient ? (planId, complete) => sendPlanner({ action: "completeTask", planId, complete }) : onCompleteTask
          }
          onIgnoreTask={isRemoteClient ? (id) => sendPlanner({ action: "ignoreTask", id }) : ignoreTask}
          onAddTaskDetails={
            isRemoteClient ? (planId, text) => sendPlanner({ action: "addDetails", planId, text }) : (planId, text) => void onAddTaskDetails(planId, text)
          }
          onDelete={isRemoteClient ? (id) => sendPlanner({ action: "deleteTask", id }) : (id) => void removeTask(id)}
          onRestore={isRemoteClient ? (id) => sendPlanner({ action: "restoreTask", id }) : (id) => void restoreTask(id)}
          onDeleteForever={isRemoteClient ? (id) => sendPlanner({ action: "deleteForever", id }) : (id) => void deleteTaskForever(id)}
          onClose={() => setShowTasks(false)}
        />
      )}

      {showCalendar && (
        <CalendarPanel
          events={calendarEvents}
          deadlines={calendarDeadlines}
          month={calendarMonth}
          loading={calendarLoading}
          {...(calendarError ? { error: calendarError } : {})}
          onPrev={isRemoteClient ? () => sendPlanner({ action: "calShift", delta: -1 }) : () => shiftCalendarMonth(-1)}
          onNext={isRemoteClient ? () => sendPlanner({ action: "calShift", delta: 1 }) : () => shiftCalendarMonth(1)}
          onToday={isRemoteClient ? () => sendPlanner({ action: "calShift", delta: "today" }) : () => shiftCalendarMonth("today")}
          onOpenTask={(id) => {
            setShowCalendar(false);
            if (isRemoteClient) sendPlanner({ action: "openTask", id });
            else void openTaskInChat(id);
          }}
          {...(googleConnected
            ? {
                onCreateEvent: isRemoteClient
                  ? (ev: { summary: string; start: string; end: string; description?: string; location?: string }) => {
                      sendPlanner({ action: "createEvent", ev });
                      return Promise.resolve({ ok: true });
                    }
                  : onCreateCalendarEvent,
              }
            : {})}
          onClose={() => setShowCalendar(false)}
        />
      )}

      {showActionHistory && (
        <ActionHistoryPanel
          entries={actionHistory}
          newSince={panelNewSince}
          onClear={() => {
            void clearActionHistory(libraryStore).then(() => setActionHistory([])).catch(() => {});
          }}
          onClose={() => setShowActionHistory(false)}
        />
      )}

      {renameModal && (
        <RenameExportModal
          defaultName={renameModal.defaultName}
          {...(renameModal.what ? { what: renameModal.what } : {})}
          onConfirm={(name) => {
            renameModal.resolve(name);
            setRenameModal(undefined);
          }}
          onCancel={() => {
            renameModal.resolve(null);
            setRenameModal(undefined);
          }}
        />
      )}

      {showStocks && (
        <StockChartPanel
          symbol={stockSymbol}
          onSymbol={(s) => openStocks(s)}
          quote={stockQuoteData}
          loading={stockLoading}
          alerts={priceAlerts}
          describeAlert={describeAlert}
          onAddAlert={(s, type, value) => void addAlert(s, type, value)}
          onRemoveAlert={(id) => void removeAlert(id)}
          schwabConnected={schwabConnected}
          onConnectSchwab={() => {
            void connectSchwab().then((r) => {
              if (!r.ok && r.error) setLocalError(r.error);
            });
          }}
          {...(tvBridgeEnabled ? { tvBridge: { status: tvBridgeStatus, onTest: () => void testTvBridge() } } : {})}
          onAnalyze={(s) => {
            setShowStocks(false);
            onBuddySendText(
              `Analyse ${s} stock: summarise its recent performance and key levels, the bull and bear case, and any trade ideas — search the web for current data and be clear this isn't financial advice.`,
            );
          }}
          onClose={() => setShowStocks(false)}
        />
      )}

      {showBrowser && (
        <BrowserPanel
          url={browserUrl}
          page={browserPage}
          loading={browserLoading}
          error={browserError}
          canBack={browserHistory.current.length > 0}
          onUrl={(u) => void loadPage(u)}
          onBack={browserBack}
          onClickLink={(u) => void loadPage(u)}
          {...(isDesktop
            ? {
                onOpenLive: (u: string) => {
                  void openBrowserWindow(u).then((r) => {
                    if (!r.ok && r.error) setLocalError(r.error);
                  });
                },
              }
            : {})}
          onReadIllustrate={(u) => {
            setShowBrowser(false);
            onBuddySendText(`Open and illustrate this web page: ${u}`);
          }}
          onAskBuddy={(q) => {
            setShowBrowser(false);
            onBuddySendText(
              `About this web page (${browserUrl}): ${q.trim() || "summarise it and tell me the key points."}`,
            );
          }}
          onClose={() => setShowBrowser(false)}
        />
      )}

      {pendingSkill && (
        <div
          style={{
            position: "fixed",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(560px, 94vw)",
            background: "#16181d",
            color: "#e6e6e6",
            border: "1px solid rgba(90,209,155,0.4)",
            borderRadius: 10,
            padding: "10px 14px",
            boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
            zIndex: 120,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>📌 Learn a skill: “{pendingSkill.name}”?</div>
            <div style={{ fontSize: 12, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {pendingSkill.description || "a reusable playbook for tasks like this"}
            </div>
          </div>
          <button style={{ ...styles.button, borderColor: "rgba(90,209,155,0.6)", color: "#9be8c0" }} onClick={() => void keepPendingSkill()}>
            Keep
          </button>
          <button style={styles.button} onClick={() => setPendingSkill(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showRemoteLink && remoteLink && (
        <div
          style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(8,9,13,0.7)", backdropFilter: "blur(6px)", zIndex: 100, padding: 20 }}
          onClick={() => setShowRemoteLink(false)}
        >
          <div
            style={{ width: "min(460px, 100%)", background: "#16181d", color: "#e6e6e6", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: 18, fontFamily: "system-ui, sans-serif" }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong style={{ fontSize: 15 }}>🔗 Link a phone</strong>
            {remoteLink.running ? (
              <>
                <p style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
                  On a phone on the <b>same Wi-Fi</b>, open this address (it carries a one-time pairing code):
                </p>
                <code style={{ display: "block", background: "#0d1017", padding: "8px 10px", borderRadius: 6, fontSize: 12, wordBreak: "break-all" }}>
                  {remoteLink.url}
                </code>
                <p style={{ fontSize: 11, opacity: 0.55, marginTop: 8 }}>
                  LAN-only; nothing leaves your network. This link stays the SAME across app restarts (the phone keeps
                  working) until you press <b>Change link</b>, which rotates the pairing code. Stop ends the relay but
                  keeps the same address for next time.
                </p>

                {/* Internet link via a tunnel (e.g. Cloudflare) — works off Wi-Fi when configured. */}
                <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 12 }}>
                  <p style={{ fontSize: 13, opacity: 0.8, margin: 0 }}>
                    <b>From anywhere (internet)</b> — your tunnel hostname (e.g. a Cloudflare named tunnel):
                  </p>
                  <input
                    style={{ width: "100%", boxSizing: "border-box", marginTop: 6, background: "rgba(255,255,255,0.06)", color: "inherit", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: 8, fontSize: 13 }}
                    value={settings.remoteLinkHost ?? ""}
                    placeholder="vr.example.com"
                    onChange={(e) => setSettings((s) => ({ ...s, remoteLinkHost: e.target.value }))}
                  />
                  {(() => {
                    const remoteUrl = remoteLink.token ? buildRemoteLinkUrl(settings.remoteLinkHost ?? "", remoteLink.token) : undefined;
                    return remoteUrl ? (
                      <>
                        <code style={{ display: "block", background: "#0d1017", padding: "8px 10px", borderRadius: 6, fontSize: 12, wordBreak: "break-all", marginTop: 8 }}>
                          {remoteUrl}
                        </code>
                        <p style={{ fontSize: 11, opacity: 0.55, marginTop: 8 }}>
                          Works off Wi-Fi when a tunnel forwards <code>{settings.remoteLinkHost}</code> → this desktop's
                          relay (port {remoteLink.port ?? 8787}). <b>Put Cloudflare Access in front of the hostname</b> so
                          only you can reach it — the pairing code is a second factor, not the only lock. Same pairing
                          code as the Wi-Fi link; <b>Change link</b> rotates both.
                        </p>
                      </>
                    ) : (
                      <p style={{ fontSize: 11, opacity: 0.5, marginTop: 6 }}>
                        Set up a tunnel (Cloudflare) pointing <code>your-host → http://localhost:{remoteLink.port ?? 8787}</code>,
                        then enter its hostname above to get an internet link.
                      </p>
                    );
                  })()}
                </div>
              </>
            ) : (
              <p style={{ fontSize: 13, color: "#ff8c8c", marginTop: 8 }}>⚠ {remoteLink.error ?? "Couldn't start the phone link."}</p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {remoteLink.running ? (
                <>
                  <button style={styles.button} onClick={() => void stopRemoteLink()}>
                    Stop
                  </button>
                  <button style={styles.button} onClick={() => void changeRemoteLink()} title="Rotate the pairing code — previously linked phones must open the new address.">
                    Change link
                  </button>
                </>
              ) : null}
              <button style={{ ...styles.button, marginLeft: "auto" }} onClick={() => setShowRemoteLink(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {orderReview && (
        <OrderReviewModal
          summary={orderReview.summary}
          order={orderReview.order}
          connected={schwabConnected}
          placing={orderPlacing}
          result={orderResult}
          onPlace={() => void placeReviewedOrder()}
          onClose={() => {
            setOrderReview(null);
            setOrderResult(null);
          }}
        />
      )}

      {showScheduled && (
        <ScheduledTasksPanel
          tasks={scheduledTasks}
          describe={describeSchedule}
          onToggle={(id, enabled) => void toggleScheduled(id, enabled)}
          onDelete={(id) => void removeScheduled(id)}
          onClose={() => setShowScheduled(false)}
        />
      )}
    </div>
  );
}

/**
 * Read settings synchronously for the first render. API keys are stored
 * encrypted (`keysEnc`); they can't be decrypted synchronously, so we return
 * them separately for the caller to decrypt after mount. Legacy plaintext keys
 * are read inline and re-encrypted on the next save.
 */
/** "~Xs left" / "~Xm left" from a millisecond estimate. */
/**
 * The full book text column. Memoized so it only re-renders when the reader
 * crosses into a new unit (or the book/layout changes) — NOT on every bloom
 * tick, chat token, or status update. The app root re-renders on every scroll
 * frame (reading progress is state there), and reconciling every paragraph of
 * a whole book per frame was the single biggest main-thread cost while reading.
 */
/** Technical-mode inline support handed to the reader column (all optional). */
interface TechnicalSupportData {
  terms?: string[];
  /** Lower-cased term → plain-language definition (concept tooltips). */
  definitions?: Map<string, string>;
  /** First-appearance concept cards, by original page index. */
  conceptsByPage?: Map<number, ConceptIntro[]>;
  /** Retrieved figures / skip notes anchored to their source paragraph. */
  figuresByPage?: Map<number, { unitIndex: number; paragraphIndex: number; result: DisplayResult }[]>;
  /** Computed data charts anchored to the paragraph they reference. */
  datasetsByPage?: Map<number, PageAnchored<ChapterDataset>[]>;
  /** Info-graphics (flowchart/diagram/summary) anchored to their paragraph. */
  infographicsByPage?: Map<number, PageAnchored<ChapterInfographic>[]>;
}

/**
 * Assemble the .xlsx bytes for a spreadsheet export: the data sheet(s) (named, so an
 * analysis sheet's cross-sheet formula references resolve), an optional formula totals
 * row, and an optional "Analysis" sheet of live statistical formulas over the primary
 * sheet. Shared by the data-view buttons and the chat's export_data tool.
 */
function buildSpreadsheetXlsx(
  data: DataTable,
  dataSheets: { name: string; table: DataTable }[] | undefined,
  opts: { totals?: "sum" | "average" | "min" | "max" | "count"; analyze?: boolean; chart?: "bar" | "line" | "pie" },
): Uint8Array {
  const sheets = dataSheets && dataSheets.length > 1 ? dataSheets : [{ name: "Sheet1", table: data }];
  const xlsxSheets = sheets.map((s, i) =>
    // The native chart (when requested) embeds over the FIRST sheet's data.
    sheetFromDataTable(s.name, s.table, {
      ...(opts.totals ? { totals: opts.totals } : {}),
      ...(opts.chart && i === 0 ? { chart: opts.chart } : {}),
    }),
  );
  if (opts.analyze) {
    const primary = sheets[0]!;
    const analysis = buildAnalysisTable(primary.table, primary.name);
    if (analysis) xlsxSheets.push(sheetFromDataTable("Analysis", analysis));
  }
  return buildXlsx(xlsxSheets);
}

/** Auto-chart a data card ONLY for a clean label+value shape (a Key/Value table, a
 * numeric list, a small label/value list) — never a wide multi-numeric sheet, where
 * an auto-picked series would be noise. Charting stays on-demand via chat for those. */
function autoChartDataset(table: DataTable): ChapterDataset | undefined {
  const numeric = table.columns.filter((c) => c.type === "number").length;
  const strings = table.columns.filter((c) => c.type === "string").length;
  if (numeric !== 1 || strings > 1 || table.columns.length > 3) return undefined;
  return chartDatasetFromTable(table);
}

/**
 * Full-screen text reader for the Document / Plain-text views (no illustration window). Renders the
 * document in its ACTUAL formatting: an imported article keeps its HTML layout; everything else is
 * rendered from Markdown via the shared block model (so a created doc matches its PDF/Word download);
 * "plain text" shows the raw text verbatim. The buddy chat still docks beneath it.
 */
const DocumentReader = memo(function DocumentReader({
  book,
  plain,
  articleHtml,
}: {
  book: BookSource;
  plain: boolean;
  articleHtml: boolean;
}) {
  const text = useMemo(
    () => book.pages.flatMap((p) => p.paragraphs.map((par) => par.text)).join("\n\n"),
    [book],
  );
  if (plain) {
    return (
      <div style={styles.readerDocInner}>
        <pre style={styles.readerPlainText}>{text}</pre>
      </div>
    );
  }
  if (articleHtml) {
    return (
      <div style={styles.readerDocInner}>
        <style>{ARTICLE_HTML_STYLE}</style>
        {book.pages
          .flatMap((p) => p.paragraphs)
          .map((par) =>
            par.html ? (
              <HtmlParagraph key={par.id} html={par.html} />
            ) : (
              <p key={par.id} style={{ margin: "0 0 0.9em", lineHeight: 1.7 }}>
                {par.text}
              </p>
            ),
          )}
      </div>
    );
  }
  return <DocBlocksView markdown={text} style={styles.readerDocInner} />;
});

const ReaderColumn = memo(function ReaderColumn({
  book,
  pageToUnit,
  unitIndex,
  pagesPerImage,
  registerParagraph,
  dataEdit,
  dataOpen,
  onDataToggle,
  onAddAnalysisSheet,
  saveNamed,
  technical,
  layoutHtml,
}: {
  book: BookSource;
  pageToUnit: number[] | undefined;
  unitIndex: number;
  pagesPerImage: number | "chapter";
  registerParagraph: (id: string) => (el: HTMLElement | null) => void;
  /** Whether the inline spreadsheet preview is expanded (controlled by App so it survives the
   * remounts a linked phone's sync pushes cause — an uncontrolled `<details open>` kept reopening). */
  dataOpen: boolean;
  onDataToggle: (open: boolean) => void;
  /** Edit the data grid (sheetIndex is null for a single-table import). */
  dataEdit?: {
    onEditCell: (s: number | null, r: number, c: number, raw: string) => void;
    onAddRow: (s: number | null) => void;
    onDeleteRow: (s: number | null, r: number) => void;
    onAddColumn: (s: number | null) => void;
    onDeleteColumn: (s: number | null, c: number) => void;
    onRenameColumn: (s: number | null, c: number, name: string) => void;
  };
  /** Append a live statistical Analysis sheet (cross-sheet formulas) to the workbook. */
  onAddAnalysisSheet?: () => void;
  /** Save a data export through the rename-before-save modal. */
  saveNamed: (defaultName: string, data: string | Uint8Array, mime: string, what?: string) => Promise<string | true | undefined>;
  /** Present only in technical mode: concept marks + paragraph-anchored support. */
  technical?: TechnicalSupportData;
  /** Render web-article paragraphs in their original (sanitized) HTML layout. */
  layoutHtml?: boolean;
}) {
  const chaptersById = useMemo(() => new Map(book.chapters.map((c) => [c.id, c])), [book]);
  // Multi-sheet workbook: let the reader pick which tab to view/chart/download.
  const sheets = book.dataSheets && book.dataSheets.length > 1 ? book.dataSheets : undefined;
  const [activeSheet, setActiveSheet] = useState(0);
  const activeTable = sheets ? (sheets[Math.min(activeSheet, sheets.length - 1)]?.table ?? book.data) : book.data;
  const dataChart = useMemo(() => (activeTable ? autoChartDataset(activeTable) : undefined), [activeTable]);
  return (
    <article style={activeTable ? { ...styles.column, maxWidth: "100%" } : styles.column}>
      {layoutHtml && <style>{ARTICLE_HTML_STYLE}</style>}
      {/* An uploaded spreadsheet/CSV/tabular-JSON: show the REAL grid as an aligned
          table up top (the flattened "a | b | c" pipe-text below is what the
          illustration/extraction pipeline reads, but it's no way to look at a sheet).
          A single label+value table also gets an auto-chart. */}
      {activeTable ? (
        <details open={dataOpen} onToggle={(e) => onDataToggle(e.currentTarget.open)} style={styles.dataPreview}>
          <summary style={styles.dataPreviewSummary}>
            <strong>🗂 {book.title || "Data"}</strong>
            <span style={{ opacity: 0.6 }}>
              {" "}
              {sheets ? `— ${sheets.length} sheets · ` : "— "}
              {activeTable.rows.length.toLocaleString("en-US")} row
              {activeTable.rows.length === 1 ? "" : "s"} × {activeTable.columns.length} column
              {activeTable.columns.length === 1 ? "" : "s"}. Ask the buddy to analyse, chart, or pivot it.
            </span>
          </summary>
          {sheets ? (
            <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
              {sheets.map((s, i) => (
                <button
                  key={s.name + i}
                  onClick={() => setActiveSheet(i)}
                  style={{
                    ...styles.smallButton,
                    ...(i === Math.min(activeSheet, sheets.length - 1)
                      ? { background: "rgba(90,209,155,0.3)", fontWeight: 600 }
                      : {}),
                  }}
                  title={`View sheet "${s.name}"`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button
              style={styles.smallButton}
              title={sheets ? "Download a real Excel workbook (.xlsx) of ALL sheets" : "Download a real Excel workbook (.xlsx) of this table"}
              onClick={() => {
                const bytes = sheets
                  ? buildXlsx(sheets.map((s) => sheetFromDataTable(s.name, s.table)))
                  : dataTableToXlsx(activeTable);
                void saveNamed(exportFilename(book.title || "data", "xlsx", "data"), bytes, XLSX_MIME, "Excel workbook");
              }}
            >
              ⬇ Excel (.xlsx){sheets ? " — all sheets" : ""}
            </button>
            {activeTable.columns.some((c) => c.type === "number") ? (
              <button
                style={styles.smallButton}
                title="Excel with an Analysis sheet of live formulas (stats, correlation, regression) over this sheet"
                onClick={() => {
                  const name = sheets ? (sheets[Math.min(activeSheet, sheets.length - 1)]?.name ?? "Sheet1") : "Sheet1";
                  const analysis = buildAnalysisTable(activeTable, name);
                  const xlsxSheets = [
                    sheetFromDataTable(name, activeTable),
                    ...(analysis ? [sheetFromDataTable("Analysis", analysis)] : []),
                  ];
                  void saveNamed(exportFilename(`${book.title || "data"}-analysis`, "xlsx", "data-analysis"), buildXlsx(xlsxSheets), XLSX_MIME, "Excel + Analysis");
                }}
              >
                ⬇ + Analysis
              </button>
            ) : null}
            {activeTable.columns.some((c) => c.type === "number") ? (
              <button
                style={styles.smallButton}
                title="Excel with a native, editable chart embedded over this sheet's data"
                onClick={() => {
                  const name = sheets ? (sheets[Math.min(activeSheet, sheets.length - 1)]?.name ?? "Sheet1") : "Sheet1";
                  const kind: "bar" | "line" | "pie" = dataChart?.kind === "line" ? "line" : "bar";
                  void saveNamed(exportFilename(`${book.title || "data"}-chart`, "xlsx", "data-chart"), buildXlsx([sheetFromDataTable(name, activeTable, { chart: kind })]), XLSX_MIME, "Excel + Chart");
                }}
              >
                ⬇ + Chart
              </button>
            ) : null}
            {onAddAnalysisSheet && activeTable.columns.some((c) => c.type === "number") ? (
              <button
                style={styles.smallButton}
                title="Add a live Analysis sheet — stats/correlation/regression as formulas that update with your data"
                onClick={onAddAnalysisSheet}
              >
                ➕ Analysis sheet
              </button>
            ) : null}
            <button
              style={styles.smallButton}
              title={sheets ? "Download the current sheet as CSV" : "Download this table as CSV"}
              onClick={() => {
                const suffix = sheets ? `-${sheets[Math.min(activeSheet, sheets.length - 1)]?.name ?? "sheet"}` : "";
                void saveNamed(exportFilename(`${book.title || "data"}${suffix}`, "csv", "data"), dataTableToCsv(activeTable), "text/csv", "CSV");
              }}
            >
              ⬇ CSV{sheets ? " (this sheet)" : ""}
            </button>
          </div>
          <div style={{ marginTop: 8 }}>
            <DataTablePreview
              table={activeTable}
              maxRows={200}
              maxHeight={420}
              {...(dataEdit
                ? (() => {
                    const si = sheets ? Math.min(activeSheet, sheets.length - 1) : null;
                    return {
                      onEditCell: (r: number, c: number, raw: string) => dataEdit.onEditCell(si, r, c, raw),
                      onAddRow: () => dataEdit.onAddRow(si),
                      onDeleteRow: (r: number) => dataEdit.onDeleteRow(si, r),
                      onAddColumn: () => dataEdit.onAddColumn(si),
                      onDeleteColumn: (c: number) => dataEdit.onDeleteColumn(si, c),
                      onRenameColumn: (c: number, name: string) => dataEdit.onRenameColumn(si, c, name),
                    };
                  })()
                : {})}
            />
          </div>
          {dataEdit ? (
            <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>
              Click a cell to select it (edit its value or =formula in the bar above), double-click to edit inline, a
              header to rename, ✕ to delete a row/column, ⇅ to sort — changes save automatically and the chat re-analyses
              them.
            </div>
          ) : null}
          {dataChart ? (
            <div style={{ marginTop: 8 }}>
              <DataChart dataset={dataChart} />
            </div>
          ) : null}
        </details>
      ) : book.tree !== undefined ? (
        // Nested/irregular JSON: a collapsible tree, the view that actually fits it.
        <details open style={styles.dataPreview}>
          <summary style={styles.dataPreviewSummary}>
            <strong>🧬 {book.title || "JSON"}</strong>
            <span style={{ opacity: 0.6 }}> — structured JSON. Expand to explore; ask the buddy about it.</span>
          </summary>
          <div style={{ marginTop: 8 }}>
            <JsonTreeView value={book.tree} maxHeight={460} />
          </div>
        </details>
      ) : null}
      {book.pages.map((page, i) => {
        const prev = book.pages[i - 1];
        const newChapter = !prev || prev.chapterId !== page.chapterId;
        const chapter = chaptersById.get(page.chapterId);
        const pageUnit = pageToUnit?.[i] ?? i;
        const isActiveUnit = pageUnit === unitIndex;
        const next = book.pages[i + 1];
        // "Page N" dividers between pages of the same chapter (chapter
        // boundaries are marked by the heading). Hidden in whole-chapter mode.
        const showPageDivider =
          pagesPerImage !== "chapter" && next !== undefined && next.chapterId === page.chapterId;
        const concepts = technical?.conceptsByPage?.get(i);
        const figures = technical?.figuresByPage?.get(i);
        const datasets = technical?.datasetsByPage?.get(i);
        const infographics = technical?.infographicsByPage?.get(i);
        return (
          <Fragment key={page.id}>
            {newChapter && (
              <h2 style={styles.chapterHeading}>
                {chapter?.title || `Chapter ${(chapter?.index ?? 0) + 1}`}
              </h2>
            )}
            <section style={isActiveUnit ? { ...styles.page, ...styles.sectionActive } : styles.page}>
              {page.paragraphs.map((para, pi) => {
                // Technical support anchored to THIS paragraph — it scrolls with
                // its source text instead of living in a detached side pane.
                const paraConcepts = concepts?.filter((c) => c.paragraphIndex === pi);
                const paraFigures = figures?.filter((f) => f.paragraphIndex === pi);
                const paraDatasets = datasets?.filter((d) => d.paragraphIndex === pi);
                const paraInfographics = infographics?.filter((g) => g.paragraphIndex === pi);
                const support =
                  (paraConcepts?.length ?? 0) > 0 ||
                  (paraFigures?.length ?? 0) > 0 ||
                  (paraDatasets?.length ?? 0) > 0 ||
                  (paraInfographics?.length ?? 0) > 0;
                return (
                  <Fragment key={para.id}>
                    {book.contentMode === "code" ? (
                      <pre ref={registerParagraph(para.id)} style={styles.codeBlock}>
                        <code>{para.text}</code>
                      </pre>
                    ) : layoutHtml && para.html ? (
                      <HtmlParagraph html={para.html} innerRef={registerParagraph(para.id)} />
                    ) : (
                      <p ref={registerParagraph(para.id)} style={styles.paragraph}>
                        {technical?.terms?.length && technical.definitions ? (
                          <ConceptText
                            text={para.text}
                            terms={technical.terms}
                            definitions={technical.definitions}
                          />
                        ) : (
                          para.text
                        )}
                      </p>
                    )}
                    {support && (
                      <SupportRow>
                        {paraFigures?.map((f) => (
                          <InlineFigure key={`fig-${f.unitIndex}`} result={f.result} />
                        ))}
                        {paraInfographics?.map((g) => (
                          <Infographic key={g.item.id} data={g.item} />
                        ))}
                        {paraDatasets?.map((d) => (
                          <DataChart key={d.item.id} dataset={d.item} />
                        ))}
                        {paraConcepts?.map((c) => (
                          <ConceptCard key={c.term} term={c.term} definition={c.definition} />
                        ))}
                      </SupportRow>
                    )}
                  </Fragment>
                );
              })}
            </section>
            {showPageDivider && (
              <div style={styles.pageDivider}>
                <span style={styles.pageDividerLabel}>Page {i + 1}</span>
              </div>
            )}
          </Fragment>
        );
      })}
    </article>
  );
});

function formatLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return ms < 60000 ? `~${Math.round(ms / 1000)}s left` : `~${Math.round(ms / 60000)}m left`;
}

/** A book title reduced to a safe export filename stem (no path/illegal chars). */
function safeFileName(title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "book").slice(0, 80);
}

/** Best-effort filename from a download URL (for pasted checkpoint/LoRA URLs). */
function fileNameFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split("/").filter(Boolean).pop();
    const clean = base ? decodeURIComponent(base) : "";
    if (clean) return /\.(safetensors|ckpt|pt)$/i.test(clean) ? clean : `${clean}.safetensors`;
  } catch {
    /* fall through */
  }
  return "model.safetensors";
}

/**
 * The phone-link pairing token is PERSISTED (not minted per session) so the link a phone has
 * saved keeps working across desktop restarts. The token only changes when the user presses
 * "Change link" (rotateRemoteToken). The "enabled" flag remembers that the user opted in, so a
 * relay that was running is brought back up on the next launch with the SAME token.
 */
const REMOTE_TOKEN_KEY = "vr-remote-token";
const REMOTE_ENABLED_KEY = "vr-remote-enabled";

/** The persisted pairing token, minting + storing one on first use (stable across restarts). */
function persistedRemoteToken(): string {
  try {
    const existing = localStorage.getItem(REMOTE_TOKEN_KEY);
    if (existing) return existing;
  } catch {
    /* ignore */
  }
  const token = generatePairingToken();
  try {
    localStorage.setItem(REMOTE_TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
  return token;
}

/** Rotate the persisted pairing token (the "Change link" action) → a fresh, stored token. */
function rotateRemoteToken(): string {
  const token = generatePairingToken();
  try {
    localStorage.setItem(REMOTE_TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
  return token;
}

/** Remember whether the user opted into the relay, so it auto-restarts on the next launch. */
function setRemoteEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(REMOTE_ENABLED_KEY, "1");
    else localStorage.removeItem(REMOTE_ENABLED_KEY);
  } catch {
    /* ignore */
  }
}
function remoteWasEnabled(): boolean {
  try {
    return localStorage.getItem(REMOTE_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function loadStoredSettings(): { settings: ReaderSettings; encrypted?: EncryptedSecrets } {
  try {
    const raw = localStorage.getItem("vr-settings");
    if (!raw) return { settings: DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const base = migrate(parsed);
    delete (base as unknown as Record<string, unknown>).keysEnc;
    const enc = parsed.keysEnc as EncryptedSecrets | undefined;
    if (enc && Array.isArray(enc.ciphertext) && Array.isArray(enc.iv)) {
      return { settings: { ...base, keys: {} }, encrypted: enc };
    }
    return { settings: base };
  } catch {
    return { settings: DEFAULT_SETTINGS };
  }
}

/** Accept the new shape as-is; migrate the v1 `{tier,llmKey,imageKey}` shape. */
function migrate(raw: Record<string, unknown>): ReaderSettings {
  if (typeof raw.textProvider === "string") {
    const migrated = { ...DEFAULT_SETTINGS, ...(raw as Partial<ReaderSettings>) };
    // Legacy `illustrationScope` (page|chapter) → pagesPerImage.
    if (migrated.pagesPerImage === undefined && typeof raw.illustrationScope === "string") {
      migrated.pagesPerImage = raw.illustrationScope === "chapter" ? "chapter" : 1;
    }
    delete (migrated as Record<string, unknown>).illustrationScope;
    // Legacy flat `videoParams` (one shared set) → per-family: it used to apply to whatever model was
    // selected, so seed BOTH families with it. New shape is keyed by `kind` (wan-i2v / ltx2-i2v).
    const vp = raw.videoParams as Record<string, unknown> | undefined;
    if (vp && !("wan-i2v" in vp) && !("ltx2-i2v" in vp) && Object.keys(vp).length > 0) {
      migrated.videoParams = { "wan-i2v": { ...vp }, "ltx2-i2v": { ...vp } } as NonNullable<ReaderSettings["videoParams"]>;
    }
    return migrated;
  }
  const llmKey = typeof raw.llmKey === "string" ? raw.llmKey : "";
  const imageKey = typeof raw.imageKey === "string" ? raw.imageKey : "";
  return {
    ...DEFAULT_SETTINGS,
    keys: { ...(llmKey ? { claude: llmKey } : {}), ...(imageKey ? { flux: imageKey } : {}) },
    configured: Boolean(llmKey && imageKey),
  };
}

async function saveSettings(s: ReaderSettings): Promise<void> {
  try {
    // Drop the transient engine URL + active backend + detected VRAM and the plaintext keys; persist
    // the keys only as an encrypted blob (never in plaintext).
    const { keys, engineBaseUrl: _url, engineBackend: _backend, gpuVramMb: _vram, ...rest } = s;
    void _url;
    void _backend;
    void _vram;
    const persist: Record<string, unknown> = { ...rest };
    delete persist.keysEnc;
    if (keys && Object.keys(keys).length > 0) {
      persist.keysEnc = await encryptSecrets(keys);
    }
    localStorage.setItem("vr-settings", JSON.stringify(persist));
  } catch {
    /* ignore quota / private-mode / crypto errors */
  }
}

/**
 * Status chips showing whether the real LLM / image providers are active or the
 * app silently fell back to a mock — and why. This is the cure for "endless
 * painting with no idea what's happening": at a glance you can see "Image: mock —
 * no checkpoint selected" instead of guessing.
 */
/** Paste/upload a Visual Bible JSON, preview its contents, and import it. */
/** Every dataset the analysis extracted from a TECHNICAL book, charted, grouped
 * by chapter — the technical counterpart of the Character Bible. */
function DataModal({
  datasets,
  chapterTitles,
  onClose,
}: {
  datasets: ChapterDataset[];
  chapterTitles: string[];
  onClose: () => void;
}) {
  const byChapter = useMemo(() => {
    const groups = new Map<number, ChapterDataset[]>();
    for (const d of datasets) {
      const list = groups.get(d.chapterIndex) ?? [];
      list.push(d);
      groups.set(d.chapterIndex, list);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [datasets]);
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalPanel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong>📊 Data — every extracted dataset ({datasets.length})</strong>
          <button style={styles.button} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ opacity: 0.65, fontSize: 12, margin: "0 0 8px" }}>
          Real numeric series captured from the text, charted by the app with exact values —
          never an AI&rsquo;s imagined numbers. The reader aside shows the current chapter&rsquo;s
          data; this is the whole book&rsquo;s.
        </p>
        {datasets.length === 0 && (
          <p style={{ opacity: 0.6, fontSize: 13 }}>
            No datasets extracted yet — they appear as the analysis finds real numeric series
            (tables, results, comparisons) in the text.
          </p>
        )}
        {byChapter.map(([chapterIndex, list]) => (
          <section key={chapterIndex} style={{ marginBottom: 14 }}>
            <h3 style={{ fontSize: 13, margin: "10px 0 4px", opacity: 0.85 }}>
              {chapterTitles[chapterIndex] ?? `Chapter ${chapterIndex + 1}`}
            </h3>
            {list.map((d) => (
              <DataChart key={d.id} dataset={d} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function ImportBibleModal({
  bookId,
  onImport,
  result,
  onClose,
}: {
  bookId: string;
  onImport: (json: string) => void;
  result: ImportResult | undefined;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const preview = useMemo(() => (text.trim() ? parseImportedBible(text, bookId) : undefined), [text, bookId]);

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalPanel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong>Import Visual Bible</strong>
          <button style={styles.button} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ opacity: 0.65, fontSize: 12, margin: "0 0 8px" }}>
          Paste a Visual Bible JSON (or upload a file). It merges onto this book and is saved;
          existing images are kept.
        </p>
        <label style={styles.upload}>
          Choose .json file
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>
        <textarea
          style={styles.importTextarea}
          value={text}
          placeholder="…or paste the JSON here"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        {preview?.error && <div style={{ color: "#ff9b9b", fontSize: 13 }}>{preview.error}</div>}
        {preview?.stats && (
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            Ready to import: {preview.stats.characters} characters · {preview.stats.creatures} creatures ·{" "}
            {preview.stats.environments} locations · {preview.stats.storyboard} chapters ·{" "}
            {preview.stats.glossary} glossary
          </div>
        )}
        {result && (
          <div style={{ color: result.ok ? "#7dd87f" : "#ff9b9b", fontSize: 13 }}>
            {result.ok ? "Imported ✓ — the Visual Bible has been updated." : result.error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            style={styles.buttonPrimary}
            disabled={!preview?.stats}
            onClick={() => onImport(text)}
          >
            Import &amp; merge
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Paste any raw text (an article, a chapter, a paper) and read/illustrate it like a
 * book. "Technical" marks non-fiction so illustration prompts use the concept/diagram
 * template instead of fiction scenes. The book id is a hash of the content, so pasting
 * the same text again reopens the same book with its bible and images intact.
 */
function PasteTextModal({
  initial,
  onCreate,
  onPolish,
  onClose,
}: {
  /** Prefill when the text came from an opened file (PDF/Word/CSV/…). */
  initial?:
    | { title: string; text: string; mode?: ContentMode; data?: DataTable; tree?: JsonValue }
    | undefined;
  onCreate: (title: string, text: string, mode: ContentMode) => void;
  /** Switch to the faithful summarize/rework flow with the current title + text. */
  onPolish?: (title: string, text: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [mode, setMode] = useState<ContentMode>(initial?.mode ?? "fiction");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalPanel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong>Read pasted text</strong>
          <button style={styles.button} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ opacity: 0.65, fontSize: 12, margin: "0 0 8px" }}>
          Paste anything — it becomes a book you can read and illustrate. Chapter headings
          (Markdown #, “Chapter N”) are detected automatically.
        </p>
        <input
          style={{ width: "100%", marginBottom: 8, boxSizing: "border-box" }}
          value={title}
          placeholder="Title (optional)"
          onChange={(e) => setTitle(e.target.value)}
        />
        {initial?.data ? (
          <div style={{ marginBottom: 8 }}>
            <DataTablePreview
              table={initial.data}
              maxRows={8}
              maxHeight={200}
              caption={`Detected a table — ${initial.data.rows.length.toLocaleString("en-US")} rows × ${initial.data.columns.length} columns. Opened technical, ready to analyse/chart in chat.`}
            />
          </div>
        ) : initial?.tree !== undefined ? (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, opacity: 0.6, margin: "0 0 4px" }}>
              Detected nested JSON — shown as a tree you can explore in the reader.
            </div>
            <JsonTreeView value={initial.tree} maxHeight={200} />
          </div>
        ) : null}
        <textarea
          style={styles.importTextarea}
          value={text}
          placeholder="Paste the text here…"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, margin: "6px 0", flexWrap: "wrap" }}>
          <span>Treat as</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as ContentMode)} style={{ fontSize: 13 }}>
            <option value="fiction">Story / fiction — illustrate scenes</option>
            <option value="technical">Technical / non-fiction — concepts &amp; diagrams</option>
            <option value="code">Code — glossary, module map &amp; flow diagrams</option>
          </select>
          <em style={{ opacity: 0.6 }}>(experimental)</em>
        </label>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
          <span style={{ opacity: 0.6, fontSize: 12 }}>{words ? `${words} words` : ""}</span>
          <span style={{ display: "flex", gap: 6 }}>
            {onPolish && (
              <button
                style={styles.button}
                disabled={!text.trim()}
                title="Summarize, rewrite, or proofread this text faithfully — no illustration"
                onClick={() => onPolish(title.trim() || "Document", text)}
              >
                ✍ Summarize / rework
              </button>
            )}
            <button
              style={styles.buttonPrimary}
              disabled={!text.trim()}
              onClick={() => onCreate(title.trim() || "Pasted text", text, mode)}
            >
              Read it
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Freeform playground: type anything → one image with the current provider/style/
 * quality (no bible, no LLM, no cache). The fastest way to test a model, an art style,
 * or a LoRA before committing to a whole book.
 */
function TestImageModal({
  onRender,
  onAddToChat,
  onClose,
}: {
  onRender: (text: string, opts?: { onProgress?: (f: number) => void }) => Promise<TestRenderResult>;
  /** Drop the rendered image into the chat conversation. */
  onAddToChat?: (image: { bytes: ArrayBuffer; mimeType: string }) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | undefined>();
  const [result, setResult] = useState<TestRenderResult | undefined>();
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [addedToChat, setAddedToChat] = useState(false);
  useEffect(() => () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);

  const run = async () => {
    setBusy(true);
    setResult(undefined);
    setProgress(undefined);
    setAddedToChat(false);
    const r = await onRender(text, { onProgress: setProgress });
    setBusy(false);
    setProgress(undefined);
    setResult(r);
    if (r.image) {
      setImageUrl(URL.createObjectURL(new Blob([r.image.bytes], { type: r.image.mimeType })));
    }
  };

  return (
    <div style={styles.modalOverlay}>
      <div style={styles.modalPanel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong>Test an image</strong>
          <button style={styles.button} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ opacity: 0.65, fontSize: 12, margin: "0 0 8px" }}>
          Renders one image from your text with the current model, art style, quality and
          aspect settings — nothing is analysed or saved. Great for testing styles and LoRAs.
        </p>
        <textarea
          style={{ ...styles.importTextarea, minHeight: 70 }}
          value={text}
          placeholder="e.g. A lighthouse keeper rowing out into a storm at dusk"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 4 }}>
          {busy && (
            <span style={{ opacity: 0.7, fontSize: 12 }}>
              {progress !== undefined ? `Rendering… ${Math.round(progress * 100)}%` : "Rendering…"}
            </span>
          )}
          <button style={styles.buttonPrimary} disabled={busy || !text.trim()} onClick={() => void run()}>
            {busy ? "Working…" : "Render"}
          </button>
        </div>
        {result?.error && (
          <div style={{ color: "#ff9b9b", fontSize: 13, whiteSpace: "pre-wrap" }}>{result.error}</div>
        )}
        {result?.ok && imageUrl && (
          <>
            <img
              src={imageUrl}
              alt="Test render"
              style={{
                display: "block",
                alignSelf: "flex-start",
                width: "auto",
                height: "auto",
                maxWidth: "100%",
                maxHeight: 480,
                objectFit: "contain",
                borderRadius: 8,
                marginTop: 8,
              }}
            />
            {onAddToChat && result.image && (
              <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
                <button
                  style={styles.button}
                  onClick={() => {
                    onAddToChat(result.image!);
                    setAddedToChat(true);
                  }}
                >
                  💬 Add to chat
                </button>
                {addedToChat && <span style={{ opacity: 0.65, fontSize: 12 }}>Added to chat.</span>}
              </div>
            )}
            {result.prompt && (
              <div style={{ opacity: 0.6, fontSize: 11, marginTop: 6, whiteSpace: "pre-wrap" }}>
                {result.prompt}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Transform a photo (img2img): pick or drop in a picture, describe the change,
 * set how far to push it, and render a NEW image based on it with the current
 * image model/style. Local engine only (ComfyUI encodes the photo to latent and
 * denoises from it); the result can be saved or fed back in as the next base.
 */
function PhotoTransformModal({
  initial,
  onRender,
  onAddToChat,
  onExtractText,
  onClose,
}: {
  initial?: { name: string; bytes: ArrayBuffer; mimeType: string } | undefined;
  onRender: (
    text: string,
    opts: {
      initImage: { bytes: ArrayBuffer; mimeType: string };
      denoise: number;
      size?: { width: number; height: number };
      onProgress?: (f: number) => void;
    },
  ) => Promise<TestRenderResult>;
  /** Drop the transformed image into the chat conversation. */
  onAddToChat?: (image: { bytes: ArrayBuffer; mimeType: string }) => void;
  /** Extract the text from the image (OCR via the vision model) and open it as a document. */
  onExtractText?: (img: { name: string; bytes: ArrayBuffer; mimeType: string }) => void;
  onClose: () => void;
}) {
  const [base, setBase] = useState<{ name: string; bytes: ArrayBuffer; mimeType: string } | undefined>(initial);
  const [baseDims, setBaseDims] = useState<{ width: number; height: number } | undefined>();
  const [text, setText] = useState("");
  const [strength, setStrength] = useState(0.6);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | undefined>();
  const [result, setResult] = useState<TestRenderResult | undefined>();
  const [baseUrl, setBaseUrl] = useState<string | undefined>();
  const [resultUrl, setResultUrl] = useState<string | undefined>();
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    if (!base) {
      setBaseUrl(undefined);
      setBaseDims(undefined);
      return;
    }
    const url = URL.createObjectURL(new Blob([base.bytes], { type: base.mimeType }));
    setBaseUrl(url);
    // Read the source aspect so the output matches it (no more square crops). Scale
    // the long edge to ~1024, rounded to /8 for the local sampler.
    const img = new Image();
    img.onload = () => {
      const long = Math.max(img.naturalWidth, img.naturalHeight) || 1024;
      const scale = Math.min(1, 1024 / long);
      const round8 = (n: number) => Math.max(64, Math.round((n * scale) / 8) * 8);
      setBaseDims({ width: round8(img.naturalWidth), height: round8(img.naturalHeight) });
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [base]);
  useEffect(() => () => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
  }, [resultUrl]);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setResult(undefined);
    setNote("");
    setBase({ name: file.name, bytes: await file.arrayBuffer(), mimeType: file.type || "image/png" });
  };

  const run = async () => {
    if (!base) return;
    setBusy(true);
    setResult(undefined);
    setProgress(undefined);
    setNote("");
    const r = await onRender(text, {
      initImage: { bytes: base.bytes, mimeType: base.mimeType },
      denoise: strength,
      ...(baseDims ? { size: baseDims } : {}),
      onProgress: setProgress,
    });
    setBusy(false);
    setProgress(undefined);
    setResult(r);
    if (r.image) setResultUrl(URL.createObjectURL(new Blob([r.image.bytes], { type: r.image.mimeType })));
  };

  const useResultAsBase = () => {
    if (!result?.image) return;
    setBase({ name: "result.png", bytes: result.image.bytes, mimeType: result.image.mimeType });
    setResult(undefined);
    setResultUrl(undefined);
    setNote("");
  };

  const saveResult = async () => {
    if (!result?.image) return;
    const ext = /jpe?g/i.test(result.image.mimeType) ? "jpg" : /webp/i.test(result.image.mimeType) ? "webp" : "png";
    try {
      const saved = await saveExportFile(`transformed-${Date.now()}.${ext}`, new Uint8Array(result.image.bytes), result.image.mimeType);
      setNote(typeof saved === "string" ? `✓ Saved to ${saved}` : "✓ Saved (check your downloads)");
    } catch (err) {
      setNote(`✗ Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div style={styles.modalOverlay}>
      <div style={styles.modalPanel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong>Transform a photo</strong>
          <button style={styles.button} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ opacity: 0.65, fontSize: 12, margin: "0 0 8px" }}>
          Start from a picture and reimagine it. Works with a local ComfyUI engine or a
          Gemini / OpenAI image key — other engines ignore the photo. Set the art style to
          “Auto” and describe what you want in the box (a forced style fights the photo).
          On the local engine, lower strength stays closer to the original.
        </p>
        <label style={{ ...styles.button, display: "inline-block", cursor: "pointer", marginBottom: 8 }}>
          {base ? `Photo: ${base.name}` : "Choose a photo…"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: "none" }}
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
        </label>
        {baseUrl && (
          <img
            src={baseUrl}
            alt="Base"
            // alignSelf/width:auto stop the flex-column from stretching the image to the
            // panel width (which, with maxHeight, squished wide photos); maxW+maxH+auto
            // then scale it down preserving its real aspect ratio.
            style={{
              display: "block",
              alignSelf: "flex-start",
              width: "auto",
              height: "auto",
              maxWidth: "100%",
              maxHeight: 200,
              objectFit: "contain",
              borderRadius: 8,
              marginBottom: 8,
            }}
          />
        )}
        <textarea
          style={{ ...styles.importTextarea, minHeight: 56 }}
          value={text}
          placeholder="Describe what you want — e.g. a photorealistic aerial view of this dungeon map; turn this into an oil painting"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, margin: "8px 0" }}>
          <span style={{ opacity: 0.7, whiteSpace: "nowrap" }}>Strength {Math.round(strength * 100)}%</span>
          <input
            type="range"
            min={0.2}
            max={0.9}
            step={0.05}
            value={strength}
            style={{ flex: 1 }}
            onChange={(e) => setStrength(Number(e.target.value))}
          />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
          {busy && (
            <span style={{ opacity: 0.7, fontSize: 12 }}>
              {progress !== undefined ? `Rendering… ${Math.round(progress * 100)}%` : "Rendering…"}
            </span>
          )}
          {onExtractText ? (
            <button
              style={styles.button}
              disabled={busy || !base}
              onClick={() => base && onExtractText({ name: base.name, bytes: base.bytes, mimeType: base.mimeType })}
              title="Read the text in this image (OCR via your vision model) and open it as a document"
            >
              🔤 Extract text
            </button>
          ) : null}
          <button style={styles.buttonPrimary} disabled={busy || !base || !text.trim()} onClick={() => void run()}>
            {busy ? "Working…" : "Transform"}
          </button>
        </div>
        {result?.error && (
          <div style={{ color: "#ff9b9b", fontSize: 13, whiteSpace: "pre-wrap", marginTop: 8 }}>{result.error}</div>
        )}
        {result?.ok && resultUrl && (
          <>
            <img
              src={resultUrl}
              alt="Transformed"
              style={{
                display: "block",
                alignSelf: "flex-start",
                width: "auto",
                height: "auto",
                maxWidth: "100%",
                maxHeight: 480,
                objectFit: "contain",
                borderRadius: 8,
                marginTop: 8,
              }}
            />
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <button style={styles.button} onClick={() => void saveResult()}>
                ⤓ Save
              </button>
              {onAddToChat && result.image && (
                <button
                  style={styles.button}
                  onClick={() => {
                    onAddToChat(result.image!);
                    setNote("✓ Added to chat.");
                  }}
                >
                  💬 Add to chat
                </button>
              )}
              <button style={styles.button} onClick={useResultAsBase}>
                ↺ Use as new base
              </button>
            </div>
            {note && <div style={{ opacity: 0.75, fontSize: 12, marginTop: 6 }}>{note}</div>}
          </>
        )}
      </div>
    </div>
  );
}

function ProviderBadges({
  providers,
  engineStatus,
  vram,
  hideImage,
  children,
}: {
  providers: ProvidersDiagnostics | undefined;
  engineStatus: string;
  vram?: EngineVram | undefined;
  /** Suppress the "Image:" badge — used on the phone for a LOCAL engine, where a dedicated red
   * engine pill stands in for it (the desktop's image badge would otherwise read green/healthy). */
  hideImage?: boolean;
  /** Optional leading badge (e.g. the phone's "Linked to …" chip) rendered before the model tags. */
  children?: React.ReactNode;
}) {
  if (!children && !providers && !engineStatus && !vram) return null;
  return (
    <div style={styles.badges}>
      {children}
      {providers && <Badge slot="Text" diag={providers.llm} />}
      {providers && !hideImage && <Badge slot="Image" diag={providers.image} />}
      {engineStatus && (
        <span style={{ ...styles.badge, ...styles.badgeBusy }} title="Local GPU engine status">
          Engine: {engineStatus}
        </span>
      )}
      {vram && <VramBadge vram={vram} />}
    </div>
  );
}

/** Live GPU VRAM chip: "VRAM 14.2 / 24.0 GB" with a usage tint (green < 75%, amber < 92%, red above). */
function VramBadge({ vram }: { vram: EngineVram }) {
  const usedGb = vram.usedMb / 1024;
  const totalGb = vram.totalMb / 1024;
  const frac = vram.totalMb > 0 ? vram.usedMb / vram.totalMb : 0;
  const tone = frac >= 0.92 ? styles.badgeWarn : frac >= 0.75 ? styles.badgeBusy : styles.badgeOk;
  const pct = Math.round(frac * 100);
  return (
    <span
      style={{ ...styles.badge, ...tone }}
      title={`${vram.device ?? "GPU"} — ${pct}% of VRAM in use (${usedGb.toFixed(1)} of ${totalGb.toFixed(1)} GB)`}
    >
      <span aria-hidden style={{ opacity: 0.8 }}>▦</span> VRAM {usedGb.toFixed(1)} / {totalGb.toFixed(1)} GB
    </span>
  );
}

function Badge({ slot, diag }: { slot: string; diag: ProvidersDiagnostics["llm"] }) {
  const tone = diag.mock ? styles.badgeWarn : styles.badgeOk;
  return (
    <span style={{ ...styles.badge, ...tone }} title={diag.reason ?? ""}>
      <span aria-hidden style={{ opacity: 0.8 }}>{diag.mock ? "▲" : "●"}</span> {slot}: {diag.label}
      {diag.mock && diag.reason ? ` — ${diag.reason}` : ""}
    </span>
  );
}

/**
 * Always-visible workflow strip (inside the sticky header): which stage the engine
 * is in (read → prompts → paint), exactly which chapter/page it's working on, and a
 * transient "✓ your click did X" note so Redo presses are never ambiguous.
 */
function WorkflowBar({
  stage,
  paused,
  workflow,
  readingChapter,
  painting,
  paintingWhere,
  settledCount,
  totalUnits,
  actionNote,
  detail,
}: {
  stage: "read" | "prompts" | "paint" | "done" | "idle";
  paused: { bible: boolean; images: boolean };
  workflow: { bibleDone: number; bibleTotal: number; promptsDone: number; promptsTotal: number };
  readingChapter: string;
  painting: { unit: number; progress?: number } | undefined;
  paintingWhere: string;
  settledCount: number;
  totalUnits: number;
  actionNote: string;
  detail: string;
}) {
  const chip = (
    label: string,
    state: "todo" | "active" | "paused" | "done",
    count: string,
  ): React.ReactNode => (
    <span
      key={label}
      style={{
        ...styles.stageChip,
        ...(state === "active" ? styles.stageChipActive : {}),
        ...(state === "done" ? styles.stageChipDone : {}),
        ...(state === "paused" ? styles.stageChipPaused : {}),
      }}
    >
      {state === "done" ? "✓ " : state === "paused" ? "⏸ " : ""}
      {label}
      {count ? <span style={{ opacity: 0.75 }}> {count}</span> : null}
    </span>
  );

  const readState =
    paused.bible && stage !== "done" && stage !== "idle"
      ? "paused"
      : workflow.bibleTotal > 0 && workflow.bibleDone >= workflow.bibleTotal
        ? "done"
        : stage === "read"
          ? "active"
          : "todo";
  const promptState =
    paused.bible && stage === "prompts"
      ? "paused"
      : readState === "done" && (workflow.promptsTotal === 0 || workflow.promptsDone >= workflow.promptsTotal)
        ? "done"
        : stage === "prompts"
          ? "active"
          : "todo";
  const paintState =
    paused.images && stage !== "idle"
      ? "paused"
      : totalUnits > 0 && settledCount >= totalUnits
        ? "done"
        : stage === "paint"
          ? "active"
          : "todo";

  // The single most useful sentence about what's happening RIGHT NOW. Reading and
  // painting can overlap (chapter mode) — show both when they do.
  const paintingNow = painting
    ? `painting image ${painting.unit + 1}/${totalUnits}` +
      (paintingWhere ? ` (${paintingWhere})` : "") +
      (painting.progress !== undefined ? ` · ${Math.round(painting.progress * 100)}%` : "")
    : "";
  const now =
    stage === "idle"
      ? "Press ▶ Start illustrating to begin."
      : paused.bible && paused.images
        ? "Paused."
        : stage === "read"
          ? `Reading chapter ${Math.min(workflow.bibleDone + 1, workflow.bibleTotal)}/${workflow.bibleTotal}` +
            (readingChapter ? ` — “${readingChapter}”` : "") +
            (paintingNow ? ` · ${paintingNow}` : "")
          : stage === "prompts"
            ? `Writing illustration prompts ${workflow.promptsDone}/${workflow.promptsTotal}` +
              (paintingNow ? ` · ${paintingNow}` : "")
            : stage === "paint"
              ? paintingNow
                ? paintingNow.charAt(0).toUpperCase() + paintingNow.slice(1)
                : `Painting — ${settledCount}/${totalUnits} done`
              : "All illustrations ready ✓";

  return (
    <div style={styles.workflowBar} aria-live="polite">
      <div style={styles.workflowChips}>
        {chip("1 Read", readState, workflow.bibleTotal ? `${Math.min(workflow.bibleDone, workflow.bibleTotal)}/${workflow.bibleTotal}` : "")}
        <span style={styles.stageArrow}>→</span>
        {chip("2 Prompts", promptState, workflow.promptsTotal ? `${workflow.promptsDone}/${workflow.promptsTotal}` : "")}
        <span style={styles.stageArrow}>→</span>
        {chip("3 Paint", paintState, totalUnits ? `${settledCount}/${totalUnits}` : "")}
        <span style={styles.workflowNow}>{now}</span>
        {actionNote && <span style={styles.actionNote}>{actionNote}</span>}
      </div>
      {detail && <div style={styles.workflowDetail}>{detail}</div>}
    </div>
  );
}

const KEYFRAMES =
  `@keyframes vr-pulse { 0%,100% { opacity: 0.55 } 50% { opacity: 0.9 } }\n` +
  // The "Redo…" dropdown uses a native <details>; hide its default triangle marker.
  `details > summary { list-style: none; }\n` +
  `details > summary::-webkit-details-marker { display: none; }`;

const styles: Record<string, React.CSSProperties> = {
  // Full-height flex column: fixed header on top, a scrolling content region in the middle, and a
  // fixed-height chat dock pinned at the bottom (when a book is open).
  shell: {
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    background: "#11131a",
    color: "#e7e7ee",
    fontFamily: "Georgia, 'Iowan Old Style', serif",
  },
  // The middle region between header and bottom dock — this is what scrolls. `minHeight: 0` is
  // required so the flex child can shrink below its content height and actually scroll.
  contentScroll: { flex: "1 1 auto", overflowY: "auto", minHeight: 0 },
  header: {
    flex: "0 0 auto",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "12px 20px 8px",
    background: "rgba(17,19,26,0.92)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    backdropFilter: "blur(8px)",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
  },
  headerControls: { display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" },
  // --- always-visible workflow strip (inside the sticky header) ---
  workflowBar: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    fontFamily: "system-ui, sans-serif",
  },
  workflowChips: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 },
  stageChip: {
    padding: "2px 8px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.18)",
    opacity: 0.55,
    whiteSpace: "nowrap",
  },
  stageChipActive: {
    opacity: 1,
    border: "1px solid rgba(120,180,255,0.7)",
    background: "rgba(96,170,255,0.15)",
    color: "#cfe2ff",
    animation: "vr-pulse 2s ease-in-out infinite",
  },
  stageChipDone: { opacity: 0.85, border: "1px solid rgba(125,216,127,0.5)", color: "#9fdfa1" },
  stageChipPaused: { opacity: 0.9, border: "1px solid rgba(255,212,121,0.6)", color: "#ffd479" },
  stageArrow: { opacity: 0.35 },
  workflowNow: { marginLeft: 8, opacity: 0.9 },
  actionNote: { marginLeft: "auto", color: "#9fdfa1", fontSize: 12 },
  workflowDetail: { fontSize: 11, opacity: 0.6 },
  // --- the "Redo…" dropdown ---
  menu: { position: "relative" },
  menuSummary: {
    listStyle: "none",
    border: "1px solid rgba(255,255,255,0.3)",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 13,
    userSelect: "none",
  },
  menuList: {
    position: "absolute",
    right: 0,
    top: "calc(100% + 4px)",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    minWidth: 320,
    background: "#1b1e2a",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 8,
    boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
    overflow: "hidden",
  },
  menuItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    padding: "8px 12px",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid rgba(255,255,255,0.07)",
    color: "inherit",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
    fontFamily: "system-ui, sans-serif",
  },
  upload: {
    border: "1px solid rgba(255,255,255,0.3)",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 13,
  },
  button: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.3)",
    color: "inherit",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 13,
  },
  buttonPrimary: {
    background: "rgba(96,170,255,0.18)",
    border: "1px solid rgba(120,180,255,0.6)",
    color: "#cfe2ff",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  smallButton: {
    background: "rgba(90,209,155,0.12)",
    border: "1px solid rgba(90,209,155,0.5)",
    color: "inherit",
    borderRadius: 6,
    padding: "3px 9px",
    cursor: "pointer",
    fontSize: 12,
  },
  status: { padding: "10px 20px", color: "#ffd479" },
  bibleStatus: { padding: "4px 20px 0", fontSize: 12, opacity: 0.75, fontFamily: "system-ui, sans-serif" },
  badges: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    padding: "8px 20px 0",
    fontFamily: "system-ui, sans-serif",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    lineHeight: 1.4,
    padding: "3px 9px",
    borderRadius: 999,
    border: "1px solid transparent",
    maxWidth: "100%",
  },
  badgeOk: {
    background: "rgba(64,160,96,0.16)",
    borderColor: "rgba(96,200,128,0.4)",
    color: "#9be2b4",
  },
  badgeWarn: {
    background: "rgba(200,140,40,0.16)",
    borderColor: "rgba(230,170,70,0.45)",
    color: "#ffd479",
  },
  badgeBusy: {
    background: "rgba(90,120,200,0.16)",
    borderColor: "rgba(120,150,220,0.45)",
    color: "#bcd0ff",
  },
  badgeErr: {
    background: "rgba(200,60,60,0.16)",
    borderColor: "rgba(230,90,90,0.5)",
    color: "#ff9c9c",
  },
  empty: { padding: "10px 24px 8px", maxWidth: 760, fontSize: 13, opacity: 0.8, lineHeight: 1.5 },
  buddySection: { padding: "0 24px 20px", display: "flex", justifyContent: "center" },
  // With a book open the chat docks at the bottom of the page (full width), beneath the reader. It's
  // a fixed-height flex child of the shell; its inner panel scrolls. The story workflow/cadence
  // controls sit above it when the book is a "story as you go".
  chatDock: {
    flex: "0 0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 10,
    boxSizing: "border-box",
    background: "#0e0f13",
    borderTop: "1px solid rgba(255,255,255,0.12)",
  },
  // The story dock's control row: workflow + cadence dropdowns and an Illustrate button (no model round).
  storyControls: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  storyControlSelect: {
    background: "rgba(255,255,255,0.08)",
    color: "inherit",
    border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: 6,
    padding: "5px 8px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  // The reader's "view as…" category drop-down (replaces the old static mode badge).
  viewAsSelect: {
    background: "rgba(255,255,255,0.08)",
    color: "inherit",
    border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: 999,
    padding: "4px 8px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  // Full-screen text reader (Document / Plain text views — no illustration window).
  readerDoc: {
    flex: 1,
    overflowY: "auto",
    padding: "24px 24px 40px",
    display: "flex",
    justifyContent: "center",
  },
  readerDocInner: { width: "100%", maxWidth: 760 },
  readerPlainText: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 14,
    lineHeight: 1.6,
    margin: 0,
  },
  // "Lock this look" control under a story beat's image: pin it as a character's reference.
  lockLook: { marginTop: 6, display: "flex", flexDirection: "column", gap: 4 },
  lockLookLabel: { fontSize: 11, opacity: 0.6 },
  lockLookRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  lockLookButton: {
    background: "#23262d",
    color: "#e6e6e6",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 999,
    padding: "3px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
  reader: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 520px)",
    gap: 40,
    padding: "32px 20px 50vh",
    maxWidth: 1400,
    margin: "0 auto",
  },
  // Wider image column for dense multi-panel views (comic page / panel grid).
  readerWide: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(440px, 900px)",
    gap: 40,
    padding: "32px 20px 50vh",
    maxWidth: 1700,
    margin: "0 auto",
  },
  // Data/spreadsheet books: a single FULL-WIDTH column (no reserved illustration pane), so the grid
  // gets the horizontal room a sheet needs instead of squishing into the ~640px reading column.
  readerData: {
    display: "block",
    padding: "32px 20px 50vh",
    maxWidth: 1200,
    margin: "0 auto",
  },
  // Narrow / phone viewport: a single column. Because the grid becomes `display:block`, the image
  // `<aside>` (the second child) flows BELOW the text it illustrates instead of beside it.
  readerNarrow: {
    display: "block",
    padding: "24px 16px 40vh",
    maxWidth: 680,
    margin: "0 auto",
  },
  column: { maxWidth: 640 },
  dataPreview: {
    marginBottom: 24,
    background: "rgba(122,162,255,0.05)",
    border: "1px solid rgba(122,162,255,0.25)",
    borderRadius: 10,
    padding: "8px 12px",
  },
  dataPreviewSummary: { cursor: "pointer", fontSize: 13, fontFamily: "system-ui, sans-serif" },
  page: { marginBottom: 32, transition: "border-color 0.4s ease" },
  sectionActive: {
    borderLeft: "2px solid rgba(120,180,255,0.6)",
    paddingLeft: 16,
    marginLeft: -18,
  },
  chapterHeading: {
    fontSize: 26,
    fontWeight: 700,
    margin: "44px 0 20px",
    paddingTop: 20,
    borderTop: "1px solid rgba(255,255,255,0.12)",
    scrollMarginTop: 80,
  },
  pageDivider: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "8px 0 28px",
    borderTop: "1px dashed rgba(255,255,255,0.12)",
  },
  pageDividerLabel: {
    transform: "translateY(-50%)",
    background: "#11131a",
    padding: "0 10px",
    fontSize: 12,
    letterSpacing: 0.4,
    color: "rgba(255,255,255,0.45)",
    fontFamily: "system-ui, sans-serif",
  },
  paragraph: { fontSize: 19, lineHeight: 1.8, margin: "0 0 18px" },
  codeBlock: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.6,
    margin: "0 0 14px",
    padding: "10px 14px",
    background: "rgba(0,0,0,0.28)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 8,
    overflowX: "auto" as const,
    whiteSpace: "pre" as const,
    tabSize: 2,
  },
  // A small pill in the header that names the kind of document you're in (Story / Technical / Code).
  modeBadge: {
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    color: "rgba(255,255,255,0.82)",
    whiteSpace: "nowrap" as const,
    fontFamily: "system-ui, sans-serif",
  },
  // Full-screen code workspace (code books): a toolbar, an editable monospace area that fills the
  // screen, and the run output below it.
  codeWorkspace: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    height: "calc(100vh - 72px)",
    maxWidth: 1600,
    width: "100%",
    margin: "0 auto",
    padding: "12px 16px 16px",
    boxSizing: "border-box" as const,
  },
  codeToolbar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  codeToolbarTitle: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 14,
    opacity: 0.85,
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
  codeEditor: {
    flex: 1,
    width: "100%",
    resize: "none" as const,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.6,
    color: "#e7e7ee",
    background: "rgba(0,0,0,0.32)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    padding: "12px 14px",
    whiteSpace: "pre" as const,
    overflow: "auto" as const,
    tabSize: 2,
    boxSizing: "border-box" as const,
  },
  // In-app rendered HTML/SVG page (the 👁 Preview), filling the editor area.
  codePreview: {
    flex: 1,
    width: "100%",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    background: "#fff",
    boxSizing: "border-box" as const,
  },
  codeOutput: {
    margin: 0,
    maxHeight: "30vh",
    overflow: "auto" as const,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12.5,
    lineHeight: 1.55,
    color: "#d7dbe6",
    background: "rgba(0,0,0,0.4)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: "10px 12px",
    whiteSpace: "pre-wrap" as const,
  },
  // The editor + its run output (left) sit next to the optional analysis pane (right).
  codeBody: { display: "flex", flex: 1, gap: 12, minHeight: 0 },
  codeMain: { display: "flex", flexDirection: "column" as const, flex: 1, gap: 8, minWidth: 0 },
  codeAnalysis: {
    width: 340,
    flexShrink: 0,
    overflow: "auto" as const,
    background: "rgba(122,162,255,0.05)",
    border: "1px solid rgba(122,162,255,0.22)",
    borderRadius: 8,
    padding: "12px 14px",
    fontFamily: "system-ui, sans-serif",
  },
  codeAnalysisHead: { fontSize: 13, fontWeight: 700, marginBottom: 10, opacity: 0.85 },
  codeAnalysisGroup: { marginBottom: 14 },
  codeAnalysisLabel: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: 0.6,
    opacity: 0.6,
    marginBottom: 6,
  },
  codeAnalysisItem: { fontSize: 12.5, lineHeight: 1.5, marginBottom: 6, color: "rgba(255,255,255,0.85)" },
  codeAnalysisHint: { fontSize: 11.5, opacity: 0.6, lineHeight: 1.5, marginTop: 4 },
  aside: {},
  // The aside is sticky; when its content (image + data charts on technical
  // books) exceeds the viewport it must scroll INTERNALLY — a sticky element's
  // overflow is otherwise unreachable ("no scroll" on technical books).
  panel: {
    position: "sticky",
    top: 80,
    maxHeight: "calc(100vh - 96px)",
    overflowY: "auto",
    paddingRight: 4,
  },
  imageDescription: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 1.4,
    opacity: 0.9,
    fontFamily: "system-ui, sans-serif",
    // The description is the image's full prompt (it can be long, especially with a
    // reference block) — keep it scrollable instead of swallowing the panel.
    maxHeight: "9em",
    overflowY: "auto",
    whiteSpace: "pre-wrap",
  },
  caption: { marginTop: 6, fontSize: 12, opacity: 0.6, fontFamily: "system-ui, sans-serif" },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "8vh 16px",
    zIndex: 50,
    overflowY: "auto",
  },
  modalPanel: {
    width: "min(620px, 100%)",
    background: "#171922",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    fontFamily: "system-ui, sans-serif",
  },
  importTextarea: {
    width: "100%",
    boxSizing: "border-box",
    minHeight: 160,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 8,
    color: "inherit",
    padding: 10,
    fontSize: 12,
    fontFamily: "monospace",
  },
};
