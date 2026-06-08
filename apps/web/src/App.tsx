import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Automatic1111Backend,
  ComfyUIBackend,
  IndexedDbStore,
  LocalServerLLMProvider,
  LOCAL_IMAGE_MODELS,
  computeBloomTarget,
  decryptSecrets,
  encryptSecrets,
  getImageStyle,
  latestSpoilerParagraphIndex,
  paragraphIndexFromId,
  resolvePageEntities,
  spoilerRevealPoint,
  type BookSource,
  type BookSummary,
  type EncryptedSecrets,
} from "@visual-reader/core";
import { parseEpub } from "@visual-reader/epub";
import {
  DEFAULT_SETTINGS,
  FirstRunWizard,
  ImagePanel,
  SettingsPanel,
  useScrollDepth,
  type InstalledModel,
  type LocalBackendId,
  type ProvidersDiagnostics,
  type ReaderSettings,
} from "@visual-reader/ui";
import type { LocalTextServerId } from "@visual-reader/core";
import { loadSampleBook } from "./sample.js";
import { useEngineWorker } from "./useEngineWorker.js";
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
  const [engineStatus, setEngineStatus] = useState("");
  const [installedLoras, setInstalledLoras] = useState<string[]>([]);
  const [library, setLibrary] = useState<BookSummary[]>([]);
  const libraryStore = useMemo(() => new IndexedDbStore(), []);
  const hydrated = useRef(false);
  const {
    bible,
    results,
    status,
    providers,
    generating,
    openBook: openInWorker,
    startGeneration,
    goTo,
    prerenderAll,
  } = useEngineWorker(settings);
  const [prerendering, setPrerendering] = useState(false);
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
      setModelProgress((prev) => ({ ...prev, [p.id]: p.percent }));
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

  const onDownloadModel = useCallback(async (id: string) => {
    const model = LOCAL_IMAGE_MODELS.find((m) => m.id === id);
    if (!model) return;
    setModelProgress((prev) => ({ ...prev, [id]: 0 }));
    try {
      await downloadModel({ id: model.id, filename: model.filename, url: model.url });
      setModelProgress((prev) => ({ ...prev, [id]: 100 }));
      setInstalledModels(await listLocalModels());
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setLocalError(`Model download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

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
      setPrerendering(false);
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

  const onPrerenderAll = useCallback(() => {
    setPrerendering(true);
    prerenderAll();
  }, [prerenderAll]);

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

  useEffect(() => {
    goTo(activePageIndex);
  }, [activePageIndex, goTo]);

  const activePage = book?.pages[activePageIndex];
  const pageSpoilerIds =
    book && bible && activePage ? resolvePageEntities(bible, activePage).spoilerIds : [];

  // Bloom target: reveal the illustration only as the reader progresses through the
  // page, holding any depicted spoiler until they reach its paragraph (core/reveal).
  const paraCount = activePage?.paragraphs.length ?? 1;
  const pageProgress = Math.min(
    1,
    Math.max(0, ((paragraphIndexFromId(activeParagraphId) ?? 0) + activeParagraphProgress) / paraCount),
  );
  const hasPageSpoiler = pageSpoilerIds.length > 0;
  const bloom = activePage
    ? computeBloomTarget(
        pageProgress,
        spoilerRevealPoint(
          latestSpoilerParagraphIndex(activePage, pageSpoilerIds, bible?.spoilers ?? []),
          hasPageSpoiler,
          paraCount,
        ),
        hasPageSpoiler,
      )
    : 0;

  const renderedCount = useMemo(
    () => [...results.values()].filter((r) => r.status === "ready").length,
    [results],
  );
  const totalPages = book?.pages.length ?? 0;
  const prerenderDone = prerendering && totalPages > 0 && renderedCount >= totalPages;

  return (
    <div style={styles.shell}>
      <style>{KEYFRAMES}</style>
      <header style={styles.header}>
        <strong>Visual Reader</strong>
        <div style={styles.headerControls}>
          {library.length > 0 && (
            <select
              style={styles.button}
              value={book && library.some((b) => b.id === book.id) ? book.id : ""}
              onChange={(e) => void onPickBook(e.target.value)}
              title="Switch between books you've opened"
            >
              <option value="" disabled>
                Library ({library.length})…
              </option>
              {library.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                  {b.author ? ` — ${b.author}` : ""}
                </option>
              ))}
            </select>
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
          {book && (
            <button
              style={generating ? styles.button : styles.buttonPrimary}
              onClick={startGeneration}
              disabled={generating}
              title="Start building the Visual Bible and illustrating, reusing anything generated in past sessions"
            >
              {generating ? "Generating…" : "Begin generating book"}
            </button>
          )}
          {book && (
            <button
              style={styles.button}
              onClick={onPrerenderAll}
              disabled={prerendering && !prerenderDone}
              title="Render illustrations for every page now, instead of as you reach them"
            >
              {prerenderDone
                ? "Whole book rendered ✓"
                : prerendering
                  ? `Rendering ${renderedCount}/${totalPages}…`
                  : "Pre-render whole book"}
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
            engineStatus={engineStatus}
            installedLoras={installedLoras}
            onDownloadStyleLora={onDownloadStyleLora}
            onConnectLocalServer={onConnectLocalServer}
            connectingLocal={connectingLocal}
            textModels={textModels}
            onConnectLocalTextServer={onConnectLocalTextServer}
            connectingLocalText={connectingLocalText}
          />
        </div>
      </header>

      {!settings.configured && (
        <FirstRunWizard current={settings} onComplete={setSettings} isDesktop={isDesktop} />
      )}

      <ProviderBadges providers={providers} engineStatus={engineStatus} />

      {(status || localError) && <div style={styles.status}>{localError || status}</div>}

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
            {book.pages.map((page) => (
              <section key={page.id} style={styles.page}>
                {page.paragraphs.map((para) => (
                  <p key={para.id} ref={registerParagraph(para.id)} style={styles.paragraph}>
                    {para.text}
                  </p>
                ))}
              </section>
            ))}
          </article>

          <aside style={styles.aside}>
            <div style={styles.panel}>
              <ImagePanel
                result={results.get(activePageIndex)}
                bloom={bloom}
                pageKey={activePageIndex}
                awaitingStart={!generating}
              />
              <div style={styles.caption}>
                Page {activePageIndex + 1} of {book.pages.length}
                {bible ? ` · ${bible.characters.length} characters tracked` : ""}
              </div>
            </div>
          </aside>
        </main>
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
    return { ...DEFAULT_SETTINGS, ...(raw as Partial<ReaderSettings>) };
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

const KEYFRAMES = `@keyframes vr-pulse { 0%,100% { opacity: 0.55 } 50% { opacity: 0.9 } }`;

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
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    padding: "12px 20px",
    background: "rgba(17,19,26,0.92)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    backdropFilter: "blur(8px)",
  },
  headerControls: { display: "flex", gap: 10, alignItems: "flex-start" },
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
    gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 380px)",
    gap: 40,
    padding: "32px 20px 50vh",
    maxWidth: 1200,
    margin: "0 auto",
  },
  column: { maxWidth: 640 },
  page: { marginBottom: 32 },
  paragraph: { fontSize: 19, lineHeight: 1.8, margin: "0 0 18px" },
  aside: {},
  panel: { position: "sticky", top: 80 },
  caption: { marginTop: 10, fontSize: 13, opacity: 0.7, fontFamily: "system-ui, sans-serif" },
};
