import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Automatic1111Backend,
  ComfyUIBackend,
  resolvePageEntities,
  type BookSource,
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
  type ReaderSettings,
} from "@visual-reader/ui";
import { loadSampleBook } from "./sample.js";
import { useEngineWorker } from "./useEngineWorker.js";
import { downloadModel, ensureEngine, isDesktop, listLocalModels } from "./runtime.js";

export function App() {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [book, setBook] = useState<BookSource | undefined>();
  const [localError, setLocalError] = useState<string>("");
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
  const [connectingLocal, setConnectingLocal] = useState(false);
  const { bible, results, status, openBook: openInWorker, goTo } = useEngineWorker(settings);
  const { registerParagraph, activeParagraphId, passedParagraphIds } = useScrollDepth();

  useEffect(() => saveSettings(settings), [settings]);

  // Desktop: when the local image path is selected, make sure the GPU engine is
  // installed + running (downloads on first use) and learn its base URL + models.
  useEffect(() => {
    if (!isDesktop || settings.imageProvider !== "local" || settings.engineBaseUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        const baseUrl = await ensureEngine();
        const models = await listLocalModels();
        if (cancelled) return;
        setInstalledModels(models);
        setSettings((s) => ({ ...s, engineBaseUrl: baseUrl }));
      } catch (err) {
        if (!cancelled) setLocalError(`Local engine setup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.imageProvider, settings.engineBaseUrl]);

  const onDownloadModel = useCallback(async (id: string) => {
    try {
      await downloadModel(id);
      setInstalledModels(await listLocalModels());
    } catch (err) {
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

  const openBook = useCallback(
    (source: BookSource) => {
      setLocalError("");
      setBook(source);
      openInWorker(source);
    },
    [openInWorker],
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

  useEffect(() => {
    goTo(activePageIndex);
  }, [activePageIndex, goTo]);

  const activePage = book?.pages[activePageIndex];
  const pageSpoilerIds =
    book && bible && activePage ? resolvePageEntities(bible, activePage).spoilerIds : [];

  return (
    <div style={styles.shell}>
      <style>{KEYFRAMES}</style>
      <header style={styles.header}>
        <strong>Visual Reader</strong>
        <div style={styles.headerControls}>
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
          <SettingsPanel
            value={settings}
            onChange={setSettings}
            isDesktop={isDesktop}
            installedModels={installedModels}
            onDownloadModel={onDownloadModel}
            onConnectLocalServer={onConnectLocalServer}
            connectingLocal={connectingLocal}
          />
        </div>
      </header>

      {!settings.configured && (
        <FirstRunWizard current={settings} onComplete={setSettings} isDesktop={isDesktop} />
      )}

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
                imageSpoilerIds={pageSpoilerIds}
                spoilers={bible?.spoilers ?? []}
                passedParagraphIds={passedParagraphIds}
                bloom={1}
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

function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem("vr-settings");
    if (!raw) return DEFAULT_SETTINGS;
    return migrate(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return DEFAULT_SETTINGS;
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

function saveSettings(s: ReaderSettings) {
  try {
    // engineBaseUrl is transient (re-discovered each run) — don't persist it.
    const { engineBaseUrl: _drop, ...persist } = s;
    void _drop;
    localStorage.setItem("vr-settings", JSON.stringify(persist));
  } catch {
    /* ignore quota / private-mode errors */
  }
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
  status: { padding: "10px 20px", color: "#ffd479" },
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
