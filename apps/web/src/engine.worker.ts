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
  historyBudget,
  trimChatHistory,
  CHARS_PER_TOKEN,
  CHAT_CONTEXT_BUDGET_CHARS,
  LocalServerLLMProvider,
  analyzeData,
  imageModelVramCostGb,
  serverModelVramCostGb,
  chatImageVramFit,
  BUNDLED_LLM_VRAM_GB,
  staleComfyUrlToFree,
  comfyUrlForVideo,
  staleA1111UrlToFree,
  type VideoModelFiles,
  type VideoRenderParams,
  resolveLoadedContextTokens,
  createDataTable,
  recalcTable,
  tableToText,
  yahooQuoteUrl,
  yahooFetchError,
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
  buildFileLedgerBlock,
  buildImageReferenceBlock,
  recentThinkingBlock,
  planHasPendingStep,
  compileWorkflow,
  activeStep,
  MAX_STEP_REMINDERS,
  MAX_STEP_ROUNDS,
  adoptPlanProgress,
  doneWhenToNeeds,
  isToolAvailable,
  evaluateStep,
  attemptedStepWork,
  advanceWorkflow,
  stepDirective,
  workflowToPlan,
  requestedRendersNote,
  buildProjectGuideBlock,
  buildActiveDocumentBlock,
  buildActiveDraftBlock,
  activeDocBudget,
  documentOutline,
  applyFileEdits,
  applyLineUpserts,
  summarizeFileEdits,
  summarizeAmbiguousLines,
  extractSection,
  buildToolCallFormat,
  type CreatedFileRef,
  ollamaToolSchemas,
  toolsetDoc,
  toolsetsForNeeds,
  shouldAppendBeat,
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
  withBuiltinSkills,
  locatePrompt,
  pngSize,
  loadSoul,
  loadSoulName,
  loadSoulImages,
  measureGeneration,
  type GenerationRate,
  describeReferenceSources,
  referenceOutcome,
  type ImageGenerationOutput,
  soulRefSeeds,
  type SoulImage,
  rememberSoul,
  forgetSoul,
  soulContextPromptBlock,
  storySoulCharacterizationPromptBlock,
  selectSoulContextMode,
  buildSoulEssenceDistillationPrompt,
  buildSoulEssenceMergePrompt,
  buildSoulEssenceAbstractionPrompt,
  partitionSoulNotes,
  validateSoulEssence,
  loadSoulEssence,
  loadLatestSoulEssence,
  saveSoulEssence,
  soulSourceFingerprint,
  selfPortraitPrompt,
  userPortraitPrompt,
  isSelfPortraitRequest,
  isUserPortraitRequest,
  storyStatePromptBlock,
  synopsisRequest,
  storyOpeningRequest,
  createStorySoulCast,
  normalizeStorySoulCast,
  validateStorySoulCastAgainstCharacters,
  roleplayStoryTurnPrompt,
  parseStoryOpening,
  storyStartBeats,
  naturalStoryProse,
  SYNOPSIS_REFRESH_EVERY,
  MAX_SYNOPSIS_CHARS,
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
  patchEvent,
  createDraft,
  listDrafts,
  sameDraftTarget,
  editDraft,
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
  retrieveFromHits,
  unsupportedImageFormat,
  normalizeTaskPlan,
  nextOccurrence,
  upsertTaskPlan,
  loadTaskPlans,
  normalizeScheduledTask,
  updateScheduledTaskContent,
  scheduledTaskBlock,
  type VisualReaderStore,
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
  googleParentPatch,
  applyPlanEdit,
  applyTaskDocEdit,
  mergeReplan,
  appendTaskContext,
  filterActionHistory,
  formatActionHistory,
  producedArtifactFrom,
  type ArtifactKind,
  loadActionHistory,
  loadLastScan,
  scanHealthNote,
  harvestTaskContext,
  completeStepById,
  setTaskPlanComplete,
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
  findBibleTermsInText,
  presentFromScene,
  emptyStoryScene,
  createEmptyBible,
  emptyAppearance,
  deterministicSeed,
  ComfyUIBackend,
  Automatic1111Backend,
  summarizeVram,
  type BookSource,
  type StoryScene,
  type StoryRoleplay,
  type StoryPresent,
  type BuddyDeps,
  type BuddyOpenedInfo,
  type BuddyToolCall,
  type BuddyToolResultPayload,
  type ChatTurn,
  type ChatToolDeps,
  type FigureSearch,
  type ImageProvider,
  type LLMProvider,
  type SoulEssence,
  type SoulEssenceDigestInput,
  type SoulContextMode,
  type SoulKind,
  type SoulNote,
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
import { formatBuildStamp, loadBuildStamp } from "./build-stamp.js";
import type { EngineVram, SoulEssenceJobPhase, SoulEssenceJobProgress } from "./remote-sync.js";
import {
  completeSoulEssenceWithRepair,
  type SoulEssenceCompletionFailure,
} from "./soul-essence-completion.js";

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
  | {
      llm: LLMProvider;
      image: ImageProvider;
      tier: TierConfig;
      imageSearch: FigureSearch;
      llmMock: boolean;
      llmLabel: string;
      imageMock: boolean;
    }
  | undefined;
/** In-flight chat rounds, aborted by `chatCancel`. */
const chatAborts = new Map<number, AbortController>();
/** Manual Soul Essence jobs have their own cancellation scope: stopping one must not stop chat. */
const soulEssenceAborts = new Map<number, AbortController>();
/** The validated essence is crossing its atomic persistence boundary; cancellation waits for success. */
const soulEssenceCommits = new Set<number>();
/** At most one low-priority Essence rebuild may occupy the text-model lane during app downtime. */
let idleSoulEssenceRequestId: number | undefined;

const IDLE_SOUL_PREEMPTING_REQUESTS = new Set<MainToWorker["type"]>([
  "init",
  "open",
  "start",
  "resume",
  "resumeBible",
  "resumeImages",
  "regenerateStoryboard",
  "storyRenderLatest",
  "rebuildPrompts",
  "regenerateAllImages",
  "regenerateImage",
  "completeBook",
  "paintForward",
  "testRender",
  "chat",
  "buddyChat",
  "runCodingAgents",
  "resolveConflicts",
  "summarize",
  "planTask",
  "scanInbox",
  "polish",
  "chatTool",
  "chatVideo",
  "assessImage",
  "warmLlm",
]);

function preemptIdleSoulEssence(msg: MainToWorker): void {
  const requestId = idleSoulEssenceRequestId;
  if (requestId === undefined || soulEssenceCommits.has(requestId)) return;
  if (
    IDLE_SOUL_PREEMPTING_REQUESTS.has(msg.type) ||
    (msg.type === "soulEssenceRefresh" && msg.background !== true)
  ) {
    soulEssenceAborts.get(requestId)?.abort();
  }
}

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
  /** Per-beat active-scene SNAPSHOTS (index = beat); persisted so a reopen resumes the exact
   * scene and render_scene of a past beat uses that beat's cast/location. */
  scenes: StoryScene[];
  roleplay?: StoryRoleplay;
  /** Explicit Soul-backed story names. Absent for custom stories, so Souls cannot bleed into them. */
  soulCast?: { self: string; user: string; source: "you-and-me-setup-v1" };
  /** The story workflow: "roleplay" (reader steers a character, the assistant voices everyone) or
   * "direct" (reader directs, the assistant narrates). Drives the writing prompt. */
  mode: "direct" | "roleplay";
  /** Roleplay only: the played character NAMES for authorship boundaries (me = reader, you = assistant). */
  play?: { me?: string; you?: string };
  /** Rolling "story so far" synopsis, refreshed every N beats and fed back to the writer. */
  synopsis?: string;
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
 * signal — the same matcher the render uses, so the tracker never misses one and never invents one).
 *
 * This was a bare `text.includes(name)`, and it is why a place named after a character kept putting
 * that character in the picture even after the render-side fixes: a beat set in "Sato's Synthetic
 * Noodles" reported SATO as mentioned, the tracker added him to the present cast — and the cast is
 * CARRIED FORWARD, so once he was wrongly in he stayed in, beat after beat, until something removed
 * him. findBibleTermsInText applies the same longest-name-wins claim and the possessive rule, and
 * takes the beat's location so the place takes its own span. */
function bibleNamesInText(text: string, bible: VisualBible, location?: string): string[] {
  return findBibleTermsInText(text, bible, location)
    .filter((t) => t.kind === "character")
    .map((t) => t.names[0]!)
    .filter((n): n is string => !!n);
}

/**
 * The names the storyboard says are in this beat's scene (`keyEvent.cast` — extraction is required
 * to fill it). Deduped across the chapter's keyEvents; [] when the bible predates it or the model
 * left it out, in which case the tracker falls back to carrying the previous cast forward.
 */
function castOfScene(scene: { keyEvents?: { cast?: { name: string }[] }[] } | undefined): string[] {
  const names = (scene?.keyEvents ?? []).flatMap((e) => (e.cast ?? []).map((c) => c.name?.trim() ?? ""));
  return [...new Set(names.filter(Boolean))];
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
    {
      mentionedNames: bibleNamesInText(text, bible, scene?.location),
      ...(scene?.location ? { location: scene.location } : {}),
      // The storyboard's own cast for this beat, when extraction gave one — authoritative, so the
      // tracked cast follows the story instead of only ever growing.
      ...(castOfScene(scene).length ? { castNames: castOfScene(scene) } : {}),
    },
    story.roleplay,
  );
  story.scenes[chapterIndex] = story.scene; // snapshot this beat's tracked scene (persisted below)
  // Persist the just-tracked snapshot immediately + durably: extraction is async (it finishes
  // after the chat turn, so a buddy-request reply can't be relied on), so the worker writes the
  // book itself. A reopen's getBook then has the latest beat's scene too (not lagging by one).
  if (currentBook?.kind === "story" && currentBook.id === story.bookId) {
    currentBook = { ...currentBook, storyConfig: storyConfigOf(story) };
    void buddyStore?.putBook(currentBook).catch(() => {});
  }
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

/** The book-persisted view of the live session (role-play, cadence, per-beat scene snapshots),
 * so a reopen resumes the exact scene + contract. */
function storyConfigOf(s: StorySessionState): NonNullable<BookSource["storyConfig"]> {
  return {
    ...(s.roleplay ? { roleplay: s.roleplay } : {}),
    ...(s.soulCast ? { soulCast: s.soulCast } : {}),
    mode: s.mode,
    ...(s.play ? { play: s.play } : {}),
    ...(s.synopsis ? { synopsis: s.synopsis } : {}),
    cadence: s.cadence,
    scenes: s.scenes.map((sc) => ({ presentCharacterIds: [...sc.presentCharacterIds], ...(sc.locationId ? { locationId: sc.locationId } : {}) })),
  };
}

/** Persist the live story session onto the open book's storyConfig and hand it to the host (setBook +
 * putBook), with NO new beat — used by the header controls (cadence / mode) that the reader changes
 * directly. `requestId: 0` marks a host-initiated (non-turn) update. */
function persistStoryConfig(): void {
  if (story && currentBook?.kind === "story" && currentBook.id === story.bookId) {
    currentBook = { ...currentBook, storyConfig: storyConfigOf(story) };
    post({ type: "storyConfig", requestId: 0, book: currentBook });
  }
}

/** The live STORY STATE block fed to the WRITING model each beat (present cast + location from the
 * tracker, the last few beats verbatim, and the rolling synopsis) — so a long story keeps continuity
 * even after chat history is trimmed. "" when there's nothing to say. */
/**
 * Toolsets loaded per chat session, remembered across turns.
 *
 * A conversation that turns to code loads the coding documentation once and keeps it — paying the
 * round-trip on every later turn would be worse than never having deferred it. Cleared when the chat
 * is cleared, since a fresh conversation is a fresh set of needs.
 */
const loadedToolsetsBySession = new Map<string, string[]>();
/**
 * Deliberately UNBOUNDED. A cap would have to evict by load ORDER, since a loaded set is used without
 * passing through the loader again and so leaves no trace of recency — meaning a set in constant use
 * would be dropped for one loaded once and forgotten. That is a mid-conversation reset with no reason
 * the reader can see, which is the exact defect fixed above. A conversation that has genuinely needed
 * five capabilities is a conversation that needs five capabilities; the common case is one or two.
 */

/** The prompt options that decide what this ENVIRONMENT can offer, shared by the prompt and the
 * per-toolset documents so the two can never disagree about what exists. */
function buildStoryStateBlock(s: StorySessionState): string {
  const bible = currentBible;
  const presentCast = (s.scene.presentCharacterIds ?? []).map((id) => {
    const c = bible?.characters.find((ch) => ch.id === id);
    const name = c?.name ?? id;
    const note = c?.persistentTraits?.slice(0, 2).join(", ");
    return note ? { name, note } : { name };
  });
  const location = s.scene.locationId ? bible?.environments.find((e) => e.id === s.scene.locationId)?.name : undefined;
  return storyStatePromptBlock({
    mode: s.mode,
    ...(s.play ? { play: s.play } : {}),
    presentCast,
    ...(location ? { location } : {}),
    recentBeats: s.beats.slice(-3),
    ...(s.synopsis ? { synopsis: s.synopsis } : {}),
  });
}

/** Rebuild the story session from a reopened story book (fresh worker / library reopen).
 * Per-beat scene snapshots are RE-DERIVED from the beats + the restored bible, not trusted from
 * `storyConfig.scenes`. The tracker is a pure function of exactly those inputs, so a replay normally
 * reproduces the saved snapshots — but it also REPAIRS them, which matters: the old name scan added a
 * character to the cast whenever a place was named after them, and the cast carries forward, so one
 * bad beat kept them in every picture from then on. Trusting the snapshot would preserve that
 * forever. A snapshot's location is kept where the replay can't recover one (its beat's storyboard
 * entry is gone), since that's the one thing re-derivation can lose.
 * Role-play + cadence are restored from `storyConfig`, so the contract survives, not defaults. */
function rebuildStoryFromBook(book: BookSource, bible: VisualBible | undefined): StorySessionState {
  const beats = beatsFromBook(book);
  const roleplay = book.storyConfig?.roleplay;
  const cadence = book.storyConfig?.cadence ?? { mode: "per-response" as const, n: 3 };
  const persisted = book.storyConfig?.scenes ?? [];
  // A persisted marker is portable/importable data, not proof by itself. Restore Soul ownership
  // only after the story's Bible is available and confirms both mapped canonical cast names.
  const soulCast = validateStorySoulCastAgainstCharacters(
    book.storyConfig?.soulCast,
    bible?.characters,
  );
  const scenes: StoryScene[] = [];
  let running: StoryScene = emptyStoryScene();
  beats.forEach((text, k) => {
    const snap = persisted[k];
    if (bible) {
      // Same inputs the live tracker used: this beat's mentioned cast + its scene location + the
      // role-play seed. Deterministic, so this reproduces a good snapshot and corrects a bad one.
      const s = bible.storyboard.find((x) => x.chapterIndex === k);
      running = advanceStoryScene(
        running,
        bible,
        {
          mentionedNames: bibleNamesInText(text, bible, s?.location),
          ...(s?.location ? { location: s.location } : {}),
          ...(castOfScene(s).length ? { castNames: castOfScene(s) } : {}),
        },
        roleplay,
      );
      // Only the location falls back: without this beat's storyboard entry the replay has no place
      // to move to, and the snapshot remembers where the scene actually was.
      if (!running.locationId && snap?.locationId) running = { ...running, locationId: snap.locationId };
    } else if (snap) {
      // No bible to replay against (not yet analysed) — the snapshot is all there is.
      running = { presentCharacterIds: [...snap.presentCharacterIds], ...(snap.locationId ? { locationId: snap.locationId } : {}) };
    }
    scenes[k] = running;
  });
  return {
    bookId: book.id,
    title: book.title,
    ...(book.author ? { author: book.author } : {}),
    beats,
    scene: scenes[scenes.length - 1] ?? emptyStoryScene(),
    scenes,
    ...(roleplay ? { roleplay } : {}),
    ...(soulCast ? { soulCast } : {}),
    // Workflow + played names persist on storyConfig (Phase C); fall back to deriving the mode from
    // whether a played cast exists, so stories created before that still resume in a sensible mode.
    mode: book.storyConfig?.mode ?? (roleplay ? "roleplay" : "direct"),
    ...(book.storyConfig?.play ? { play: book.storyConfig.play } : {}),
    ...(book.storyConfig?.synopsis ? { synopsis: book.storyConfig.synopsis } : {}),
    cadence: { mode: cadence.mode, n: cadence.n ?? 3 },
    beatsSinceImage: 0,
  };
}

