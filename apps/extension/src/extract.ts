/**
 * Lightweight readable-text extraction for the content script. Picks the
 * densest text container on the page (a Readability-style heuristic) and pulls
 * its paragraphs. v1 targets generic articles / web-EPUB readers; a fuller
 * Readability port is a later enhancement.
 */
export function extractReadableText(doc: Document): { title: string; text: string } {
  const candidates = Array.from(doc.querySelectorAll("article, main, [role='main'], body"));
  let best: { el: Element; score: number } | undefined;
  for (const el of candidates) {
    const paras = el.querySelectorAll("p");
    const score = Array.from(paras).reduce((sum, p) => sum + (p.textContent?.length ?? 0), 0);
    if (!best || score > best.score) best = { el, score };
  }
  const root = best?.el ?? doc.body;
  const text = Array.from(root.querySelectorAll("p"))
    .map((p) => p.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter((t) => t.length > 0)
    .join("\n\n");
  return { title: doc.title || "This page", text };
}
