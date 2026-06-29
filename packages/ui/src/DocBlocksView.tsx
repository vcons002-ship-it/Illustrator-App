import { memo, type CSSProperties, type ReactNode } from "react";
import { markdownToBlocks, type DocBlock, type DocInline } from "@visual-reader/core";

/**
 * Render a Markdown document in its ACTUAL formatting (headings, bold / italic / code, bullet +
 * numbered lists, code blocks, rules) as plain React elements — no `dangerouslySetInnerHTML`, no
 * markdown library. Shares the {@link markdownToBlocks} model with the PDF/Word exporters, so the
 * on-screen document matches the file the reader downloads. Used full-screen in the reader's
 * "document" view AND inline in the chat (so a document can be read without leaving the conversation).
 */

function runs(parts: DocInline[]): ReactNode {
  return parts.map((r, i) => {
    let node: ReactNode = r.text;
    if (r.code) node = <code style={CODE_INLINE} key={i}>{r.text}</code>;
    if (r.bold) node = <strong key={i}>{node}</strong>;
    if (r.italic) node = <em key={i}>{node}</em>;
    return typeof node === "string" ? <span key={i}>{node}</span> : node;
  });
}

function Block({ block }: { block: DocBlock }): ReactNode {
  switch (block.type) {
    case "heading": {
      const style = block.level === 1 ? H1 : block.level === 2 ? H2 : H3;
      const Tag = (`h${block.level}` as "h1" | "h2" | "h3");
      return <Tag style={style}>{runs(block.runs)}</Tag>;
    }
    case "paragraph":
      return <p style={P}>{runs(block.runs)}</p>;
    case "list":
      return block.ordered ? (
        <ol style={LIST}>{block.items.map((it, i) => <li key={i} style={LI}>{runs(it)}</li>)}</ol>
      ) : (
        <ul style={LIST}>{block.items.map((it, i) => <li key={i} style={LI}>{runs(it)}</li>)}</ul>
      );
    case "code":
      return <pre style={PRE}><code>{block.text}</code></pre>;
    case "rule":
      return <hr style={HR} />;
  }
}

export const DocBlocksView = memo(function DocBlocksView({
  markdown,
  blocks,
  style,
}: {
  /** Markdown source (parsed with the shared model). Provide this OR `blocks`. */
  markdown?: string;
  /** Pre-parsed blocks (when the caller already has them). */
  blocks?: DocBlock[];
  style?: CSSProperties | undefined;
}) {
  const parsed = blocks ?? markdownToBlocks(markdown ?? "");
  return (
    <div style={{ ...DOC, ...style }}>
      {parsed.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
});

const DOC: CSSProperties = {
  fontFamily: "Georgia, 'Iowan Old Style', serif",
  fontSize: 17,
  lineHeight: 1.65,
  color: "inherit",
  wordBreak: "break-word",
};
const H1: CSSProperties = { fontFamily: "system-ui, sans-serif", fontSize: "1.7em", fontWeight: 700, lineHeight: 1.25, margin: "0.2em 0 0.5em" };
const H2: CSSProperties = { fontFamily: "system-ui, sans-serif", fontSize: "1.35em", fontWeight: 700, lineHeight: 1.3, margin: "1.1em 0 0.4em" };
const H3: CSSProperties = { fontFamily: "system-ui, sans-serif", fontSize: "1.15em", fontWeight: 600, lineHeight: 1.3, margin: "1em 0 0.35em" };
const P: CSSProperties = { margin: "0 0 0.9em" };
const LIST: CSSProperties = { margin: "0 0 0.9em 1.4em", padding: 0 };
const LI: CSSProperties = { margin: "0.25em 0" };
const PRE: CSSProperties = {
  background: "rgba(255,255,255,0.05)",
  padding: "10px 12px",
  borderRadius: 6,
  overflowX: "auto",
  fontSize: "0.86em",
  fontFamily: "ui-monospace, monospace",
  lineHeight: 1.5,
  margin: "0 0 0.9em",
};
const CODE_INLINE: CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: "0.9em",
  background: "rgba(255,255,255,0.08)",
  padding: "1px 4px",
  borderRadius: 4,
};
const HR: CSSProperties = { border: "none", borderTop: "1px solid rgba(255,255,255,0.15)", margin: "1.3em 0" };