async function soulCastForStoryBook(
  book: BookSource | undefined,
): Promise<StorySessionState["soulCast"]> {
  if (book?.kind !== "story" || story?.bookId !== book.id) return undefined;
  // Live setup mappings were cast-validated before stamping; reopened mappings enter `story` only
  // through rebuildStoryFromBook's restored-Bible validation above. Never fall back to raw book data.
  return normalizeStorySoulCast(story.soulCast);
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
  locate?: string,
): Promise<void> {
  try {
    const { llm } = chatProviders();
    if (!supportsVision(llm)) {
      throw new Error(
        `Your chat model (“${llm.id}”) can't see images. Use Gemini, OpenAI, or Claude, or a local VISION ` +
          "model (Ollama llama3.2-vision / llava, or LM Studio) — set the chat text provider in Settings.",
      );
    }
    // LOCATING REPLACES THE PROMPT rather than extending it. The describe wrapper ends with "be
    // concrete about what you can and cannot see" — the opposite of what a coordinate answer needs,
    // which must be JSON and nothing else or there is nothing to click with. The frame those pixels
    // are measured in comes from the PNG's own header, since the capture never carried its size.
    const prompt = locate
      ? locatePrompt(locate, pngSize(image.bytes))
      : "You are looking at a screenshot of the reader's computer screen. " +
        (question
          ? `Answer this specifically and concisely: ${question}`
          : "Describe what's on screen and whether anything looks broken or like an error.") +
        " Be concrete about what you can and cannot see.";
    const text = await withChatPriority(llm.id, () =>
      llm.describeImage({ bytes: image.bytes, mimeType: image.mimeType, prompt }),
    );
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
let localTextQueueTail: Promise<void> = Promise.resolve();
let localTextQueueDepth = 0;

function abortError(): DOMException {
  return new DOMException("The operation was cancelled.", "AbortError");
}

async function waitForLocalTextTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitForForegroundChat(
  signal?: AbortSignal,
  onQueued: () => void = () => {},
): Promise<void> {
  if (chatAborts.size === 0) return;
  onQueued();
  const heartbeat = setInterval(onQueued, 30_000);
  try {
    while (chatAborts.size > 0) {
      if (signal?.aborted) throw abortError();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 100);
        function done(): void {
          signal?.removeEventListener("abort", aborted);
          resolve();
        }
        function aborted(): void {
          clearTimeout(timer);
          signal?.removeEventListener("abort", aborted);
          reject(abortError());
        }
        signal?.addEventListener("abort", aborted, { once: true });
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

interface LocalModelLease {
  holdCurrentEngine(): void;
  release(): void;
}

async function acquireLocalModelLease(opts: {
  signal?: AbortSignal;
  onQueued?: () => void;
  engineHold: { bible: boolean; images: boolean };
}): Promise<LocalModelLease> {
  if (opts.signal?.aborted) throw abortError();
  // Every owner of the shared local-model FIFO (text, image, video, or book-open) must establish
  // its Engine hold BEFORE waiting. Adjacent owners then overlap their holds, so resolving slot A
  // cannot synchronously restart background extraction/rendering before slot B's continuation.
  const engineHolds: Array<{ target: Engine; release: () => void }> = [];
  const holdCurrentEngine = (): void => {
    const target = engine;
    if (
      target === undefined ||
      engineHolds.some((held) => held.target === target)
    ) {
      return;
    }
    engineHolds.push({
      target,
      release: target.acquireExecutionHold(opts.engineHold),
    });
  };
  const releaseEngineHolds = (): void => {
    for (const held of engineHolds) held.release();
    if (engineHolds.some((held) => engine === held.target)) postPaused();
  };
  holdCurrentEngine();
  const previous = localTextQueueTail.catch(() => {});
  const queued = localTextQueueDepth > 0;
  localTextQueueDepth += 1;
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  localTextQueueTail = previous.then(() => current);
  if (queued) opts.onQueued?.();
  const heartbeat =
    queued && opts.onQueued
      ? setInterval(opts.onQueued, 30_000)
      : undefined;
  try {
    await waitForLocalTextTurn(previous, opts.signal);
  } catch (error) {
    releaseCurrent();
    localTextQueueDepth = Math.max(0, localTextQueueDepth - 1);
    releaseEngineHolds();
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  // A book-open slot ahead of us may have replaced the Engine while we waited.
  holdCurrentEngine();
  let released = false;
  return {
    holdCurrentEngine,
    release: () => {
      if (released) return;
      released = true;
      // Resolve the FIFO first; the next owner already established its overlapping hold at entry.
      releaseCurrent();
      localTextQueueDepth = Math.max(0, localTextQueueDepth - 1);
      releaseEngineHolds();
    },
  };
}

async function withChatPriority<T>(
  llmId: string,
  fn: () => Promise<T>,
  opts: {
    signal?: AbortSignal;
    onQueued?: () => void;
    onAcquired?: () => void;
    forceBundledEnsure?: boolean;
    onModelProgress?: (message: string, percent?: number) => void;
  } = {},
): Promise<T> {
  const isLocal = llmId === "local-server" || llmId === "local" || llmId === "webllm";
  if (opts.signal?.aborted) throw abortError();
  // Establish the Engine hold when the job ENTERS the FIFO, not after it reaches the front.
  // That makes adjacent foreground jobs overlap their holds: finishing job A cannot briefly
  // restart extraction/rendering before queued job B acquires the shared local model.
  const handoffImage = isLocal && shouldHandImageModelToChat();
  let lease: LocalModelLease | undefined;
  try {
    if (isLocal) {
      lease = await acquireLocalModelLease({
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onQueued ? { onQueued: opts.onQueued } : {}),
        engineHold: { bible: true, images: handoffImage },
      });
    }
    if (opts.signal?.aborted) throw abortError();
    opts.onAcquired?.();
    const ensureBundled =
      opts.forceBundledEnsure === true || (isLocal && bundledLocalSelected());
    // Hand the idle image model's VRAM back (if a render evicted the LLM) AND evict any OTHER resident
    // local model, THEN reload the chat LLM into the freed VRAM. See prepareChatLlmLoad.
    // Stop new local renders before unloading their model, then launch the text model into the
    // released VRAM. RenderBuffer aborts an in-flight render and requeues it for the resume below.
    await prepareChatLlmLoad(handoffImage);
    await restoreChatLlm({
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(ensureBundled ? { forceBundledEnsure: true } : {}),
      ...(opts.onModelProgress ? { onProgress: opts.onModelProgress } : {}),
      allowBookFallback: isLocal,
    });
    if (opts.signal?.aborted) throw abortError();
    return await fn();
  } finally {
    lease?.release();
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

// --- Live GPU VRAM indicator -------------------------------------------------
// Poll the local ComfyUI engine's /system_stats so the status bar (and the mirrored phone) shows
// live VRAM use. Best-effort and self-healing: a miss clears the indicator; an engine-config change
// (which re-sends `init`) restarts the poll against the current engine. No-op for A1111 or no local
// engine — nothing to poll there, so the indicator simply stays hidden.
let vramTimer: ReturnType<typeof setInterval> | undefined;
let vramAbort: AbortController | undefined;
let lastVramJson = ""; // dedupe identical ticks so we don't spam postMessage every 4s
const VRAM_POLL_MS = 4000;

function postVram(vram: EngineVram | undefined): void {
  const json = vram ? JSON.stringify(vram) : "";
  if (json === lastVramJson) return; // unchanged since last tick — skip
  lastVramJson = json;
  post({ type: "vram", ...(vram ? { vram } : {}) });
}

function stopVramPoll(): void {
  if (vramTimer) {
    clearInterval(vramTimer);
    vramTimer = undefined;
  }
  vramAbort?.abort();
  vramAbort = undefined;
}

/** (Re)start the VRAM poll for the CURRENT settings. Called on `init` (engine-config changes, like
 * connecting/disconnecting the local engine, re-send `init`). */
function restartVramPoll(): void {
  stopVramPoll();
  const s = settings;
  const baseUrl = s?.engineBaseUrl ?? s?.localServerUrl;
  const isComfy = (s?.engineBackend ?? s?.localBackend) !== "a1111";
  if (!s || !baseUrl || !isComfy) {
    postVram(undefined); // engine removed / switched to A1111 → clear any stale indicator
    return;
  }
  const backend = new ComfyUIBackend({ baseUrl });
  const tick = async (): Promise<void> => {
    vramAbort?.abort(); // supersede any still-in-flight prior tick (a slow GET overlapping the next)
    const ac = new AbortController();
    vramAbort = ac;
    const devices = await backend.systemStats(ac.signal);
    if (ac.signal.aborted) return; // a newer tick/restart superseded this one — don't clobber it
    postVram(summarizeVram(devices));
  };
  void tick(); // immediate first reading (don't wait a full interval)
  vramTimer = setInterval(() => void tick(), VRAM_POLL_MS);
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
/**
 * The chat's working folder, mirrored from the latest buddy turn.
 *
 * read_file's job is to read back what write_file just wrote. write_file resolves a path against the
 * chat's folder; read_file went to the open-file bridge, which only understands ABSOLUTE paths. So the
 * file ledger — which records `code/app.js`, the path the model itself used — pointed at something the
 * model could not open. Carrying the folder on the read request lets the main thread resolve a
 * workspace-relative path through the same door that wrote it.
 */
let hostWorkingDir: string | undefined;
function hostFile(req: { op: "search" | "read" | "pdftext" | "imageBytes"; query?: string; path?: string; bytesBase64?: string; cwd?: string }): Promise<HostFileReply> {
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
interface LlmVramRuntime {
  baseUrl?: string;
  model?: string;
}

interface PendingLlmVramCall {
  action: "stop" | "ensure";
  progress: (message: string, percent?: number) => void;
  settle: (result: Extract<MainToWorker, { type: "llmVramResult" }>) => void;
}

const llmVramPending = new Map<number, PendingLlmVramCall>();
let nextLlmVramId = 1;
/** True while we've stopped the bundled chat LLM to free VRAM/RAM for image renders — so any later
 * LLM use (a chat turn, opening a book) knows to relaunch it first. */
let chatLlmFreed = false;
/** True while we've asked the local image engine to unload its model for a chat burst — the reverse
 * hand-off of `chatLlmFreed`. Set once per chat burst so we don't spam /free; reset at render start so
 * the next image reloads the engine. The image engine reloads lazily on the next generate(). */
let imageModelFreed = false;
/** Workspace files the assistant wrote this session (pushed from the host via the `fileLedger` message);
 * injected as a terse non-trimmable reminder into the buddy prompt so the model remembers what it made. */
let fileLedger: CreatedFileRef[] = [];
/** Labels of the reference pictures active in the host's chat (bytes stay there). */
let imageRefLedger: string[] = [];
/** The workspace's AGENTS.md / CONVENTIONS.md text (pushed from the host); injected as durable project
 * conventions into the buddy prompt. Empty when there's no such file. */
let projectGuide = "";
/**
 * PER-CONVERSATION STATE, KEYED BY CONVERSATION. This was two module globals, and "global" was never
 * a decision — the worker simply had no way to tell one chat from another, so everything it held
 * belonged to all of them.
 *
 * What that cost, reported: an unattended ✨ Creative run wrote an essay about lambda phage; every
 * turn afterwards, in the reader's OWN chat, opened with "the active document — a long essay…". Not
 * just confusing. The excerpt is pinned system text budgeted at 40% of the history allowance, so on
 * a 30k window it was ~7,800 characters of somebody else's work sitting in front of a conversation
 * it then pushed out of the window — the reader came back hours later to an assistant that could not
 * remember the code it had written with them.
 *
 * A turn with no session id falls back to one shared slot, which is exactly the old behaviour: the
 * only callers without one are internal, and none of them is a second conversation.
 */
const NO_SESSION = "";
/** The document the reader is currently viewing — set by create_document, or pushed from the host
 * (`activeDocument` message) when they open/upload one. Injected (bounded) AFTER the cache prefix so
 * the buddy can discuss + revise the REAL text without a read_file round-trip. */
const activeDocumentBySession = new Map<string, { title: string; content: string }>();
/** The last email draft saved or edited this session — surfaced every turn so a follow-up revision
 * edits it instead of drafting a second copy (see buildActiveDraftBlock).
 *
 * Keyed for a sharper reason than the document: `lastDraft` carries a live Gmail draft id, and the
 * prompt tells the model to `edit_draft` it. Shared, a draft written in one chat is a draft another
 * chat is invited to rewrite — in the reader's actual mailbox. */
const lastDraftBySession = new Map<string, { id: string; to: string[]; subject: string }>();
/** The conversation the turn being served belongs to. Set at the top of every buddy turn; read by the
 * tool handlers, which run inside it and have no other way to know. */
let turnSessionId = NO_SESSION;
/** Ceiling on ONE read_document reply — matches the read_file ceiling. This is an on-demand read, not
 * the per-turn excerpt, so it can be generous: it's paid once, when the model actually asks. */
const MAX_DOCUMENT_READ_CHARS = 60_000;
let documentCounter = 0;
function llmVramOp(
  action: "stop" | "ensure",
  opts: {
    signal?: AbortSignal;
    onProgress?: (message: string, percent?: number) => void;
  } = {},
): Promise<LlmVramRuntime> {
  return new Promise((resolve, reject) => {
    const callId = nextLlmVramId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      llmVramPending.delete(callId);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resetTimer = () => {
      if (action === "ensure") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => {
          fail(new Error("Stopping the bundled text model timed out."));
        },
        30_000,
      );
    };
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    // Native setup cannot be interrupted. Once posted, keep the model lease until main replies;
    // the caller checks its AbortSignal immediately afterward and never enters generation.
    llmVramPending.set(callId, {
      action,
      progress: (message, percent) => {
        if (settled) return;
        resetTimer();
        opts.onProgress?.(message, percent);
      },
      settle: (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!result.ok) {
          reject(
            new Error(
              result.error ||
                (action === "ensure"
                  ? "The bundled text model could not start."
                  : "The bundled text model could not stop."),
            ),
          );
          return;
        }
        resolve({
          ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
          ...(result.model ? { model: result.model } : {}),
        });
      },
    });
    resetTimer();
    post({ type: "llmVram", callId, action });
  });
}

const bundledLlmEnsuresInFlight = new Set<Promise<LlmVramRuntime>>();

function ensureBundledLlm(
  opts: {
    signal?: AbortSignal;
    onProgress?: (message: string, percent?: number) => void;
  } = {},
): Promise<LlmVramRuntime> {
  const pending = llmVramOp("ensure", opts);
  bundledLlmEnsuresInFlight.add(pending);
  void pending.then(
    () => bundledLlmEnsuresInFlight.delete(pending),
    () => bundledLlmEnsuresInFlight.delete(pending),
  );
  return pending;
}

async function waitForBundledLlmEnsure(): Promise<void> {
  if (bundledLlmEnsuresInFlight.size === 0) return;
  await Promise.allSettled([...bundledLlmEnsuresInFlight]);
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
  // Never free during either half of the Engine's text phase. The final prompt gap-fill and an
  // explicit prompt rebuild still call the LLM after chapter extraction has reached N/N.
  if (
    engine?.isGenerating() &&
    !engine.isBiblePaused() &&
    !engine.isLlmPhaseComplete()
  ) {
    return false;
  }
  const cs = chatSettingsOf(settings);
  if (cs.imageProvider !== "local" && settings.imageProvider !== "local") return false;
  // A1111 is now coordinated like ComfyUI: it can unload its checkpoint (POST /sdapi/v1/unload-checkpoint,
  // see Automatic1111Backend.freeMemory) so freeing the chat LLM for it no longer strands it — the reverse
  // hand-off (freeImageModelForChat) unloads A1111 when the LLM reloads. Freeing the LLM BEFORE the render
  // is in fact essential for A1111: it picks its VRAM/shared-RAM split at LOAD time from whatever's free, so
  // loading SDXL into a GPU still occupied by the LLM permanently offloads part of it to slow shared RAM
  // (the reported "32GB VRAM + 10GB shared for one SDXL model"). The fit math below still keeps both
  // resident on an ample-VRAM box; this only changes the proven-tight / low-VRAM case.
  // VRAM HEADROOM (low-VRAM OFF): keep BOTH models resident UNLESS we can PROVE they don't both fit.
  // A cold reload of a big Ollama model is a multi-minute stall, so we never pay it on a guess — only
  // when the math says it can't fit. Crucially, UNKNOWN (VRAM undetected — non-NVIDIA / nvidia-smi
  // absent — or a model size we can't estimate, e.g. a ":latest" tag) now KEEPS the model loaded
  // instead of falling through to freeing, which used to evict the LLM on common configs despite
  // low-VRAM being off. Low-VRAM ON still forces the free path below (unchanged).
  if (!settings.lowVram) {
    const imageGb = imageModelVramCostGb(settings.localModel ?? "");
    const chatGb =
      settings.localTextBackend === "bundled"
        ? BUNDLED_LLM_VRAM_GB
        : serverModelVramCostGb(cs.localServerTextModel ?? settings.localServerTextModel ?? "");
    if (chatImageVramFit({ gpuVramMb: settings.gpuVramMb, imageGb, chatGb }) !== "nofit") return false;
  }
  try {
    return chatProviders().llm.id === "local-server";
  } catch {
    return false;
  }
}

/** Before a STANDALONE image render (no book open): stop the bundled chat LLM so ComfyUI gets the
 * whole GPU AND its model stops squatting system RAM. Once per burst; relaunched only on demand. */
async function freeChatLlmForRender(): Promise<void> {
  // A cancelled first-use launch still has to finish its native invoke. Never begin loading the
  // diffusion model during that tail; once it settles, the normal state check below can stop it.
  await waitForBundledLlmEnsure();
  if (chatLlmFreed || !canFreeChatLlm()) return;
  chatLlmFreed = true;
  if (settings?.localTextBackend === "bundled") {
    try {
      await llmVramOp("stop"); // we own the bundled process — kill it to free its RAM/VRAM
    } catch {
      // Keep the state truthful if the native stop failed; the next render may still have to share.
      chatLlmFreed = false;
    }
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
function bundledLocalSelected(scope: "chat" | "book" = "chat"): boolean {
  if (!settings || !corsProxyAvailable || settings.localTextBackend !== "bundled") return false;
  return (scope === "book" ? settings : chatSettingsOf(settings)).textProvider === "local";
}

function applyBundledLlmRuntime(
  runtime: LlmVramRuntime,
  scope: "chat" | "book" = "chat",
): void {
  // Provider choices can change while a first-use download is awaiting native setup. Never let that
  // late result overwrite a newly selected Ollama/external-server endpoint.
  if (!settings || !bundledLocalSelected(scope) || !runtime.baseUrl || !runtime.model) return;
  settings = {
    ...settings,
    localServerTextUrl: runtime.baseUrl,
    localServerTextModel: runtime.model,
    chatLocalModel: runtime.model,
  };
}

async function reconcileBundledLlmRuntime(
  runtime: LlmVramRuntime,
  preferredScope: "chat" | "book",
): Promise<void> {
  const alternateScope = preferredScope === "chat" ? "book" : "chat";
  const activeScope = bundledLocalSelected(preferredScope)
    ? preferredScope
    : bundledLocalSelected(alternateScope)
      ? alternateScope
      : undefined;
  if (activeScope) {
    applyBundledLlmRuntime(runtime, activeScope);
    chatLlmFreed = false;
    return;
  }
  // The provider changed while setup was downloading. If no other worker ensure now owns the
  // process, release the orphan so cloud/Ollama plus local image work do not inherit its VRAM.
  await Promise.resolve();
  if (
    bundledLlmEnsuresInFlight.size === 0 &&
    !bundledLocalSelected("chat") &&
    !bundledLocalSelected("book")
  ) {
    try {
      await llmVramOp("stop");
      chatLlmFreed = true;
    } catch {
      chatLlmFreed = false;
    }
  }
}

async function restoreChatLlm(
  opts: {
    signal?: AbortSignal;
    forceBundledEnsure?: boolean;
    onProgress?: (message: string, percent?: number) => void;
    bundledScope?: "chat" | "book";
    allowBookFallback?: boolean;
  } = {},
): Promise<void> {
  const bundledScope = opts.bundledScope ?? "chat";
  const activeBundledScope = bundledLocalSelected(bundledScope)
    ? bundledScope
    : opts.allowBookFallback && bundledScope === "chat" && bundledLocalSelected("book")
      ? "book"
      : undefined;
  if (opts.forceBundledEnsure && activeBundledScope) {
    const runtime = await ensureBundledLlm({
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    await reconcileBundledLlmRuntime(runtime, activeBundledScope);
    return;
  }
  if (!chatLlmFreed) return;
  // Only the bundled server needs an explicit relaunch. An Ollama ("server") model reloads
  // lazily on the next chat request (which is what triggered this restore), so nothing to start.
  if (settings?.localTextBackend === "bundled" && activeBundledScope) {
    const runtime = await ensureBundledLlm({
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    await reconcileBundledLlmRuntime(runtime, activeBundledScope);
  }
  if (settings?.localTextBackend !== "bundled") chatLlmFreed = false;
}

/** The REVERSE hand-off of freeChatLlmForRender: unload the idle LOCAL image model so the chat LLM can
 * reload into that VRAM (lets a larger model coexist in the render→chat workflow). Called by
 * withChatPriority ONLY when the chat LLM is actually about to (re)load (`chatLlmFreed`) — i.e. a render
 * evicted it and we're restoring it now — so we never unload an image model that a still-resident LLM
 * doesn't need out of the way (which would just force a needless cold reload on the next render). The
 * lowVram / proven-tight self-check here is a belt-and-suspenders mirror of canFreeChatLlm (the gate
 * that set `chatLlmFreed` in the first place). Once per chat burst (imageModelFreed); reset at the next
 * render start. The image engine reloads lazily on the next generate(), so this is safe to do eagerly. */
function localModelsNeedExclusiveVram(scope: "chat" | "book" = "chat"): boolean {
  if (!settings) return false;
  const cs = chatSettingsOf(settings);
  if (!settings.lowVram) {
    const imageGb = imageModelVramCostGb(settings.localModel ?? "");
    const chatGb =
      settings.localTextBackend === "bundled"
        ? BUNDLED_LLM_VRAM_GB
        : serverModelVramCostGb(
            scope === "book"
              ? (settings.localServerTextModel ?? "")
              : (cs.localServerTextModel ?? settings.localServerTextModel ?? ""),
          );
    if (chatImageVramFit({ gpuVramMb: settings.gpuVramMb, imageGb, chatGb }) !== "nofit") {
      return false;
    }
  }
  return true;
}

function shouldHandImageModelToChat(scope: "chat" | "book" = "chat"): boolean {
  if (!settings) return false;
  const cs = chatSettingsOf(settings);
  const activeBookUsesLocalImages =
    engine !== undefined &&
    bookProviders !== undefined &&
    bookProviders.image.id === "local";
  // Either configured scope can have left a checkpoint resident on the shared image backend.
  // The scope selects the text-model size used for fit math, not which resident image is relevant.
  if (
    settings.imageProvider !== "local" &&
    cs.imageProvider !== "local" &&
    !activeBookUsesLocalImages
  ) {
    return false;
  }
  return localModelsNeedExclusiveVram(scope);
}

async function freeImageModelForChat(
  force = false,
  scope: "chat" | "book" = "chat",
): Promise<void> {
  // A forced hand-off follows an Engine pause/abort. The Engine may have lazily reloaded its
  // checkpoint since the previous chat burst without passing through renderFromText(), so the
  // cached flag is not authoritative here: establish a fresh, awaited /free boundary every time.
  if ((!force && imageModelFreed) || !shouldHandImageModelToChat(scope)) return;
  imageModelFreed = true;
  try {
    const cs = chatSettingsOf(settings!);
    // Prefer the provider owned by the paused book Engine: a cloud chat-image override must not
    // redirect this unload away from the local checkpoint that is actually holding VRAM. Both
    // local scopes share the same configured backend, so one call also covers chat-made images.
    const image =
      engine !== undefined &&
      bookProviders !== undefined &&
      bookProviders.image.id === "local"
        ? bookProviders.image
        : scope === "book" && settings!.imageProvider === "local"
          ? (() => {
              const cf = corsFetch();
              return buildProviders(settings!, cf ? { corsFetch: cf } : {}).image;
            })()
        : cs.imageProvider === "local"
          ? chatProviders().image
          : undefined;
    await image?.freeMemory?.();
  } catch {
    /* best-effort — the image model just stays warm if the engine can't free right now */
  }
}

/** Once-per-arm guard: a ComfyUI we left resident is only /free'd once after a switch to A1111 (re-armed
 * below whenever A1111 is NOT the active backend, so a later ComfyUI→A1111 switch frees it again). */
let staleComfyFreed = false;
/**
 * Hand the GPU to an external A1111 render: a ComfyUI used earlier this session keeps its checkpoint
 * resident in VRAM (it only releases on an explicit /free), so after the reader switches the image
 * backend to A1111 that stale model squats the GPU and the A1111 render spills to system RAM and crawls.
 * When A1111 is the active backend, POST /free to the last-known ComfyUI URL once. Best-effort; ComfyUI
 * reloads lazily if the reader ever switches back. No-op for any other backend / when no ComfyUI is known.
 */
async function freeStaleComfyForA1111(): Promise<void> {
  if (!settings) return;
  const url = staleComfyUrlToFree(settings);
  if (!url) {
    staleComfyFreed = false; // not on A1111 (or nothing to free) → re-arm for the next switch
    return;
  }
  if (staleComfyFreed) return;
  staleComfyFreed = true;
  try {
    await new ComfyUIBackend({ baseUrl: url }).freeMemory();
  } catch {
    /* best-effort — that ComfyUI may be gone/unreachable, which is fine */
  }
}

/** Mirror of staleComfyFreed for the reverse direction (a separate A1111 left resident before a ComfyUI
 * video render). Re-armed whenever there's nothing to free, so a later switch frees it again. */
let staleA1111Freed = false;
/**
 * The reverse hand-off: when images run on a SEPARATE AUTOMATIC1111 and we're about to render VIDEO on
 * ComfyUI, A1111's checkpoint squats the VRAM the large video experts need. Unload it (POST
 * /sdapi/v1/unload-checkpoint) once. Best-effort; A1111 reloads its checkpoint lazily on the next image
 * render. No-op when A1111 is itself the active op, none is remembered, or it's the same server as ComfyUI.
 */
async function freeStaleA1111ForComfy(): Promise<void> {
  if (!settings) return;
  const url = staleA1111UrlToFree(settings);
  if (!url) {
    staleA1111Freed = false; // nothing to free → re-arm for the next switch
    return;
  }
  if (staleA1111Freed) return;
  staleA1111Freed = true;
  try {
    await new Automatic1111Backend({ baseUrl: url }).freeMemory();
  } catch {
    /* best-effort — that A1111 may be gone/unreachable, which is fine */
  }
}

/**
 * Make room for the local chat LLM before it (re)loads — run at the start of every chat turn and before
 * a warm. Two steps, both low-VRAM-scoped so an ample-VRAM box keeps its models hot:
 *  1. If a render evicted the LLM (`chatLlmFreed`), free the idle image model first so the LLM reloads
 *     into that VRAM — the reverse of the render→chat hand-off (see freeImageModelForChat).
 *  2. Evict any OTHER resident model on the local server so two LLMs never coexist in VRAM — e.g. after
 *     a model switch, or a vision/assess model left loaded ("two models in `ollama ps`"). Ollama-only;
 *     a non-Ollama / cloud backend is a silent no-op.
 */
async function prepareChatLlmLoad(
  forceImageHandoff = false,
  scope: "chat" | "book" = "chat",
): Promise<void> {
  if (chatLlmFreed || forceImageHandoff) {
    await freeImageModelForChat(forceImageHandoff, scope);
  }
  if (!settings?.lowVram) return; // ample VRAM: leave co-resident models alone (no churn)
  try {
    // Opening a book must preserve its selected model, which may differ from the chat override.
    // Evict around the provider that is actually about to load instead of always preserving chat.
    const llm =
      scope === "book"
        ? (() => {
            const cf = corsFetch();
            return buildProviders(settings!, cf ? { corsFetch: cf } : {}).llm;
          })()
        : chatProviders().llm;
    if (llm.id === "local-server") await llm.evictOtherModels?.();
  } catch {
    /* best-effort — leave VRAM as-is if the server can't be queried */
  }
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

function setBiblePauseIntent(paused: boolean, broadcast = true): void {
  engine?.setBiblePaused(paused);
  if (broadcast) postPaused();
}

function setImagePauseIntent(paused: boolean, broadcast = true): void {
  engine?.setImagePaused(paused);
  if (broadcast) postPaused();
}

/** True while `handleOpen` is mid-flight (the engine object exists but its book
 * isn't loaded yet). A `start` that arrives in this window must NOT call
 * startGeneration() — `openBook` resets generationStarted afterwards, swallowing
 * it — so it defers via pendingStart, which handleOpen replays once open resolves. */
let opening = false;
/** Supersedes slow async opens. Close and every newer open invalidate all older continuations. */
let openEpoch = 0;

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
  // Idle synthesis must yield to the reader, regardless of whether the main thread's cancellation
  // message wins the race with this foreground request.
  preemptIdleSoulEssence(msg);
  switch (msg.type) {
    case "init": {
      const prevSettings = settings;
      settings = msg.settings;
      corsProxyAvailable = msg.corsProxy === true;
      void evictReplacedChatModel(prevSettings, settings); // free the old local model on a model switch
      void freeSwitchedImageEngine(prevSettings, settings); // clear the image engine's VRAM (A1111 startup squat / a switch)
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
      restartVramPoll(); // (re)point the VRAM indicator at the current engine
      break;
    }
    case "tune": {
      // Tuning-only change: swap the live engine's tier (future renders use it) without
      // disposing anything — in-flight extraction/renders continue uninterrupted. The
      // providers themselves are unchanged for tune-eligible fields, so the freshly
      // built ones are discarded; only the tier they computed is applied.
      const prevSettings = settings;
      settings = msg.settings;
      void evictReplacedChatModel(prevSettings, settings); // free the old local model if the model changed
      void freeSwitchedImageEngine(prevSettings, settings); // free the image engine's VRAM on a backend switch
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
    }
    case "imageRefLedger":
      imageRefLedger = msg.labels;
      break;
    case "fileLedger":
      // The host's current set of workspace files the assistant wrote this session — injected into the
      // buddy prompt so the model stays aware of what it made (and can read_file before editing).
      fileLedger = msg.files;
      break;
    case "projectGuide":
      projectGuide = msg.text;
      break;
    case "activeDocument":
      // The host set/cleared the document the reader is viewing (e.g. one they uploaded) so the buddy
      // can discuss + revise it. create_document sets this itself; this is for host-opened docs.
      // Against the session the host names, or the shared slot when it names none — an upload belongs
      // to the chat it was dropped into, not to every chat.
      if (msg.doc) activeDocumentBySession.set(msg.sessionId ?? NO_SESSION, msg.doc);
      else activeDocumentBySession.delete(msg.sessionId ?? NO_SESSION);
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
      setBiblePauseIntent(true, false);
      setImagePauseIntent(true, false);
      postPaused();
      break;
    case "resume":
      setBiblePauseIntent(false, false);
      setImagePauseIntent(false, false);
      postPaused();
      break;
    case "pauseBible":
      setBiblePauseIntent(true);
      break;
    case "resumeBible":
      setBiblePauseIntent(false);
      break;
    case "pauseImages":
      setImagePauseIntent(true);
      break;
    case "resumeImages":
      setImagePauseIntent(false);
      break;
    case "regenerateStoryboard":
      void engine?.regenerateStoryboard();
      postPaused();
      break;
    case "storySetCadence":
      if (story) {
        story.cadence = { mode: msg.mode, n: msg.n ?? story.cadence.n };
        if (msg.mode === "per-response") story.beatsSinceImage = 0;
        persistStoryConfig();
      }
      break;
    case "storySetMode":
      if (story) {
        story.mode = msg.mode;
        persistStoryConfig();
      }
      break;
    case "storyRenderLatest":
      if (story && engine && story.beats.length > 0) {
        const last = story.beats.length - 1;
        void engine.renderScene(last, last);
      }
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
    case "updateCreature":
      void engine?.updateCreature(msg.creatureId, msg.patch);
      break;
    case "updateEnvironment":
      void engine?.updateEnvironment(msg.environmentId, msg.patch);
      break;
    case "removeBibleEntry":
      // Save-only like the edits, and remembered: the engine records the deletion so a later
      // chapter naming the same entry doesn't re-add it.
      void engine?.removeBibleEntry(msg.kind, msg.id);
      break;
    case "restoreBibleEntry":
      void engine?.restoreBibleEntry(msg.kind, msg.id);
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
      // Mirror the turn's working folder so a host file READ resolves the same way its WRITE did.
      hostWorkingDir = msg.workingDir;
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
    case "soulEssenceRefresh":
      void handleSoulEssenceRefresh(msg);
      break;
    case "soulEssenceCancel": {
      const accepted = !soulEssenceCommits.has(msg.requestId);
      if (accepted) {
        soulEssenceAborts.get(msg.requestId)?.abort();
      }
      post({ type: "soulEssenceCancelResult", requestId: msg.requestId, accepted });
      break;
    }
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
    case "syncTaskGoogle":
      void mirrorPlanToGoogle(msg.planId).finally(() => post({ type: "taskGoogleSynced", requestId: msg.requestId }));
      break;
    case "createGoogleTask":
      void handleCreateGoogleTask(msg);
      break;
    case "createEvent":
      void handleCreateEvent(msg);
      break;
    case "updateEvent":
      void handleUpdateEvent(msg);
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
      void handleChatTool(msg.requestId, msg.call, msg.refImages, msg.userText);
      break;
    case "chatVideo":
      void handleChatVideo(msg.requestId, msg.call, msg.image, msg.models, msg.params, msg.warmBatch, msg.endImage, msg.keepResident);
      break;
    case "assessImage":
      void handleAssessImage(msg.requestId, msg.image, msg.question, msg.locate);
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
    case "llmVramProgress": {
      llmVramPending.get(msg.callId)?.progress(msg.message, msg.percent);
      break;
    }
    case "llmVramResult": {
      // Keep residency state truthful even if a native response lands after its UI request was
      // cancelled. The exact waiter applies URL/model only if its provider selection is still current.
      if (msg.action === "ensure" && msg.ok) {
        chatLlmFreed = false;
      }
      llmVramPending.get(msg.callId)?.settle(msg);
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
    /** Character reference photos (a soul's reference images) — used by Gemini/OpenAI native + ComfyUI. */
    ipAdapterRefs?: { bytes: ArrayBuffer; mimeType: string; weight: number }[];
    /** Output dimensions (the photo path passes the source photo's aspect). */
    width?: number;
    height?: number;
    /** Render progress sink (0..1) for engines that report it (ComfyUI). */
    onProgress?: (fraction: number) => void;
    /** Cancellation: aborting it interrupts the in-flight ComfyUI render (the Stop button). */
    signal?: AbortSignal;
  } = {},
): Promise<{ bytes: ArrayBuffer; mimeType: string; prompt: string; references?: ImageGenerationOutput["references"] }> {
  const isLocal = tier.tier === "local";
  const localModelLease = isLocal
    ? await acquireLocalModelLease({
        ...(opts.signal ? { signal: opts.signal } : {}),
        engineHold: { bible: true, images: true },
      })
    : undefined;
  try {
  // Standalone render (playground / chat generate_image): free the bundled chat LLM's VRAM first so
  // ComfyUI gets the whole GPU. Once per burst (gated to safe cases); relaunched after the burst by
  // the debounced warm or the next chat. The book's bible-illustration path doesn't come through
  // here, so it's never disturbed.
  await freeChatLlmForRender();
  // If the reader switched from ComfyUI to an external A1111, free the ComfyUI we left resident so this
  // A1111 render gets the GPU instead of spilling to system RAM. No-op unless A1111 is active + a
  // separate ComfyUI URL is remembered.
  await freeStaleComfyForA1111();
  // A new render means the image engine will (re)load its model — clear the chat-side "freed" flag so
  // the next chat burst frees it again.
  imageModelFreed = false;
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
  const styleLora = !isLocal || !applyStyle
    ? undefined
    : tier.disableStyleLora
      ? undefined
      : tier.styleLoraOverride
        ? { name: tier.styleLoraOverride, strength: 0.8 }
        : style.local?.lora;
  const steps = stepsOverride ?? (isLocal ? tier.localSteps : undefined);
  // Hi-Res two-pass is controlled SOLELY by the persisted "High resolution" setting (tier.hires).
  // The chat/model can NOT enable it per-request — too many prompts ("draw a detailed …") were
  // misread as high-res requests and triggered the slow, ghosting second pass unasked.
  const hires = isLocal ? tier.hires : undefined;
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
    ...(opts.ipAdapterRefs?.length ? { ipAdapterRefs: opts.ipAdapterRefs } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { bytes: out.bytes, mimeType: out.mimeType, prompt, ...(out.references ? { references: out.references } : {}) };
  } finally {
    localModelLease?.release();
  }
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
  if (chatAborts.size > 0) return;
  // Same pre-load as a chat turn: hand the image model's VRAM back (low-VRAM, if a render freed the LLM)
  // and evict any other resident model BEFORE warming, so the warm reload lands into freed VRAM and
  // doesn't end up co-resident with the image model or a stale LLM.
  try {
    const queueId = bundledLocalSelected() ? "local-server" : chatProviders().llm.id;
    await withChatPriority(
      queueId,
      async () => {
        const { llm } = chatProviders();
        if (
          !supportsChat(llm) ||
          (llm.id !== "local-server" && llm.id !== "local" && llm.id !== "webllm")
        ) {
          return;
        }
        await llm.chat([{ role: "user", content: "ok" }], { maxTokens: 1 }).catch(() => {});
      },
      { forceBundledEnsure: true },
    );
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
function chatProviders(opts: {
  onLocalStatus?: (text: string) => void;
  onLocalActivity?: (activity: { phase: "bible" | "prompt"; tokens: number }) => void;
} = {}): {
  llm: LLMProvider;
  image: ImageProvider;
  tier: TierConfig;
  imageSearch: FigureSearch;
  llmDiagnostic: { label: string; mock: boolean; reason?: string };
} {
  if (!settings) throw new Error("Settings not initialised yet.");
  const cf = corsFetch();
  const built = buildProviders(chatSettingsOf(settings), {
    ...(cf ? { corsFetch: cf } : {}),
    ...(opts.onLocalStatus ? { onLocalStatus: opts.onLocalStatus } : {}),
    ...(opts.onLocalActivity ? { onLocalActivity: opts.onLocalActivity } : {}),
  });
  const fallbackBookLlm =
    built.diagnostics.llm.mock && bookProviders && !bookProviders.llmMock
      ? bookProviders
      : undefined;
  const llm = fallbackBookLlm?.llm ?? built.llm;
  const image =
    built.diagnostics.image.mock && bookProviders && !bookProviders.imageMock
      ? bookProviders.image
      : built.image;
  const tier =
    built.diagnostics.image.mock && bookProviders && !bookProviders.imageMock
      ? bookProviders.tier
      : built.tier;
  const llmDiagnostic = fallbackBookLlm
    ? { label: fallbackBookLlm.llmLabel, mock: false }
    : built.diagnostics.llm;
  return { llm, image, tier, imageSearch: built.imageSearch, llmDiagnostic };
}

/**
 * Soul notes are the authoritative ledger; the compact essence is a disposable cache derived from
 * that ledger. One in-flight map keeps explicit and idle refresh requests from independently
 * distilling the same revision, while a failure cooldown prevents repeated downtime retries after a
 * small model returns malformed JSON. Foreground chat only reads the cache/fallback and never enters
 * this generation path; changing notes or models changes the refresh key immediately.
 */
const soulEssenceInFlight = new Map<
  string,
  { promise: Promise<SoulEssence | undefined> }
>();
const soulEssenceFailedUntil = new Map<string, number>();
const SOUL_ESSENCE_RETRY_MS = 10 * 60_000;
const SOUL_ESSENCE_MAX_TOKENS = 1_400;
const MIN_SOUL_DISTILLATION_CONTEXT_TOKENS = 4_096;
const MIN_SOUL_SOURCE_CHUNK_CHARS = 3_000;
const MAX_SOUL_SOURCE_CHUNK_CHARS = 48_000;
const SOUL_DIGEST_CACHE_LIMIT = 512;
const SOUL_DIGEST_CACHE_MAX_CHARS = 1_000_000;
const SOUL_DIGEST_CACHE_KEY: Record<SoulKind, string> = {
  self: "self-soul-essence-digests-v2",
  user: "about-you-soul-essence-digests-v2",
};

type SoulEssenceProgressCallback = (
  phase: SoulEssenceJobPhase,
  message: string,
  progress?: { pass?: number; total?: number },
) => void;

interface SoulDigestCacheEntry {
  fingerprint: string;
  essence: SoulEssence;
  touchedAt: number;
}

interface SoulDigestCacheEnvelope {
  modelKey: string;
  entries: SoulDigestCacheEntry[];
}

function soulDistillationFitsContext(contextTokens?: number): boolean {
  return (contextTokens ?? OLLAMA_DEFAULT_LOADED_TOKENS) >= MIN_SOUL_DISTILLATION_CONTEXT_TOKENS;
}

async function loadSoulDigestCache(
  kind: SoulKind,
  modelKey: string,
): Promise<Map<string, SoulDigestCacheEntry>> {
  try {
    const raw = await memoryStore().getMemo?.(SOUL_DIGEST_CACHE_KEY[kind]);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const envelope = parsed as Partial<SoulDigestCacheEnvelope>;
    if (envelope.modelKey !== modelKey || !Array.isArray(envelope.entries)) return new Map();
    return new Map(
      envelope.entries
        .filter((entry): entry is SoulDigestCacheEntry => {
          if (!entry || typeof entry !== "object") return false;
          const candidate = entry as Partial<SoulDigestCacheEntry>;
          return (
            typeof candidate.fingerprint === "string" &&
            typeof candidate.touchedAt === "number" &&
            !!candidate.essence &&
            typeof candidate.essence === "object"
          );
        })
        .slice(0, SOUL_DIGEST_CACHE_LIMIT)
        .map((entry) => [entry.fingerprint, entry]),
    );
  } catch {
    return new Map();
  }
}

async function saveSoulDigestCache(
  kind: SoulKind,
  modelKey: string,
  cache: ReadonlyMap<string, SoulDigestCacheEntry>,
): Promise<void> {
  try {
    const candidates = [...cache.values()]
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .slice(0, SOUL_DIGEST_CACHE_LIMIT);
    const entries: SoulDigestCacheEntry[] = [];
    let used = JSON.stringify({ modelKey, entries: [] }).length;
    for (const entry of candidates) {
      const cost = JSON.stringify(entry).length + 1;
      if (used + cost > SOUL_DIGEST_CACHE_MAX_CHARS) continue;
      entries.push(entry);
      used += cost;
    }
    const envelope: SoulDigestCacheEnvelope = { modelKey, entries };
    await memoryStore().putMemo?.(SOUL_DIGEST_CACHE_KEY[kind], JSON.stringify(envelope));
  } catch {
    // A digest cache only saves regeneration work; failure never affects the authoritative notes.
  }
}

function soulEssenceModelKey(llm: LLMProvider): string {
  if (!settings) return llm.id;
  const active = chatSettingsOf(settings);
  return [
    llm.id,
    active.textProvider,
    active.localTextBackend ?? "",
    active.localServerTextModel ?? "",
    active.localTextModel ?? "",
  ].join(":");
}

function soulDistillationSourceBudget(contextTokens?: number): number {
  const tokens = contextTokens && contextTokens > 0 ? contextTokens : OLLAMA_DEFAULT_LOADED_TOKENS;
  return Math.max(
    MIN_SOUL_SOURCE_CHUNK_CHARS,
    Math.min(
      MAX_SOUL_SOURCE_CHUNK_CHARS,
      Math.floor(tokens * CHARS_PER_TOKEN * 0.28),
    ),
  );
}

function soulDistillationOutputBudget(contextTokens?: number): number {
  const tokens = contextTokens && contextTokens > 0 ? contextTokens : OLLAMA_DEFAULT_LOADED_TOKENS;
  // Reserve most of a small local window for system + grounded input. Merge evidence IDs are
  // restored deterministically, so even a 200-note final result does not need an enormous output.
  return Math.min(
    SOUL_ESSENCE_MAX_TOKENS,
    Math.max(512, Math.floor(tokens * 0.3)),
  );
}

async function completeSoulEssence(
  llm: LLMProvider,
  kind: SoulKind,
  notes: readonly SoulNote[],
  prompt: ReturnType<typeof buildSoulEssenceDistillationPrompt>,
  maxTokens: number,
  signal?: AbortSignal,
  digests?: readonly SoulEssenceDigestInput[],
  onToken?: (delta: string) => void,
  onRepair?: (feedback: string, truncated: boolean) => void,
  abstractionBase?: SoulEssence,
): Promise<{ essence?: SoulEssence; failure?: SoulEssenceCompletionFailure }> {
  return completeSoulEssenceWithRepair({
    llm,
    kind,
    notes,
    prompt,
    maxTokens,
    ...(signal ? { signal } : {}),
    ...(digests ? { digests } : {}),
    ...(abstractionBase ? { abstractionBase } : {}),
    ...(onToken ? { onToken } : {}),
    ...(onRepair ? { onRepair } : {}),
  });
}

function soulEssenceFormatError(
  failure: SoulEssenceCompletionFailure | undefined,
  scope: "source" | "merge" | "abstraction",
): Error {
  const raw = failure?.feedback.replace(/\s+/g, " ").trim() ?? "";
  const detail = raw.length > 700 ? `${raw.slice(0, 697)}...` : raw;
  const stage =
    scope === "source"
      ? "one authoritative Soul note"
      : scope === "merge"
        ? "the final Soul summaries"
        : "the final generalized Soul Essence";
  return new Error(
    [
      `The text model could not ground ${stage} after a targeted repair.`,
      detail,
      "The original Soul notes are unchanged. Retry, or choose a stronger instruction model if this repeats.",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function groupSoulDigests(
  digests: readonly SoulEssenceDigestInput[],
  budget: number,
): SoulEssenceDigestInput[][] {
  const groups: SoulEssenceDigestInput[][] = [];
  let current: SoulEssenceDigestInput[] = [];
  let used = 2;
  for (const digest of digests) {
    const cost =
      JSON.stringify(Object.values(digest.essence.facets).map((facet) => facet.text)).length +
      (current.length ? 1 : 0);
    if (current.length > 0 && used + cost > budget) {
      groups.push(current);
      current = [];
      used = 2;
    }
    current.push(digest);
    used += cost;
  }
  if (current.length > 0) groups.push(current);

  // A particularly wordy digest can fill the budget by itself. Pair singletons anyway so recursive
  // reduction always makes progress; each facet is already hard-capped, so a pair remains bounded.
  if (groups.length === digests.length && digests.length > 1) {
    const pairs: SoulEssenceDigestInput[][] = [];
    for (let index = 0; index < digests.length; index += 2) {
      pairs.push(digests.slice(index, index + 2) as SoulEssenceDigestInput[]);
    }
    return pairs;
  }
  return groups;
}

async function distillSoulEssence(
  llm: LLMProvider,
  kind: SoulKind,
  notes: readonly SoulNote[],
  sourceBudget: number,
  outputBudget: number,
  reuseCache: boolean,
  allowAdaptiveRecovery: boolean,
  signal?: AbortSignal,
  onProgress?: SoulEssenceProgressCallback,
  onToken?: (delta: string) => void,
): Promise<SoulEssence | undefined> {
  const modelKey = soulEssenceModelKey(llm);
  const cache = await loadSoulDigestCache(kind, modelKey);
  const rootFingerprint = soulSourceFingerprint(notes);
  let cacheDirty = false;
  let activePhase: SoulEssenceJobPhase = "analyzing";
  let activePass = 0;
  let activeTotal = 0;
  let lastCompletionFailure: SoulEssenceCompletionFailure | undefined;
  const digest = async (
    scopeNotes: readonly SoulNote[],
    prompt: ReturnType<typeof buildSoulEssenceDistillationPrompt>,
    children?: readonly SoulEssenceDigestInput[],
  ): Promise<SoulEssence | undefined> => {
    const fingerprint = soulSourceFingerprint(scopeNotes);
    // Explicit Refresh should rebuild the final integration, but it can safely reuse every unchanged
    // validated child digest. A one-chunk Soul has no children, so it is regenerated in full.
    if (reuseCache && fingerprint !== rootFingerprint) {
      const cached = cache.get(fingerprint);
      const valid = cached
        ? validateSoulEssence(cached.essence, kind, scopeNotes)
        : undefined;
      if (valid) {
        cached!.touchedAt = Date.now();
        cacheDirty = true;
        return valid;
      }
    }
    const result = await completeSoulEssence(
      llm,
      kind,
      scopeNotes,
      prompt,
      outputBudget,
      signal,
      children,
      onToken,
      (_feedback, truncated) =>
        onProgress?.(
          "validating",
          truncated
            ? `The model's response was cut off; repairing pass ${activePass} with a shorter answer…`
            : `The model missed a grounding rule; repairing pass ${activePass} with the exact missing evidence…`,
          { pass: activePass, total: activeTotal },
        ),
    );
    const essence = result.essence;
    lastCompletionFailure = result.failure;
    if (essence && fingerprint !== rootFingerprint) {
      // Appearance/directions are reconstructed deterministically from scopeNotes during cache
      // validation, so do not duplicate potentially large exact arrays in every child digest.
      const compactEssence: SoulEssence = {
        ...essence,
        facets: {
          ...essence.facets,
          personalityDirections: { text: "", sourceIds: [] },
        },
        exactAppearance: [],
        exactPersonalityDirections: [],
      };
      cache.set(fingerprint, { fingerprint, essence: compactEssence, touchedAt: Date.now() });
      cacheDirty = true;
    }
    return essence;
  };
  const flushCache = async () => {
    if (!cacheDirty) return;
    cacheDirty = false;
    await saveSoulDigestCache(kind, modelKey, cache);
  };

  try {
    const chunks = partitionSoulNotes(notes, sourceBudget);
    let completed = 0;
    let total = chunks.length;
    const analyzeChunk = async (
      chunk: readonly SoulNote[],
      label: string,
      retrying = false,
    ): Promise<SoulEssenceDigestInput[]> => {
      activePhase = "analyzing";
      activePass = completed + 1;
      activeTotal = total;
      onProgress?.(
        activePhase,
        retrying
          ? `Retrying ${label} as a smaller grounded section (${chunk.length} note${chunk.length === 1 ? "" : "s"})…`
          : chunks.length === 1
          ? "Analyzing the complete Soul…"
          : `Analyzing ${label}…`,
        { pass: activePass, total: activeTotal },
      );
      const essence = await digest(
        chunk,
        buildSoulEssenceDistillationPrompt(kind, chunk),
      );
      if (essence) {
        completed += 1;
        return [{ notes: chunk, essence }];
      }

      // Do not relax grounding or falsely attach a missed ID. A repeatedly failing multi-note leaf
      // is divided until the model has a small, explicit evidence set (ultimately one source), then
      // the existing merge path recombines the validated meanings and restores citations.
      if (!allowAdaptiveRecovery || chunk.length <= 1) {
        throw soulEssenceFormatError(lastCompletionFailure, "source");
      }
      const middle = Math.ceil(chunk.length / 2);
      const left = chunk.slice(0, middle);
      const right = chunk.slice(middle);
      total += 1; // one planned leaf is now two successful leaf passes
      activeTotal = total;
      onProgress?.(
        "validating",
        `That section still missed evidence; splitting it into ${left.length} and ${right.length} notes…`,
        { pass: completed + 1, total },
      );
      return [
        ...(await analyzeChunk(left, `${label}, first half`, true)),
        ...(await analyzeChunk(right, `${label}, second half`, true)),
      ];
    };

    let digests: SoulEssenceDigestInput[] = [];
    for (let index = 0; index < chunks.length; index++) {
      digests.push(
        ...(await analyzeChunk(
          chunks[index]!,
          `Soul section ${index + 1} of ${chunks.length}`,
        )),
      );
    }
    await flushCache();

    const mergeGroup = async (
      group: readonly SoulEssenceDigestInput[],
    ): Promise<SoulEssenceDigestInput> => {
      if (group.length === 1) return group[0]!;
      activePhase = "merging";
      activePass = completed + 1;
      activeTotal = total;
      onProgress?.(
        activePhase,
        "Integrating grounded Soul summaries into one everyday identity…",
        { pass: activePass, total: activeTotal },
      );
      const scopeNotes = group.flatMap((child) => [...child.notes]);
      const essence = await digest(
        scopeNotes,
        buildSoulEssenceMergePrompt(kind, scopeNotes, group),
        group,
      );
      if (essence) {
        completed += 1;
        return { notes: scopeNotes, essence };
      }
      if (!allowAdaptiveRecovery || group.length <= 2) {
        throw soulEssenceFormatError(lastCompletionFailure, "merge");
      }

      // A small local model may preserve every child facet pairwise but lose one when asked to merge
      // a large group at once. Fall back to a balanced merge tree without weakening validation.
      const middle = Math.ceil(group.length / 2);
      const left = group.slice(0, middle);
      const right = group.slice(middle);
      total += Number(left.length > 1) + Number(right.length > 1);
      activeTotal = total;
      onProgress?.(
        "validating",
        `The combined summary was too broad; retrying it as two smaller grounded merges…`,
        { pass: completed + 1, total },
      );
      const mergedLeft = await mergeGroup(left);
      const mergedRight = await mergeGroup(right);
      return mergeGroup([mergedLeft, mergedRight]);
    };

    while (digests.length > 1) {
      const next: SoulEssenceDigestInput[] = [];
      const groups = groupSoulDigests(digests, sourceBudget);
      const mergeCount = groups.filter((group) => group.length > 1).length;
      total += mergeCount;
      for (const group of groups) {
        next.push(await mergeGroup(group));
      }
      await flushCache();
      digests = next;
    }
    // Even a one-chunk Soul needs a distinct abstraction pass. The leaf's seven support facets are
    // a grounded evidence index; this final pass is what turns their combined pattern into the short,
    // portable standing identity. It returns ONLY that small field; validated support and exact
    // invariants are carried forward deterministically instead of being regenerated.
    if (digests.length === 1 && digests[0]!.essence.generalizedEssence.text) {
      total += 1;
      activePhase = "merging";
      activePass = completed + 1;
      activeTotal = total;
      onProgress?.(
        activePhase,
        "Abstracting the grounded Soul into one portable everyday essence…",
        { pass: activePass, total: activeTotal },
      );
      const integrated = digests[0]!;
      const result = await completeSoulEssence(
        llm,
        kind,
        notes,
        buildSoulEssenceAbstractionPrompt(kind, notes, integrated.essence),
        Math.min(outputBudget, 384),
        signal,
        undefined,
        onToken,
        (_feedback, truncated) =>
          onProgress?.(
            "validating",
            truncated
              ? "The model's final essence was cut off; repairing it with the minimal output shape…"
              : "The model's final essence was too specific or malformed; repairing the abstraction…",
            { pass: activePass, total: activeTotal },
          ),
        integrated.essence,
      );
      lastCompletionFailure = result.failure;
      if (!result.essence) {
        throw soulEssenceFormatError(lastCompletionFailure, "abstraction");
      }
      completed += 1;
      digests = [{ notes, essence: result.essence }];
    }
    await flushCache();
    onProgress?.("validating", "Validating every synthesis against its source notes…", {
      pass: completed,
      total,
    });
    return digests[0]?.essence;
  } finally {
    // Abort between leaves/merges still persists every completed child digest, so the next idle or
    // manual run resumes instead of repeating already-paid generations.
    await flushCache();
  }
}

async function ensureSoulEssence(
  llm: LLMProvider,
  kind: SoulKind,
  notes: readonly SoulNote[],
  opts: {
    force?: boolean;
    /** Background downtime work may traverse the complete resumable ledger without becoming force. */
    allowMultiPass?: boolean;
    signal?: AbortSignal;
    contextTokens?: number;
    sourceBudget?: number;
    outputBudget?: number;
    onProgress?: SoulEssenceProgressCallback;
    onToken?: (delta: string) => void;
  } = {},
): Promise<SoulEssence | undefined> {
  if (opts.signal?.aborted) throw abortError();
  if (
    notes.length === 0 ||
    !supportsChat(llm) ||
    !soulDistillationFitsContext(opts.contextTokens)
  ) {
    return undefined;
  }
  const store = memoryStore();
  if (!opts.force) {
    const stored = await loadSoulEssence(store, kind, notes);
    if (stored) return stored;
  }

  const key = `${soulEssenceModelKey(llm)}:${kind}:${soulSourceFingerprint(notes)}`;
  if (opts.force) soulEssenceFailedUntil.delete(key);
  const retryAt = soulEssenceFailedUntil.get(key) ?? 0;
  if (retryAt > Date.now()) return undefined;
  soulEssenceFailedUntil.delete(key);
  let running = soulEssenceInFlight.get(key)?.promise;
  while (running) {
    if (!opts.force) return running;
    // Cancel resolves the panel immediately, while a provider may need another event-loop turn to
    // reject its request and release this key. A retry waits for that exact predecessor, ignores its
    // outcome, then starts a genuinely new forced rebuild instead of inheriting the cancelled one.
    opts.onProgress?.("queued", "Waiting for the previous Soul Essence job to stop…");
    await waitForLocalTextTurn(running.then(() => undefined, () => undefined), opts.signal);
    if (opts.signal?.aborted) throw abortError();
    running = soulEssenceInFlight.get(key)?.promise;
  }

  const entry = { promise: Promise.resolve<SoulEssence | undefined>(undefined) };
  const work = (async (): Promise<SoulEssence | undefined> => {
    // Let the ownership entry land before any synchronous provider callback can fail this job.
    await Promise.resolve();
    try {
      const essence = await distillSoulEssence(
        llm,
        kind,
        notes,
        opts.sourceBudget ?? soulDistillationSourceBudget(),
        opts.outputBudget ?? soulDistillationOutputBudget(),
        true,
        opts.force === true || opts.allowMultiPass === true,
        opts.signal,
        opts.onProgress,
        opts.onToken,
      );
      if (opts.signal?.aborted) throw abortError();
      if (!essence) {
        soulEssenceFailedUntil.set(key, Date.now() + SOUL_ESSENCE_RETRY_MS);
        if (opts.force) {
          throw new Error(
            "The text model returned data that did not satisfy the grounded Soul Essence format after a repair attempt.",
          );
        }
        return undefined;
      }
      const fingerprint = soulSourceFingerprint(notes);
      if (soulSourceFingerprint(await loadSoul(store, kind)) !== fingerprint) {
        if (opts.force) throw new Error("The Soul notes changed while the essence was being generated. Try again.");
        return undefined;
      }
      if (opts.signal?.aborted) throw abortError();
      // From this point through save + broadcast, the validated commit is atomic/non-cancellable.
      opts.onProgress?.("saving", "Saving the validated Soul Essence…");
      const saved = await saveSoulEssence(store, kind, essence, notes);
      // A note may have changed while storage was committing. Never let an in-flight turn embody an
      // essence from a revision that is no longer authoritative.
      if (soulSourceFingerprint(await loadSoul(store, kind)) !== fingerprint) {
        if (opts.force) throw new Error("The Soul notes changed while the essence was being saved. Try again.");
        return undefined;
      }
      post({ type: "soulEssenceUpdated", kind, notes: [...notes], essence: saved });
      return saved;
    } catch (error) {
      const aborted =
        opts.signal?.aborted === true ||
        (error instanceof Error && error.name === "AbortError");
      if (!aborted) soulEssenceFailedUntil.set(key, Date.now() + SOUL_ESSENCE_RETRY_MS);
      if (opts.force) throw error;
      return undefined;
    } finally {
      if (soulEssenceInFlight.get(key) === entry) soulEssenceInFlight.delete(key);
    }
  })();
  entry.promise = work;
  soulEssenceInFlight.set(key, entry);
  return work;
}

async function soulPromptFor(
  kind: SoulKind,
  opts: {
    mode?: SoulContextMode;
    /** Story-only mapped character name; keeps edited setup names bound after the opening. */
    nameOverride?: string;
    queryContext?: string;
  } = {},
): Promise<string> {
  const store = memoryStore();
  const [notes, storedName] = await Promise.all([loadSoul(store, kind), loadSoulName(store, kind)]);
  const name = opts.nameOverride !== undefined ? opts.nameOverride.trim() : storedName;
  const latestEssence = notes.length > 0
    ? await loadLatestSoulEssence(store, kind, notes)
    : undefined;
  return soulContextPromptBlock(kind, notes, {
    ...(opts.mode ? { mode: opts.mode } : {}),
    name,
    ...(opts.queryContext ? { queryContext: opts.queryContext } : {}),
    ...(latestEssence ? { latestEssence } : {}),
  });
}

function soulEvidenceQueryContext(history: readonly ChatTurn[], userText: string): string {
  const priorUserText = [...history]
    .reverse()
    .find((turn) => turn.role === "user")
    ?.content.trim();
  return priorUserText
    ? `PRIOR USER REQUEST:\n${priorUserText}\nCURRENT USER REQUEST:\n${userText}`
    : userText;
}

/**
 * When the chat model CHANGES, ask Ollama to evict the PREVIOUS local model (keep_alive 0) so two
 * models don't sit in VRAM at once — otherwise a freshly-loaded big model has to share the GPU with
 * the one it replaced (switching e.g. gemma → a 27B left BOTH resident, starving the new one and
 * making it slow). Only evicts a local-server (Ollama) model that's genuinely being replaced by a
 * different one; a cloud or unchanged model is a no-op. Best-effort — a non-Ollama server 404s harmlessly.
 */
async function evictReplacedChatModel(prev: ReaderSettings | undefined, next: ReaderSettings): Promise<void> {
  if (!prev) return;
  try {
    const cf = corsFetch();
    const opts = cf ? { corsFetch: cf } : {};
    const oldP = buildProviders(chatSettingsOf(prev), opts);
    if (oldP.llm.id !== "local-server") return; // nothing local was loaded to free
    const newP = buildProviders(chatSettingsOf(next), opts);
    if (oldP.diagnostics.llm.label === newP.diagnostics.llm.label) return; // same model — keep it warm
    await oldP.llm.unload?.();
  } catch {
    /* best-effort — a build hiccup or non-Ollama server is a silent no-op */
  }
}

/**
 * Free the image engine's resident VRAM when the reader SWITCHES image backends (or on first init), so the
 * low-VRAM IDLE state is "image model unloaded, chat LLM holds the GPU" — the baseline ComfyUI already has
 * (it loads lazily). It matters most for AUTOMATIC1111, which auto-loads a checkpoint the moment it starts,
 * so without this it squats the GPU during idle chat and the LLM spills to slow shared RAM. Unloads BOTH the
 * newly-active engine's idle model and the one just switched away from; each reloads on its next render.
 * Low-VRAM only (an ample box keeps models hot); best-effort. The per-render hand-off (freeChatLlmForRender /
 * freeImageModelForChat) does the rest of the cycle, identically to ComfyUI.
 */
async function freeSwitchedImageEngine(prev: ReaderSettings | undefined, next: ReaderSettings): Promise<void> {
  if (!next.lowVram) return;
  try {
    const cf = corsFetch();
    const opts = cf ? { corsFetch: cf } : {};
    const newP = buildProviders(next, opts);
    const oldP = prev ? buildProviders(prev, opts) : undefined;
    // An unrelated settings tweak that didn't change the image engine → don't churn (a needless unload
    // forces a cold reload on the next render). A genuine switch (or first init) falls through.
    if (oldP && oldP.diagnostics.image.label === newP.diagnostics.image.label) return;
    await newP.image.freeMemory?.(); // A1111's startup checkpoint (a lazy no-op for ComfyUI / cloud)
    if (oldP) await oldP.image.freeMemory?.(); // the engine we left, if it still holds its model
  } catch {
    /* best-effort — a build hiccup / unreachable engine / non-managed provider is a silent no-op */
  }
}

/**
 * Context budgets by provider class. Cloud chat models have six-figure token
 * windows — capping their book context at the local-friendly default threw away
 * 90% of what they could read. Local/on-device models keep the small budgets.
 */
const CLOUD_LLM_IDS = new Set(["claude", "gemini", "openai"]);
/** Cloud models bill per call, so a long auto-run tool streak PAUSES for a "keep going?" check this
 * often (the reader gets a Continue button) instead of running to the big local backstop. Local/free
 * models (local-server / local WebLLM) don't pass this, so they run uninterrupted. */
const CLOUD_TOOL_PAUSE_ROUNDS = 10;
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
  /**
   * Total characters one turn may send — system prompt, conversation AND the tool results that
   * arrive mid-turn. `book`/`history` bound what is assembled BEFORE a turn starts; this bounds the
   * turn as it runs, which is where a 60,000-character file read actually overflows the window.
   */
  input: number;
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
const LOCAL_REPLY_FRACTION = 0.4;
const MAX_LOCAL_REPLY_TOKENS = 32_768;
/**
 * THE FLOOR, AND WHY A FRACTION ALONE WAS THE WRONG SHAPE.
 *
 * Reasoning tokens and reply tokens come out of the SAME `num_predict` on Ollama. At 30% of a
 * conservative 8,192-token window that was 2,457 tokens for both — and a qwen3-class model spends
 * 800–3,000 of them thinking before it writes a character. So the generation ended inside the
 * thinking block, every round, and the round loop bought nothing: round 20 faced the identical wall
 * as round 0. Reported as "it just thought forever and never gave anything".
 *
 * A fraction of the window was never the right rule anyway. `num_predict` does not have to be
 * carved out of `num_ctx` proportionally — the INPUT is bounded separately (see `inputChars`), so
 * the only real constraint is that the two together fit. A floor plus a half-the-window ceiling says
 * that directly: the reply always has room to be an answer, and the input always keeps half.
 *
 * 4,096 because that is roughly a thinking model's deliberation plus a page of real output — below
 * it, a long deliverable is not merely tight, it is impossible however many rounds are spent on it.
 */
const MIN_LOCAL_REPLY_TOKENS = 4096;
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
    const window = CLOUD_MAX_TOKENS[llmId];
    return {
      book: 24_000,
      history: 60_000,
      reply: CLOUD_REPLY_TOKENS,
      // Cloud windows are large, so the turn bound is generous — it exists to stop a runaway tool
      // loop, not to ration a conversation.
      input: window ? Math.floor(window * CHARS_PER_TOKEN * 0.45) : 120_000,
      ...(window ? { maxTokens: window } : {}),
    };
  }
  if (ctxTokens && ctxTokens > 0) {
    const usable = Math.min(ctxTokens, MAX_TRUSTED_CONTEXT_TOKENS);
    const replyTokens = Math.min(
      MAX_LOCAL_REPLY_TOKENS,
      // The input always keeps half the window. This is what makes the floor safe on a small one:
      // an 8,192-token window gives 4,096 to each side rather than a floor that eats the context.
      Math.floor(usable / 2),
      Math.max(MIN_LOCAL_REPLY_TOKENS, Math.floor(usable * LOCAL_REPLY_FRACTION)),
    );
    // What is left for INPUT after the reply, not an arbitrary fraction of the whole window.
    //
    // 45% was too small to be a bound on anything: on a 32k-token model it allowed 58,982 characters
    // of input while the system prompt alone — role, tools, identity notes, memories, skills — came to
    // about 66,000. The allowance was smaller than the thing it was supposed to be allocating, so the
    // conversation's share of it was negative and it fell to the floor. The reader saw a long chat on
    // screen and an assistant that could see only their current message.
    //
    // The window minus the reply, minus a tenth for tokenizer variance, is what is actually available.
    const inputChars = Math.min(
      Math.floor(Math.max(usable - replyTokens, Math.floor(usable * 0.3)) * CHARS_PER_TOKEN * 0.9),
      MAX_LOCAL_INPUT_CHARS,
    );
    return {
      book: Math.floor(inputChars * 0.7),
      history: Math.floor(inputChars * 0.3),
      input: inputChars,
      // ~30% of the window per reply (floored so tiny windows still answer; ceilinged at
      // MAX_LOCAL_REPLY_TOKENS so ONE generation stays tractable). A 100k window → ~30k per pass, and
      // the chat/buddy loop AUTO-CONTINUES beyond even that — total output is effectively unbounded.
      reply: replyTokens,
      maxTokens: usable,
    };
  }
  return { book: CHAT_CONTEXT_BUDGET_CHARS, history: 8_000, reply: 1024, input: CHAT_CONTEXT_BUDGET_CHARS + 8_000 };
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
  // Budget to the window we ACTUALLY loaded. On the Ollama path buildProviders sends
  // num_ctx = defaultLoadedWindow(...), which overrides the Modelfile — so size the budget to that (not
  // the old 4096 fallback, which trimmed a just-written file out of context). Bundled/other servers keep
  // the queried-or-conservative path. The per-model/global overrides above already returned.
  const isOllama = settings.localTextBackend !== "bundled" && (settings.localTextServer ?? "ollama") === "ollama";
  const ctx = resolveLoadedContextTokens({
    isOllama,
    model,
    gpuVramMb: settings.gpuVramMb,
    infoLoaded: info?.loaded,
    infoMax: info?.max,
    ollamaDefault: OLLAMA_DEFAULT_LOADED_TOKENS,
  });
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
        slash.call.tool === "generate_video" ||
        slash.call.tool === "generate_long_video" ||
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
    // The assistant's identity ("soul") — emitted as the FIRST section of ordinary book chat too.
    // Stories use a narrower policy: only a persisted You-and-me cast receives generalized character
    // baselines. Raw notes/evidence stay out, and custom fictional casts receive no Soul context.
    const soulQueryContext = soulEvidenceQueryContext(msg.history, msg.userText);
    const soulMode = selectSoulContextMode({ storyActive: book.kind === "story" });
    const storySoulCast = await soulCastForStoryBook(book);
    const [selfSoul, userSoul] =
      soulMode === "story" && !storySoulCast
        ? ["", ""] as const
        : await Promise.all([
            soulMode === "story" && !storySoulCast?.self
              ? Promise.resolve("")
              : soulPromptFor("self", {
                  mode: soulMode,
                  ...(storySoulCast?.self ? { nameOverride: storySoulCast.self } : {}),
                  ...(soulMode !== "story" ? { queryContext: soulQueryContext } : {}),
                }),
            soulMode === "story" && !storySoulCast?.user
              ? Promise.resolve("")
              : soulPromptFor("user", {
                  mode: soulMode,
                  ...(storySoulCast?.user ? { nameOverride: storySoulCast.user } : {}),
                  ...(soulMode !== "story" ? { queryContext: soulQueryContext } : {}),
                }),
          ]);
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
      ...(selfSoul ? { selfSoul } : {}),
      ...(userSoul ? { userSoul } : {}),
    });
    const sec = (key: string) => sections.find((s) => s.key === key)?.text ?? "";
    const memory = memoryPromptBlock(await loadMemory(memoryStore()));
    const skills = skillsIndexBlock(withBuiltinSkills(await loadSkills(memoryStore())));
    // THE SAME REFERENCE PICTURES THE BUDDY CHAT DRAWS FROM. The reference set is per-SESSION, not
    // per-panel, and the reader's renders were the one surface that knew nothing about it: the block
    // rode only the buddy turn, and handleChatTool was called from here without `refImages`. So a
    // picture the reader had chosen worked when they asked for it in the buddy chat and silently did
    // nothing when they asked for it beside their book.
    //
    // Both halves land together, and that is the point. Passing the pictures to the render while
    // leaving the model unaware of them is worse than neither: not knowing a reference is attached,
    // it writes a fully descriptive prompt, and a description plus a reference gives you the
    // description rather than the likeness — the failure this block exists to prevent. It also
    // carries the "say so rather than silently drawing from these" rule, which a chat about a BOOK
    // needs more than the buddy does: most illustrations here have nothing to do with the reader's
    // saved picture, and the model has to be able to say so.
    //
    // Rides at the END, after the stable sections that chatSystemCachePrefix is built from, so a set
    // that changes mid-session can't invalidate the cached prefix.
    const imageRefBlock = buildImageReferenceBlock(imageRefLedger);
    const system =
      sections
        .map((s) => s.text)
        .filter(Boolean)
        .join("\n\n") +
      (memory ? `\n\n${memory}` : "") +
      // selfSoul/userSoul are now the FIRST section (above), not appended here.
      (skills ? `\n\n${skills}` : "") +
      (note ? `\n\n${note}` : "") +
      (imageRefBlock ? `\n\n${imageRefBlock}` : "");
    // A bare roleplay line ("I draw my sword") looks like chat addressed to the assistant's
    // character, even though the desired product is a narrated story beat. Wrap ONLY the model-facing
    // current turn in an explicit writing brief: the UI/history still stores the reader's exact text,
    // while the model must place it on the page before continuing the scene.
    const modelFacingUserText =
      story?.mode === "roleplay"
        ? roleplayStoryTurnPrompt(msg.userText, story.play)
        : msg.userText;
    // The conversation gets whatever the system prompt didn't use — measured, not guessed. See
    // historyBudget: a fixed fraction starved the chat of all but the last exchange or two.
    const history = trimChatHistory(
      [...msg.history, { role: "user", content: modelFacingUserText }],
      historyBudget(budgets.input, system.length),
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
      contextChars: budgets.input,
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
      message: stopOrError(ac, err),
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
            const r = await hostFile({ op: "read", path, ...(hostWorkingDir ? { cwd: hostWorkingDir } : {}) });
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
/**
 * MAKE GOOGLE TASKS MATCH THE APP for one plan, from anywhere.
 *
 * The write-back used to be scattered and partial: two chat tools patched a single sub-task's
 * status, a re-plan ran the full sync, and everything else — the new editing tools, and every
 * checkbox in the app's own Tasks panel and timeline — wrote to the local store and stopped there.
 * So a reader who ticked steps off in the app watched Google Tasks (and therefore their phone) keep
 * showing the whole list as outstanding, with no way to tell which copy was current.
 *
 * Best-effort by design: the in-app plan is already saved before this runs, and a failed Google call
 * must never lose it.
 */
async function mirrorPlanToGoogle(planId: string): Promise<void> {
  const googleId = settings?.keys?.googleClientId;
  const googleSecret = settings?.keys?.googleClientSecret;
  if (!googleId || !googleSecret) return;
  const store = memoryStore();
  const plan = (await loadTaskPlans(store)).find((p) => p.id === planId);
  if (!plan?.googleTaskId) return; // never linked to Google — nothing to mirror
  try {
    if (!(await loadGoogleTokens(store))) return;
    const t = new DirectTransport(corsFetch());
    const tok = (): Promise<string> => getFreshAccessToken(store, { clientId: googleId, clientSecret: googleSecret, transport: t });
    const synced = await syncPlanToGoogleTasks(plan, t, tok);
    await upsertTaskPlan(store, synced); // keeps the sub-task ids the sync just learned
  } catch {
    /* best-effort */
  }
}

/**
 * WHY a picture couldn't be adopted, when we can find out cheaply.
 *
 * The ladder returns "no bytes" for a refusal and for a format we reject, which are different
 * problems: one is the host saying no, the other is "pick a different result, this one is AVIF".
 * A second fetch is worth it because the alternative is a reader retrying a dead end.
 */
async function describeAdoptFailure(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  const cf = corsFetch();
  if (!cf) return undefined;
  try {
    const res = await new DirectTransport(cf).send({ url, method: "GET", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return `that host refused the download (HTTP ${res.status}) — it only allows hotlinking`;
    const bytes = await res.arrayBuffer();
    const format = unsupportedImageFormat(bytes);
    if (format) {
      return `that picture is ${format}, which the image engine can't open — pick a JPEG or PNG result instead`;
    }
    return "that host served something that wasn't an image (usually a block page)";
  } catch {
    return undefined;
  }
}

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
    // Push the step's CURRENT state: complete it, reopen it, and correct any wording/date/detail
    // that has drifted. Reopening and correcting are new — the sync only ever pushed completions, so
    // un-ticking a step or renaming it was a change Google never heard about.
    const status = action.needsComplete ? ("completed" as const) : action.needsReopen ? ("needsAction" as const) : undefined;
    if (gid && (status || action.patch)) {
      try {
        await patchTask(transport, await tok(), gid, { ...(status ? { status } : {}), ...action.patch });
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
  // …along with its TITLE, DUE DATE and DONE/NOT-DONE state. Only the notes used to be refreshed, so
  // a renamed, re-dated or completed task still showed on the reader's phone under the old title, on
  // the old date, as something still to do.
  const notes = formatPlanForGoogleNotes({ ...plan, steps });
  let googleNotesSynced = plan.googleNotesSynced;
  try {
    await patchTask(transport, await tok(), parentId, googleParentPatch(plan, notes));
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
            listEvents: async (o: { max?: number; timeMin?: string; timeMax?: string; query?: string }) =>
              listEvents(transport, await tok(), o),
          }
        : {}),
      openLibraryBook: notUsed,
      openWebText: notUsed,
      openPastedText: notUsed,
      removeLibraryBook: notUsed,
      setVisualStyle: notUsed,
    };
    // Loaded BEFORE the planning run, not after, because the planner needs to know what's already
    // finished. Without it a re-plan rebuilds the task from the beginning and hands the reader back
    // the four steps they'd already done as work still to do.
    const existing = msg.planId ? (await loadTaskPlans(store)).find((p) => p.id === msg.planId) : undefined;
    const alreadyDone = (existing?.steps ?? []).filter((s) => s.status === "done").map((s) => s.title);
    const plan = await withChatPriority(
      llm.id,
      () =>
        runTaskPlanning({
          llm,
          research,
          source: msg.source,
          sourceText: msg.sourceText,
          todayIso: new Date().toISOString().slice(0, 10),
          ...(alreadyDone.length ? { alreadyDone } : {}),
          signal: ac.signal,
          onPhase: (phase, note) =>
            post({ type: "planProgress", requestId: msg.requestId, phase, ...(note ? { note } : {}) }),
        }),
      { signal: ac.signal },
    );
    if (!plan) throw new Error("Couldn't produce a usable plan — try rephrasing the task.");
    // Re-planning an existing task MERGES onto it (see mergeReplan) rather than replacing it. The
    // planner is never shown the current plan — it works from a prose blob of title/summary/deadline
    // /reader-notes — so it cannot re-emit what was already there, and this used to carry five keys
    // forward and drop everything else: completed steps came back un-ticked, step ids the chat was
    // holding went dangling, per-step findings vanished, and every document on the task was
    // destroyed. Dropping `needsReplan` is still what CLEARS the re-attack flag.
    const baseFinal: TaskPlan = existing ? mergeReplan(existing, plan) : plan;
    // When the task came FROM an email, drop a Gmail link on the step that needs the reply/send, so
    // the reader can jump straight to it from the plan (and from Google Tasks, via the notes).
    const srcEmailId =
      baseFinal.source.kind === "email" || baseFinal.source.kind === "scan" ? baseFinal.source.emailId : undefined;
    const finalPlan = attachSourceEmailLink(baseFinal, srcEmailId);
    // SAVE + return the plan FIRST, so the steps show in the app immediately and can't be lost to a
    // slow/hung Google call. The Google mirror is then best-effort in the BACKGROUND (below).
    await upsertTaskPlan(store, finalPlan);
    // Turn the plan's WATCHES into scheduled actions bound to it, so the task can advance on its own
    // between visits. Reconciled (not re-created): re-planning happens repeatedly, and recreating them
    // each time would both pile up duplicates and reset each watch's run history — losing the
    // "what's new since last time" window that keeps a repeating check incremental.
    await reconcilePlanWatches(store, finalPlan).catch(() => {});
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
      error: stopOrError(ac, err),
    });
  } finally {
    chatAborts.delete(msg.requestId);
  }
}

/**
 * Bring a plan's bound scheduled actions in line with the watches it asked for.
 *
 * Matched by title (the planner is told to keep them stable), so re-planning a task UPDATES a watch
 * in place — keeping its `lastRunIso`, and therefore the incremental window each run is given —
 * rather than replacing it with a fresh one that would re-read everything from scratch. Watches the
 * plan no longer lists are removed, so a re-plan that drops a check stops it firing. Only touches
 * actions bound to THIS plan; standalone scheduled actions are never in scope.
 */
async function reconcilePlanWatches(store: VisualReaderStore, plan: TaskPlan): Promise<void> {
  const wanted = plan.watches ?? [];
  const all = await loadScheduledTasks(store);
  const mine = all.filter((t) => t.planId === plan.id);
  for (const stale of mine.filter((t) => !wanted.some((w) => w.title === t.title))) {
    await deleteScheduledTask(store, stale.id).catch(() => {});
  }
  for (const w of wanted) {
    const existing = mine.find((t) => t.title === w.title);
    await upsertScheduledTask(
      store,
      normalizeScheduledTask({
        ...(existing ?? {}), // keep id, enabled, lastRunIso, nextDueIso
        title: w.title,
        prompt: w.prompt,
        rule: w.rule,
        planId: plan.id,
        ...(w.time ? { time: w.time } : {}),
        ...(w.date ? { date: w.date } : {}),
        ...(w.weekday !== undefined ? { weekday: w.weekday } : {}),
        ...(w.dayOfMonth !== undefined ? { dayOfMonth: w.dayOfMonth } : {}),
      }),
    ).catch(() => {});
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
    await waitForForegroundChat();
    const reply = await withChatPriority(llm.id, () =>
      llm.chat(buildScanPrompt(emails, events, now.toISOString().slice(0, 10), focusIds), {
        maxTokens: 1024,
      }),
    );
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

/** Edit an existing Google Calendar event (the Calendar panel's inline edit). Mirrors
 * handleCreateEvent; `patchEvent` handles the append-vs-replace read-modify-write. */
async function handleUpdateEvent(msg: Extract<MainToWorker, { type: "updateEvent" }>): Promise<void> {
  try {
    const store = memoryStore();
    const googleId = settings?.keys?.googleClientId;
    const googleSecret = settings?.keys?.googleClientSecret;
    if (!googleId || !googleSecret || !(await loadGoogleTokens(store))) {
      post({ type: "eventUpdated", requestId: msg.requestId, ok: false, error: "Connect Google first." });
      return;
    }
    const transport = new DirectTransport(corsFetch());
    const token = await getFreshAccessToken(store, { clientId: googleId, clientSecret: googleSecret, transport });
    const ev = await patchEvent(transport, token, msg.eventId, msg.patch, msg.calendarId);
    post({ type: "eventUpdated", requestId: msg.requestId, ok: true, ...(ev.id ? { id: ev.id } : {}) });
  } catch (err) {
    post({ type: "eventUpdated", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
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
    // A failed Yahoo response isn't JSON — a rate-limit is the plain text "Edge: Too Many Requests" —
    // so reading it as JSON turned a throttle into a parse error that named neither cause nor cure.
    const bad = yahooFetchError(res.status);
    if (bad) throw new Error(bad);
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
    const bad = yahooFetchError(res.status);
    if (bad) throw new Error(bad);
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
    const text = await withChatPriority(llm.id, () =>
      llm.chat(
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
      ),
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

async function handleSoulEssenceRefresh(
  msg: Extract<MainToWorker, { type: "soulEssenceRefresh" }>,
): Promise<void> {
  const ac = new AbortController();
  soulEssenceAborts.get(msg.requestId)?.abort();
  soulEssenceAborts.set(msg.requestId, ac);
  if (msg.background) {
    const previous = idleSoulEssenceRequestId;
    if (previous !== undefined && previous !== msg.requestId) {
      soulEssenceAborts.get(previous)?.abort();
    }
    idleSoulEssenceRequestId = msg.requestId;
  }
  const startedAt = Date.now();
  let tokens = 0;
  let lastTokenPost = 0;
  let tokenTimer: ReturnType<typeof setTimeout> | undefined;
  let current: SoulEssenceJobProgress = {
    phase: "queued",
    message: "Soul Essence generation queued…",
    startedAt,
  };
  const postCurrent = () => {
    lastTokenPost = Date.now();
    post({
      type: "soulEssenceProgress",
      requestId: msg.requestId,
      kind: msg.kind,
      progress: { ...current, tokens },
    });
  };
  const report: SoulEssenceProgressCallback = (phase, message, progress = {}) => {
    if (tokenTimer) {
      clearTimeout(tokenTimer);
      tokenTimer = undefined;
    }
    current = {
      ...current,
      phase,
      message,
      ...("pass" in progress ? { pass: progress.pass } : {}),
      ...("total" in progress ? { total: progress.total } : {}),
    };
    if (phase === "saving") soulEssenceCommits.add(msg.requestId);
    postCurrent();
  };
  const onToken = (delta: string) => {
    tokens += Math.max(1, Math.ceil(delta.length / CHARS_PER_TOKEN));
    const wait = 250 - (Date.now() - lastTokenPost);
    if (wait <= 0) {
      postCurrent();
      return;
    }
    if (!tokenTimer) {
      tokenTimer = setTimeout(() => {
        tokenTimer = undefined;
        postCurrent();
      }, wait);
    }
  };
  // Some providers buffer a whole response (no token callbacks), and a healthy local queue/video
  // wait can exceed the UI watchdog. Re-post the current phase so desktop and phone distinguish a
  // live foreground job from a genuinely stalled model.
  const jobHeartbeat = setInterval(postCurrent, 30_000);
  try {
    report("loading", "Preparing the chat text model…");
    const store = memoryStore();
    const notes = await loadSoul(store, msg.kind);
    if (
      msg.expectedFingerprint &&
      soulSourceFingerprint(notes) !== msg.expectedFingerprint
    ) {
      // The edit was superseded before its idle slot began. This is a successful no-op; the app's
      // newer fingerprint remains dirty and will be considered by a later sweep.
      post({ type: "soulEssenceRefreshed", requestId: msg.requestId, ok: true });
      return;
    }
    if (notes.length === 0) {
      post({ type: "soulEssenceRefreshed", requestId: msg.requestId, ok: true });
      return;
    }
    // A manual multi-pass rebuild is deliberately lower priority than a conversation already in
    // flight, including the small gap between that turn's identity-prep and reply leases.
    await waitForForegroundChat(ac.signal, () =>
      report("queued", "Waiting for the active chat-model turn to finish…"),
    );
    const queueId = bundledLocalSelected() ? "local-server" : chatProviders().llm.id;
    const essence = await withChatPriority(
      queueId,
      async () => {
        // Build only after the worker-owned VRAM hand-off and bundled launch returned its live URL.
        const { llm, llmDiagnostic } = chatProviders({
          onLocalStatus: (message) => {
            if (message) report("loading", message);
          },
        });
        if (llm.id === "mock" || !supportsChat(llm)) {
          throw new Error(
            llmDiagnostic.reason
              ? `The chat text model is not available: ${llmDiagnostic.reason}`
              : "The chat text model is not available. Choose or start a text model in Settings.",
          );
        }
        report("loading", `Activating ${llmDiagnostic.label || "the chat text model"}…`);
        const contextTokens = await localContextTokens(llm.id);
        const budgets = contextBudgets(llm.id, contextTokens);
        if (!soulDistillationFitsContext(budgets.maxTokens)) {
          throw new Error(
            `Soul Essence generation needs at least a ${MIN_SOUL_DISTILLATION_CONTEXT_TOKENS.toLocaleString()}-token text-model context window. Increase the local context setting; the original Soul notes remain intact.`,
          );
        }
        const sourceBudget = soulDistillationSourceBudget(budgets.maxTokens);
        const outputBudget = soulDistillationOutputBudget(budgets.maxTokens);
        return ensureSoulEssence(llm, msg.kind, notes, {
          force: msg.background !== true,
          ...(msg.background ? { allowMultiPass: true } : {}),
          signal: ac.signal,
          ...(budgets.maxTokens ? { contextTokens: budgets.maxTokens } : {}),
          sourceBudget,
          outputBudget,
          onProgress: report,
          onToken,
        });
      },
      {
        signal: ac.signal,
        onQueued: () => report("queued", "Waiting for the active chat-model turn to finish…"),
        onAcquired: () => report("loading", "Preparing the chat text model…"),
        forceBundledEnsure: true,
        onModelProgress: (message, percent) =>
          report(
            "loading",
            percent !== undefined ? `${message} ${Math.round(percent)}%` : message,
          ),
      },
    );
    if (!essence) throw new Error("the text model could not produce a grounded Soul Essence");
    post({
      type: "soulEssenceRefreshed",
      requestId: msg.requestId,
      ok: true,
      essence,
    });
  } catch (err) {
    const cancelled = ac.signal.aborted || (err instanceof Error && err.name === "AbortError");
    post({
      type: "soulEssenceRefreshed",
      requestId: msg.requestId,
      ok: false,
      error: cancelled
        ? "Soul Essence generation was cancelled."
        : err instanceof Error
          ? err.message
          : String(err),
    });
  } finally {
    clearInterval(jobHeartbeat);
    if (tokenTimer) clearTimeout(tokenTimer);
    soulEssenceCommits.delete(msg.requestId);
    if (soulEssenceAborts.get(msg.requestId) === ac) soulEssenceAborts.delete(msg.requestId);
    if (idleSoulEssenceRequestId === msg.requestId) idleSoulEssenceRequestId = undefined;
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
      const raw = await withChatPriority(
        llm.id,
        () => llm.chat(buildUnderstandPrompt(base), { maxTokens: 512, signal: ac.signal }),
        { signal: ac.signal },
      );
      const { plan, question } = parseUnderstanding(raw);
      post({ type: "polished", requestId: msg.requestId, stage: "understand", ok: true, plan, question });
      return;
    }
    const text = await withChatPriority(
      llm.id,
      () =>
        llm.chat(buildProducePrompt({ ...base, confirmedPlan: msg.confirmedPlan ?? "" }), {
          maxTokens: 4096,
          signal: ac.signal,
          onToken: (delta) => post({ type: "polishToken", requestId: msg.requestId, text: delta }),
        }),
      { signal: ac.signal },
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
      error: stopOrError(ac, err),
    });
  } finally {
    chatAborts.delete(msg.requestId);
  }
}

/**
 * A CANCELLATION IS AN OUTCOME, NOT A FAULT — and rendering it as one put Chrome's internals into
 * the reader's chat AND into the model's history.
 *
 * Pressing Stop aborts the fetch, and the rejection that comes back is a DOMException whose message
 * is whatever the browser felt like saying: "BodyStreamBuffer was aborted". Four handlers posted
 * `err.message` unclassified, so that string became the error the host reports. `interruptedRunNote`
 * then writes it into a DURABLE model-facing turn — "[That run STOPPED before it finished —
 * BodyStreamBuffer was aborted…]" — which is replayed as history on every later turn of that chat,
 * so a 30k-window local model spends the rest of the session being told its last attempt died of a
 * Blink internal.
 *
 * This file already knew: `handleChatTool` classifies the same abort and says "Image generation
 * stopped." The handlers that feed the reader's own chat were the ones that did not.
 */
const stopOrError = (ac: AbortController, err: unknown): string =>
  ac.signal.aborted || (err instanceof Error && err.name === "AbortError")
    ? "Stopped."
    : err instanceof Error
      ? err.message
      : String(err);

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
/** The last buddy reply's measured speed, handed to the next turn's prompt. */
let lastGeneration: GenerationRate | undefined;

function currentDateTimeLabel(): string {
  const now = new Date();
  const label = now.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    // Seconds, so the clock the model compares message stamps against is as precise as the stamps
    // themselves. Without it, everything inside the current minute reads as "just now" or "a minute
    // ago" depending on which side of the rounding it fell.
    second: "2-digit",
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
    const runAgents = () =>
      mapWithConcurrency(msg.agents, concurrency, async (agent, idx) => {
        try {
          const out = await runBuddyTurn({
            llm: agentLlm,
            system: buildCodingAgentPrompt({ title: agent.title, instructions: agent.instructions }, agent.dir),
            history: [{ role: "user", content: "Complete your subtask in your worktree, verify it, and report what you changed." }],
            deps,
            runHostTool: (call) => runHostToolViaMain(msg.runId, idx, call, agent.dir),
            maxTokens: budgets.reply,
            contextChars: budgets.input,
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
    const results =
      agentLlm === llm
        ? await withChatPriority(llm.id, runAgents, { signal: ac.signal })
        : await runAgents();
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
    const resolved = await withChatPriority(llm.id, () =>
      mapWithConcurrency(msg.files, 1, async (f) => {
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
      }),
    );
    post({ type: "conflictsResolved", requestId: msg.requestId, files: resolved });
  } catch (e) {
    post({ type: "conflictsResolved", requestId: msg.requestId, files: [], error: e instanceof Error ? e.message : String(e) });
  }
}

async function handleBuddyChat(msg: Extract<MainToWorker, { type: "buddyChat" }>): Promise<void> {
  const ac = new AbortController();
  const turnStartedAt = Date.now();
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
    // The chat's lightweight working checklist. Starts as whatever the host injected; set_plan/
    // complete_step mutate THIS copy mid-turn (so the loop's feedback shows progress) and post each
    // update to the host, which renders + persists it as the canonical per-session plan.
    let plan = msg.plan;
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
            draftEmail: async (d) => {
              // REVISION GUARD. Being told to use edit_draft isn't enough — the model still reaches
              // for draft_email on "change it", and the cost is a second draft in the reader's Gmail
              // with nothing marking which is current. When this call targets the SAME people about
              // the SAME subject as the draft already open, it IS that revision: update that draft
              // instead of adding another. Only the target is compared, never the body — the body is
              // what a revision changes. A genuinely different email (new recipient, new subject)
              // drafts normally, and the result says which happened so the model can tell.
              const held = lastDraftBySession.get(turnSessionId);
              if (held && sameDraftTarget(held, d)) {
                const updated = await editDraft(transport, await tok(), held.id, {
                  to: d.to,
                  subject: d.subject,
                  body: d.body,
                  ...(d.cc ? { cc: d.cc } : {}),
                  ...(d.bcc ? { bcc: d.bcc } : {}),
                });
                lastDraftBySession.set(turnSessionId, { id: updated.id, to: updated.to, subject: updated.subject });
                return { id: updated.id, updatedExisting: true };
              }
              const r = await createDraft(transport, await tok(), d);
              // Remember it for the DRAFT IN PROGRESS block: the id would otherwise survive only in
              // this one tool result, and a later "make it warmer" would draft a second copy.
              if (r.id) lastDraftBySession.set(turnSessionId, { id: r.id, to: d.to, subject: d.subject });
              return r;
            },
            listDrafts: async (max) => listDrafts(transport, await tok(), max),
            editDraft: async (draftId, patch) => {
              const d = await editDraft(transport, await tok(), draftId, patch);
              lastDraftBySession.set(turnSessionId, { id: d.id, to: d.to, subject: d.subject });
              return d;
            },
            listEvents: async (o: { max?: number; timeMin?: string; timeMax?: string; query?: string }) =>
              listEvents(transport, await tok(), o),
            createEvent: async (ev) => createEvent(transport, await tok(), ev),
            updateEvent: async (eventId, patch, calendarId) => patchEvent(transport, await tok(), eventId, patch, calendarId),
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
      // App-managed-steps mode: the host runs the checklist + ticks steps from evidence, so the worker
      // refuses a stray complete_step (set_plan still COMPILES the plan; the host owns advancement).
      ...(msg.appManagedSteps ? { appManagedSteps: true } : {}),
      searchWeb: (q) => imageSearch.searchWeb(q),
      searchBooks: (q) => books.search(q),
      searchImages: (q) => imageSearch.search(q),
      // ADOPT a searched picture: `retrieve` is the existing bytes → thumbnail → hotlink ladder,
      // with the guards these hosts need (thumbnail first, since Commons originals are often TIFF or
      // PDF that an <img> can't decode; a 10s deadline, because search-result hosts are the least
      // reliable endpoints we talk to). A hotlink-only result is NOT an adoption — the image model
      // needs bytes — so it's reported as a failure rather than silently doing nothing.
      adoptImageReference: async ({ query, url }: { query?: string; url?: string }) => {
        try {
          // A URL is the picture the reader actually pointed at. It goes through the SAME ladder as
          // a search hit (retrieveFromHits with a one-item list), so a thumbnail-only host and an
          // undisplayable original are handled identically either way.
          const found = url
            ? await retrieveFromHits(new DirectTransport(corsFetch() ?? fetch), [{ link: url, title: url }])
            : query
              ? await imageSearch.retrieve(query)
              : undefined;
          if (!found?.bytes) {
            // "Could not download" covers two situations that need different actions from the
            // reader, so find out which. A hotlink-blocking host and a modern container the image
            // engine can't open both end up here, and only one of them is worth retrying.
            const why = found ? await describeAdoptFailure(url ?? found.sourceUrl) : undefined;
            return { ok: false, error: why ?? (found ? "that host refused the download (it only allows hotlinking)" : "no picture found") };
          }
          const bytes = new Uint8Array(found.bytes.bytes);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return {
            ok: true,
            ...(found.title ? { title: found.title } : {}),
            base64: btoa(binary),
            mimeType: found.bytes.mimeType || "image/jpeg",
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
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
        // EVERY failure names itself. This used to return `undefined` for two unrelated reasons —
        // no CORS transport, and a response that didn't parse — which the caller then reported as
        // one vague "no market data for MSFT" covering causes with completely different fixes.
        // Thrown rather than returned: runBuddyTool turns a throw into `{ error }`, which both the
        // reader and the model actually see.
        const cf = corsFetch();
        if (!cf) {
          throw new Error(
            "The keyless quote feed needs the desktop app or the browser extension — a plain browser tab is blocked " +
              "from calling Yahoo directly (CORS). Everything else in the app still works.",
          );
        }
        const res = await new DirectTransport(cf).send({ url: yahooQuoteUrl(symbol), method: "GET" });
        const bad = yahooFetchError(res.status);
        if (bad) throw new Error(bad);
        const quote = parseYahooQuote(await res.json(), symbol);
        if (!quote) {
          throw new Error(
            `Yahoo answered for "${symbol}" but carried no price. Check the ticker — an index needs a caret (^GSPC) ` +
              "and a non-US listing needs its exchange suffix (.TO, .L, .DE).",
          );
        }
        return quote;
      },
      // Keyless technical indicators from Yahoo's chart JSON (over the CORS-exempt
      // transport; undefined on plain web).
      marketIndicators: async (symbol: string, interval?: string, range?: string) => {
        const cf = corsFetch();
        if (!cf) {
          throw new Error(
            "The keyless indicator feed needs the desktop app or the browser extension — a plain browser tab is " +
              "blocked from calling Yahoo directly (CORS).",
          );
        }
        const res = await new DirectTransport(cf).send({
          url: yahooChartUrl(symbol, { interval: interval || "5m", range: range || "1d" }),
          method: "GET",
        });
        const bad = yahooFetchError(res.status);
        if (bad) throw new Error(bad);
        const indicators = computeIndicators(symbol, parseYahooChart(await res.json()));
        if (!indicators) {
          throw new Error(
            `Yahoo returned no bars for "${symbol}" at ${interval || "5m"}/${range || "1d"} — check the ticker, or ` +
              'try a wider window (interval "1d", range "6mo").',
          );
        }
        return indicators;
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
      // Incognito (remote privacy): keep READING memory/skills/souls (so the assistant stays useful)
      // but never WRITE — a remote session leaves no remembered notes or learned identity behind.
      // `about` routes to one of the two identity souls (self/user); default → reader memory.
      remember: async (n, about) => {
        const soul = about === "self" || about === "user" ? about : undefined;
        if (settings?.incognitoRemote) return (soul ? await loadSoul(store, soul) : await loadMemory(store)).length;
        return (soul ? await rememberSoul(store, soul, n) : await rememberNote(store, n)).length;
      },
      forget: async (m, about) => {
        const soul = about === "self" || about === "user" ? about : undefined;
        if (settings?.incognitoRemote) return (soul ? await loadSoul(store, soul) : await loadMemory(store)).length;
        return (soul ? await forgetSoul(store, soul, m) : await forgetNote(store, m)).length;
      },
      // Lightweight chat-scoped checklist — mutate the in-turn `plan` and mirror each change to the host.
      setPlan: (goal, steps, stepDetails) => {
        plan = {
          ...(goal ? { goal } : {}),
          steps: steps.map((t, i) => {
            const d = stepDetails?.[i];
            return {
              text: t,
              status: "pending" as const,
              ...(d?.needs ? { needs: d.needs } : {}),
              ...(d?.onFail ? { onFail: d.onFail } : {}),
              ...(d?.produces && d.produces.length ? { produces: d.produces } : {}),
              ...(d?.verify ? { verify: d.verify } : {}),
            };
          }),
        };
        post({ type: "buddyPlan", requestId: msg.requestId, plan });
        return plan;
      },
      completeStep: (note) => {
        if (!plan) return undefined;
        const i = plan.steps.findIndex((s) => s.status === "pending");
        if (i >= 0) plan.steps[i] = { ...plan.steps[i]!, status: "done", ...(note ? { note } : {}) };
        post({ type: "buddyPlan", requestId: msg.requestId, plan });
        return plan;
      },
      readSkill: async (name) => (await touchSkill(store, name))?.body ?? "",
      saveSkill: async (name, description, body) =>
        settings?.incognitoRemote
          ? (await loadSkills(store)).length
          : (await saveSkill(store, { name, description, body })).length,
      forgetSkill: async (m) =>
        settings?.incognitoRemote ? (await loadSkills(store)).length : (await forgetSkill(store, m)).length,
      // Task-plan execution: advance/update steps + read plans over the shared store,
      // writing a completed step back to Google Tasks (best-effort) when connected.
      markStepDone: async (planId, stepId) => {
        const plan = (await loadTaskPlans(store)).find((p) => p.id === planId);
        if (!plan) return undefined;
        // Complete the NAMED step (the reader can finish sub-tasks in any order) — advanceStep
        // would silently check off the FIRST pending step instead, which is only right for
        // strictly-ordered execution.
        const r = completeStepById(plan, stepId);
        if (!r) return undefined;
        await upsertTaskPlan(store, r.plan);
        // The WHOLE plan, not just this step: finishing one step can complete the task, and the
        // parent's notes carry the step list that just changed.
        await mirrorPlanToGoogle(r.plan.id);
        return { planTitle: r.plan.title, ...(r.ready ? { nextStep: r.ready.title } : {}), completed: r.completed };
      },
      // Persist new conversation context onto the task (planId absent = this chat's active task),
      // optionally flagging an in-place re-plan so the background sweep folds it into the steps.
      saveTaskContext: async (planId, note, replan) => {
        const id = planId ?? msg.taskPlanId;
        if (!id) return undefined;
        const next = await appendTaskContext(store, id, [note], { ...(replan ? { replan: true } : {}) });
        return next ? { planTitle: next.title } : undefined;
      },
      // The whole-task check-off ("that's all done" / "reopen it"): flip the plan + every step,
      // then mirror the parent AND its synced sub-tasks to Google Tasks (best-effort).
      completeTask: async (planId, done) => {
        const plan = (await loadTaskPlans(store)).find((p) => p.id === planId);
        if (!plan) return undefined;
        await setTaskPlanComplete(store, planId, done);
        // Reopening is now carried too — the old loop pushed needsAction to every child, but the
        // shared sync is what keeps the parent's title, date and notes right at the same time.
        await mirrorPlanToGoogle(planId);
        return { planTitle: plan.title, completed: done };
      },
      updateTaskStep: async (planId, stepId, patch) => {
        const plan = (await loadTaskPlans(store)).find((p) => p.id === planId);
        if (!plan) return undefined;
        await updateTaskStep(store, planId, stepId, {
          ...(patch.status ? { status: patch.status as never } : {}),
          ...(patch.notes ? { researchNotes: patch.notes } : {}),
          ...(patch.title ? { title: patch.title } : {}),
          ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
          ...(patch.dueIso !== undefined ? { dueIso: patch.dueIso } : {}),
          ...(patch.actor ? { actor: patch.actor } : {}),
        });
        await mirrorPlanToGoogle(planId);
        return { planTitle: plan.title };
      },
      // Edit the TASK, and the DOCUMENTS on it. Both default to the task this chat is working, so the
      // model doesn't have to fetch an id to correct something the reader just said.
      updateTask: async (planId, patch) => {
        const id = planId ?? msg.taskPlanId;
        const plan = id ? (await loadTaskPlans(store)).find((p) => p.id === id) : undefined;
        if (!plan) return undefined;
        const next = applyPlanEdit(plan, patch);
        await upsertTaskPlan(store, next);
        await mirrorPlanToGoogle(next.id);
        return { planTitle: next.title };
      },
      updateTaskDoc: async (planId, edit) => {
        const id = planId ?? msg.taskPlanId;
        const plan = id ? (await loadTaskPlans(store)).find((p) => p.id === id) : undefined;
        if (!plan) return undefined;
        const r = applyTaskDocEdit(plan, edit);
        if (r.error) {
          return { planTitle: plan.title, title: edit.title, kind: edit.kind ?? "reference", body: "", created: false, replaced: [], added: [], ambiguous: [], error: r.error };
        }
        await upsertTaskPlan(store, r.plan);
        return {
          planTitle: plan.title,
          title: r.doc!.title,
          kind: r.doc!.kind,
          body: r.doc!.body,
          created: r.created,
          replaced: r.replaced,
          added: r.added,
          ambiguous: r.ambiguous,
        };
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
        // BIND TO THE CHAT'S TASK BY DEFAULT. An action scheduled while working a task belongs to
        // that task, and `planId` is what makes it run in the task's own chat rather than the generic
        // ⏰ Scheduled one. Leaving that to the model meant it was usually omitted — the prompt asks
        // for it, but nothing enforced it — so actions set up inside a task ran cold in the shared
        // window, without the task's history or checklist. Same fallback as saveTaskContext:
        // planId absent = the chat's active task. An explicit planId still wins.
        const wantedPlanId = call.planId ?? msg.taskPlanId;
        // Bind only to a LIVE task. A completed or discarded one has nothing left to maintain, and
        // the runner skips actions attached to it — so binding here would create an action that
        // silently never fires. Reachable without the model doing anything wrong: finish a task, then
        // ask for a recurring check while still in that task's chat, and the default binding would
        // have attached it to the finished task. Left unbound instead, and SAID so below.
        const boundPlan = wantedPlanId
          ? (await loadTaskPlans(store)).find((p) => p.id === wantedPlanId && p.status !== "completed" && p.status !== "archived")
          : undefined;
        const planId = boundPlan?.id;
        const task = normalizeScheduledTask({
          title: call.title,
          prompt: call.prompt,
          rule: call.rule,
          ...(call.time ? { time: call.time } : {}),
          ...(call.date ? { date: call.date } : {}), // one-time run day
          // The PARTS of the job. Parsed by the tool and normalised by the store; dropping them here
          // would have left every task stepless no matter what the model authored — the checklist
          // would have existed only in the tool call and never in anything that runs.
          ...(call.steps?.length ? { steps: call.steps } : {}),
          ...(planId ? { planId } : {}), // bound task: runs in that task's chat
          ...(call.weekday !== undefined ? { weekday: call.weekday } : {}),
          ...(call.dayOfMonth !== undefined ? { dayOfMonth: call.dayOfMonth } : {}),
        });
        await upsertScheduledTask(store, task);
        post({ type: "buddyScheduledChanged", requestId: msg.requestId });
        return {
          id: task.id,
          title: task.title,
          describe: describeSchedule(task),
          ...(boundPlan ? { planTitle: boundPlan.title } : {}),
          // A planId was asked for and refused — the model should say why rather than report a
          // binding it didn't get.
          ...(wantedPlanId && !boundPlan ? { planUnavailable: true } : {}),
        };
      },
      updateScheduledTask: async (call) => {
        const stored = (await loadScheduledTasks(store)).find((t) => t.id === call.id);
        // A guessed id must come back as a miss, not a quiet success — see the result formatter.
        if (!stored) return { found: false };
        const next = updateScheduledTaskContent(stored, {
          ...(call.title ? { title: call.title } : {}),
          ...(call.prompt ? { prompt: call.prompt } : {}),
          ...(call.steps !== undefined ? { steps: call.steps } : {}),
        });
        await upsertScheduledTask(store, next);
        post({ type: "buddyScheduledChanged", requestId: msg.requestId });
        return { found: true, title: next.title, stepCount: next.steps?.length ?? 0 };
      },
      listScheduled: async () =>
        (await loadScheduledTasks(store)).map((t) => ({
          id: t.id,
          title: t.title,
          describe: describeSchedule(t),
          enabled: t.enabled,
          // WHEN it last ran, and what came of it — without these, "when did you last run X?" had no
          // answer in the one tool that lists X.
          ...(t.lastRunIso ? { lastRunIso: t.lastRunIso } : {}),
          ...(t.lastRunNote ? { lastRunNote: t.lastRunNote } : {}),
        })),
      // The assistant reading back its OWN unattended work. Every entry was already being written
      // here, with a timestamp; only the reader could see it.
      recentActions: async (kind, limit) => {
        const history = formatActionHistory(filterActionHistory(await loadActionHistory(store), kind, limit));
        // The automatic email/calendar scan is the one piece of unattended work whose ABSENCE from
        // the list above means nothing on its own — a quiet sweep is deliberately not logged, so
        // "no scan entries" reads identically to "the scan is dead". Its own record says which.
        return `${history}\n\n${scanHealthNote(await loadLastScan(store), Date.now())}`;
      },
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
      openPastedText: async (call) => {
        // Safety net: HTML/SVG/markup (pasted, or written by the model and mis-routed here instead of
        // open_code) opens as a CODE book so the SOURCE is kept in book.code — renderable in-app + re-
        // savable — instead of being reduced to extracted text ("saves the output, not the code").
        const head = call.text.slice(0, 400);
        const svg = /^\s*<svg[\s>]/i.test(head);
        const html = /<!doctype html|<html[\s>]/i.test(head) || /<\/(html|body|head)>/i.test(call.text);
        return opened(
          svg || html
            ? bookFromCode(call.title, call.text, svg ? "svg" : "html", "Pasted in chat")
            : bookFromText(call.title, call.text, call.mode, "Pasted in chat"),
          call.visuals,
        );
      },
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
      createDocument: async (call) => {
        // Make a real document from the buddy's Markdown: the HOST renders the PDF/Word bytes on
        // demand, shows a downloadable file card (+ side reader), and saves the source to the
        // workspace. The worker keeps it as the ACTIVE document so the reader can revise it by talking.
        const slug =
          (call.title || "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
          "document";
        const id = `doc-${++documentCounter}-${slug}`;
        const path = `documents/${slug}.md`;
        const words = call.content.trim() ? call.content.trim().split(/\s+/).length : 0;
        activeDocumentBySession.set(turnSessionId, { title: call.title, content: call.content });
        post({
          type: "documentCreated",
          requestId: msg.requestId,
          id,
          title: call.title,
          content: call.content,
          path,
          ...(call.format ? { format: call.format } : {}),
        });
        return { ok: true, id, title: call.title, words, path };
      },
      editDocument: async (patch) => {
        // Edits land on the FULL stored text, NOT on the bounded excerpt the model sees in its prompt.
        // That's the whole point: a document can be revised correctly without the model ever holding
        // all of it, so a long one can no longer lose the part that didn't fit.
        const activeDocument = activeDocumentBySession.get(turnSessionId);
        if (!activeDocument) {
          return { ok: false, title: "", applied: 0, failures: 0, words: 0, summary: "", error: "no document is open" };
        }
        const doc = activeDocument;
        const r = applyFileEdits(doc.content, patch.edits ?? []);
        // Upserts run AFTER the search/replaces, on their result — so a call can fix prose and update a
        // checklist in one round, and the upsert sees the text the edits just produced.
        const up = applyLineUpserts(r.content, patch.setLines ?? []);
        const landed = r.applied + up.replaced.length + up.added.length;
        const summary = summarizeFileEdits(doc.title, r);
        // A label that hit several lines changed nothing — the lines go back to the model so it can
        // name one, rather than the first being rewritten and the others quietly deleted.
        const ambiguous = summarizeAmbiguousLines(up.ambiguous);
        if (landed === 0) {
          return {
            ok: false,
            title: doc.title,
            applied: 0,
            failures: r.failures.length,
            words: 0,
            summary,
            ...(ambiguous ? { ambiguous } : {}),
          };
        }
        activeDocumentBySession.set(turnSessionId, { title: doc.title, content: up.text });
        const slug =
          (doc.title || "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
          "document";
        // Re-post through the normal create path so the host rebuilds the file card and the PDF/Word
        // bytes from the revised source — an edited document the reader can't download is half-done.
        post({
          type: "documentCreated",
          requestId: msg.requestId,
          id: `doc-${++documentCounter}-${slug}`,
          title: doc.title,
          content: up.text,
          path: `documents/${slug}.md`,
        });
        const words = up.text.trim() ? up.text.trim().split(/\s+/).length : 0;
        return {
          ok: true,
          title: doc.title,
          applied: landed,
          failures: r.failures.length,
          words,
          summary,
          ...(ambiguous ? { ambiguous } : {}),
        };
      },
      readDocument: async (section) => {
        const viewing = activeDocumentBySession.get(turnSessionId);
        if (!viewing) return { title: "", text: "", total: 0, found: false };
        const { title, content } = viewing;
        const body = section ? extractSection(content, section) : content;
        if (section && body === undefined) {
          return { title, text: "", total: content.length, found: false, outline: documentOutline(content).join(" › ") };
        }
        const full = body ?? content;
        // Bounded by the same ceiling as read_file — generous (a book chapter's worth), and far above
        // the standing excerpt, which is what makes "read the rest of it" actually work.
        const text = full.slice(0, MAX_DOCUMENT_READ_CHARS);
        return {
          title,
          text,
          total: content.length,
          found: true,
          ...(full.length > text.length ? { truncated: true } : {}),
        };
      },
      // Story "as you go": create the story book from the opening beat and open it (the
      // normal `opened` path → the host opens it, the worker rebuilds the engine with the
      // active-scene hook, beat one extracts + illustrates). worldStyle/style is applied
      // to the worker's settings so the open renders in the chosen look.
      startStory: async (call) => {
        const played = [call.roleplay?.you, call.roleplay?.me].filter((n): n is string => !!n);
        const isRoleplay = !!call.roleplay && played.length > 0;
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
        // Dedup the named cast (start_story `characters` + the role-played pair) — used both to seed
        // the bible and to ground the AI-written opening below.
        const seedCast: { name: string; description?: string }[] = [...(call.characters ?? []), ...played.map((name) => ({ name }))];
        const seen = new Set<string>();
        const cast = seedCast.filter((c) => {
          const k = c.name.trim().toLowerCase();
          if (!k || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        let resolvedSoulCast:
          | { self: string; user: string; source: "you-and-me-setup-v1" }
          | undefined;
        const requestedSoulCast = createStorySoulCast(msg.storySoulCast);
        const castNames = new Set(cast.map((character) => character.name.trim().toLocaleLowerCase()));
        if (
          requestedSoulCast &&
          castNames.has(requestedSoulCast.self.toLocaleLowerCase()) &&
          castNames.has(requestedSoulCast.user.toLocaleLowerCase())
        ) {
          resolvedSoulCast = requestedSoulCast;
        }
        // The reader's setup text is a PREMISE, not the opening prose: let the AI write the actual
        // opening beat and propose a title from it (grounded in the cast/roleplay). Best-effort —
        // if chat is unavailable or the reply doesn't parse, fall back to the typed text + title.
        let title = call.title?.trim() || "Our Story";
        // A carried chat is stored as the book's first beat below. `opening` is therefore only the
        // newly generated continuation; leave it empty on generation failure instead of replacing
        // the entire chat with its final two lines.
        let opening = call.soFar?.trim() ? "" : call.opening.trim();
        if (supportsChat(llm) && (call.opening.trim() || call.soFar?.trim())) {
          try {
            post({ type: "buddyActivity", requestId: msg.requestId, text: "Writing the opening scene…" });
            const { system, user } = storyOpeningRequest(call.opening, {
              // Exact Soul appearance belongs in cast → Visual Bible → image prompts. The prose
              // writer receives names only, plus the generalized behavioral baseline below.
              characters: cast.map((character) => ({ name: character.name })),
              mode: isRoleplay ? "roleplay" : "direct",
              ...(isRoleplay && call.roleplay ? { play: call.roleplay } : {}),
              // Carried in from the chat this was started in — the opening then CONTINUES that
              // story rather than opening a fresh one.
              ...(call.soFar ? { soFar: call.soFar } : {}),
            });
            // The setup marker authorizes only the mapped You-and-me characters. Prose receives the
            // generalized Essence; exact appearance already travels through cast → Visual Bible,
            // while raw notes, evidence retrieval, and exact conversational directions stay out.
            let soulCharacterization = "";
            if (resolvedSoulCast) {
              const [selfNotes, userNotes] = await Promise.all([
                loadSoul(store, "self"),
                loadSoul(store, "user"),
              ]);
              const [selfEssence, userEssence] = await Promise.all([
                selfNotes.length > 0
                  ? loadLatestSoulEssence(store, "self", selfNotes)
                  : Promise.resolve(undefined),
                userNotes.length > 0
                  ? loadLatestSoulEssence(store, "user", userNotes)
                  : Promise.resolve(undefined),
              ]);
              soulCharacterization = storySoulCharacterizationPromptBlock({
                ...(selfEssence ? { selfEssence } : {}),
                selfName: resolvedSoulCast.self,
                ...(userEssence ? { userEssence } : {}),
                userName: resolvedSoulCast.user,
              });
            }
            const openingSystem = soulCharacterization
              ? `${system}\n\n${soulCharacterization}`
              : system;
            // start_story runs inside runBuddyTurn's outer local-model lease, so this call is
            // intentionally direct; taking a nested lease would deadlock that same queue.
            const reply = (
              await llm.chat(
                [{ role: "system", content: openingSystem }, { role: "user", content: user }],
                { maxTokens: 600 },
              )
            ).trim();
            const parsed = parseStoryOpening(reply);
            if (parsed.opening) opening = parsed.opening;
            if (!call.title?.trim() && parsed.title) title = parsed.title;
          } catch {
            // Generation is best-effort. A fresh story keeps its typed premise; a carried story
            // still opens with the complete transcript via storyStartBeats below.
          }
        }
        const initialBeats = storyStartBeats(opening, call.soFar, {
          mode: isRoleplay ? "roleplay" : "direct",
        });
        const id = `story-${storyCounter++}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}`;
        story = {
          bookId: id,
          title,
          author: "Story with the chat buddy",
          beats: initialBeats,
          scene: emptyStoryScene(),
          scenes: [],
          ...(played.length ? { roleplay: { playedCharacterNames: played } } : {}),
          ...(resolvedSoulCast ? { soulCast: resolvedSoulCast } : {}),
          mode: isRoleplay ? "roleplay" : "direct",
          ...(isRoleplay ? { play: { ...(call.roleplay?.me ? { me: call.roleplay.me } : {}), ...(call.roleplay?.you ? { you: call.roleplay.you } : {}) } } : {}),
          cadence: { mode: "per-response", n: 3 },
          beatsSinceImage: 0,
        };
        // Pre-seed the named cast into the bible BEFORE the open, so the active-scene tracker resolves
        // + keeps them present from beat one even if the opening prose doesn't name them — closing the
        // "setting-only opening" gap. A cast entry's `description` seeds its LOOK (appearance notes) so
        // the first image isn't arbitrary. Extraction UPSERTS by name on the first beat that describes
        // them, enriching this same entry (no duplicate). A setup description belongs in the
        // appearance `notes` field, not the fallback-only persistent-trait bucket: analysis can then
        // add structured hair/eyes/etc. without making the exact "You" description disappear from
        // image prompts. Written to the shared store so openBook restores it. The played pair is
        // added (name-only) when not already in `characters`.
        if (cast.length) {
          await store.putBible({
            ...createEmptyBible(id),
            characters: cast.map((c) => ({
              id: `char-${storySlug(c.name)}`,
              name: c.name.trim(),
              aliases: [],
              appearance: {
                ...emptyAppearance(),
                ...(c.description ? { notes: c.description } : {}),
              },
              persistentTraits: [],
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
        const beat = story.mode === "roleplay" ? naturalStoryProse(call.text) : call.text.trim();
        if (!beat) throw new Error("the story beat contained no narrative prose");
        story.beats.push(beat);
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
        // Rolling synopsis: every N beats, refresh the "story so far" in the BACKGROUND (don't block
        // the beat) so the writer keeps long-range continuity after chat history is trimmed. Persist
        // via a storyConfig update when it lands.
        if (story.beats.length % SYNOPSIS_REFRESH_EVERY === 0 && supportsChat(llm)) {
          const chatLlm = llm;
          const forBook = story.bookId;
          const beatsSnapshot = [...story.beats];
          const prev = story.synopsis;
          void (async () => {
            try {
              const { system, user } = synopsisRequest(beatsSnapshot, prev);
              await waitForForegroundChat();
              const text = (
                await withChatPriority(chatLlm.id, () =>
                  chatLlm.chat(
                    [{ role: "system", content: system }, { role: "user", content: user }],
                    { maxTokens: 320 },
                  ),
                )
              ).trim();
              if (text && story && story.bookId === forBook) {
                story.synopsis = text.slice(0, MAX_SYNOPSIS_CHARS);
                if (currentBook?.kind === "story" && currentBook.id === story.bookId) {
                  currentBook = { ...currentBook, storyConfig: storyConfigOf(story) };
                  post({ type: "storyConfig", requestId: msg.requestId, book: currentBook });
                }
              }
            } catch {
              // Best-effort — a failed synopsis just means the writer leans on the recent beats this round.
            }
          })();
        }
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
        slash.call.tool === "generate_video" ||
        slash.call.tool === "generate_long_video" ||
        slash.call.tool === "stitch_videos" ||
        slash.call.tool === "find_files" ||
        slash.call.tool === "run_command" ||
        slash.call.tool === "write_file" ||
        slash.call.tool === "edit_file" ||
        slash.call.tool === "screenshot" ||
        slash.call.tool === "control_ui" ||
        slash.call.tool === "plan_task" ||
        slash.call.tool === "prep_order" ||
        slash.call.tool === "tv_chart" ||
        slash.call.tool === "browser_eval" ||
        slash.call.tool === "delegate" ||
        slash.call.tool === "send_email" ||
        slash.call.tool === "delegate_coding_task" ||
        slash.call.tool === "spawn_coding_agents" ||
        // The open spreadsheet lives in the host's book state, so its cell tools run there too.
        slash.call.tool === "set_cell" ||
        slash.call.tool === "add_formula_column" ||
        slash.call.tool === "read_data"
      ) {
        post({ type: "buddyDone", requestId: msg.requestId, text: "", transcript: [], pendingTool: slash.call });
        return;
      }
      if (slash.call.tool === "extract_from_document") {
        // Sweeping a document is a model-driven loop, so it needs a turn to run in — a slash command
        // has no LLM here. Same shape as spawn_agents below.
        post({
          type: "buddyDone",
          requestId: msg.requestId,
          text: "Ask me in chat to find something in that document — I'll read it through section by section.",
          transcript: [],
        });
        return;
      }
      if (slash.call.tool === "load_toolset") {
        // Loading documentation only means something inside a turn, where the loaded set is carried
        // and the prompt is rebuilt around it. Same shape as the two above.
        post({
          type: "buddyDone",
          requestId: msg.requestId,
          text: "Just ask me for what you need — I'll pull in the right tools myself.",
          transcript: [],
        });
        return;
      }
      if (slash.call.tool === "spawn_agents") {
        // Parallel fan-out only makes sense inside an LLM turn (the model writes the subtasks) — not
        // as a one-shot slash command, which has no runSubAgents orchestration here.
        post({ type: "buddyDone", requestId: msg.requestId, text: "Ask me in chat to split the work — I'll fan it out to parallel sub-agents.", transcript: [] });
        return;
      }
      // start_story may write an opening with the main LLM. Model-driven tool calls already run
      // inside the outer buddy lease; the one-shot slash path does not, so acquire it here only.
      const slashCall = slash.call;
      const result =
        slashCall.tool === "start_story"
          ? await withChatPriority(llm.id, () => runBuddyTool(slashCall, deps), {
              signal: ac.signal,
            })
          : await runBuddyTool(slashCall, deps);
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
        ...(result.quote ? { quote: result.quote } : {}),
        ...(result.indicators ? { indicators: result.indicators } : {}),
        // The two payloads that carry PICTURE BYTES home. Without them the direct path could run
        // use_image_reference / open_image, download the picture, and then drop it on the floor —
        // the tool "succeeded" and nothing was adopted, which is the worst of both outcomes. The
        // host registers the reference from these (see the tool-result handler in App).
        ...(result.referenceAdopted ? { referenceAdopted: result.referenceAdopted } : {}),
        ...(result.openedImage ? { openedImage: result.openedImage } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      post({ type: "buddyDone", requestId: msg.requestId, text: "", transcript: [] });
      return;
    }
    if (!supportsChat(llm)) {
      throw new Error(`The "${llm.id}" text provider doesn't support chat yet.`);
    }
    const note = await renderDefaultsNote();
    // Cached after the first turn; a fetch of a local file, and it can't change while loaded.
    const buildStampLabel = formatBuildStamp(await loadBuildStamp());
    const budgets = contextBudgets(llm.id, await localContextTokens(llm.id));
    const memory = memoryPromptBlock(await loadMemory(store));
    const selfName = await loadSoulName(store, "self");
    const soulQueryContext = soulEvidenceQueryContext(msg.history, msg.userText);
    const soulMode = selectSoulContextMode({
      storyActive: currentBook?.kind === "story",
      creativeIdle: msg.creativeIdle === true,
      creativeSession: msg.creativeSession === true,
    });
    const storySoulCast = await soulCastForStoryBook(currentBook);
    const [selfSoul, userSoul] =
      soulMode === "story" && !storySoulCast
        ? ["", ""] as const
        : await Promise.all([
            soulMode === "story" && !storySoulCast?.self
              ? Promise.resolve("")
              : soulPromptFor("self", {
                  mode: soulMode,
                  ...(storySoulCast?.self ? { nameOverride: storySoulCast.self } : {}),
                  ...(soulMode !== "story" ? { queryContext: soulQueryContext } : {}),
                }),
            soulMode === "story" && !storySoulCast?.user
              ? Promise.resolve("")
              : soulPromptFor("user", {
                  mode: soulMode,
                  ...(storySoulCast?.user ? { nameOverride: storySoulCast.user } : {}),
                  ...(soulMode !== "story" ? { queryContext: soulQueryContext } : {}),
                }),
          ]);
    await seedStarterSkills(store); // one-time: ship a few ready-made playbooks on a fresh install
    // Plus the playbooks the APP ships (driving an open program, editing a live Word/Excel doc):
    // merged at read time rather than seeded, so installs that already have skills get them too.
    const skills = skillsIndexBlock(withBuiltinSkills(await loadSkills(store)));
    // When this session is executing a task plan, load its context for the prompt.
    let activePlan = msg.taskPlanId ? (await loadTaskPlans(store)).find((p) => p.id === msg.taskPlanId) : undefined;
    // CONTEXT CAPTURE: anything the reader HANDS a task chat (pasted links, attached files — both
    // recoverable from the turn text) lands on the plan deterministically, BEFORE the model even
    // answers — so closing the window never loses what was shared. The model's save_task_context
    // notes add the meaning on top; this is the floor, not the ceiling.
    if (activePlan) {
      const harvested = harvestTaskContext(msg.userText);
      if (harvested.length > 0) {
        activePlan = (await appendTaskContext(store, activePlan.id, harvested)) ?? activePlan;
      }
    }
    // Connected when the reader linked their own Schwab app (creds + a live token). Reused below to
    // auto-enable the keyless markets tools as well.
    const schwabConnected = !!(
      settings?.keys?.schwabClientId &&
      settings?.keys?.schwabClientSecret &&
      (await loadSchwabTokens(store))
    );
    // On-demand tool documentation: the prompt carries a one-line index and the model loads what a
    // request actually needs (see chat/toolsets.ts). Held per session so a coding conversation pays
    // for the coding document once, not once a turn.
    // Keyed on the CONVERSATION, not on what the conversation is currently working on. taskPlanId is
    // "the task this chat is working" — it appears and disappears mid-thread, so keying on it reset
    // the loaded set twice per task, in the middle of one continuous chat, for no reason the reader
    // could see.
    //
    // …and until the message carried a session id, "the conversation" was the string "buddy": one
    // entry for every chat in the app. An unattended Creative run may load a toolset — `load_toolset`
    // is the first thing its allowlist permits — and that documentation was then welded onto every
    // other conversation's setup, inside the cache prefix, for the rest of the page's life.
    const sessionKey = msg.sessionId ?? NO_SESSION;
    // The tool handlers below run inside this turn and have no other way to know whose it is.
    turnSessionId = sessionKey;
    // THE CHECKLIST'S OWN TOOLSETS, IN FRONT OF IT BEFORE IT ASKS. A run whose step says
    // needs:"read_file" is a run that will want the `files` docs, and making it discover that costs
    // a round trip it may not spend: reported as a scheduled run searching the WEB for "how to read
    // a local file in Visual Reader assistant", having reasoned — correctly — that it didn't know
    // the tool's name and should load the set first. The app already knows; see toolsetsForNeeds.
    // Unioned with what the conversation has loaded rather than replacing it, so a set the reader's
    // earlier turns pulled in doesn't vanish for the length of a checklist.
    const planNeeds = toolsetsForNeeds((msg.plan?.steps ?? []).map((st) => st.needs));
    const loadedToolsets = [...new Set([...(loadedToolsetsBySession.get(sessionKey) ?? []), ...planNeeds])];
    const promptOpts = {
        persona: msg.persona,
        library: msg.library,
        // The assistant's own identity ("soul"): its NAME is woven into the persona's first line and
        // its WHO-YOU-ARE block sits at the TOP of the prompt (with the reader's WHO-YOU-ARE), so it
        // actually answers to its name + stays in character — not buried under the tool catalog.
        ...(!story && selfName ? { selfName } : {}),
        ...(selfSoul ? { selfSoul } : {}),
        ...(userSoul ? { userSoul } : {}),
        // Anchor "today"/"this week"/"by when" answers + ISO date math to the reader's
        // own clock (the worker runs in their browser, so this is their local time/zone).
        now: currentDateTimeLabel(),
        // How fast the PREVIOUS reply came out. Measured here because the model cannot measure it:
        // its own stamp is written after the reply exists, so asked to time itself it invents a
        // figure or loops working it out from timestamps that don't include the one it needs.
        ...(lastGeneration ? { lastGeneration } : {}),
        // Which bundle this is — so "which build are you on?" is answerable and a stale build stops
        // looking like an unfixed bug. Resolved before the turn (see below); "" until then, and the
        // prompt omits the line rather than showing a blank.
        ...(buildStampLabel ? { buildStamp: buildStampLabel } : {}),
        // Idle exploring is on → the model is told it does this, so it can talk about its own work
        // rather than meeting it as a stranger's. Independent of `creativeIdle` (which is only set on
        // the unattended runs themselves): this belongs in EVERY chat, including the creative one when
        // the reader is in there talking to it.
        ...(settings?.allowCreativeIdle ? { hasCreativeChat: true } : {}),
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
        // LIVE CONTROL: the observe/act/verify block + the targeting ladder. Same gate as the shell
        // (desktop + allowCommands) because control_ui reaches the machine the same way, plus its own
        // toggle — this changes how the assistant works, so it is never on by inference.
        ...(corsProxyAvailable && settings?.allowCommands && settings?.liveControl ? { liveControl: true } : {}),
        // External coding agent (Aider) delegation: opt-in + commands. The host's runtime PATH check
        // surfaces a clear "install Aider" message if the tool is used when it isn't installed.
        ...(corsProxyAvailable && settings?.allowCommands && settings?.delegateCoding
          ? { canDelegateCoding: true }
          : {}),
        // Image-to-video renders on ComfyUI. Advertise it whenever the local image engine is active AND a
        // ComfyUI is reachable for video — INCLUDING when images run on AUTOMATIC1111, since video routes to
        // ComfyUI independently (comfyUrlForVideo). Only withheld when no ComfyUI is known at all. The
        // runtime surfaces a clear error if the video model isn't installed yet.
        ...(corsProxyAvailable && settings?.imageProvider === "local" && comfyUrlForVideo(settings ?? {})
          ? { canGenerateVideo: true }
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
        // A code file is open in the reader's editable code window — point the model at its workspace
        // file so it edits/runs THAT file in place (only meaningful when it can write/run).
        ...(corsProxyAvailable && settings?.allowCommands && msg.currentCodeFile
          ? { currentCodeFile: msg.currentCodeFile }
          : {}),
        // The chat's working checklist — injected so the model re-reads it and resumes from the first
        // unfinished step (set_plan/complete_step are always available; the live state shows only here).
        //
        // ONLY WHILE IT HAS WORK LEFT. A FINISHED checklist stayed installed, and a finished
        // checklist that still counts as the active one does real damage: `hasPlan` goes true, so
        // the prompt swaps MULTI-STEP vs SINGLE for mid-checklist discipline, and the next request
        // never meets the rule that would have planned it. Asked for three elephants right after a
        // three-bird run, the model got "work the current checklist" for a checklist with nothing
        // left in it — and made one elephant. The card stays on screen as a record; what ends here
        // is its claim on the next turn.
        ...(planHasPendingStep(msg.plan) ? { activePlan: msg.plan } : {}),
        // App-managed steps: the prompt shows ONLY the current step (execution framing) + withdraws
        // complete_step. The host derives `msg.plan` from the live workflow each turn.
        ...(msg.appManagedSteps ? { appManagedSteps: true } : {}),
        // A co-written story is open → switch the prompt into story-writing mode (the reply IS the
        // next beat; no tools). storyMode/storyPlay tailor direct vs roleplay narration.
        ...(story ? { storyActive: true, storyMode: story.mode, ...(story.play ? { storyPlay: story.play } : {}) } : {}),
        // Gmail/Calendar/Tasks tools when Google is connected.
        ...(googleConnected ? { canGoogle: true } : {}),
        // Auto-approval: create reminders without per-item confirm when opted in.
        ...(googleConnected && settings?.allowTaskAutomation ? { canAutomateTasks: true } : {}),
        // Task-orchestrator surface (plan_task + scheduled tasks): opted in, OR a task is already
        // active, OR we're in planning mode (its natural home). Otherwise a plain chat skips it.
        ...(settings?.allowTaskAutomation || activePlan || msg.persona === "planning" ? { canTaskTools: true } : {}),
        // Sub-agent fan-out (delegate + spawn_agents): opt-in, or a sub-agent backend is configured.
        ...(settings?.allowSubAgents || settings?.subAgentServerUrl || settings?.subAgentModel
          ? { canSubAgents: true }
          : {}),
        // Keyless markets suite: opt-in, or auto-on when a broker / TV bridge is connected (which also
        // keeps the Schwab block's "prefer these over the keyless feeds" reference from dangling).
        ...(settings?.allowMarkets || schwabConnected || (corsProxyAvailable && settings?.allowTradingViewBridge)
          ? { canMarkets: true }
          : {}),
        // Schwab tools when the user connected their own Schwab app.
        ...(schwabConnected ? { canSchwab: true } : {}),
        // TradingView Desktop bridge when enabled (desktop + opt-in).
        ...(corsProxyAvailable && settings?.allowTradingViewBridge ? { canTvBridge: true } : {}),
        // MCP servers the reader configured (advertise their tools), when a proxy can reach them.
        ...(corsProxyAvailable && parseMcpServers(settings?.mcpServers).length > 0
          ? { mcpServers: parseMcpServers(settings?.mcpServers).map((s) => s.name) }
          : {}),
        // AN UNATTENDED CREATIVE RUN keeps only "look things up and write them up". LAST in the
        // object so it overrides every capability decided above, whatever the reader has enabled
        // elsewhere — the run happens with nobody watching, so its surface is decided here rather
        // than inherited. This narrows what the model is OFFERED; runBuddyTurn's creativeIdle gate is
        // what actually stops a call, and neither relies on the other.
        ...(msg.creativeIdle
          ? {
              canSearchFiles: false,
              canRunCommands: false,
              canAutonomousWorkspace: false,
              canDelegateCoding: false,
              canGenerateVideo: false,
              canGithub: false,
              canGoogle: false,
              canSchwab: false,
              canTvBridge: false,
              canAutomateTasks: false,
              canTaskTools: false,
              canSubAgents: false,
              canMarkets: false,
              mcpServers: [],
            }
          : {}),
    } as const;
    const setup =
      buildBuddySystemPrompt({ ...promptOpts, loadedToolsets }) +
      (memory ? `\n\n${memory}` : "") +
      // selfSoul/userSoul are now injected at the TOP of buildBuddySystemPrompt (see above), not appended here.
      (skills ? `\n\n${skills}` : "") +
      (note ? `\n\n${note}` : "");
    // Same roleplay contract as the reader-side chat path above. This is the dedicated story-buddy
    // path used by Story as you go (including linked-mobile turns); keep the wrapper model-only.
    const modelFacingUserText =
      story?.mode === "roleplay"
        ? roleplayStoryTurnPrompt(msg.userText, story.play)
        : msg.userText;
    const thinking = thinkingNotifier((text) =>
      post({ type: "buddyThinking", requestId: msg.requestId, text }),
    );
    // Story "as you go": inject the live STORY STATE AFTER the stable cache prefix (it changes each
    // beat, so it must not be part of the cached prefix), re-grounding the writer in the present cast,
    // location, recent beats, and synopsis even when chat history has been trimmed.
    const storyStateBlock = story ? buildStoryStateBlock(story) : "";
    // Like the story-state block, the file ledger rides AFTER the cached prefix (it changes as files are
    // written) so the model stays aware of what it created even after history trimming.
    const ledgerBlock = buildFileLedgerBlock(fileLedger);
    // Same reason as the file ledger: it changes mid-session and must outlive history trimming.
    const imageRefBlock = buildImageReferenceBlock(imageRefLedger);
    // The task this workspace belongs to, when the reader is inside one. Rides after the cache prefix
    // with the other blocks that change mid-session — a task edited in here reads correctly next turn.
    // What it was thinking on the previous step. Volatile like the rest of these — rebuilt each turn
    // from what the host hands over, never stored — which is what keeps it a note rather than a
    // permanent fixture of the conversation.
    const thinkingBlock = recentThinkingBlock(msg.lastThinking);
    const scheduledBlock = msg.scheduledTaskId
      ? scheduledTaskBlock((await loadScheduledTasks(store)).find((t) => t.id === msg.scheduledTaskId))
      : "";
    const guideBlock = buildProjectGuideBlock(projectGuide);
    // The active document (last create_document / one the reader opened) rides after the cache prefix
    // too, so "tighten the intro / add a section" acts on the real text even after history trimming.
    // Its size is budgeted off the SAME window the rest of the context is: a flat cap held a cloud
    // model with a 200k window to a 4k local model's excerpt for no reason. Whatever doesn't fit is
    // reachable with read_document and editable with edit_document, so the cap costs nothing but a
    // round-trip now.
    const activeDocBlock = buildActiveDocumentBlock(activeDocumentBySession.get(sessionKey), activeDocBudget(budgets.history));
    const draftBlock = buildActiveDraftBlock(lastDraftBySession.get(sessionKey));
    /**
     * "GENERATE 3 IMAGES" CAME BACK AS ONE PICTURE, THREE PROMPT FIXES RUNNING.
     *
     * The standing rule that several pictures means a checklist was present, correct and read every
     * time; it lost to whichever neighbouring rule the model reached first. A fourth wording would
     * have been a fourth guess, so the app counts instead — a number sitting directly in front of a
     * picture word is not a matter of interpretation.
     *
     * Volatile like the rest of these: rebuilt from THIS turn's message, never stored. That is the
     * whole point — it arrives WITH the request that needs it, specific and unmissable, instead of
     * sitting in a standing instruction competing with forty others.
     */
    const rendersBlock = requestedRendersNote(msg.userText ?? "", planHasPendingStep(msg.plan));
    /**
     * THE PROMPT'S LIVE BLOCKS ARE PART OF THE PROMPT — and pretending otherwise is what turned a
     * leaked document into lost work.
     *
     * The history was trimmed to `input − setup`, with `setup` measured BEFORE these blocks existed.
     * So the conversation was sized generously against a prompt that then grew by everything below,
     * the total overshot the window at send time, and `trimTurnMessages` clawed the difference back
     * by dropping the OLDEST turns — silently, behind the reader, every turn. On the reported
     * session the active-document excerpt alone is budgeted at ~7,800 characters, and the overshoot
     * was about that: an essay nobody asked for, evicting the conversation it was pinned beside.
     *
     * They are assembled here, ahead of the trim, so the history is sized for the prompt that is
     * actually sent. And they are metered, because the readout said "53% of window" while the real
     * prompt was larger — the one number the reader had to go on did not include them.
     */
    const volatile = [storyStateBlock, guideBlock, ledgerBlock, imageRefBlock, scheduledBlock, activeDocBlock, draftBlock, thinkingBlock, rendersBlock].filter(Boolean).join("\n\n");
    // As above: the buddy chat has no book section at all, so a fixed 30%-to-history split
    // reserved most of the window for something that isn't there and left the conversation with a
    // few hundred words. What the setup didn't use is the conversation's.
    const history = trimChatHistory(
      [...msg.history, { role: "user", content: modelFacingUserText }],
      historyBudget(budgets.input, setup.length + volatile.length),
    );
    post({
      type: "chatContextUsage",
      requestId: msg.requestId,
      usage: measureContextUsage(
        [
          { key: "instructions", label: "Assistant setup & tools", text: setup },
          { key: "live", label: "Documents & working state", text: volatile },
          { key: "history", label: "Chat history", text: history.slice(0, -1).map((t) => t.content).join("\n") },
          { key: "message", label: "Your message", text: msg.userText },
        ],
        { budgetChars: budgets.book, ...(budgets.maxTokens ? { maxTokens: budgets.maxTokens } : {}) },
      ),
    });
    /**
     * APP-MANAGED CHECKLISTS RUN INSIDE THE TURN NOW.
     *
     * They used to run one step per TURN: the host judged a settled turn and dispatched a fresh one
     * whose opening user message was "Now do ONLY step 2 of 26 … Call its tool and stop". The reader
     * watched the alphabet stall, and the model's reasoning said why — "The user's prompt in this
     * specific turn [2026-08-13 13:16:43.860] is the system telling me to do step 1". A turn-opening
     * directive is indistinguishable from the reader speaking, and "call its tool and stop" tells a
     * step whose deliverable is the letter A to end the turn, when it has no tool to call.
     *
     * The contracts survive the round trip on their own: `workflowToPlan` writes each step's `needs`
     * into the projection and `compileWorkflow` reads it back, so the judging rebuilt here is the
     * same judging, from the same declarations, with no second copy of the run's state to fall out
     * of date. Every advance is mirrored to the host through the SAME `buddyPlan` post that set_plan
     * and complete_step already use, so the card and the stored workflow move exactly as before.
     *
     * Only reached when a round produced no tool call. A render still suspends the turn and resumes
     * on the next one — that boundary is real, because the host genuinely has to run it.
     */
    /**
     * COMPILE, THEN PUT THE PROGRESS BACK. `compileWorkflow` hardcodes every step to `pending` and
     * makes step 1 active — it is for a checklist that has just been WRITTEN, and this is a
     * checklist that has been running for four turns.
     *
     * Without the second half, every turn's in-turn tick believed step 1 was current. The host's own
     * copy is protected (its `origin:"app"` posts go through `adoptPlanProgress`, which only ever
     * upgrades a step to done), so the card kept showing the real position while the directives
     * pushed into the turn named a step that finished three turns ago — the model rewrote the same
     * file and the run never reached the rest. It reads as a stall and is actually a rewind, which
     * is why "it used to hand turns back and forth and that seems to be lost" is the exact symptom.
     *
     * `msg.plan` does carry the progress: `workflowToPlan` emits `status: "done"` per finished step
     * and the host sends the live projection every turn. `adoptPlanProgress` is positional and fails
     * closed on any mismatch — here the two cannot mismatch, since `prev` is the fresh compile of
     * that same plan.
     */
    let wf = msg.appManagedSteps && planHasPendingStep(msg.plan)
      ? adoptPlanProgress(compileWorkflow(msg.plan!), msg.plan!)
      : undefined;
    // The nudge budget, per step. "Exactly as the host's executor does" was true of the free nudge
    // and false of everything around it: the host BOUNDS its nudges (MAX_STEP_REMINDERS) and names
    // the tool the step needs. This copy had neither, and inside a 50-round turn that is the
    // difference between a step that eventually parks and one that spins the whole budget being
    // asked the same thing. Per-step, so a run that is actually progressing never accumulates.
    let tickNudges = { stepId: "", count: 0 };
    /**
     * A STEP IS NOT A ROUND, and treating them as the same thing failed every step bigger than one
     * generation.
     *
     * Every round that did not satisfy the contract was read as a failed attempt: `advanceWorkflow`
     * with `done:false` spends one of the step's few attempts, and after `maxAttempts` the step parks
     * at "⏸ Stuck". That is right for a step whose work is one act — render this image, run this
     * command — and wrong for one whose deliverable does not fit a single reply. "Write index.html"
     * is several rounds of appending on a local model whose budget cannot hold the file, and under
     * the old reading those rounds were failures rather than progress.
     *
     * So a round that produced something NEW toward the step CONTINUES it — no attempt spent, no
     * advance, the step stays current. Only a round that added nothing counts against it. Bounded, so
     * a model emitting a trickle forever still reaches the normal retry/park path.
     *
     * Progress is measured, not claimed: more tool results than last round, or more text. Both come
     * from the app's own observation of the round, which is the same standard the collar holds
     * everywhere else.
     */
    let tickProgress = { stepId: "", tools: -1, chars: -1, rounds: 0 };
    const appManagedTick = wf
      ? (evidence: { toolResults: { call: BuddyToolCall; result: BuddyToolResultPayload }[]; text: string }) => {
          const step = activeStep(wf);
          if (!step) return { kind: "stop" as const };
          const outcome = evaluateStep(step, evidence);
          const sameStep = tickProgress.stepId === step.id;
          const grew =
            !sameStep ||
            evidence.toolResults.length > tickProgress.tools ||
            evidence.text.length > tickProgress.chars;
          const progressRounds = sameStep ? tickProgress.rounds : 0;
          tickProgress = {
            stepId: step.id,
            tools: evidence.toolResults.length,
            chars: evidence.text.length,
            rounds: grew ? progressRounds + 1 : progressRounds,
          };
          // The step is under way and this round moved it along — carry on rather than judging it.
          if (!outcome.done && !outcome.parks && grew && attemptedStepWork(step, evidence) && progressRounds < MAX_STEP_ROUNDS) {
            return {
              kind: "continue" as const,
              directive: stepDirective(wf!, step, "continue", outcome.reason ? { reason: outcome.reason } : {}),
            };
          }
          // The model narrated instead of doing the step: nudge without spending an attempt, exactly
          // as the host's executor does, so a confused model is not marched into a premature park.
          if (!outcome.done && !outcome.parks && !attemptedStepWork(step, evidence)) {
            const used = tickNudges.stepId === step.id ? tickNudges.count : 0;
            if (used < MAX_STEP_REMINDERS) {
              tickNudges = { stepId: step.id, count: used + 1 };
              // `needsTool` is the only text that says a file step is satisfied by an actual
              // write_file call and not by a description of one — the host passes it and this
              // dropped it, which is precisely the confusion the nudge is answering.
              const need = doneWhenToNeeds(step.doneWhen);
              return {
                kind: "continue" as const,
                directive: stepDirective(wf!, step, "nudge", need ? { needsTool: need } : {}),
              };
            }
            // Budget spent — fall through to the normal retry/park path. A genuinely stuck run has
            // to be able to end, and an unbounded free nudge is what stopped it ending.
          }
          tickNudges = { stepId: "", count: 0 }; // a real attempt or an advance restores the budget
          tickProgress = { stepId: "", tools: -1, chars: -1, rounds: 0 }; // and the next step starts fresh
          const adv = advanceWorkflow(wf!, outcome);
          wf = adv.workflow;
          plan = workflowToPlan(wf);
          // origin "app" — WE advanced this, the model did not re-plan. Without the tag the host runs
          // it through recompileWorkflow, which throws the incoming statuses away and resets the run.
          post({ type: "buddyPlan", requestId: msg.requestId, plan, origin: "app" });
          if ((adv.action === "advance" || adv.action === "skip") && adv.next)
            // `advanced` — the only branch where the checklist actually moved on, so the only one
            // where the previous step's evidence stops counting. A retry/nudge below keeps it.
            return { kind: "continue" as const, directive: stepDirective(wf, adv.next, "advance"), advanced: true };
          if (adv.action === "retry")
            return { kind: "continue" as const, directive: stepDirective(wf, step, "retry", outcome.reason ? { reason: outcome.reason } : {}) };
          // finish / park / abort — the model should be writing to the reader now, not working.
          return { kind: "stop" as const };
        }
      : undefined;
    /**
     * G3 — in app-managed mode, GRAMMAR-CONSTRAIN the reply to the tool the active step's contract
     * demands, so a stubborn small model can't narrate instead of acting. Only for a concrete tool
     * need (the step's `needs` token is a tool name); text/narration steps stay free. Local-server
     * only — the provider applies Ollama `format`; cloud ignores `toolFormat`. A file step also
     * allows read_file (a sensible precursor) so the model can read before rewriting.
     *
     * READ EVERY ROUND, NOT ONCE PER TURN. This used to be a value, computed here from the plan's
     * opening step, which was right when a turn was one step. A checklist now runs every step inside
     * one turn, so a fixed grammar stayed pinned to step ONE's tool while the tick moved on: from
     * step two the sampler admitted nothing but a call the model had already made and no longer
     * needed. No other tool, no plain text — and on a reasoning model the only channel left
     * unconstrained was the thinking, which is where the run then sat.
     *
     * NEVER LOCK ONTO A TOOL THAT CANNOT BE CALLED. `buildToolCallFormat` reads the full schema list,
     * ungated, so a step needing a deferred tool produced a grammar for something this session has
     * not loaded — and `load_toolset`, the one move that would fix it, was itself forbidden by that
     * grammar. A step like that is left unconstrained instead, which is the weaker guarantee and the
     * only one that can actually be satisfied.
     */
    const stepFormat = (): Record<string, unknown> | undefined => {
      if (!msg.appManagedSteps || llm.id !== "local-server") return undefined;
      // The live workflow first — it is the copy the tick advances. `plan` only backstops the round
      // before the tick has run (and the legacy path, where there is no workflow in here at all).
      const live = wf ? activeStep(wf) : undefined;
      const needs = (live ? doneWhenToNeeds(live.doneWhen) : undefined) ?? plan?.steps.find((s) => s.status !== "done")?.needs;
      if (!needs || !isToolAvailable(needs, loadedToolsets)) return undefined;
      return buildToolCallFormat(needs === "write_file" ? ["write_file", "edit_file", "read_file"] : [needs]);
    };
    const outcome = await withChatPriority(llm.id, () => runBuddyTurn({
      llm,
      system: volatile ? `${setup}\n\n${volatile}` : setup,
      // The buddy prompt (persona + tool defs + library) is stable across a
      // conversation — nothing changes turn-to-turn but the history — so it's the
      // cache prefix (an explicit library edit just rewrites it once); volatile story
      // state rides AFTER it so the prefix stays cacheable.
      cachePrefix: setup,
      history,
      maxTokens: budgets.reply,
      /**
       * HOW LONG IT MAY DELIBERATE BEFORE WRITING ANYTHING, in characters (~4 per token).
       *
       * A LAST RESORT, NOT A LEASH. This started at half the reply budget and that was wrong: at
       * that size it fires on a model that is legitimately planning, hands back a half-formed plan,
       * and demands output from it — "the budget you gave for thinking is not nearly large enough."
       *
       * The honest bound is the point past which there was never going to be an answer anyway.
       * Reasoning and reply share one `num_predict`, so a deliberation that has run well past what
       * the answer needs has already spent it; nothing is taken away by stopping there. Below that,
       * the right response to a big deliverable is to SPLIT it, not to cut the thinking.
       *
       * ×1.5, not the ×3 first tried. At ×3 on a 30k window the bound sits around 9k tokens of pure
       * deliberation — more than the reply budget itself — so it can never fire on a model that was
       * going to answer, and never fires on one that was not either. That is not a bound, it is a
       * formality. ×1.5 is still a long think and actually trips.
       *
       * Local only: on a cloud provider reasoning does not come out of the reply's budget. Anthropic
       * has a real knob for this — `thinking.budget_tokens`, set alongside `max_tokens` — which ends
       * the thinking phase and lets the same generation continue into the answer. Ollama's
       * `num_predict` is one undifferentiated number, so this is the nearest available thing.
       */
      ...(llm.id === "local-server" ? { thinkingBudgetChars: Math.floor(budgets.reply * 1.5) } : {}),
      contextChars: budgets.input,
      loadedToolsets,
      ...(appManagedTick ? { appManagedTick } : {}),
      // The document is DERIVED from the same prompt options, so what the model loads is exactly the
      // text the prompt would have carried — there is no second copy to fall out of date.
      toolsetDoc: (id: string) => toolsetDoc(id, { ...promptOpts, loadedToolsets }),
      // The hard limit for an unattended creative run — enforced in the loop, independent of what the
      // prompt above happens to advertise.
      ...(msg.creativeIdle ? { creativeIdle: true } : {}),
      ...(chatReasoningEffort(settings) ? { reasoningEffort: chatReasoningEffort(settings)! } : {}),
      // Cloud (paid) models pause for a "keep going?" check every so often so a long task doesn't burn
      // many API calls unattended; local/free models run to the backstop (no pauseEvery).
      // Live control overrides the cloud "keep going?" checkpoint inside runBuddyTurn: a pause every
      // few rounds is exactly the interruption the mode exists to remove.
      ...(settings?.allowCommands && settings?.liveControl ? { liveControl: true } : {}),
      ...(CLOUD_LLM_IDS.has(llm.id) ? { pauseEvery: CLOUD_TOOL_PAUSE_ROUNDS } : {}),
      // NATIVE TOOL CALLING for a local server (Ollama): hand a tool-capable model the schemas so it
      // emits structured tool_calls instead of having to follow the text protocol — the reliable path
      // for small models (Gemma etc.). The provider gates on the model's "tools" capability and falls
      // back to the text catalog (still in `system`) when unsupported. Same availability flags as the prompt.
      ...(llm.id === "local-server"
        ? {
            // Gated by the SAME loaded set as the prompt. These ride alongside it, so leaving them
            // ungated would hand back most of what deferring the prompt text just saved.
            tools: ollamaToolSchemas({
              canSearchFiles: corsProxyAvailable,
              canRunCommands: corsProxyAvailable && !!settings?.allowCommands,
              canWolfram: !!settings?.keys?.wolfram,
              // RAW availability, not the gated flag: the carve-out matters most before `markets`
              // is loaded, which is exactly when the gated flag is false.
              canMarkets: !!(settings?.allowMarkets || schwabConnected || (corsProxyAvailable && settings?.allowTradingViewBridge)),
              loadedToolsets,
            }),
          }
        : {}),
      toolFormat: stepFormat,
      // A story is open → STORY MODE: if the model ends a turn empty/tool-only, the wrap-up asks for
      // the next BEAT (prose), so the recovered reply is still appendable to the book.
      ...(story && currentBook?.kind === "story" ? { storyMode: true } : {}),
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
            contextChars: budgets.input,
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
        // A checklist step finished inside the turn. Nothing else marks that boundary for a step
        // whose deliverable is text: the host flushes streamed prose when a TOOL CALL follows it,
        // and a text step has none.
        else if (e.kind === "stepDone") post({ type: "buddyStepDone", requestId: msg.requestId, text: e.text });
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
            ...(e.result.referenceAdopted ? { referenceAdopted: e.result.referenceAdopted } : {}),
            // Whether this produced something durable. Only a handful of fields cross this boundary,
            // so the part of the payload that says WHAT a tool made never reached the app-managed
            // collar — which then judged "no file was written" about a document it had just written.
            // Created-vs-changed rides along: a step asking for a SECOND document is not finished
            // by an edit to the first, and one bit couldn't tell those apart.
            ...((): { artifact?: ArtifactKind } => {
              const a = producedArtifactFrom(e.result);
              return a ? { artifact: a } : {};
            })(),
            ...(e.result.error ? { error: e.result.error } : {}),
          });
      },
      signal: ac.signal,
    }));
    // Remember what the turn pulled in, so the next one in this chat doesn't pay the round-trip again.
    if (outcome.loadedToolsets) loadedToolsetsBySession.set(sessionKey, [...outcome.loadedToolsets]);
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
          const candidate = await withChatPriority(
            llm.id,
            () => runSkillProposal(llm, { goal: msg.userText, transcript: outcome.transcript, signal: ac.signal }),
            { signal: ac.signal },
          );
          // Built-ins count as duplicates: proposing "how to drive Word over COM" back to the reader
          // after they just used the shipped playbook to do it is noise, and saving it would shadow
          // the real one with a worse copy.
          if (candidate && !isDuplicateSkill(candidate, withBuiltinSkills(await loadSkills(store)))) {
            post({ type: "buddySkillProposed", requestId: msg.requestId, skill: candidate });
          }
        }
      } catch {
        // Reflection is best-effort — skip silently on any failure.
      }
    }
    // Story "as you go": with a story open and the story tools removed, the model's plain prose reply
    // IS the next beat. Route it into the same append+illustrate path the continue_story tool used, so
    // the reader grows beside the chat. (shouldAppendBeat encodes the guards — story open, story book,
    // non-empty prose, and no story tool already ran this turn so the beat isn't appended twice.)
    if (
      deps.continueStory &&
      shouldAppendBeat(outcome, { storyOpen: !!story, isStoryBook: currentBook?.kind === "story" })
    ) {
      try {
        await deps.continueStory({ tool: "continue_story", text: outcome.text.trim() });
      } catch {
        // Best-effort: if the beat can't append, the prose still shows in the chat below.
      }
    }
    // Measure what just came out, for the NEXT turn's prompt. Wall time from the start of the turn
    // to here, against the reply's own length — the only vantage point from which "how fast do you
    // generate" has an answer, since the model is inside the thing being timed.
    lastGeneration = measureGeneration(outcome.text.length, Date.now() - turnStartedAt) ?? lastGeneration;
    post({
      type: "buddyDone",
      requestId: msg.requestId,
      text: outcome.text,
      transcript: outcome.transcript,
      ...(outcome.pendingTool ? { pendingTool: outcome.pendingTool } : {}),
      ...(outcome.thinking ? { thinking: outcome.thinking } : {}),
      ...(outcome.paused ? { paused: true } : {}),
    });
  } catch (err) {
    post({
      type: "buddyError",
      requestId: msg.requestId,
      message: stopOrError(ac, err),
    });
  } finally {
    chatAborts.delete(msg.requestId);
  }
}

/** A soul's reference photos, decoded to bytes for use as character references in an image render. */
/**
 * The ceiling on how many reference photos one chat render may carry.
 *
 * Deliberately the LOOSEST of the routes, not the tightest: each backend caps to what its own
 * mechanism can use (IP-Adapter blends, so it takes four; Flux.2's ReferenceLatent chain keeps each
 * photo independent, so it takes ten). Clamping to four here would have silently thrown away the
 * capability that makes Flux.2 worth using — a person from one photo, a place from another.
 * This is only a sanity bound so an accidental drag-and-drop of a folder can't queue fifty encodes.
 */
const MAX_CHAT_REFS = 10;

async function loadSoulRefs(
  store: ReturnType<typeof memoryStore>,
  kind: "self" | "user",
): Promise<{ bytes: ArrayBuffer; mimeType: string; weight: number }[]> {
  const imgs = await loadSoulImages(store, kind);
  return imgs.map((im) => ({ bytes: base64ToBytes(im.dataBase64), mimeType: im.mimeType, weight: 0.85 }));
}

/**
 * Copy a cast Soul's reference photos into the character it plays, once.
 *
 * Deliberately routed through the engine's own addCharacterReference rather than writing anchors
 * directly: that is what keys the bytes into this book's namespace, respects the per-character cap,
 * clears the pipeline's byte cache and persists the bible. A second mechanism for the same thing is
 * how two sources of truth start.
 */
async function seedSoulReferences(target: Engine): Promise<void> {
  const bible = target.getBible();
  const cast = story?.soulCast;
  if (!bible || !cast) return;
  const store = memoryStore();
  const photos: Record<"self" | "user", SoulImage[]> = {
    self: await loadSoulImages(store, "self"),
    user: await loadSoulImages(store, "user"),
  };
  const seeds = soulRefSeeds(cast, bible.characters, (kind) => photos[kind].length > 0);
  for (const seed of seeds) {
    for (const im of photos[seed.kind]) {
      await target.addCharacterReference(seed.characterId, {
        bytes: base64ToBytes(im.dataBase64),
        mimeType: im.mimeType,
      });
    }
  }
}

/**
 * A user-APPROVED generate_image tool call. In-chat render overrides apply here:
 * a named model resolves against the engine's INSTALLED models (a model that
 * isn't downloaded silently keeps the current one), a named style against the
 * style catalog, and a step count rides the render directly.
 */
async function handleChatTool(
  requestId: number,
  call: ToolCall,
  refImages?: { bytes: ArrayBuffer; mimeType: string }[],
  userText?: string,
): Promise<void> {
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
    // If the image is of the assistant ITSELF or of the READER, fold that soul's appearance into the
    // prompt AND pass its reference photos to the model (Gemini/OpenAI native + ComfyUI use them; other
    // providers ignore them). No-op for any other subject.
    const store = memoryStore();
    const [selfName, selfNotes, userName, userNotes] = await Promise.all([
      loadSoulName(store, "self"),
      loadSoul(store, "self"),
      loadSoulName(store, "user"),
      loadSoul(store, "user"),
    ]);
    const inStory = currentBook?.kind === "story";
    const storySoulCast = inStory ? await soulCastForStoryBook(currentBook) : undefined;
    const portraitSelfName = storySoulCast?.self ?? selfName;
    const portraitUserName = storySoulCast?.user ?? userName;
    let prompt = call.prompt;
    // Every reference this render can legitimately use, in one list.
    //
    // It used to be an if/else over the two Souls, so "draw you and me together" carried ONE face —
    // whichever branch won — and the other person came out a stranger in a picture that named them.
    // And an ATTACHED photo carried nothing at all: the vision model described it, the description
    // went into the prompt, and the bytes were dropped, so "make an image from this" rendered from
    // somebody's words about the picture rather than the picture.
    const refs: { bytes: ArrayBuffer; mimeType: string; weight: number }[] = [];
    // Counted by SOURCE as they're gathered, so the note under the picture can name where they came
    // from. "Used 3 reference photos" leaves the Soul case unanswered — an attachment is visible in
    // the transcript, but a Soul photo lives two panels away with nothing on screen to say it helped.
    const sources: { attached?: number; self?: number; user?: number; selfName?: string } = {};
    // Tested against the READER'S OWN WORDS as well as the model's prompt. "Generate an image of
    // yourself" is unmistakable; the prompt the model then writes may be "a portrait of a woman in a
    // garden", which contains nothing this can match — so the Soul was skipped for the one request
    // that named it outright.
    const request = userText?.trim() ? `${userText}\n${call.prompt}` : call.prompt;
    if ((!inStory || !!storySoulCast?.self) && isSelfPortraitRequest(request, portraitSelfName)) {
      prompt = selfPortraitPrompt(prompt, portraitSelfName, selfNotes, request);
      const own = await loadSoulRefs(store, "self");
      refs.push(...own);
      if (own.length) sources.self = own.length;
    }
    if ((!inStory || !!storySoulCast?.user) && isUserPortraitRequest(request, portraitUserName)) {
      prompt = userPortraitPrompt(prompt, portraitUserName, userNotes, request);
      const own = await loadSoulRefs(store, "user");
      refs.push(...own);
      if (own.length) sources.user = own.length;
    }
    // The reader's own picture is the strongest statement of intent there is — they picked THIS one
    // for THIS chat — so it leads, and at a higher weight than a stored Soul photo.
    //
    // It LEADS. It was appended last and the list then cut with `slice(0, MAX_CHAT_REFS)`, which
    // keeps the FIRST ten — so on a request that also pulled in Soul photos, enough of them pushed
    // the reader's own picture off the end and the render never saw it. Silently, and worse than
    // silently: `sources.attached` was counted before the cut, so the note under the picture said
    // the reference had been used. A chat reference is the reader choosing, now; a Soul photo is
    // standing configuration. If anything has to go, it isn't the choice they just made.
    //
    // NEWEST FIRST, because every cap downstream takes the FIRST n: this list is trimmed to
    // MAX_CHAT_REFS, and then the backend trims again to what it can actually use — four on
    // IP-Adapter, ten on a ReferenceLatent family. The set is held oldest-first (that is what makes
    // its own cap keep the newest), so passing it through unreversed meant a capped render kept the
    // pictures chosen EARLIEST and dropped the ones just added. The most recent choice is the one
    // most likely to be what the reader means now.
    const chatRefs = [...(refImages ?? [])]
      .reverse()
      .map((im) => ({ bytes: im.bytes, mimeType: im.mimeType, weight: 0.9 }));
    const ordered = [...chatRefs, ...refs];
    if (portraitSelfName.trim()) sources.selfName = portraitSelfName;
    const soulRefs = ordered.length ? ordered.slice(0, MAX_CHAT_REFS) : undefined;
    // Count what SURVIVED the cut, not what was gathered — the note under the picture is read as a
    // statement about the render, so it has to be one.
    if (chatRefs.length) sources.attached = Math.min(chatRefs.length, soulRefs?.length ?? 0);
    if (sources.self) sources.self = Math.min(sources.self, Math.max(0, (soulRefs?.length ?? 0) - chatRefs.length));
    if (sources.user) sources.user = Math.min(sources.user, Math.max(0, (soulRefs?.length ?? 0) - chatRefs.length - (sources.self ?? 0)));
    const out = await renderFromText(image, tier, prompt, {
      ...(call.steps ? { stepsOverride: call.steps } : {}),
      ...(soulRefs?.length ? { ipAdapterRefs: soulRefs } : {}),
      signal: ac.signal,
      onProgress: (fraction) => post({ type: "testProgress", requestId, fraction }),
    });
    // Say what became of the reference photos. Every way this goes wrong yields a perfectly good
    // picture that just isn't of the person, so without this the reader is left comparing faces and
    // guessing between "wrong model", "nodes missing", "upload failed" and "it worked, badly".
    const note = referenceOutcome(soulRefs?.length ?? 0, out.references, describeReferenceSources(sources));
    post(
      {
        type: "chatToolResult",
        requestId,
        call,
        image: { bytes: out.bytes, mimeType: out.mimeType },
        ...(note ? { referenceNote: note } : {}),
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

/**
 * Run a user-approved generate_video call: the host already resolved the SOURCE image bytes + the model
 * files (the worker can't reach the chat's images / library). Frees the chat LLM first (the video model is
 * large), runs the ComfyUI image-to-video graph, and posts the clip back via chatToolResult. Local
 * ComfyUI only.
 */
async function handleChatVideo(
  requestId: number,
  call: Extract<BuddyToolCall, { tool: "generate_video" }>,
  image: { bytes: ArrayBuffer; mimeType: string } | undefined,
  models: VideoModelFiles,
  params?: VideoRenderParams,
  /** Long-form batch: clips 2..N skip the VRAM hand-off so the video model stays resident between clips. */
  warmBatch?: boolean,
  /** First+last-frame conditioning (Wan only): the clip arrives at this frame. */
  endImage?: { bytes: ArrayBuffer; mimeType: string },
  /** Long-form batch, every clip but the last: keep the video model resident AFTER the render so the
   * next clip finds it warm (the backend's finally skips its /free). The last clip frees. */
  keepResident?: boolean,
): Promise<void> {
  const ac = new AbortController();
  let localModelLease: LocalModelLease | undefined;
  chatAborts.set(requestId, ac);
  try {
    if (!settings) throw new Error("Settings not initialised yet.");
    const cs = chatSettingsOf(settings);
    if (cs.imageProvider !== "local" && settings.imageProvider !== "local") {
      throw new Error("Image-to-video needs the local engine — set the image provider to “Run on my computer”.");
    }
    // Video is ComfyUI-only, but image generation may be running on AUTOMATIC1111 at the same time — so
    // resolve a ComfyUI URL independent of the active image backend (the per-backend URL memory survives an
    // image-backend switch). This lets "images on A1111, video on ComfyUI" work with both engines alive.
    const comfyUrl = comfyUrlForVideo(settings);
    if (!comfyUrl) {
      throw new Error("Video needs ComfyUI running — connect or auto-start ComfyUI in Settings (it runs alongside AUTOMATIC1111).");
    }
    localModelLease = await acquireLocalModelLease({
      signal: ac.signal,
      engineHold: { bible: true, images: true },
    });
    const cfTool = corsFetch();
    const backend = new ComfyUIBackend({ baseUrl: comfyUrl, ...(cfTool ? { transport: new DirectTransport(cfTool) } : {}) });
    // Hand the GPU to the (large) video model: free the chat LLM first, same as a render.
    cancelChatWarm();
    await freeChatLlmForRender();
    imageModelFreed = false;
    // A long-form batch renders many clips back-to-back on THIS ComfyUI. Only the FIRST clip does the VRAM
    // hand-off; clips 2..N skip it so the video model stays resident (a per-clip evict+reload would dominate
    // the wall-clock). warmBatch is set by the host loop for the follow-on clips.
    if (!warmBatch) {
      // When images run on a SEPARATE A1111, its checkpoint squats VRAM the video experts need — unload it.
      await freeStaleA1111ForComfy();
      // Also clear ComfyUI's OWN resident image/video state before the big load. Video models are far larger
      // than any still-resident image checkpoint (Wan 2.2 = two ~14GB experts + umt5; LTX-2 = 22B + Gemma) and
      // the per-expert LoRAs add patch/dequant overhead on top — so anything squatting VRAM is enough to tip
      // the load past the card and spill into shared system RAM (slow). A fresh lazy reload is cheap next to a
      // multi-minute video render crawling out of system RAM.
      try {
        await backend.freeMemory();
      } catch {
        /* best-effort — if the engine can't free now, the render just starts with less headroom */
      }
    }
    const out = await backend.generateVideo(
      {
        prompt: call.prompt,
        // The long-video loop's scene-lock negative (replaces the family default, which it extends).
        ...(call.negativePrompt ? { negativePrompt: call.negativePrompt } : {}),
        // Image present → image-to-video; absent → text-to-video.
        ...(image ? { image } : {}),
        // End frame present → first+last-frame conditioning (the backend validates model support).
        ...(endImage ? { endImage } : {}),
        // The model's per-call frames wins over the Settings default; the rest of the graph choices
        // (fps/size/steps/cfg/shift) come from Settings overrides, else the backend's Wan defaults.
        ...((call.frames ?? params?.frames) !== undefined ? { frames: (call.frames ?? params?.frames)! } : {}),
        ...(params?.fps ? { fps: params.fps } : {}),
        ...(params?.width ? { width: params.width } : {}),
        ...(params?.height ? { height: params.height } : {}),
        ...(params?.steps ? { steps: params.steps } : {}),
        ...(params?.cfg !== undefined ? { cfg: params.cfg } : {}),
        ...(params?.shift !== undefined ? { shift: params.shift } : {}),
        ...(params?.highRes !== undefined ? { highRes: params.highRes } : {}),
        ...(params?.audio !== undefined ? { audio: params.audio } : {}),
        // Skip the post-render /free between long-video clips so the ~30 GB model stays warm (V1).
        ...(keepResident ? { keepResident: true } : {}),
        lowVram: !!settings.lowVram,
        signal: ac.signal,
        onProgress: (fraction) => post({ type: "testProgress", requestId, fraction }),
      },
      models,
    );
    post({ type: "chatToolResult", requestId, call, video: { bytes: out.bytes, mimeType: out.mimeType } }, [out.bytes]);
  } catch (err) {
    const aborted = ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
    post({
      type: "chatToolResult",
      requestId,
      call,
      error: aborted ? "Video generation stopped." : err instanceof Error ? err.message : String(err),
    });
  } finally {
    localModelLease?.release();
    chatAborts.delete(requestId);
    warmChatModel();
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
  openEpoch++;
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
  const epoch = ++openEpoch;
  const isCurrentOpen = (): boolean => epoch === openEpoch;
  // Clear only stale intent from the previous book. A start arriving after `opening = true`
  // belongs to this open and must survive every awaited setup/download below.
  pendingStart = false;
  opening = true;
  const openNeedsLocalLease =
    settings.textProvider === "local" ||
    settings.imageProvider === "local";
  let localModelLease: LocalModelLease | undefined;
  let nextEngine: Engine | undefined;
  // Opening a book means the engine's bible-build will need the LLM — relaunch it if a prior image
  // session had freed it (otherwise extraction would hit a stopped server).
  try {
    if (openNeedsLocalLease) {
      localModelLease = await acquireLocalModelLease({
        engineHold: { bible: true, images: true },
      });
    }
    if (!isCurrentOpen()) return;
    // Stop the previous Engine before any VRAM hand-off. Its RenderBuffer is not a participant in
    // the model lease, so leaving it live here lets an in-flight render reload while /free runs.
    const previousProviders = bookProviders;
    const bookUsesLocalText = settings.textProvider === "local";
    const configuredImageNeedsHandoff =
      bookUsesLocalText && shouldHandImageModelToChat("book");
    const previousImageNeedsHandoff =
      bookUsesLocalText &&
      previousProviders?.image.id === "local" &&
      localModelsNeedExclusiveVram("book");
    engine?.dispose();
    engine = undefined;
    bookProviders = undefined;
    const bookUsesBundledLocal =
      corsProxyAvailable &&
      settings.localTextBackend === "bundled" &&
      settings.textProvider === "local";
    // Free the exact provider owned by the disposed Engine when local text/image cannot coexist.
    // This applies to bundled llama.cpp and external Ollama/LM Studio alike, while ample-VRAM
    // configurations retain their no-churn behavior.
    if (previousImageNeedsHandoff) {
      try {
        await previousProviders!.image.freeMemory?.();
        imageModelFreed = true;
      } catch {
        /* best-effort — native text setup still reports a useful failure if VRAM stays occupied */
      }
    }
    if (!isCurrentOpen()) return;
    // If the prior Engine already freed the shared local backend, do not issue a duplicate /free.
    await prepareChatLlmLoad(
      configuredImageNeedsHandoff && !previousImageNeedsHandoff,
      "book",
    );
    if (!isCurrentOpen()) return;
    await restoreChatLlm({
      ...(bookUsesBundledLocal ? { forceBundledEnsure: true } : {}),
      bundledScope: "book",
    });
    if (!isCurrentOpen()) return;
    post({ type: "status", message: "" });
    post({ type: "generating", value: false });
    post({ type: "paused", bible: false, images: false });
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
      onLocalStatus: (message) => {
        if (isCurrentOpen()) {
          post({ type: "status", message: message || "Building the Visual Bible…" });
        }
      },
      onLocalActivity: (activity) => {
        if (!isCurrentOpen()) return;
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
      llmLabel: diagnostics.llm.label,
      imageMock: diagnostics.image.mock,
    };
    nextEngine = new Engine({
      llm,
      image,
      tier,
      ...(imageSearch ? { imageSearch } : {}),
      ...(webSearch ? { webSearch } : {}),
      store: new IndexedDbStore(),
      onUpdate: (pageIndex, result) => {
        if (!isCurrentOpen() || engine !== nextEngine) return;
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
      onBibleProgress: (done, total) => {
        if (isCurrentOpen() && engine === nextEngine) setBibleChapter(done, total);
      },
      onPromptProgress: (done, total) => {
        if (isCurrentOpen() && engine === nextEngine) setPromptProgress(done, total);
      },
      // The bible builds in the background; relay each growth so the UI's
      // character/spoiler context (and the panel) stay current — and refresh the
      // live status line so the character count grows in real time.
      onBibleUpdate: (bible) => {
        if (!isCurrentOpen() || engine !== nextEngine) return;
        bibleCharacters = bible.characters.length;
        currentBible = bible; // the chat reads the live bible
        post({ type: "opened", bible });
        renderBibleStatus();
      },
      onBibleNote: (message) => {
        if (isCurrentOpen() && engine === nextEngine) {
          post({ type: "status", message });
        }
      },
      // Story "as you go": illustrate as each beat (chapter) is read — the first image
      // appears right after beat one, not after the whole "book". Ordinary books keep the
      // user's setting (default whole-book for the best art).
      illustrateAfter: book.kind === "story" ? "chapter" : (settings.illustrateAfter ?? "book"),
      // Story active-scene hook (no-op for ordinary books): pin the tracked present cast +
      // location per beat so terse beats still illustrate the right scene.
      onChapterExtracted: (chapterIndex, bible) =>
        isCurrentOpen() && engine === nextEngine
          ? storyPresentFor(chapterIndex, bible)
          : undefined,
    });
    engine = nextEngine;
    // This lease entered while the previous Engine (or none) was current. Keep the newly created
    // Engine under the same queue-wide hold through openBook and the lease handoff.
    localModelLease?.holdCurrentEngine();
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
    await nextEngine.openBook(renderBook);
    if (!isCurrentOpen()) {
      nextEngine.dispose();
      if (engine === nextEngine) {
        engine = undefined;
        bookProviders = undefined;
      }
      return;
    }
    // On a reopen, restore the per-beat scene snapshots (persisted, replay-filled) and PUSH
    // each into the engine — nothing re-extracts on a cached reopen, so this is what makes
    // render_scene of a PAST beat use that beat's exact tracked cast/location, and a
    // post-reopen append carry the correct scene forward. (No-op for live starts.)
    if (reopenedStory && nextEngine.getBible()) {
      story = rebuildStoryFromBook(book, nextEngine.getBible());
      story.scenes.forEach((sc, k) => nextEngine!.setStoryPresent(k, presentFromScene(sc)));
    }
    // A cast Soul brings its own FACE into the story, not just its name. `soulCast` renamed the
    // character in the text prompt and stopped there, so a reader cast as a character got a stranger
    // in every picture while their photos sat two panels away in the Soul panel. Seed those photos
    // into that character's own reference slots, so every existing path — the per-frame budget, the
    // weight split, the thumbnail, the reader deleting one they don't want — treats them like any
    // other reference. Skips a character who already HAS references, so the reader's own uploads win
    // and running this on every open can't stack duplicates. Best-effort: a failure here must not
    // stop a book from opening.
    void seedSoulReferences(nextEngine).catch(() => {});
    // Open is complete — now a deferred start can actually run (and `beginGeneration`
    // below sees `opening === false`). Replaying covers a `start` that arrived during
    // the open (e.g. the buddy's "open and illustrate it") as well as a settings re-open.
    opening = false;
    if (pendingStart) {
      pendingStart = false;
      if (localModelLease) {
        // This open owns the current local-model FIFO slot. Queue the deferred start behind every
        // foreground job already waiting for it (notably a Soul job requested during bundled-model
        // startup), so the fresh Engine cannot extract before that job binds its execution hold.
        const startAfterForeground = localTextQueueTail.catch(() => {});
        void startAfterForeground.then(() => {
          if (isCurrentOpen() && engine === nextEngine && !opening) beginGeneration();
        });
      } else {
        beginGeneration();
      }
    }
  } catch (err) {
    nextEngine?.dispose();
    if (engine === nextEngine) {
      engine = undefined;
      bookProviders = undefined;
    }
    if (isCurrentOpen()) {
      opening = false;
      post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    localModelLease?.release();
  }
}
