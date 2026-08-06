import { t } from "./design/tokens.js";
import { memo } from "react";

/**
 * Render one paragraph/block of a web article in its **original layout** (headings, lists, images,
 * links, emphasis). The `html` is ALREADY sanitized in core (`sanitizeArticleHtml`) — it contains
 * only an allowlist of tags with safe, escaped attributes — so `dangerouslySetInnerHTML` is safe
 * here. The block keeps the paragraph ref so scroll/bloom tracking and figure anchoring still work.
 */
export const HtmlParagraph = memo(function HtmlParagraph({
  html,
  innerRef,
}: {
  html: string;
  innerRef?: (el: HTMLElement | null) => void;
}) {
  return <div ref={innerRef} className="vr-article-html" dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * Styling for the article-layout blocks, matched to the reader. Render ONCE in a `<style>` while the
 * layout view is on (the inline styles on a container don't cascade to `dangerouslySetInnerHTML`
 * children).
 */
export const ARTICLE_HTML_STYLE = `
.vr-article-html { margin: 0 0 1em; line-height: 1.7; }
.vr-article-html h1, .vr-article-html h2, .vr-article-html h3,
.vr-article-html h4, .vr-article-html h5, .vr-article-html h6 {
  line-height: 1.3; margin: 1.2em 0 0.4em; font-weight: 600; font-family: system-ui, sans-serif;
}
.vr-article-html h1 { font-size: 1.5em; } .vr-article-html h2 { font-size: 1.3em; }
.vr-article-html h3 { font-size: 1.15em; }
.vr-article-html p { margin: 0 0 0.9em; }
.vr-article-html a { color: t.accent.text; text-decoration: underline; }
.vr-article-html img { max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 0.6em 0; }
.vr-article-html ul, .vr-article-html ol { margin: 0 0 0.9em 1.2em; padding: 0; }
.vr-article-html li { margin: 0.2em 0; }
.vr-article-html blockquote {
  margin: 0.8em 0; padding: 0.2em 0 0.2em 0.9em; border-left: 3px solid ${t.fill.strong}; opacity: 0.85;
}
.vr-article-html pre {
  background: t.fill.subtle; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 0.9em;
}
.vr-article-html code { font-family: ui-monospace, monospace; font-size: 0.92em; }
.vr-article-html figure { margin: 0.8em 0; }
.vr-article-html figcaption { font-size: 0.85em; opacity: 0.6; margin-top: 0.3em; }
.vr-article-html hr { border: none; border-top: 1px solid ${t.border.subtle}; margin: 1.2em 0; }
`;
