import { memo } from "react";
import { cx } from "./design/classes.js";

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
  return <div ref={innerRef} className={cx.articleHtml} dangerouslySetInnerHTML={{ __html: html }} />;
});
