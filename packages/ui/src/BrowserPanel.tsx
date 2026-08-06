import { t } from "./design/tokens.js";
import { memo, useState } from "react";
import type { PageText } from "@visual-reader/core";

/**
 * An in-app **browser** (desktop): enter a URL and the host fetches its *readable text +
 * on-page links* over the CORS-exempt transport (no third-party JS runs in-process — safer
 * than a live webview). Click a link to navigate; hand the page to the reader's illustration
 * pipeline ("Read & illustrate") or to the chat buddy ("Ask about this page"). Pure
 * presentation — all fetching/navigation lives in the host (App).
 */
export interface BrowserPanelProps {
  url: string;
  page: PageText | null;
  loading?: boolean;
  /** Whether there's a previous page to go back to. */
  canBack?: boolean;
  error?: string | null;
  onUrl: (url: string) => void;
  onBack: () => void;
  onClickLink: (url: string) => void;
  onReadIllustrate: (url: string) => void;
  onAskBuddy: (question: string) => void;
  /** Open the live page in its own desktop window (when supported); omitted on web. */
  onOpenLive?: (url: string) => void;
  onClose: () => void;
}

export const BrowserPanel = memo(function BrowserPanel({
  url,
  page,
  loading,
  canBack,
  error,
  onUrl,
  onBack,
  onClickLink,
  onReadIllustrate,
  onAskBuddy,
  onOpenLive,
  onClose,
}: BrowserPanelProps) {
  const [draft, setDraft] = useState(url);
  const [question, setQuestion] = useState("");

  const go = () => {
    const u = normalizeUrl(draft);
    if (u) onUrl(u);
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 15 }}>🌐 Browse</strong>
          <button style={btn} onClick={onBack} disabled={!canBack} title="Back">
            ◀
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            placeholder="https://example.com/article"
            style={addressBar}
          />
          <button style={btn} onClick={go}>
            Go
          </button>
          {onOpenLive ? (
            <button style={btn} onClick={() => onOpenLive(url)} disabled={!url} title="Open the live page (with scripts) in its own window">
              🖥 Live
            </button>
          ) : null}
          <button style={{ ...btn, marginLeft: "auto" }} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <button style={accentBtn} onClick={() => onReadIllustrate(url)} disabled={!page} title="Open this page in the reader and illustrate it">
            📖 Read &amp; illustrate
          </button>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && page && onAskBuddy(question)}
            placeholder="Ask the buddy about this page…"
            style={{ ...addressBar, flex: "1 1 220px", textTransform: "none" }}
          />
          <button style={btn} onClick={() => onAskBuddy(question)} disabled={!page} title="Hand this page to the chat assistant">
            🤖 Ask
          </button>
        </div>

        <div style={body}>
          {loading ? (
            <div style={{ opacity: 0.6, padding: 12 }}>Loading {url}…</div>
          ) : error ? (
            <div style={{ color: t.state.danger, padding: 12 }}>
              ⚠ {error}
              <div style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>
                Most sites only load in the desktop app (a browser tab can't bypass cross-origin rules).
              </div>
            </div>
          ) : page ? (
            <div style={{ display: "flex", gap: 14, height: "100%", minHeight: 0 }}>
              <article style={articleCol}>
                {page.title ? <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>{page.title}</h2> : null}
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.6 }}>{page.text}</div>
              </article>
              {page.links && page.links.length > 0 ? (
                <nav style={linksCol}>
                  <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, marginBottom: 6 }}>
                    Links on this page ({page.links.length})
                  </div>
                  {page.links.map((l) => (
                    <button key={l.url} style={linkBtn} onClick={() => onClickLink(l.url)} title={l.url}>
                      {l.text}
                    </button>
                  ))}
                </nav>
              ) : null}
            </div>
          ) : (
            <div style={{ opacity: 0.55, padding: 12 }}>Enter a URL above to read it here.</div>
          )}
        </div>

        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 6 }}>
          Readable text + links only (no scripts run). Best in the desktop app.
        </div>
      </div>
    </div>
  );
});

/** Add https:// when the user types a bare host, and reject obvious non-URLs. */
function normalizeUrl(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return undefined;
  }
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: t.surface.overlay,
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};
const panel: React.CSSProperties = {
  width: "min(1040px, 100%)",
  height: "min(88vh, 760px)",
  display: "flex",
  flexDirection: "column",
  background: t.surface.card,
  color: t.text.base,
  border: `1px solid ${t.border.subtle}`,
  borderRadius: 12,
  padding: 18,
  fontFamily: "system-ui, sans-serif",
};
const body: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  borderRadius: 8,
  overflow: "hidden",
  background: t.surface.sunken,
  border: `1px solid ${t.border.faint}`,
};
const articleCol: React.CSSProperties = { flex: 1, minWidth: 0, overflowY: "auto", padding: 14 };
const linksCol: React.CSSProperties = {
  width: 240,
  flexShrink: 0,
  overflowY: "auto",
  padding: 12,
  borderLeft: `1px solid ${t.border.faint}`,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const addressBar: React.CSSProperties = {
  flex: "1 1 320px",
  background: t.surface.sunken,
  color: t.text.base,
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "5px 9px",
  fontSize: 13,
};
const btn: React.CSSProperties = {
  background: t.fill.base,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const accentBtn: React.CSSProperties = {
  ...btn,
  borderColor: t.state.good,
  color: t.state.good,
};
const linkBtn: React.CSSProperties = {
  background: "transparent",
  color: t.accent.text,
  border: "none",
  borderRadius: 4,
  padding: "3px 4px",
  fontSize: 12,
  textAlign: "left",
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
