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
  bestParagraphIndex,
  conceptIntroductions,
  subjectFromCaption,
  rankLocalFiles,
  formatFileSize,
  type ConceptIntro,
  type BookSource,
  type BookSummary,
  type ChapterDataset,
  type BuddyPersona,
  type BuddyToolCall,
  type ChatTurn,
  type ContextUsage,
  type EncryptedSecrets,
  type StoredChatMessage,
  type ToolCall,
} from "@visual-reader/core";
import {
  bookFromText,
  buildIllustratedEpub,
  buildIllustratedHtml,
  type ExportImage,
  type ExportImages,
} from "@visual-reader/epub";
import { IMPORT_ACCEPT, importBookFile } from "./import-file.js";
import {
  CharacterBible,
  ChatBuddyPanel,
  ChatPanel,
  DataChart,
  DataSection,
  DEFAULT_SETTINGS,
  FirstRunWizard,
  ImagePanel,
  PanelGrid,
  LibraryPanel,
  SettingsPanel,
  useScrollDepth,
  ConceptCard,
  ConceptText,
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
import {
  downloadLora,
  downloadModel,
  ensureEngine,
  gpuVramMb,
  isDesktop,
  listLocalModels,
  listLoras,
  loraFamilies,
  onEngineProgress,
  onModelProgress,
  readLocalFile,
  saveExportFile,
  searchLocalFiles,
} from "./runtime.js";

/** Chat-history key for the landing-page buddy — reserved, never a book id. */
const BUDDY_CHAT_ID = "__buddy__";

/** Message shown when a figure search returns nothing (or errors) — so an empty
 * result is visible instead of looking like the search silently did nothing. */
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
    chat,
    chatTool,
    chatCancel,
    buddyChat,
    buddyCancel,
    summarize,
  } = useEngineWorker(settings);
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
    { title: string; text: string; mode?: "fiction" | "technical" } | undefined
  >();
  const [showLibrary, setShowLibrary] = useState(false);
  // Reading-companion chat (per book; persisted in IndexedDB).
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<StoredChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStreaming, setChatStreaming] = useState("");
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
  const [buddyActivity, setBuddyActivity] = useState("");
  const [buddyPersona, setBuddyPersona] = useState<BuddyPersona>("freeform");
  const [buddyPendingTool, setBuddyPendingTool] = useState<BuddyToolCall | undefined>();
  const [buddyUsage, setBuddyUsage] = useState<ContextUsage | undefined>();
  // The pending generate_image's transcript, folded in only on approval (same
  // injection guard as the book chat's pendingTranscript).
  const pendingBuddyTranscript = useRef<ChatTurn[]>([]);
  // Session grant for buddy-initiated filesystem search: once the reader picks
  // "Allow this session", later find_files calls run without re-confirming (a
  // direct /find never needed confirming — the reader typed it). Reset on reload.
  const fileAccessGranted = useRef(false);
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
    return () => {
      void unEngine?.then((fn) => fn());
      void unModel?.then((fn) => fn());
    };
  }, []);

  // Desktop: when the local image path is selected, make sure the GPU engine is
  // installed + running (downloads on first use) and learn its base URL + models.
  useEffect(() => {
    if (!isDesktop || settings.imageProvider !== "local" || settings.engineBaseUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        setEngineStatus("Setting up the local engine…");
        const baseUrl = await ensureEngine();
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
      try {
        const source = await libraryStore.getBook(id);
        if (source) openBook(source);
      } catch {
        /* ignore */
      }
    },
    [book, libraryStore, openBook],
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
  // runs front-to-back on its own; scrolling only drives the reveal (bloom).

  const activePage = book?.pages[activePageIndex];
  const pageEntities =
    book && bible && activePage ? resolvePageEntities(bible, activePage) : undefined;
  const pageSpoilerIds = pageEntities?.spoilerIds ?? [];
  // The story-chapter index of the page being read (keys the bible's per-chapter
  // storyboard/datasets) — same mapping the engine uses.
  const activeChapterIndex = useMemo(
    () => book?.chapters.find((c) => c.id === activePage?.chapterId)?.index ?? 0,
    [book, activePage],
  );
  const activeDatasets = useMemo(
    () =>
      book?.contentMode === "technical" && bible?.datasets
        ? bible.datasets.filter((d) => d.chapterIndex === activeChapterIndex)
        : [],
    [book, bible, activeChapterIndex],
  );

  // --- Technical-mode reading support (inline, anchored to source paragraphs) --
  // Key concepts marked in the text + first-appearance explanation cards. Depends
  // only on the book + glossary, so it survives result churn untouched.
  const techConcepts = useMemo(() => {
    if (book?.contentMode !== "technical" || !bible?.glossary.length) return undefined;
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
    if (book?.contentMode !== "technical" || !units) return undefined;
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
      book?.contentMode === "technical"
        ? { ...(techConcepts ?? {}), ...(techFiguresByPage ? { figuresByPage: techFiguresByPage } : {}) }
        : undefined,
    [book, techConcepts, techFiguresByPage],
  );

  // --- Reading-companion chat ------------------------------------------------
  const isTechnical = book?.contentMode === "technical";
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

  // Save a file the assistant wrote in a code block (a webpage, CSV worksheet,
  // script…) — desktop writes to ~/VisualReader/exports, web downloads it.
  const onSaveChatFile = useCallback(
    (filename: string, content: string, mime: string): Promise<string | true> =>
      saveExportFile(filename, content, mime),
    [],
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
      const turnBookId = book.id; // guard: ignore this turn if the reader switches/exits
      const seq = ++chatTurnSeq.current; // guard: ignore if Clear/cancel supersedes it
      const history = chatTurnsOf(chatMessages);
      appendChat({ role: "user", text });
      setChatBusy(true);
      setChatStreaming("");
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
          } else if (e.kind === "activity") setChatActivity(e.text);
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
              const best = e.imageHits[0]!;
              appendChat({
                role: "tool",
                text: `Found: ${best.title ?? "image"}`,
                image: { sourceUrl: best.thumbnailLink ?? best.link },
                // Links open the IMAGES themselves, not their source pages.
                links: e.imageHits
                  .slice(0, 5)
                  .map((h, i) => ({ url: h.link, title: `${i + 1}. ${h.title ?? "image"}` })),
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
        setChatActivity("");
      }
      if (chatBookRef.current?.id !== turnBookId || chatTurnSeq.current !== seq) return;
      if (res.error) {
        appendChat({ role: "tool", text: `⚠ ${res.error}`, turns: [] });
        return;
      }
      if (res.pendingTool) {
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
  useEffect(() => {
    let cancelled = false;
    void libraryStore.getChatHistory?.(BUDDY_CHAT_ID).then((stored) => {
      if (!cancelled && stored) setBuddyMessages(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [libraryStore]);
  const buddyHadMessages = useRef(false);
  useEffect(() => {
    if (buddyMessages.length === 0) {
      // Same delete-vs-initial-empty distinction as the book chat's persist.
      if (buddyHadMessages.current) void libraryStore.deleteChatHistory?.(BUDDY_CHAT_ID);
      return;
    }
    buddyHadMessages.current = true;
    const t = setTimeout(() => void libraryStore.putChatHistory?.(BUDDY_CHAT_ID, buddyMessages), 500);
    return () => clearTimeout(t);
  }, [buddyMessages, libraryStore]);

  const appendBuddy = (msg: Omit<StoredChatMessage, "at">) =>
    setBuddyMessages((prev) => [...prev, { ...msg, at: Date.now() }]);

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
  const runFileSearch = async (query: string, modelTurns?: ChatTurn[]): Promise<void> => {
    if (!isDesktop) {
      appendBuddy({ role: "tool", text: "🔒 Searching your computer needs the desktop app.", ...(modelTurns ? { turns: [] } : {}) });
      return;
    }
    setBuddyBusy(true);
    setBuddyActivity(`Searching your files for “${query}”…`);
    try {
      const ranked = rankLocalFiles(query, await searchLocalFiles(query), 15);
      const baked = modelTurns
        ? {
            turns: [
              ...modelTurns,
              {
                role: "user" as const,
                content: formatBuddyToolResult(
                  { tool: "find_files", query },
                  { files: ranked.map((f) => ({ path: f.path, name: f.name })) },
                ),
              },
            ],
          }
        : {};
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

  // Approve a buddy-requested find_files: run it with the pending transcript baked in.
  const approveFindFiles = (call: Extract<BuddyToolCall, { tool: "find_files" }>): void => {
    setBuddyPendingTool(undefined);
    const turns = pendingBuddyTranscript.current;
    pendingBuddyTranscript.current = [];
    void runFileSearch(call.query, turns);
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
            image: { sourceUrl: ref.url },
            links: [{ url: ref.url, title: "open full image" }],
          });
        }
        return;
      }
      // A pasted bare link.
      const url = text.trim();
      if (/^https?:\/\/\S+$/i.test(url)) {
        appendBuddy({ role: "user", text });
        // A direct image link should just DISPLAY — not try to open a book/article.
        if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|#|$)/i.test(url)) {
          appendBuddy({ role: "tool", text: "Here's that image:", image: { sourceUrl: url }, links: [{ url, title: "open full image" }] });
          return;
        }
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
      const seq = ++buddyTurnSeq.current; // guard: ignore if Clear/cancel supersedes it
      const history = chatTurnsOf(buddyMessages);
      appendBuddy({ role: "user", text });
      setBuddyBusy(true);
      setBuddyStreaming("");
      setBuddyActivity("");
      setBuddyPendingTool(undefined);
      let openedBook = false;
      const res = await buddyChat(history, text, buddyPersona, library, (e) => {
        if (e.kind === "token") {
          setBuddyStreaming((prev) => prev + e.text);
          setBuddyActivity(""); // visible text replaces any "Reasoning…" status
        } else if (e.kind === "activity") setBuddyActivity(e.text);
        else if (e.kind === "usage") setBuddyUsage(e.usage);
        else if (e.kind === "tool") {
          setBuddyActivity(
            e.call.tool === "search_books"
              ? `Searching Project Gutenberg for “${e.call.query}”…`
              : e.call.tool === "random_books"
                ? "Pulling some classics off the shelf…"
                : e.call.tool === "search_web"
                  ? `Searching for “${e.call.query}”…`
                  : e.call.tool === "read_url"
                    ? `Reading ${e.call.url}…`
                    : e.call.tool === "search_images"
                    ? `Looking for images of “${e.call.query}”…`
                    : e.call.tool === "calculate"
                      ? "Calculating…"
                      : e.call.tool === "remember" || e.call.tool === "forget"
                      ? "Updating memory…"
                      : e.call.tool === "set_visual_style"
                        ? "Updating the visual settings…"
                        : e.call.tool === "open_library_book"
                        ? "Opening from your library…"
                        : e.call.tool === "open_pasted_text"
                          ? "Opening your text…"
                          : e.call.tool === "remove_library_book"
                            ? "Removing from your library…"
                            : e.call.tool === "generate_image"
                              ? "Preparing an image…"
                              : e.call.tool === "find_files"
                                ? "Asking to search your files…"
                                : "Fetching the text and opening it…",
          );
        } else if (e.kind === "settings") {
          // The buddy resolved a settings change against the catalog; commit it
          // here (the App owns settings) and show what changed.
          setSettings((s) => ({
            ...s,
            ...(e.style ? { imageStyle: e.style.id } : {}),
            ...(e.pagesPerImage !== undefined ? { pagesPerImage: e.pagesPerImage } : {}),
            ...(e.illustrateAfter !== undefined ? { illustrateAfter: e.illustrateAfter } : {}),
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
          appendBuddy({ role: "tool", text: `🎨 ${parts.join(" · ")}` });
        } else if (e.kind === "libraryChanged") {
          // A book was removed from IndexedDB — refresh the library list (the
          // tool's prose confirmation handles user-facing acknowledgement).
          void libraryStore.listBooks().then(setLibrary).catch(() => {});
        } else if (e.kind === "opened") {
          // Hand the VISIBLE conversation off into the book chat (model-facing
          // `turns` are stripped — the book chat has different tools/context),
          // open the book, and start visuals when the reader asked for them.
          openedBook = true;
          buddyHandoff.current = [...buddyMessages, { role: "user" as const, text, at: Date.now() }]
            .slice(-12)
            .map(({ turns: _turns, ...m }) => m);
          openBook(e.book);
          if (e.visuals) startGeneration();
          setShowChat(true);
        } else {
          setBuddyActivity("");
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
            // Inline figure + links that open the IMAGES themselves (not their source
            // pages); remember the list so "show #2" can display another one.
            const best = e.imageHits[0]!;
            lastRefs.current = e.imageHits.map((h) => ({
              kind: "image",
              label: h.title ?? "image",
              url: h.link,
            }));
            appendBuddy({
              role: "tool",
              text: `Found: ${best.title ?? "image"} (say “show #N” for another)`,
              image: { sourceUrl: best.thumbnailLink ?? best.link },
              links: e.imageHits
                .slice(0, 5)
                .map((h, i) => ({ url: h.link, title: `${i + 1}. ${h.title ?? "image"}` })),
            });
          } else if (e.calc) {
            appendBuddy({ role: "tool", text: `🧮 ${e.calc.expression} = ${e.calc.result}` });
          } else if (e.memory) {
            appendBuddy({
              role: "tool",
              text: `🧠 ${e.memory.action === "remembered" ? "Remembered" : "Forgot"}: “${e.memory.note}”`,
            });
          } else if (e.removed) {
            appendBuddy({ role: "tool", text: `🗑 Removed “${e.removed}” from the library.` });
          } else if (e.call.tool === "search_images") {
            appendBuddy({ role: "tool", text: imageSearchMiss(e.call.query, e.error, hasSearchKey) });
          } else if (text.startsWith("/") && e.error) {
            // A direct command's failure has no model to fold it into — show it.
            appendBuddy({ role: "tool", text: `⚠ ${e.error}` });
          } else if (
            text.startsWith("/") &&
            (e.call.tool === "search_books" || e.call.tool === "random_books" || e.call.tool === "search_web")
          ) {
            appendBuddy({ role: "tool", text: "🔍 No results." });
          }
        }
      });
      // Clear this turn's busy/transient state unless a newer turn superseded it, so
      // a mid-turn Clear/supersede can never leave the panel stuck "Thinking…".
      if (buddyTurnSeq.current !== seq) return;
      setBuddyBusy(false);
      setBuddyStreaming("");
      setBuddyActivity("");
      if (res.error) {
        appendBuddy({ role: "tool", text: `⚠ ${res.error}`, turns: [] });
        return;
      }
      if (res.pendingTool) {
        pendingBuddyTranscript.current = [{ role: "user", content: text }, ...res.transcript];
        // find_files runs WITHOUT re-prompting once the reader granted access this
        // session; otherwise (and always for generate_image) it waits for approval.
        if (res.pendingTool.tool === "find_files" && fileAccessGranted.current) {
          approveFindFiles(res.pendingTool);
        } else {
          setBuddyPendingTool(res.pendingTool);
        }
        return;
      }
      if (res.text) {
        appendBuddy({
          role: "assistant",
          text: res.text,
          turns: [{ role: "user", content: text }, ...res.transcript],
        });
        // When a book opened this turn the landing panel is gone — the closing
        // prose ("It's open! …") must land in the book chat to be seen.
        if (openedBook) appendChat({ role: "assistant", text: res.text });
      }
    },
    [buddyMessages, buddyChat, buddyPersona, library, openBook, startGeneration, libraryStore, hasSearchKey],
  );
  const onBuddySendText = useCallback((text: string) => void onBuddySend(text), [onBuddySend]);
  // Approved buddy render: the worker's chatTool path serves both chats (the
  // buddy's generate_image call has the identical shape by design).
  const onApproveBuddyTool = useCallback(async () => {
    const call = buddyPendingTool;
    if (call?.tool === "find_files") {
      approveFindFiles(call);
      return;
    }
    if (!call || call.tool !== "generate_image") return;
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
  }, [buddyPendingTool, chatTool]);
  const onApproveBuddyPendingTool = useCallback(() => void onApproveBuddyTool(), [onApproveBuddyTool]);
  // "Allow this session": grant filesystem access so later find_files calls run
  // without re-prompting, then run the pending search.
  const onAllowBuddyFilesAlways = useCallback(() => {
    fileAccessGranted.current = true;
    const call = buddyPendingTool;
    if (call?.tool === "find_files") approveFindFiles(call);
  }, [buddyPendingTool]);
  const onDismissBuddyPendingTool = useCallback(() => {
    setBuddyPendingTool(undefined);
    pendingBuddyTranscript.current = [];
  }, []);
  const onClearBuddy = useCallback(() => {
    buddyTurnSeq.current++;
    buddyCancel();
    setBuddyBusy(false);
    setBuddyStreaming("");
    setBuddyActivity("");
    setBuddyMessages([]);
    setBuddyPendingTool(undefined);
    void libraryStore.deleteChatHistory?.(BUDDY_CHAT_ID);
  }, [libraryStore, buddyCancel]);
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
        ...(m.files ? { files: m.files } : {}),
        ...(m.actions ? { actions: m.actions } : {}),
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
    () => [...results.values()].filter((r) => r.status === "ready" && (r.image || r.sourceUrl)).length,
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
      if (result.status !== "ready" || !result.image) continue; // hotlink-only figures aren't embeddable
      const bytes =
        "blob" in result.image ? await result.image.blob.arrayBuffer() : result.image.bytes;
      const page = firstPageOfUnit.get(unitIndex) ?? unitIndex;
      map.set(page, {
        bytes,
        mimeType: result.image.mimeType,
        ...(result.prompt ? { caption: displayCaption(result.prompt) } : {}),
      });
    }
    return map;
  }, [results, units]);

  const onExport = useCallback(
    async (format: "html" | "epub") => {
      if (!book) return;
      if (exportMenuRef.current) exportMenuRef.current.open = false;
      try {
        const images = await gatherExportImages();
        const styleNote = `Illustrated with Visual Reader · ${getImageStyle(settings.imageStyle).label} style · ${images.size} image${images.size === 1 ? "" : "s"}`;
        const opts = { styleNote };
        const base = safeFileName(book.title);
        const result =
          format === "html"
            ? await saveExportFile(`${base}.html`, buildIllustratedHtml(book, images, opts), "text/html")
            : await saveExportFile(
                `${base}.epub`,
                buildIllustratedEpub(book, images, opts),
                "application/epub+zip",
              );
        const where = typeof result === "string" ? ` to ${result}` : " (check your downloads)";
        noteAction(`✓ Exported ${format.toUpperCase()} with ${images.size} illustration${images.size === 1 ? "" : "s"}${where}.`);
      } catch (err) {
        setLocalError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [book, gatherExportImages, settings.imageStyle, noteAction],
  );

  // Save just the illustration the reader is currently looking at.
  const onSaveCurrentImage = useCallback(async () => {
    const result = results.get(unitIndex);
    if (!book || !result?.image) return;
    try {
      const bytes =
        "blob" in result.image ? await result.image.blob.arrayBuffer() : result.image.bytes;
      const ext = /jpe?g/i.test(result.image.mimeType) ? "jpg" : /webp/i.test(result.image.mimeType) ? "webp" : "png";
      const saved = await saveExportFile(
        `${safeFileName(book.title)} - image ${unitIndex + 1}.${ext}`,
        new Uint8Array(bytes),
        result.image.mimeType,
      );
      const where = typeof saved === "string" ? ` to ${saved}` : " (check your downloads)";
      noteAction(`✓ Saved image ${unitIndex + 1}${where}.`);
    } catch (err) {
      setLocalError(`Couldn't save the image: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [book, results, unitIndex, noteAction]);

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
          {library.length > 0 && (
            <button
              style={styles.button}
              onClick={() => setShowLibrary(true)}
              title="Your opened books — switch, remove, or carry a bible forward for a series"
            >
              Library ({library.length})
            </button>
          )}
          <label style={styles.upload} title="EPUB, TXT, Markdown, HTML, or PDF">
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
            title="Start from a photo and reimagine it with the current image model and art style (local engine)"
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

      {!settings.configured && (
        <FirstRunWizard current={settings} onComplete={setSettings} isDesktop={isDesktop} />
      )}

      <ProviderBadges providers={providers} engineStatus={engineStatus} />

      {!book && (status || localError) && (
        <div style={styles.status}>{localError || status}</div>
      )}

      {!book && !status && !localError && (
        <div style={styles.empty}>
          Open an EPUB, load the sample, or ask the buddy below to find &amp; illustrate something.
          <span style={{ opacity: 0.55 }}> No API keys? It runs with placeholder art so you can see the flow.</span>
        </div>
      )}

      {!book && (
        <section style={styles.buddySection}>
          <ChatBuddyPanel
            messages={buddyPanelMessages}
            {...(buddyStreaming ? { streamingText: buddyStreaming } : {})}
            busy={buddyBusy}
            {...(buddyActivity ? { activity: buddyActivity } : {})}
            {...(buddyPendingTool ? { pendingTool: buddyPendingTool } : {})}
            persona={buddyPersona}
            onPersonaChange={setBuddyPersona}
            onSend={onBuddySendText}
            onApprovePendingTool={onApproveBuddyPendingTool}
            onApprovePendingToolAlways={onAllowBuddyFilesAlways}
            onDismissPendingTool={onDismissBuddyPendingTool}
            onCancel={buddyCancel}
            onClearHistory={onClearBuddy}
            onDeleteMessage={onDeleteBuddyMessage}
            onCompact={onCompactBuddyClick}
            desktop={isDesktop}
            onOpenLocalFile={onOpenLocalFile}
            onSaveFile={onSaveChatFile}
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
            {...(technicalSupport ? { technical: technicalSupport } : {})}
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
              <DataSection
                datasets={activeDatasets}
                sourceLabel={
                  book.chapters.find((c) => c.index === activeChapterIndex)?.title ||
                  `chapter ${activeChapterIndex + 1}`
                }
                defaultOpen={isTechnical}
              />
              <div style={styles.caption}>
                {pagesPerImage === "chapter"
                  ? `Chapter ${unitIndex + 1} of ${totalUnits}`
                  : `Page ${activePageIndex + 1} of ${book.pages.length}${
                      singlePage ? "" : ` · image ${unitIndex + 1}/${totalUnits}`
                    }`}
                {bible
                  ? book.contentMode === "technical"
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
          {...(chatUsage ? { contextUsage: chatUsage } : {})}
        />
      )}

      {showPasteText && (
        <PasteTextModal
          initial={pasteInitial}
          onCreate={(title, text, mode) => {
            try {
              // Library provenance: did this text come from a file or a raw paste?
              openBook(bookFromText(title, text, mode, pasteInitial ? "Imported file" : "Pasted text"));
              setShowPasteText(false);
              setPasteInitial(undefined);
            } catch (err) {
              setLocalError(err instanceof Error ? err.message : String(err));
            }
          }}
          onClose={() => {
            setShowPasteText(false);
            setPasteInitial(undefined);
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
}

const ReaderColumn = memo(function ReaderColumn({
  book,
  pageToUnit,
  unitIndex,
  pagesPerImage,
  registerParagraph,
  technical,
}: {
  book: BookSource;
  pageToUnit: number[] | undefined;
  unitIndex: number;
  pagesPerImage: number | "chapter";
  registerParagraph: (id: string) => (el: HTMLElement | null) => void;
  /** Present only in technical mode: concept marks + paragraph-anchored support. */
  technical?: TechnicalSupportData;
}) {
  const chaptersById = useMemo(() => new Map(book.chapters.map((c) => [c.id, c])), [book]);
  return (
    <article style={styles.column}>
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
                const support =
                  (paraConcepts?.length ?? 0) > 0 || (paraFigures?.length ?? 0) > 0;
                return (
                  <Fragment key={para.id}>
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
                    {support && (
                      <SupportRow>
                        {paraFigures?.map((f) => (
                          <InlineFigure key={`fig-${f.unitIndex}`} result={f.result} />
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
  onClose,
}: {
  /** Prefill when the text came from an opened file (PDF/Word/CSV/…). */
  initial?: { title: string; text: string; mode?: "fiction" | "technical" } | undefined;
  onCreate: (title: string, text: string, mode: "fiction" | "technical") => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [mode, setMode] = useState<"fiction" | "technical">(initial?.mode ?? "fiction");
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
        <textarea
          style={styles.importTextarea}
          value={text}
          placeholder="Paste the text here…"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, margin: "6px 0" }}>
          <input
            type="checkbox"
            checked={mode === "technical"}
            onChange={(e) => setMode(e.target.checked ? "technical" : "fiction")}
          />
          <span>
            Technical / non-fiction (papers, textbooks) — illustrate concepts and diagrams
            instead of story scenes <em style={{ opacity: 0.6 }}>(experimental)</em>
          </span>
        </label>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
          <span style={{ opacity: 0.6, fontSize: 12 }}>{words ? `${words} words` : ""}</span>
          <button
            style={styles.buttonPrimary}
            disabled={!text.trim()}
            onClick={() => onCreate(title.trim() || "Pasted text", text, mode)}
          >
            Read it
          </button>
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
