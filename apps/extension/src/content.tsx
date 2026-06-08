import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Automatic1111Backend,
  ComfyUIBackend,
  DirectTransport,
  Engine,
  computeBloomTarget,
  latestSpoilerParagraphIndex,
  resolvePageEntities,
  spoilerRevealPoint,
  type BookSource,
  type EncryptedSecrets,
  type ImageResult,
  type VisualBible,
} from "@visual-reader/core";
import { segmentBook } from "@visual-reader/epub";
import {
  DEFAULT_SETTINGS,
  ImagePanel,
  SettingsPanel,
  buildProviders,
  type InstalledModel,
  type LocalBackendId,
  type ReaderSettings,
} from "@visual-reader/ui";
import { extractReadableText } from "./extract.js";
import { createCacheStore } from "./cache-store.js";
import { decryptViaBackground, encryptViaBackground, proxyFetch } from "./message-transport.js";

const STORAGE_KEY = "vr-settings";

/**
 * Content-script overlay. Extracts the page's readable text, runs it through the
 * SAME shared engine the web app uses, and floats an image panel beside the
 * article. Real generation: providers are built from the user's settings (BYO
 * cloud keys or a connected local Stable Diffusion server), and all network goes
 * through the background worker (`proxyFetch`) to dodge page CORS. With no keys
 * it falls back to the built-in placeholder art. Settings persist in
 * `chrome.storage`; scroll position drives which page is shown.
 */
