import { memo, type CSSProperties, type ReactNode } from "react";
import { segmentByTerms, subjectFromCaption } from "@visual-reader/core";
import { useObjectUrl, type DisplayResult } from "./imageObjectUrl.js";

/**
 * Technical-mode reading support, rendered INLINE in the text column so it
 * scrolls with the paragraph it belongs to (no sticky pane, no blur — a
 * technical book is reference material, not a story to avoid spoiling):
 *
 * - `ConceptText` highlights the bible's key concepts inside a paragraph, with
 *   the plain-language explanation as a hover tooltip.
 * - `ConceptCard` introduces a concept the first time it appears in the book.
 * - `InlineFigure` shows the unit's RETRIEVED real figure (never generated art)
 *   under its source paragraph, with attribution; when no verified figure was
 *   found it renders the skip note as a quiet line instead.
 */

/** Paragraph text with the bible's concepts highlighted (tooltip = definition). */
export const ConceptText = memo(function ConceptText({
  text,
  terms,
  definitions,
}: {
  text: string;
  terms: readonly string[];
  /** Lower-cased term → plain-language definition (for the hover tooltip). */
  definitions: ReadonlyMap<string, string>;
}) {
  const segments = segmentByTerms(text, terms);
  if (segments.length === 1 && !segments[0]!.term) return <>{text}</>;
  return (
    <>
      {segments.map((s, i) =>
        s.term ? (
          <mark key={i} style={markStyle} title={lookupDefinition(definitions, s.term)}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
});

/** Tolerate the plural-s the matcher allows ("chains" → "chain"). */
function lookupDefinition(definitions: ReadonlyMap<string, string>, matched: string): string {
  const lower = matched.toLowerCase();
  return definitions.get(lower) ?? definitions.get(lower.replace(/s$/, "")) ?? "";
}

/** First-appearance card for a key concept: term + plain-language explanation. */
export function ConceptCard({ term, definition }: { term: string; definition: string }) {
  return (
    <div style={conceptCardStyle}>
      <span style={conceptTermStyle}>💡 {term}</span>
      <span style={conceptDefStyle}>{definition}</span>
    </div>
  );
}

/**
 * A unit's retrieved figure (or its "no verified figure" note), anchored under
 * the paragraph it illustrates. Renders nothing while the unit is still queued
 * or rendering — support appears when it's real, without placeholder churn.
 */
export function InlineFigure({ result }: { result: DisplayResult }) {
  const url = useObjectUrl(result);
  const src = url ?? result.sourceUrl;
  if (result.status === "skipped") {
    return result.prompt ? <div style={skipNoteStyle}>{result.prompt}</div> : null;
  }
  if (result.status !== "ready" || !src) return null;
  const caption = result.prompt ?? "";
  const subject = subjectFromCaption(caption);
  const source = /Source: (?:(.+) — )?(\S+)$/.exec(caption);
  return (
    <figure style={figureStyle}>
      <img
        src={src}
        alt={subject ? `Figure: ${subject}` : "Retrieved figure"}
        decoding="async"
        loading="lazy"
        style={figureImgStyle}
      />
      <figcaption style={figureCaptionStyle}>
        {subject ? `Figure: ${subject}` : "Retrieved figure"}
        {source?.[2] && (
          <>
            {" · "}
            <a href={source[2]} target="_blank" rel="noreferrer" style={sourceLinkStyle}>
              {source[1] ?? "source"}
            </a>
          </>
        )}
      </figcaption>
    </figure>
  );
}

/** Stack of support cards under one paragraph (keeps the column markup tidy). */
export function SupportRow({ children }: { children: ReactNode }) {
  return <div style={supportRowStyle}>{children}</div>;
}

const markStyle: CSSProperties = {
  background: "rgba(120, 170, 255, 0.16)",
  color: "inherit",
  borderBottom: "1px dotted rgba(120, 170, 255, 0.7)",
  borderRadius: 2,
  padding: "0 1px",
  cursor: "help",
};

const supportRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  margin: "10px 0 14px",
};

const conceptCardStyle: CSSProperties = {
  borderLeft: "3px solid rgba(120, 170, 255, 0.8)",
  background: "rgba(120, 170, 255, 0.08)",
  borderRadius: "0 8px 8px 0",
  padding: "8px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const conceptTermStyle: CSSProperties = { fontWeight: 600, fontSize: 14 };

const conceptDefStyle: CSSProperties = { fontSize: 13.5, opacity: 0.85, lineHeight: 1.45 };

const figureStyle: CSSProperties = {
  margin: 0,
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: 8,
  background: "rgba(255,255,255,0.03)",
};

const figureImgStyle: CSSProperties = {
  display: "block",
  width: "100%",
  height: "auto",
  maxHeight: 420,
  objectFit: "contain",
  borderRadius: 6,
  background: "rgba(255,255,255,0.04)",
};

const figureCaptionStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.75,
  paddingTop: 6,
  textAlign: "center",
};

const sourceLinkStyle: CSSProperties = { color: "#9cc2ff" };

const skipNoteStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.55,
  fontStyle: "italic",
  padding: "2px 0",
};
