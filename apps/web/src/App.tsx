import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Automatic1111Backend,
  ComfyUIBackend,
  DEFAULT_LOCAL_TEXT_SERVER,
  IndexedDbStore,
  LocalServerLLMProvider,
  LOCAL_IMAGE_MODELS,
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
  stripToolCallJson,
  toolFailureDirective,
  anchorByParagraph,
  bestParagraphIndex,
  conceptIntroductions,
  subjectFromCaption,
  rankLocalFiles,
  formatFileSize,
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
  loadTaskPlans,
  deleteTaskPlan,
  archiveTaskPlan,
  restoreTaskPlan,
  removeIgnore,
  upsertTaskPlan,
  updateTaskStep,
  resolveActiveTaskPlanId,
  sessionLabelForPlan,
  agentBranchName,
  parseGitConflicts,
  countChangedFiles,
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
  buildDelegatePrompt,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_DESC_CHARS,
  MAX_SKILL_BODY_CHARS,
  zipProject,
  PROJECT_ZIP_MIME,
  parseDocImages,
  embedDocImages,
  bytesToBase64,
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
  type BookSource,
  type BookSummary,
  type ChapterDataset,
  type BuddyPersona,
  type BuddyToolCall,
  type BuddyToolResultPayload,
  type ChatTurn,
  type ContextUsage,
  type EncryptedSecrets,
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
  type ExportImage,
  type ExportImages,
} from "@visual-reader/epub";
import { IMPORT_ACCEPT, importBookFile } from "./import-file.js";
import {
  CharacterBible,
  ChatBuddyPanel,
  ChatPanel,
  DataChart,
  Infographic,
  DataTablePreview,
  JsonTreeView,
  SkillsPanel,
  TasksPanel,
  ScheduledTasksPanel,
  CalendarPanel,
  ActivityCenter,
  ActionHistoryPanel,
  RenameExportModal,
  StockChartPanel,
  BrowserPanel,
  OrderReviewModal,
  type CalendarDeadline,
  DEFAULT_SETTINGS,
  DocumentPolishPanel,
  FirstRunWizard,
  ImagePanel,
  PanelGrid,
  LibraryPanel,
  SettingsPanel,
  useScrollDepth,
  ConceptCard,
  ConceptText,
  HtmlParagraph,
  ARTICLE_HTML_STYLE,
  InlineFigure,
  SupportRow,
  type DisplayResult,
  type InstalledModel,
  type LocalBackendId,
  type ProvidersDiagnostics,
  type ReaderSettings,
} from "@visual-reader/ui";
import type { LocalTextServerId } from "@visual-reader/core";
import { loadSampleBook } from "./sample.js";
import { useEngineWorker, type ImportResult, type TestRenderResult } from "./useEngineWorker.js";
import { useActivityLog } from "./useActivityLog.js";
import type { SyncToPhone } from "./remote-sync.js";
import {
  downloadLora,
  downloadModel,
  ensureEngine,
  ensureLocalLlm,
  gpuVramMb,
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
  writeWorkspaceFile,
  gitEnsureRepo,
  gitWorktreeCreate,
  gitCommitAll,
  gitWorktreeDiff,
  gitMergeBranch,
  gitMergeAbort,
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

export function App() {
  const stored = useMemo(loadStoredSettings, []);
  const [settings, setSettings] = useState<ReaderSettings>(stored.settings);
  const [book, setBook] = useState<BookSource | undefined>();
  const [localError, setLocalError] = useState<string>("");
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
  // Split-file component files (text encoders / VAEs) the local engine has, for the
  // Settings dropdowns + the model-aware suggestion. Empty for an all-in-one (A1111) engine.
  const [installedTextEncoders, setInstalledTextEncoders] = useState<string[]>([]);
  const [installedVaes, setInstalledVaes] = useState<string[]>([]);
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
  const [connectingLocalText, setConnectingLocalText] = useState(false);
  const [modelProgress, setModelProgress] = useState<Record<string, number>>({});
  // Which component file of a split-file model is downloading ("file 2/3: …").
  const [downloadStage, setDownloadStage] = useState<Record<string, string>>({});
  // Per-entry file position, to fold per-file Rust progress into one combined bar.
  const multiFile = useRef<Record<string, { index: number; count: number }>>({});
  const [pullProgress, setPullProgress] = useState<Record<string, { status: string; percent?: number }>>({});
  const [engineStatus, setEngineStatus] = useState("");
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
    chat,
    chatTool,
    chatCancel,
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
    void loadSkills(libraryStore).then(setSkills).catch(() => {});
  }, [libraryStore]);
  const openSkills = useCallback(async () => {
    await loadSkills(libraryStore).then(setSkills).catch(() => {});
    setShowSkills(true);
  }, [libraryStore]);
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
    void loadTaskPlans(libraryStore).then(setTaskPlans).catch(() => {});
  }, [libraryStore]);
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
  const openTasks = useCallback(async () => {
    await loadTaskPlans(libraryStore).then(setTaskPlans).catch(() => {});
    setShowTasks(true);
  }, [libraryStore]);
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
  // Landing-page buddy (persisted under its own key; finds + opens books via tools).
  const [buddyMessages, setBuddyMessages] = useState<StoredChatMessage[]>([]);
  const [buddyBusy, setBuddyBusy] = useState(false);
  const [buddyStreaming, setBuddyStreaming] = useState("");
  // Mirror of the live stream, so when a tool fires mid-message we can KEEP any prose the model
  // said first (a briefing) instead of losing it when the turn's final answer replaces the stream.
  const buddyStreamingRef = useRef("");
  const [buddyThinking, setBuddyThinking] = useState("");
  const [buddyActivity, setBuddyActivity] = useState("");
  // A running log of the steps (tools) the buddy takes this turn, so its process is visible.
  const [buddySteps, setBuddySteps] = useState<string[]>([]);
  const [buddyPersona, setBuddyPersona] = useState<BuddyPersona>("freeform");
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
    [persistSessions],
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
  // The model-facing history of the turn that produced a pendingTool — so an
  // approved run_command can auto-react with the exact context up to its call.
  const pendingBuddyHistory = useRef<ChatTurn[]>([]);
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

  // Desktop: when the local image path is selected, make sure the GPU engine is
  // installed + running (downloads on first use) and learn its base URL + models.
  useEffect(() => {
    if (!isDesktop || settings.imageProvider !== "local" || settings.engineBaseUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        setEngineStatus("Setting up the local engine…");
        const baseUrl = await ensureEngine(settings.lowVram);
        const models = await listLocalModels();
        const loras = await listLoras();
        // Detect each LoRA's base architecture (reads only the safetensors header) so the
        // UI can flag one that won't load on the active model.
        const families = await loraFamilies();
        if (cancelled) return;
        // Detect VRAM once so Auto-quality stays within what the card can render
        // (best-effort; undefined on non-NVIDIA GPUs leaves Auto uncapped).
        const vram = await gpuVramMb();
        if (cancelled) return;
        setEngineStatus("");
        setInstalledModels(models);
        setInstalledLoras(loras);
        setLoraFamilyMap(families);
        // The managed engine is ComfyUI — read its text-encoder + VAE files over the HTTP API
        // (same as the web "connect" path) so the split-file dropdowns are populated on desktop too.
        try {
          const comps = await new ComfyUIBackend({ baseUrl }).listComponents();
          if (!cancelled) {
            setInstalledTextEncoders(comps.textEncoders);
            setInstalledVaes(comps.vaes);
          }
        } catch {
          /* leave components empty — the fields fall back to manual entry */
        }
        setSettings((s) => ({ ...s, engineBaseUrl: baseUrl, ...(vram ? { gpuVramMb: vram } : {}) }));
      } catch (err) {
        if (!cancelled) {
          setEngineStatus("");
          setLocalError(`Local engine setup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.imageProvider, settings.engineBaseUrl]);

  // Download a catalog model: every component file of a split-file model (diffusion
  // model + text encoder + VAE, each into its ComfyUI subfolder), or the single
  // checkpoint. Sequential, with one combined progress bar; already-present files
  // are skipped on the Rust side, so a retry resumes where it failed. On success
  // the model is auto-selected so it "just works".
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
      setSettings((s) => ({ ...s, localModel: model.filename }));
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

  // Browser path: connect to a self-hosted engine (AUTOMATIC1111 / ComfyUI),
  // read its installed checkpoints, and remember the server for next time.
  const onConnectLocalServer = useCallback(async (backend: LocalBackendId, url: string) => {
    setLocalError("");
    setConnectingLocal(true);
    try {
      const engine =
        backend === "a1111" ? new Automatic1111Backend({ baseUrl: url }) : new ComfyUIBackend({ baseUrl: url });
      const models = await engine.listModels();
      setInstalledModels(models);
      // Also list the separate text-encoder + VAE files (for the split-file dropdowns).
      // Best-effort: a failure just leaves the dropdowns as manual entry.
      try {
        const comps = await engine.listComponents();
        setInstalledTextEncoders(comps.textEncoders);
        setInstalledVaes(comps.vaes);
      } catch {
        /* leave components empty */
      }
      setSettings((s) => {
        const keep = s.localModel && models.some((m) => m.id === s.localModel);
        const localModel = keep ? s.localModel : models[0]?.id;
        return {
          ...s,
          localBackend: backend,
          localServerUrl: url,
          engineBaseUrl: url,
          ...(localModel ? { localModel } : {}),
        };
      });
    } catch (err) {
      const name = backend === "a1111" ? "AUTOMATIC1111" : "ComfyUI";
      setLocalError(
        `Couldn't reach ${name} at ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Make sure it's running with its API and CORS enabled for ${location.origin}.`,
      );
    } finally {
      setConnectingLocal(false);
    }
  }, []);

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
    setBook(undefined);
    closeBook();
  }, [closeBook, chatCancel]);

  // Load the library on mount (recent books to switch between).
  useEffect(() => {
    void libraryStore.listBooks().then(setLibrary).catch(() => {});
  }, [libraryStore]);

  const onPickBook = useCallback(
    async (id: string) => {
      if (!id || id === book?.id) return;
      // On a linked phone, opening happens on the DESKTOP (which then pushes the book back).
      if (isRemoteClient) {
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
      void libraryStore
        .removeBook(id)
        .then(() => libraryStore.listBooks())
        .then(setLibrary)
        .catch(() => {});
    },
    [libraryStore],
  );

  // PHONE MIRROR: a linked phone shows exactly what THIS desktop shows — its library, the open
  // book, that book's analysis (bible), and the render-affecting settings. The desktop is the
  // source of truth and pushes its state down the relay; the phone renders it and sends back
  // high-level commands (open a library book, go home). The engine stays on the desktop, so
  // illustrate/analyse/chat the phone triggers run here and stream their results back — the phone
  // never needs its own image model or data. (`isRemoteClient` ⇒ this tab IS the phone.)
  const [remoteHost, setRemoteHost] = useState<string | undefined>();
  const buildSnapshot = useCallback(
    (): SyncToPhone => ({
      type: "vrsync:state",
      host: "this desktop",
      library,
      settings,
      ...(book ? { book } : {}),
      ...(bible ? { bible } : {}),
    }),
    [library, settings, book, bible],
  );
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
            setBook(msg.book);
            setBible(msg.bible);
            setRemoteHost(msg.host);
            break;
          case "vrsync:library":
            setLibrary(msg.library);
            break;
          case "vrsync:settings":
            setSettings(msg.settings);
            break;
          case "vrsync:book":
            setBook(msg.book);
            setBible(msg.bible);
            break;
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
          case "vrcmd:home":
            setBook(undefined);
            closeBook();
            break;
          default:
            break;
        }
      }
    });
  }, [isRemoteClient, setAppSyncHandler, sendAppSync, setBible, libraryStore, openBook, closeBook]);
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
    async (file: File) => {
      try {
        const imported = await importBookFile(file);
        if (imported.kind === "book") {
          openBook(imported.book);
        } else if (imported.kind === "image") {
          // A picture isn't a book — open it in the photo-transform (img2img) panel.
          setPhotoInitial({ name: imported.name, bytes: imported.bytes, mimeType: imported.mimeType });
          setShowPhoto(true);
        } else {
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
    [openBook],
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
    void libraryStore.getMemo?.("google-tokens").then((t) => setGoogleConnected(!!t)).catch(() => {});
    void libraryStore.getMemo?.("google-email").then((e) => setGoogleEmail(e || undefined)).catch(() => {});
  }, [libraryStore]);
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
      if (!googleConnected) return { ok: false, count: 0 };
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
    [googleConnected, loadCalendar],
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
  // `remoteLink` is the running server (kept while the panel is closed, so the URL + pairing
  // token stay CONSTANT across re-opens); `showRemoteLink` only controls the modal's visibility.
  const [remoteLink, setRemoteLink] = useState<RemoteServerStatus | null>(null);
  const [showRemoteLink, setShowRemoteLink] = useState(false);
  const bridgeToRelay = useCallback(
    (status: RemoteServerStatus, token: string) => {
      if (status.running && status.port) startHostBridge(`ws://127.0.0.1:${status.port}/`, token);
    },
    [startHostBridge],
  );
  // On desktop startup, adopt an already-running relay so a reload doesn't lose (or duplicate) it.
  useEffect(() => {
    if (!isDesktop) return;
    void remoteServerStatus().then((s) => {
      if (s.running) {
        setRemoteLink(s);
        if (s.token) bridgeToRelay(s, s.token);
      }
    });
  }, [bridgeToRelay]);
  // Open the panel WITHOUT restarting a live server: reuse the running one (same URL/token) and
  // only mint a new token + start a server when nothing is listening yet.
  const openRemoteLink = useCallback(async () => {
    const existing = remoteLink?.running ? remoteLink : await remoteServerStatus();
    if (existing.running) {
      setRemoteLink(existing);
      setShowRemoteLink(true);
      if (existing.token) bridgeToRelay(existing, existing.token);
      return;
    }
    const token = generatePairingToken();
    const status = await startRemoteServer(token);
    setRemoteLink(status);
    setShowRemoteLink(true);
    bridgeToRelay(status, token);
  }, [remoteLink, bridgeToRelay]);
  // Explicit stop (the only thing that rotates the link): tear down the bridge + server.
  const stopRemoteLink = useCallback(async () => {
    stopHostBridge();
    await stopRemoteServer();
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
    [testRender],
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
    setChatPendingTool(undefined);
    setChatBusy(true);
    setChatActivity("Generating the image…");
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
      setBuddySessions(sessions);
      setActiveBuddyId(active);
      if (hist) setBuddyMessages(hist);
      buddyReady.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryStore]);
  // Persist the ACTIVE session's history (debounced). Deletion is explicit (clear /
  // delete session), so an empty conversation just stores nothing — never wiping a
  // session before its history has loaded.
  useEffect(() => {
    if (!buddyReady.current || buddyMessages.length === 0) return;
    const id = activeBuddyId;
    const t = setTimeout(() => void libraryStore.putChatHistory?.(id, buddyMessages), 500);
    return () => clearTimeout(t);
  }, [buddyMessages, activeBuddyId, libraryStore]);

  const appendBuddy = (msg: Omit<StoredChatMessage, "at">) =>
    setBuddyMessages((prev) => [...prev, { ...msg, at: Date.now() }]);
  // A reference line posted to the buddy chat when an out-of-chat button does something (scan,
  // plan, create task), so the buddy thread is a running record of "what worked". A `tool`-role
  // note renders as a system line (like a delegated-subtask note), not as the assistant talking.
  buddyNoteRef.current = (text: string) => appendBuddy({ role: "tool", text });

  // Open a local file the desktop `/find` surfaced: read its bytes via the Rust
  // bridge, then run it through the SAME importer as an upload.
  const onOpenLocalFile = useCallback(
    async (path: string) => {
      try {
        const file = await readLocalFile(path);
        await onUpload(file);
      } catch (err) {
        setLocalError(`Couldn't open that file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [onUpload],
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
        appendBuddy({
          role: "tool",
          text: `Found ${ranked.length} file${ranked.length === 1 ? "" : "s"} — click one, or say “open #N”:`,
          files: ranked.map((f, i) => ({
            path: f.path,
            name: `${i + 1}. ${f.name}${formatFileSize(f.size) ? ` · ${formatFileSize(f.size)}` : ""}`,
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
      `$ ${call.command}\n[exit ${r.code}${r.timedOut ? " · timed out" : ""}]` +
      (r.stdout ? `\n${r.stdout.slice(0, 4000)}` : "") +
      (r.stderr ? `\n⚠ ${r.stderr.slice(0, 2000)}` : "");
    appendBuddy({ role: "tool", text: summary, turns: [...pre, { role: "user", content: feedback }] });
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
        const saved = await writeWorkspaceFile(call.path, call.content, cwd);
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
  const onApproveAgentTool = (id: number): void => {
    const ctx = agentApprovalCtx.current.get(id);
    agentApprovalCtx.current.delete(id);
    setAgentApprovals((q) => q.filter((a) => a.id !== id));
    if (ctx) void executeAgentTool(ctx.call, ctx.cwd).then(ctx.resolve);
  };
  const onDenyAgentTool = (id: number): void => {
    const ctx = agentApprovalCtx.current.get(id);
    agentApprovalCtx.current.delete(id);
    setAgentApprovals((q) => q.filter((a) => a.id !== id));
    ctx?.resolve({ error: "the reader declined this step — try a different approach or stop here" });
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
          // Phase 1: don't auto-resolve — abort so the working tree stays clean, leave the branch.
          merge = parseGitConflicts(`${m.stdout}\n${m.stderr}`).length ? "conflict" : "failed";
          await gitMergeAbort(root).catch(() => {});
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

  // write_file (Autonomous workspace): save the file the model authored into the workspace, then
  // feed the result back so it can run_command it. Mirrors approveRunCommand; runs without a click.
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
    if (!(settings.allowCommands && settings.autonomousWorkspace)) {
      // write_file is only advertised with Autonomous workspace on; if it slips through otherwise,
      // degrade by handing the content to the reader to save rather than dead-ending.
      appendBuddy({
        role: "tool",
        text: `🔒 Turn on Autonomous workspace (Settings → assistant abilities) to let me save files directly. Meanwhile, here's “${call.path}” to save yourself:`,
      });
      appendBuddy({ role: "assistant", text: "```\n" + call.content.slice(0, 8000) + "\n```" });
      return;
    }
    setBuddyBusy(true);
    setBuddyActivity(`Writing ${call.path}…`);
    let payload: { path: string; ok: boolean; error?: string };
    try {
      const saved = await writeWorkspaceFile(call.path, call.content, buddyWorkingDir || undefined);
      payload = { path: saved, ok: true };
      appendBuddy({ role: "tool", text: `📝 Saved ${saved}`, turns: [] });
    } catch (err) {
      payload = { path: call.path, ok: false, error: err instanceof Error ? err.message : String(err) };
      appendBuddy({ role: "tool", text: `⚠ Couldn't write ${call.path}: ${payload.error}`, turns: [] });
    }
    const feedback = formatBuddyToolResult(call, { writeFile: payload });
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

  // Run an approved generate_image call: render it, show it, and feed the outcome back.
  // Shared by the approval modal and full-autonomy auto-run.
  const approveGenerateImage = async (call: Extract<BuddyToolCall, { tool: "generate_image" }>): Promise<void> => {
    setBuddyPendingTool(undefined);
    setBuddyBusy(true);
    setBuddyActivity("Generating the image…");
    const out = await chatTool(call, {
      onProgress: (f) => setBuddyActivity(`Generating the image… ${Math.round(f * 100)}%`),
    });
    setBuddyBusy(false);
    setBuddyActivity("");
    const feedback = formatToolResult(call, {
      image: { ok: Boolean(out.image), ...(out.error ? { error: out.error } : {}) },
    });
    appendBuddy({
      role: "tool",
      text: out.error ? `⚠ Image generation failed: ${out.error}` : "",
      ...(out.image ? { image: out.image } : {}),
      turns: [...pendingBuddyTranscript.current, { role: "user", content: feedback }],
    });
    pendingBuddyTranscript.current = [];
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

  // (when set) is shown as the reader's message; a continuation passes none — its
  // "input" is the tool feedback, recorded in the visible result above it.
  const dispatchBuddyTurn = async (
    history: ChatTurn[],
    userText: string,
    userBubbleText?: string,
  ): Promise<string | undefined> => {
    const seq = ++buddyTurnSeq.current; // guard: ignore if Clear/cancel supersedes it
    if (userBubbleText !== undefined) appendBuddy({ role: "user", text: userBubbleText });
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
      else if (e.kind === "tool") {
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
        openedBook = true;
        buddyHandoff.current = [...buddyMessages, { role: "user" as const, text: userBubbleText ?? userText, at: Date.now() }]
          .slice(-12)
          .map(({ turns: _turns, ...m }) => m);
        openBook(e.book);
        if (e.visuals) startGeneration();
        setShowChat(true);
      } else {
        setBuddyActivity("");
        // The agent just read/wrote the calendar or tasks — reflect it in the app's views.
        if (e.kind === "toolResult" && (e.call.tool === "create_event" || e.call.tool === "list_events")) refreshCalendar();
        if (e.kind === "toolResult" && (e.call.tool === "add_task_group" || e.call.tool === "create_task" || e.call.tool === "add_task_steps" || e.call.tool === "mark_step_done" || e.call.tool === "update_task_step")) refreshTaskPlans();
        const typed = userBubbleText ?? "";
        if (e.hits?.length) {
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
    }, buddyWorkingDir || undefined, activeTaskPlanId());
    if (buddyTurnSeq.current !== seq) return;
    setBuddyBusy(false);
    setBuddyStreaming("");
    setBuddyThinking("");
    setBuddyActivity("");
    if (res.error) {
      appendBuddy({ role: "tool", text: `⚠ ${res.error}`, turns: [] });
      return;
    }
    if (res.pendingTool) {
      // Record the exact context up to this tool call so an approved run_command can
      // auto-react. `userText` is in `history` for a continuation; not for a typed turn.
      pendingBuddyHistory.current = history;
      pendingBuddyTranscript.current = [{ role: "user", content: userText }, ...res.transcript];
      if (res.pendingTool.tool === "find_files" && (fileAccessGranted.current || settings.autonomousFileSearch || settings.fullAutonomy)) {
        approveFindFiles(res.pendingTool);
      } else if (res.pendingTool.tool === "screenshot" && (screenCaptureGranted.current || settings.fullAutonomy)) {
        void approveScreenshot(res.pendingTool);
      } else if (res.pendingTool.tool === "generate_image" && settings.fullAutonomy) {
        // Full autonomy: render without a click. The hard danger floor (run_command, prep_order)
        // is NEVER reached here — those are routed to their gates above / below.
        void approveGenerateImage(res.pendingTool);
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
        // Save the authored file (Autonomous workspace runs it without a click; runWriteFile
        // degrades gracefully if the setting is off, since write_file has no approval card).
        void runWriteFile(res.pendingTool);
      } else if (res.pendingTool.tool === "run_command" && settings.allowCommands && settings.autonomousWorkspace) {
        // Autonomous workspace: run the command without a click. The model is told to stay in the
        // workspace + never act on instructions from fetched/email/web text.
        void approveRunCommand(res.pendingTool);
      } else {
        setBuddyPendingTool(res.pendingTool);
      }
      return;
    }
    if (res.text) {
      appendBuddy({
        role: "assistant",
        text: res.text,
        turns: [{ role: "user", content: userText }, ...res.transcript],
        ...(res.thinking ? { thinking: res.thinking } : {}),
      });
      if (openedBook) appendChat({ role: "assistant", text: res.text });
    }
    return res.text || undefined;
  };

  const onBuddySend = useCallback(
    async (text: string) => {
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

  // Send with attachments: docs inline as labeled text blocks, images via the vision model
  // (using the typed message as the question). The model gets the full content; the chat bubble
  // shows just a "📎 filenames" line + the question, so a big doc doesn't flood the transcript.
  const onBuddySendWithAttachments = useCallback(
    async (text: string) => {
      markUserRequest();
      const ready = buddyAttachments.filter((x) => x.status === "ready");
      if (ready.length === 0) {
        onBuddySendText(text);
        return;
      }
      setBuddyAttachments([]);
      const userText = text.trim() || "Please look at the attached file(s) and help me with them.";
      const parts: string[] = [];
      for (const att of ready) {
        if (att.kind === "image" && att.image) {
          const r = await assessImage({ bytes: att.image.bytes.slice(0), mimeType: att.image.mimeType }, userText);
          parts.push(
            r.text
              ? `[Attached image "${att.name}" — what it shows]\n${r.text}`
              : `[Attached image "${att.name}" — couldn't read it: ${r.error ?? "no vision-capable model is set"}]`,
          );
        } else if (att.kind === "doc" && att.text) {
          parts.push(`[Attached file "${att.name}"]\n${att.text}`);
        }
      }
      const combined = parts.length ? `${parts.join("\n\n")}\n\n${userText}` : userText;
      const bubble = `📎 ${ready.map((a) => a.name).join(", ")}\n${userText}`;
      await dispatchBuddyTurn(chatTurnsOf(buddyMessages), combined, bubble);
    },
    [buddyAttachments, assessImage, onBuddySendText, buddyMessages],
  );

  // Scheduled-task runner: while the app is open, every ~minute fire the FIRST due task
  // into the buddy chat (so the assistant executes its instruction), then advance its
  // schedule. One per tick, and never while a turn is in flight, so it can't stampede.
  const buddyBusyRef = useRef(buddyBusy);
  buddyBusyRef.current = buddyBusy;
  useEffect(() => {
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
  }, [libraryStore, onBuddySendText, refreshScheduled]);

  // Remote bus (phone↔Google↔desktop): when enabled + Google's connected, poll the user's
  // Google Tasks for "VR:" commands they added from their phone, run each through the buddy,
  // write the answer back into the task, and mark it done. Reuses the existing buddy turn —
  // no server, no always-on daemon (the app must be open). One command per tick, never while
  // a turn is in flight, deduped so a slow run can't double-fire.
  const busProcessed = useRef<Set<string>>(new Set());
  const busPollingRef = useRef(false);
  useEffect(() => {
    if (!googleConnected || !settings.remoteBus) return;
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
  }, [googleConnected, settings.remoteBus, remoteBusList, remoteBusReply, buddyMessages]);

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
    if (call?.tool === "find_files") {
      approveFindFiles(call);
      return;
    }
    if (call?.tool === "run_command") {
      void approveRunCommand(call);
      return;
    }
    if (call?.tool === "screenshot") {
      void approveScreenshot(call);
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
    if (!call || call.tool !== "generate_image") return;
    await approveGenerateImage(call);
  }, [buddyPendingTool, chatTool]);
  const onApproveBuddyPendingTool = useCallback(() => void onApproveBuddyTool(), [onApproveBuddyTool]);
  // "Allow this session": grant the pending capability (file search OR screen
  // capture) so later same-kind calls run without re-prompting, then run this one.
  const onAllowBuddyAlways = useCallback(() => {
    const call = buddyPendingTool;
    if (call?.tool === "find_files") {
      fileAccessGranted.current = true;
      approveFindFiles(call);
    } else if (call?.tool === "screenshot") {
      screenCaptureGranted.current = true;
      void approveScreenshot(call);
    }
  }, [buddyPendingTool]);
  const onDismissBuddyPendingTool = useCallback(() => {
    setBuddyPendingTool(undefined);
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
  }, []);
  const onClearBuddy = useCallback(() => {
    buddyTurnSeq.current++;
    buddyCancel();
    setBuddyBusy(false);
    setBuddyStreaming("");
    setBuddyActivity("");
    setBuddyMessages([]);
    setBuddyPendingTool(undefined);
    void libraryStore.deleteChatHistory?.(activeBuddyId);
  }, [libraryStore, buddyCancel, activeBuddyId]);

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
    setBuddyPendingTool(undefined);
    pendingBuddyTranscript.current = [];
    pendingBuddyHistory.current = [];
  }, [buddyCancel]);
  const onSwitchBuddySession = useCallback(
    (id: string) => {
      if (id === activeBuddyId) return;
      resetBuddyView();
      void libraryStore.putMemo?.("buddy-active-session", id).catch(() => {});
      void libraryStore.getChatHistory?.(id).then((hist) => {
        setActiveBuddyId(id);
        setBuddyMessages(hist ?? []);
      });
    },
    [activeBuddyId, libraryStore, resetBuddyView],
  );
  const onNewBuddySession = useCallback(() => {
    const id = `${BUDDY_CHAT_ID}-${Date.now().toString(36)}`;
    resetBuddyView();
    setBuddySessions((prev) => {
      const next = [...prev, { id, workingDir: "" }];
      persistSessions(next);
      return next;
    });
    setActiveBuddyId(id);
    setBuddyMessages([]);
    void libraryStore.putMemo?.("buddy-active-session", id).catch(() => {});
  }, [libraryStore, persistSessions, resetBuddyView]);
  const onDeleteBuddySession = useCallback(
    (id: string) => {
      setBuddySessions((prev) => {
        if (prev.length <= 1) return prev; // keep at least one session
        const next = prev.filter((s) => s.id !== id);
        persistSessions(next);
        void libraryStore.deleteChatHistory?.(id).catch(() => {});
        if (id === activeBuddyId) {
          const fallback = next[0]!.id;
          resetBuddyView();
          void libraryStore.putMemo?.("buddy-active-session", fallback).catch(() => {});
          void libraryStore.getChatHistory?.(fallback).then((hist) => {
            setActiveBuddyId(fallback);
            setBuddyMessages(hist ?? []);
          });
        }
        return next;
      });
    },
    [activeBuddyId, libraryStore, persistSessions, resetBuddyView],
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

  // Stable per-index delete handlers (memoised bubbles take the SAME function).
  const onDeleteBuddyMessage = useCallback((index: number) => {
    setBuddyMessages((prev) => prev.filter((_, i) => i !== index));
  }, []);
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
  const buddyPanelMessages = useMemo(
    () =>
      buddyMessages.map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.image ? { image: m.image } : {}),
        ...(m.links ? { links: m.links } : {}),
        ...(m.gallery ? { gallery: m.gallery } : {}),
        ...(m.files ? { files: m.files } : {}),
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

  return (
    <div style={styles.shell}>
      <style>{KEYFRAMES}</style>
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
          {book && (
            <button
              style={styles.button}
              onClick={() => setShowChat(true)}
              title="Chat about what you're reading — it knows the book (spoiler-safely), can search the web, and can generate images"
            >
              Chat
            </button>
          )}
          {book && !generating && (
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
            onChange={setSettings}
            isDesktop={isDesktop}
            installedModels={installedModels}
            installedTextEncoders={installedTextEncoders}
            installedVaes={installedVaes}
            onDownloadModel={onDownloadModel}
            onDownloadModelUrl={onDownloadModelUrl}
            downloadProgress={modelProgress}
            downloadStage={downloadStage}
            engineStatus={engineStatus}
            installedLoras={installedLoras}
            loraFamilies={loraFamilyMap}
            onDownloadStyleLora={onDownloadStyleLora}
            onConnectLocalServer={onConnectLocalServer}
            connectingLocal={connectingLocal}
            textModels={textModels}
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
        </div>
        </div>
        {book && (
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

      {!settings.configured && !isRemoteClient && (
        <FirstRunWizard current={settings} onComplete={setSettings} isDesktop={isDesktop} />
      )}

      {/* On a linked phone the engine lives on the desktop — show the link, not a "set up a model"
          nag or local-provider badges (those reflect a model the phone will never run). */}
      {isRemoteClient ? (
        <div style={styles.badges}>
          <span style={{ ...styles.badge, ...styles.badgeOk }} title="This phone is mirroring your desktop over the LAN; the engine runs there.">
            🔗 Linked to {remoteHost ?? "your desktop"} — engine runs on the desktop
          </span>
        </div>
      ) : (
        <ProviderBadges providers={providers} engineStatus={engineStatus} />
      )}

      {/* Status center: what the app is doing right now + the queue behind it (task planning keeps
          running after you leave the Tasks window, so this is how you keep an eye on it). */}
      <ActivityCenter activities={activities} />
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

      {!book && (
        <section style={styles.buddySection}>
          <ChatBuddyPanel
            messages={buddyPanelMessages}
            {...(buddyStreaming ? { streamingText: buddyStreaming } : {})}
            {...(buddyThinking ? { thinking: buddyThinking } : {})}
            busy={buddyBusy}
            {...(buddyActivity ? { activity: buddyActivity } : {})}
            {...(buddySteps.length ? { steps: buddySteps } : {})}
            {...(buddyPendingTool ? { pendingTool: buddyPendingTool } : {})}
            persona={buddyPersona}
            onPersonaChange={setBuddyPersona}
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
            onCancel={buddyCancel}
            onClearHistory={onClearBuddy}
            onDeleteMessage={onDeleteBuddyMessage}
            onCompact={onCompactBuddyClick}
            desktop={isDesktop}
            {...(isDesktop && settings.allowCommands
              ? { workingDir: buddyWorkingDir, onSetWorkingDir: setWorkingDir, onPickFolder: pickFolder }
              : {})}
            onOpenLocalFile={onOpenLocalFile}
            onSaveFile={onSaveChatFile}
            onSaveProject={onSaveProject}
            onBuildDocument={onBuildDocument}
            {...(buddyUsage ? { contextUsage: buddyUsage } : {})}
          />
        </section>
      )}

      {book && (
        <main style={wideImageColumn ? styles.readerWide : styles.reader}>
          <ReaderColumn
            book={book}
            pageToUnit={units?.pageToUnit}
            unitIndex={unitIndex}
            pagesPerImage={pagesPerImage}
            registerParagraph={registerParagraph}
            dataEdit={dataEdit}
            onAddAnalysisSheet={addAnalysisSheet}
            saveNamed={saveNamed}
            {...(technicalSupport ? { technical: technicalSupport } : {})}
            layoutHtml={articleLayout}
          />

          <aside style={styles.aside}>
            <div style={styles.panel}>
              {/* Technical mode shows its support INLINE, anchored to the source
                  paragraphs (retrieved figures, concept cards) — no generated-art
                  pane, no progressive blur. The aside keeps the data charts. */}
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
        </main>
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
        <TestImageModal onRender={testRender} onAddToChat={onAddImageToChat} onClose={() => setShowTestImage(false)} />
      )}

      {showPhoto && (
        <PhotoTransformModal
          {...(photoInitial ? { initial: photoInitial } : {})}
          onRender={(text, opts) => testRender(text, opts)}
          onAddToChat={onAddImageToChat}
          onExtractText={(img) => void extractTextFromImage(img)}
          onClose={() => {
            setShowPhoto(false);
            setPhotoInitial(undefined);
          }}
        />
      )}

      {showChat && book && (
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
            await saveSkill(libraryStore, { name, description, body });
            refreshSkills();
          }}
          onDelete={async (name) => {
            await forgetSkill(libraryStore, name);
            refreshSkills();
          }}
          onClose={() => setShowSkills(false)}
        />
      )}

      {showTasks && (
        <TasksPanel
          plans={taskPlans}
          planning={planningCount}
          creatingTask={creatingTask}
          onCreateTask={(title, dueIso, recurrence, planNow) => void onCreateTask(title, dueIso, recurrence, planNow)}
          {...(googleConnected ? { onScanNow: () => void scanNow(), scanning: scanningNow } : {})}
          onPlanPending={() => void planAllPending()}
          planningPending={planningCount > 0}
          {...(scanMessage ? { scanMessage } : {})}
          {...(planMessage ? { planMessage } : {})}
          onPlanTask={(id) => void planOneTask(id)}
          onOpenTask={(id) => void openTaskInChat(id)}
          onAdvanceStep={onAdvanceTaskStep}
          onToggleStepDone={onToggleStepDone}
          onIgnoreTask={ignoreTask}
          onAddTaskDetails={(planId, text) => void onAddTaskDetails(planId, text)}
          onDelete={(id) => void removeTask(id)}
          onRestore={(id) => void restoreTask(id)}
          onDeleteForever={(id) => void deleteTaskForever(id)}
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
          onPrev={() => shiftCalendarMonth(-1)}
          onNext={() => shiftCalendarMonth(1)}
          onToday={() => shiftCalendarMonth("today")}
          onOpenTask={(id) => {
            setShowCalendar(false);
            void openTaskInChat(id);
          }}
          {...(googleConnected ? { onCreateEvent: onCreateCalendarEvent } : {})}
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
                  Experimental — needs a desktop build with the phone-link command and on-device verification (see
                  REMOTE-LINK.md). LAN-only; nothing leaves your network. Closing this keeps the server running and the
                  address stable — re-opening shows the same link. Use Stop to end it (which rotates the pairing code).
                </p>
              </>
            ) : (
              <p style={{ fontSize: 13, color: "#ff8c8c", marginTop: 8 }}>⚠ {remoteLink.error ?? "Couldn't start the phone link."}</p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {remoteLink.running ? (
                <button style={styles.button} onClick={() => void stopRemoteLink()}>
                  Stop
                </button>
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

const ReaderColumn = memo(function ReaderColumn({
  book,
  pageToUnit,
  unitIndex,
  pagesPerImage,
  registerParagraph,
  dataEdit,
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
    <article style={styles.column}>
      {layoutHtml && <style>{ARTICLE_HTML_STYLE}</style>}
      {/* An uploaded spreadsheet/CSV/tabular-JSON: show the REAL grid as an aligned
          table up top (the flattened "a | b | c" pipe-text below is what the
          illustration/extraction pipeline reads, but it's no way to look at a sheet).
          A single label+value table also gets an auto-chart. */}
      {activeTable ? (
        <details open style={styles.dataPreview}>
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
    // Drop the transient engine URL + detected VRAM and the plaintext keys; persist
    // the keys only as an encrypted blob (never in plaintext).
    const { keys, engineBaseUrl: _url, gpuVramMb: _vram, ...rest } = s;
    void _url;
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
}: {
  providers: ProvidersDiagnostics | undefined;
  engineStatus: string;
}) {
  if (!providers && !engineStatus) return null;
  return (
    <div style={styles.badges}>
      {providers && <Badge slot="Text" diag={providers.llm} />}
      {providers && <Badge slot="Image" diag={providers.image} />}
      {engineStatus && (
        <span style={{ ...styles.badge, ...styles.badgeBusy }} title="Local GPU engine status">
          Engine: {engineStatus}
        </span>
      )}
    </div>
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
  shell: {
    minHeight: "100vh",
    background: "#11131a",
    color: "#e7e7ee",
    fontFamily: "Georgia, 'Iowan Old Style', serif",
  },
  header: {
    position: "sticky",
    top: 0,
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
  empty: { padding: "10px 24px 8px", maxWidth: 760, fontSize: 13, opacity: 0.8, lineHeight: 1.5 },
  buddySection: { padding: "0 24px 20px", display: "flex", justifyContent: "center" },
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