function Overlay() {
  const [visible, setVisible] = useState(true);
  const [settings, setSettings] = useState<ReaderSettings | undefined>(undefined);
  const [book, setBook] = useState<BookSource | undefined>();
  const [bible, setBible] = useState<VisualBible | undefined>();
  const [results, setResults] = useState<Map<number, ImageResult>>(new Map());
  const [pageIndex, setPageIndex] = useState(0);
  // Continuous 0..1 reading position within the current page, from host scroll.
  const [subPageProgress, setSubPageProgress] = useState(0);
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
  const [connectingLocal, setConnectingLocal] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const engineRef = useRef<Engine | undefined>(undefined);
  const extractedRef = useRef<{ title: string; text: string } | undefined>(undefined);

  // Toolbar icon toggles the panel.
  useEffect(() => {
    const onMessage = (msg: { type?: string }) => {
      if (msg?.type === "visual-reader/toggle") setVisible((v) => !v);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  // Load persisted settings; API keys are stored encrypted (decrypted via the
  // background worker, where the AES key lives in the extension's own IndexedDB).
  useEffect(() => {
    void (async () => {
      const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as
        | (Partial<ReaderSettings> & { keysEnc?: EncryptedSecrets })
        | undefined;
      let keys: Record<string, string> = {};
      if (stored?.keysEnc) {
        try {
          keys = await decryptViaBackground(stored.keysEnc);
        } catch {
          /* vault unavailable / changed — start with no keys */
        }
      } else if (stored?.keys) {
        keys = stored.keys; // legacy plaintext — re-encrypted on next save
      }
      const { keysEnc: _enc, keys: _k, ...rest } = stored ?? {};
      void _enc;
      void _k;
      setSettings({ ...DEFAULT_SETTINGS, ...rest, keys });
    })();
  }, []);

  // Persist on change: encrypt the keys, never store them in plaintext.
  useEffect(() => {
    if (!settings) return;
    void (async () => {
      const { keys, engineBaseUrl: _url, ...rest } = settings;
      void _url;
      const toStore: Record<string, unknown> = { ...rest };
      delete toStore.keys;
      delete toStore.keysEnc;
      if (keys && Object.keys(keys).length > 0) {
        try {
          toStore.keysEnc = await encryptViaBackground(keys);
        } catch {
          /* if encryption fails, skip persisting keys rather than store plaintext */
        }
      }
      await chrome.storage.local.set({ [STORAGE_KEY]: toStore });
    })();
  }, [settings]);

  // Extract the article text once.
  useEffect(() => {
    const { title, text } = extractReadableText(document);
    if (text.trim().length > 0) extractedRef.current = { title, text };
  }, []);

  // (Re)build the engine whenever settings change so new keys / a connected
  // server take effect immediately.
  useEffect(() => {
    if (!settings || !extractedRef.current) return;
    const { title, text } = extractedRef.current;
    const source = segmentBook({ id: `page-${location.href}`, title }, [{ title, text }], { wordsPerPage: 220 });
    setError("");
    setResults(new Map());
    const { llm, image, tier } = buildProviders(settings, { fetch: proxyFetch, onLocalStatus: setStatus });
    const engine = new Engine({
      llm,
      image,
      tier,
      store: createCacheStore(),
      onUpdate: (idx, result) => setResults((prev) => new Map(prev).set(idx, result)),
    });
    engineRef.current = engine;
    let cancelled = false;
    void engine
      .openBook(source)
      .then(() => {
        if (cancelled) return;
        setBible(engine.getBible());
        setBook(source);
        engine.setIdleAllowed(true);
        engine.goToPage(0);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [settings]);

  // Scroll-sync: map host-page scroll to a page index AND a continuous in-page
  // progress (drives the bloom — fast scrolling keeps progress low → image hidden).
  useEffect(() => {
    if (!book) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const frac = max > 0 ? window.scrollY / max : 0;
        const scaled = frac * (book.pages.length - 1);
        const idx = Math.min(Math.floor(scaled), book.pages.length - 1);
        // Fraction within the current page; the last page tracks to full at the bottom.
        const within = idx >= book.pages.length - 1 ? 1 : Math.max(0, Math.min(1, scaled - idx));
        setPageIndex((p) => (p !== idx ? idx : p));
        setSubPageProgress(within);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [book]);

  // Steer the predictive buffer to the active page.
  useEffect(() => {
    engineRef.current?.goToPage(pageIndex);
  }, [pageIndex]);

  // Connect to a self-hosted engine (AUTOMATIC1111 / ComfyUI) and load its models.
  const onConnectLocalServer = useCallback(async (backend: LocalBackendId, url: string) => {
    setError("");
    setConnectingLocal(true);
    try {
      const transport = new DirectTransport(proxyFetch);
      const engine =
        backend === "a1111"
          ? new Automatic1111Backend({ baseUrl: url, transport })
          : new ComfyUIBackend({ baseUrl: url, transport });
      const models = await engine.listModels();
      setInstalledModels(models);
      setSettings((s) => {
        if (!s) return s;
        const keep = s.localModel && models.some((m) => m.id === s.localModel);
        const localModel = keep ? s.localModel : models[0]?.id;
        return { ...s, localBackend: backend, localServerUrl: url, ...(localModel ? { localModel } : {}) };
      });
    } catch (err) {
      const name = backend === "a1111" ? "AUTOMATIC1111" : "ComfyUI";
      setError(`Couldn't reach ${name} at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnectingLocal(false);
    }
  }, []);

  if (!visible || !settings) return null;

  const page = book?.pages[pageIndex];
  const spoilerIds = bible && page ? resolvePageEntities(bible, page).spoilerIds : [];
  const paraCount = page?.paragraphs.length ?? 1;
  const hasSpoiler = spoilerIds.length > 0;
  // Reveal follows the reader's scroll through the article (fast scroll → hidden),
  // holding any depicted spoiler until they reach its paragraph.
  const bloom = page
    ? computeBloomTarget(
        subPageProgress,
        spoilerRevealPoint(
          latestSpoilerParagraphIndex(page, spoilerIds, bible?.spoilers ?? []),
          hasSpoiler,
          paraCount,
        ),
        hasSpoiler,
      )
    : 0;

  return (
    <div style={panel}>
      <style>{KEYFRAMES}</style>
      <div style={bar}>
        <strong>Visual Reader</strong>
        <button style={btn} onClick={() => setVisible(false)}>
          ✕
        </button>
      </div>
      {error && <div style={errorBox}>{error}</div>}
      {status && <div style={{ opacity: 0.7, fontSize: 12, marginBottom: 8 }}>{status}</div>}
      <ImagePanel result={results.get(pageIndex)} bloom={bloom} pageKey={pageIndex} />
      <div style={nav}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {book ? `Page ${pageIndex + 1} / ${book.pages.length}` : "…"}
        </span>
      </div>
      <SettingsPanel
        value={settings}
        onChange={setSettings}
        installedModels={installedModels}
        onConnectLocalServer={onConnectLocalServer}
        connectingLocal={connectingLocal}
      />
    </div>
  );
}

const KEYFRAMES = `@keyframes vr-pulse { 0%,100% { opacity: 0.55 } 50% { opacity: 0.9 } }`;

const panel: React.CSSProperties = {
  position: "fixed",
  top: 16,
  right: 16,
  width: 320,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
  zIndex: 2147483647,
  padding: 12,
  borderRadius: 12,
  background: "rgba(17,19,26,0.96)",
  color: "#e7e7ee",
  boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
  fontFamily: "system-ui, sans-serif",
};
const bar: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 8,
};
const nav: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  margin: "8px 0",
};
const errorBox: React.CSSProperties = {
  background: "rgba(255,90,90,0.15)",
  border: "1px solid rgba(255,90,90,0.4)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 12,
  marginBottom: 8,
};
const btn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "inherit",
  borderRadius: 6,
  padding: "3px 8px",
  cursor: "pointer",
  fontSize: 12,
};

function mount() {
  const host = document.createElement("div");
  host.id = "visual-reader-root";
  document.body.appendChild(host);
  createRoot(host).render(
    <StrictMode>
      <Overlay />
    </StrictMode>,
  );
}

mount();
