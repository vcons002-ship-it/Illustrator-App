import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Engine,
  MockImageProvider,
  MockLLMProvider,
  resolvePageEntities,
  type BookSource,
  type ImageResult,
  type VisualBible,
} from "@visual-reader/core";
import { segmentBook } from "@visual-reader/epub";
import { ImagePanel } from "@visual-reader/ui";
import { extractReadableText } from "./extract.js";

/**
 * Content-script overlay. Extracts the page's readable text, runs it through the
 * SAME shared engine the web app uses, and floats an image panel beside the
 * article. v1 uses mock providers + manual page nav; wiring chrome.storage BYO
 * keys and scroll-sync are the documented next steps (the engine seam is ready).
 */
function Overlay() {
  const [visible, setVisible] = useState(true);
  const [book, setBook] = useState<BookSource | undefined>();
  const [bible, setBible] = useState<VisualBible | undefined>();
  const [results, setResults] = useState<Map<number, ImageResult>>(new Map());
  const [pageIndex, setPageIndex] = useState(0);
  const engineRef = useRef<Engine | undefined>(undefined);

  useEffect(() => {
    const onMessage = (msg: { type?: string }) => {
      if (msg?.type === "visual-reader/toggle") setVisible((v) => !v);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  useEffect(() => {
    const { title, text } = extractReadableText(document);
    if (text.trim().length === 0) return;
    const source = segmentBook(
      { id: `page-${location.href}`, title },
      [{ title, text }],
      { wordsPerPage: 220 },
    );
    const engine = new Engine({
      llm: new MockLLMProvider(),
      image: new MockImageProvider(),
      tier: { tier: "cloud", llmProvider: "mock", imageProvider: "mock", quality: "sketch" },
      onUpdate: (idx, result) => setResults((prev) => new Map(prev).set(idx, result)),
    });
    void engine.openBook(source).then(() => {
      engineRef.current = engine;
      setBible(engine.getBible());
      setBook(source);
      engine.goToPage(0);
    });
  }, []);

  if (!visible || !book) return null;

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(book.pages.length - 1, next));
    setPageIndex(clamped);
    engineRef.current?.goToPage(clamped);
  };

  const page = book.pages[pageIndex];
  const spoilerIds = bible && page ? resolvePageEntities(bible, page).spoilerIds : [];

  return (
    <div style={panel}>
      <div style={bar}>
        <strong>Visual Reader</strong>
        <button style={btn} onClick={() => setVisible(false)}>
          ✕
        </button>
      </div>
      <ImagePanel
        result={results.get(pageIndex)}
        imageSpoilerIds={spoilerIds}
        spoilers={bible?.spoilers ?? []}
        passedParagraphIds={new Set(page?.paragraphs.map((p) => p.id) ?? [])}
        bloom={1}
      />
      <div style={nav}>
        <button style={btn} onClick={() => go(pageIndex - 1)}>
          ‹ Prev
        </button>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {pageIndex + 1} / {book.pages.length}
        </span>
        <button style={btn} onClick={() => go(pageIndex + 1)}>
          Next ›
        </button>
      </div>
    </div>
  );
}

const panel: React.CSSProperties = {
  position: "fixed",
  top: 16,
  right: 16,
  width: 300,
  zIndex: 2147483647,
  padding: 12,
  borderRadius: 12,
  background: "rgba(17,19,26,0.95)",
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
  marginTop: 8,
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
