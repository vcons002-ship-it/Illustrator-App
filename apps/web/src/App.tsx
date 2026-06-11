import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  latestSpoilerParagraphIndex,
  paragraphIndexFromId,
  parseImportedBible,
  resolveKeyEvent,
  resolvePageEntities,
  spoilerRevealPoint,
  toRenderUnits,
  type BookSource,
  type BookSummary,
  type EncryptedSecrets,
} from "@visual-reader/core";
import { parseEpub } from "@visual-reader/epub";
import {
  CharacterBible,
  DEFAULT_SETTINGS,
  FirstRunWizard,
  ImagePanel,
  LibraryPanel,
  SettingsPanel,
  useScrollDepth,
  type InstalledModel,
  type LocalBackendId,
  type ProvidersDiagnostics,
  type ReaderSettings,
} from "@visual-reader/ui";
import type { LocalTextServerId } from "@visual-reader/core";
import { loadSampleBook } from "./sample.js";
import { useEngineWorker, type ImportResult } from "./useEngineWorker.js";
import {
  downloadLora,
  downloadModel,
  ensureEngine,
  isDesktop,
  listLocalModels,
  listLoras,
  onEngineProgress,
  onModelProgress,
} from "./runtime.js";

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
    startGeneration,
    resume,
    pauseBible,
    resumeBible,
    pauseImages,
    resumeImages,
    regenerateStoryboard,
    regenerateAllImages,
    regenerateImage,
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
  } = useEngineWorker(settings);
  const [showCharacters, setShowCharacters] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
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
        if (cancelled) return;
        setEngineStatus("");
        setInstalledModels(models);
        setInstalledLoras(loras);
        setSettings((s) => ({ ...s, engineBaseUrl: baseUrl }));
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
        const data = new Uint8Array(await file.arrayBuffer());
        const source = parseEpub(data, `epub-${file.name}-${file.size}`);
        openBook(source);
      } catch (err) {
        setLocalError(`Couldn't parse EPUB: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [openBook],
  );

  // Map the active paragraph back to its page and steer the predictive buffer.
  const activePageIndex = useMemo(() => {
    if (!book || !activeParagraphId) return 0;
    const pageId = activeParagraphId.replace(/-\d+$/, "");
    return Math.max(0, book.pages.findIndex((p) => p.id === pageId));
  }, [book, activeParagraphId]);

  // Render units: a group of pages (or a whole chapter) shares one illustration.
  // The reader still scrolls the original pages; `pageToUnit` maps the active page
  // to the unit the engine rendered (must match the worker — shared toRenderUnits).
  const pagesPerImage = settings.pagesPerImage ?? 3;
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
  // Transient "✓ your click did X" feedback, so a Redo press is never ambiguous.
  const [actionNote, setActionNote] = useState("");
  const actionNoteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteAction = useCallback((text: string) => {
    setActionNote(text);
    if (actionNoteTimer.current) clearTimeout(actionNoteTimer.current);
    actionNoteTimer.current = setTimeout(() => setActionNote(""), 8000);
  }, []);
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
          {library.length > 0 && (
            <button
              style={styles.button}
              onClick={() => setShowLibrary(true)}
              title="Your opened books — switch, remove, or carry a bible forward for a series"
            >
              Library ({library.length})
            </button>
          )}
          <label style={styles.upload}>
            Open EPUB
            <input
              type="file"
              accept=".epub"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
            />
          </label>
          <button style={styles.button} onClick={() => openBook(loadSampleBook())}>
            Load sample
          </button>
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
              onClick={() => setShowCharacters(true)}
              title="View and correct each character's appearance in the Visual Bible"
            >
              Characters{bible ? ` (${bible.characters.length})` : ""}
            </button>
          )}
          {book && (
            <button
              style={styles.button}
              onClick={exportBible}
              title="Download the Visual Bible (+ AI rules) as JSON for editing or external analysis"
            >
              ⤓ Export bible
            </button>
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
          <p>Open an EPUB or load the sample to start reading with live illustrations.</p>
          <p style={{ opacity: 0.6 }}>
            No API keys? It runs with built-in placeholder art so you can see the flow.
          </p>
        </div>
      )}

      {book && (
        <main style={styles.reader}>
          <article style={styles.column}>
            {book.pages.map((page, i) => {
              const prev = book.pages[i - 1];
              const newChapter = !prev || prev.chapterId !== page.chapterId;
              const chapter = book.chapters.find((c) => c.id === page.chapterId);
              const pageUnit = units?.pageToUnit[i] ?? i;
              const isActiveUnit = pageUnit === unitIndex;
              const next = book.pages[i + 1];
              // "Page N" dividers between pages of the same chapter (chapter
              // boundaries are marked by the heading). Hidden in whole-chapter mode.
              const showPageDivider =
                pagesPerImage !== "chapter" &&
                next !== undefined &&
                next.chapterId === page.chapterId;
              return (
                <Fragment key={page.id}>
                  {newChapter && (
                    <h2 style={styles.chapterHeading}>
                      {chapter?.title || `Chapter ${(chapter?.index ?? 0) + 1}`}
                    </h2>
                  )}
                  <section style={isActiveUnit ? { ...styles.page, ...styles.sectionActive } : styles.page}>
                    {page.paragraphs.map((para) => (
                      <p key={para.id} ref={registerParagraph(para.id)} style={styles.paragraph}>
                        {para.text}
                      </p>
                    ))}
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

          <aside style={styles.aside}>
            <div style={styles.panel}>
              <ImagePanel
                result={results.get(unitIndex)}
                bloom={bloom}
                pageKey={unitIndex}
                awaitingStart={!generating}
              />
              {imageCaption && <div style={styles.imageDescription}>{imageCaption}</div>}
              <div style={styles.caption}>
                {pagesPerImage === "chapter"
                  ? `Chapter ${unitIndex + 1} of ${totalUnits}`
                  : `Page ${activePageIndex + 1} of ${book.pages.length}${
                      singlePage ? "" : ` · image ${unitIndex + 1}/${totalUnits}`
                    }`}
                {bible ? ` · ${bible.characters.length} characters tracked` : ""}
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
function formatLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return ms < 60000 ? `~${Math.round(ms / 1000)}s left` : `~${Math.round(ms / 60000)}m left`;
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
    // Drop the transient engine URL and the plaintext keys; persist the keys
    // only as an encrypted blob (never in plaintext).
    const { keys, engineBaseUrl: _url, ...rest } = s;
    void _url;
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
  empty: { padding: 40, maxWidth: 560, lineHeight: 1.6 },
  reader: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 520px)",
    gap: 40,
    padding: "32px 20px 50vh",
    maxWidth: 1400,
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
  panel: { position: "sticky", top: 80 },
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
