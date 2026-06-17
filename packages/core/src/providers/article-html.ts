/**
 * Sanitize remote ARTICLE HTML for the optional "original layout" reader view, and split it into
 * paragraph-sized blocks. There is no DOMParser in the worker, so this is a strict **string
 * allowlist**, designed so the output is safe to render with `dangerouslySetInnerHTML`:
 *
 *  - the output contains ONLY allow-listed tags;
 *  - each kept tag is rebuilt with a FIXED set of safe, escaped attributes that WE construct —
 *    the original attribute string is never passed through (so no `onerror`, `style`, etc. survive);
 *  - every run of text between tags has its `<`/`>` escaped, so the browser can only ever parse the
 *    tags we deliberately emit — never a stray tag smuggled in as "text".
 *
 * `<script>/<style>/<iframe>/<svg>…` are dropped with their contents; `javascript:`/`data:` URLs are
 * rejected; links/images are http(s)-only with relative URLs resolved against the page.
 */

const ALLOWED_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i",
  "a", "img", "ul", "ol", "li", "blockquote", "code", "pre", "br", "figure", "figcaption", "hr",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
/** Elements dropped WITH their content so their inner text doesn't leak as visible text. */
const DROP_WITH_CONTENT =
  /<(script|style|noscript|iframe|object|embed|svg|head|nav|footer|aside|form|button|select|textarea|template)\b[\s\S]*?<\/\1\s*>/gi;

/** A sanitized, render-safe version of `html` (relative URLs resolved against `baseUrl`). */
export function sanitizeArticleHtml(html: string, baseUrl: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP_WITH_CONTENT, "");
  s = s.replace(DROP_WITH_CONTENT, ""); // a second pass clears simple same-tag nesting
  const out: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s)) !== null) {
    out.push(escapeText(s.slice(last, m.index)));
    last = tagRe.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    const attrs = m[3] ?? "";
    if (!ALLOWED_TAGS.has(tag)) continue; // unwrap: drop the tag, keep its (escaped) inner text
    if (closing) {
      if (!VOID_TAGS.has(tag)) out.push(`</${tag}>`);
      continue;
    }
    if (tag === "a") {
      const href = safeUrl(attrValue(attrs, "href"), baseUrl);
      out.push(href ? `<a href="${escapeAttr(href)}" rel="noopener noreferrer" target="_blank">` : "<a>");
    } else if (tag === "img") {
      const src = safeUrl(attrValue(attrs, "src"), baseUrl);
      if (src) out.push(`<img src="${escapeAttr(src)}" alt="${escapeAttr(attrValue(attrs, "alt") ?? "")}" />`);
      // no safe src → drop the image entirely
    } else {
      out.push(VOID_TAGS.has(tag) ? `<${tag} />` : `<${tag}>`);
    }
  }
  out.push(escapeText(s.slice(last)));
  return out.join("").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split sanitized article HTML into paragraph-sized blocks, each carrying its HTML (for the layout
 * view) + its plain text (for analysis + figure anchoring). Splits after block-closing tags.
 */
export function splitHtmlBlocks(sanitized: string): { text: string; html: string }[] {
  const parts = sanitized.split(/(?<=<\/(?:p|h[1-6]|ul|ol|blockquote|figure|pre)>)|(?<=<hr \/>)/i);
  const out: { text: string; html: string }[] = [];
  for (const part of parts) {
    const h = part.trim();
    if (!h) continue;
    const t = blockText(h);
    if (t || /<img\b/i.test(h)) out.push({ text: t, html: h });
  }
  return out;
}

/** Tag-stripped, entity-decoded plain text of one block (for the bible/analysis + anchoring). */
function blockText(html: string): string {
  return decodeBasic(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

/** An http(s) URL (relative resolved against the page), or undefined for unsafe/other schemes. */
function safeUrl(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) return undefined;
  const t = decodeBasic(url).trim();
  // A real URL is percent-encoded — raw <, >, quotes or whitespace mean a malformed/adversarial
  // attribute (e.g. a `>` inside the value broke tag parsing). Reject rather than guess.
  if (!t || /[<>"'`\s]/.test(t)) return undefined;
  if (/^(javascript|data|vbscript|file):/i.test(t)) return undefined;
  try {
    const abs = new URL(t, baseUrl);
    return abs.protocol === "http:" || abs.protocol === "https:" ? abs.toString() : undefined;
  } catch {
    return undefined;
  }
}

function escapeText(t: string): string {
  return t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function decodeBasic(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => cp(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => cp(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
function cp(n: number): string {
  return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}
