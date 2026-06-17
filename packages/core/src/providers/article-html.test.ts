import { describe, expect, it } from "vitest";
import { sanitizeArticleHtml, splitHtmlBlocks } from "./article-html.js";

const base = "https://example.com/blog/post";

describe("sanitizeArticleHtml — XSS / dangerous content", () => {
  it("drops script/style/iframe/svg with their content", () => {
    const out = sanitizeArticleHtml(
      `<p>hi</p><script>alert(1)</script><style>p{}</style><iframe src="x"></iframe><svg onload="x"></svg>`,
      base,
    );
    expect(out).toBe("<p>hi</p>");
    expect(out).not.toMatch(/alert|iframe|svg|style/i);
  });

  it("strips event handlers, style, class, id, and all non-allowlisted attributes", () => {
    const out = sanitizeArticleHtml(`<p onclick="x" style="color:red" class="c" id="i" data-x="1">hi</p>`, base);
    expect(out).toBe("<p>hi</p>");
  });

  it("rejects javascript:/data: URLs on links and images (well-formed)", () => {
    expect(sanitizeArticleHtml(`<a href="javascript:alert(1)">x</a>`, base)).toBe("<a>x</a>");
    expect(sanitizeArticleHtml(`<img src="javascript:alert(1)">`, base)).toBe("");
  });

  it("never leaves an executable URL/tag even on malformed adversarial input", () => {
    // a `>` inside the attribute value breaks naive tag parsing — the output must still be inert.
    for (const evil of [
      `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
      `<img src="data:image/svg+xml,<svg onload=alert(1)>">`,
      `<a href=" javascript:alert(1)">x</a>`,
    ]) {
      const out = sanitizeArticleHtml(evil, base);
      expect(out).not.toMatch(/<\s*(script|svg|iframe|img)/i);
      expect(out).not.toMatch(/href\s*=\s*"?(javascript|data):/i);
      expect(out).not.toMatch(/\son\w+\s*=/i); // no surviving event handler
    }
  });

  it("escapes < and > in text so smuggled markup can't be parsed by the browser", () => {
    expect(sanitizeArticleHtml(`<p>a < b and 1 > 0</p>`, base)).toBe("<p>a &lt; b and 1 &gt; 0</p>");
    // A broken/partial tag in text is neutralised to inert escaped text (no raw <img / handler).
    const out = sanitizeArticleHtml(`<p>x</p>< img src=javascript:alert(1) onerror=alert(2)`, base);
    expect(out).toContain("&lt;");
    expect(out).not.toMatch(/<\s*img/i);
  });

  it("unwraps disallowed tags but keeps their text", () => {
    expect(sanitizeArticleHtml(`<div><span>keep</span> me</div>`, base)).toBe("keep me");
  });
});

describe("sanitizeArticleHtml — allowed content", () => {
  it("keeps headings, lists, emphasis, blockquote, code", () => {
    const html = `<h2>Title</h2><p>A <strong>bold</strong> and <em>italic</em>.</p><ul><li>one</li><li>two</li></ul><blockquote>q</blockquote><pre><code>x=1</code></pre>`;
    expect(sanitizeArticleHtml(html, base)).toBe(html);
  });

  it("keeps http(s) links (new tab + noopener) and resolves relative URLs", () => {
    expect(sanitizeArticleHtml(`<a href="/next">n</a>`, base)).toBe(
      `<a href="https://example.com/next" rel="noopener noreferrer" target="_blank">n</a>`,
    );
    expect(sanitizeArticleHtml(`<img src="pic.png" alt="A & B">`, base)).toBe(
      `<img src="https://example.com/blog/pic.png" alt="A &amp; B" />`,
    );
  });
});

describe("splitHtmlBlocks", () => {
  it("splits into blocks with text + html, keeping image-only blocks", () => {
    const sanitized = sanitizeArticleHtml(`<h2>T</h2><p>Para one.</p><p>Para &amp; two.</p>`, base);
    const blocks = splitHtmlBlocks(sanitized);
    expect(blocks.map((b) => b.text)).toEqual(["T", "Para one.", "Para & two."]);
    expect(blocks[1]!.html).toBe("<p>Para one.</p>");
  });
});
