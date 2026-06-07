import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Engine,
  resolvePageEntities,
  type BookSource,
  type ImageResult,
  type VisualBible,
} from "@visual-reader/core";
import { parseEpub } from "@visual-reader/epub";
import {
  ImagePanel,
  SettingsPanel,
  useScrollDepth,
  type ReaderSettings,
} from "@visual-reader/ui";
import { buildProviders } from "./providers.js";
import { loadSampleBook } from "./sample.js";

const DEFAULT_SETTINGS: ReaderSettings = { tier: "cloud", llmKey: "", imageKey: "" };

export function App() {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [book, setBook] = useState<BookSource | undefined>();
  const [bible, setBible] = useState<VisualBible | undefined>();
  const [results, setResults] = useState<Map<number, ImageResult>>(new Map());
  const [status, setStatus] = useState<string>("");
  const engineRef = useRef<Engine | undefined>(undefined);
  const { registerParagraph, activeParagraphId, passedParagraphIds } = useScrollDepth();

  useEffect(() => saveSettings(settings), [settings]);

  const openBook = useCallback(
    async (source: BookSource) => {
      setStatus("Building the Visual Bible…");
      setResults(new Map());
      const { llm, image, tier } = buildProviders(settings);
      const engine = new Engine({
        llm,
        image,
        tier,
        onUpdate: (pageIndex, result) =>
          setResults((prev) => new Map(prev).set(pageIndex, result)),
      });
      try {
        await engine.openBook(source);
        engineRef.current = engine;
        setBible(engine.getBible());
        setBook(source);
        engine.setIdleAllowed(true);
        engine.goToPage(0);
        setStatus("");
      } catch (err) {
        setStatus(`Failed to open book: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [settings],
  );

  const onUpload = useCallback(
    async (file: File) => {
      const data = new Uint8Array(await file.arrayBuffer());
      try {
        const source = parseEpub(data, `epub-${file.name}-${file.size}`);
        await openBook(source);
      } catch (err) {
        setStatus(`Couldn't parse EPUB: ${err instanceof Error ? err.message : String(err)}`);
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
    engineRef.current?.goToPage(activePageIndex);
  }, [activePageIndex]);

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
          <SettingsPanel value={settings} onChange={setSettings} />
        </div>
      </header>

      {status && <div style={styles.status}>{status}</div>}

      {!book && !status && (
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
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: ReaderSettings) {
  try {
    localStorage.setItem("vr-settings", JSON.stringify(s));
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
