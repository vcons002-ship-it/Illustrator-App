import { DirectTransport, type Transport } from "./transport/transport.js";
import { base64ToBytes } from "./image/base64.js";

/**
 * Fetch a URL's readable text so the buddy can open web articles/books as a
 * `BookSource` (via epub's `bookFromText`) or read a page into the chat. Paths:
 *  - Wikipedia article URLs go through the Action API's plaintext extracts
 *    (CORS-open via `origin=*`, and far cleaner than stripping the page HTML).
 *  - GitHub repo / file URLs go through GitHub's keyless, CORS-open API
 *    (raw.githubusercontent for files; the readme + contents endpoints for a
 *    repo root) — the heavy github.com SPA strips to mush otherwise.
 *  - Everything else is fetched directly; HTML responses get a tag-strip good
 *    enough for article prose. CORS-blocked origins surface as a fetch error the
 *    chat reports ("ask the reader to paste/upload instead") — by design there is
 *    no scraping proxy (see free-search.ts for the rationale).
 */

export interface PageText {
  title?: string;
  text: string;
}

/** Upper bound on fetched text — keeps a mis-aimed URL from ballooning the worker. */
export const MAX_PAGE_TEXT_CHARS = 1_500_000;

/** Same sanctioned UA header the Wikimedia search clients send (free-search.ts). */
const API_USER_AGENT = "VisualReader/1.0 (https://github.com/vcons002-ship-it/illustrator-app)";

const WIKIPEDIA_ARTICLE = /^https?:\/\/([a-z][a-z-]*)(?:\.m)?\.wikipedia\.org\/wiki\/([^#?]+)/i;
/** A GitHub repo ROOT: github.com/owner/repo (optionally .git / trailing slash). */
const GITHUB_REPO = /^https?:\/\/github\.com\/([^/\s#?]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i;
/** A GitHub file view: github.com/owner/repo/blob/ref/path. */
const GITHUB_BLOB = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+?)(?:[#?].*)?$/i;

interface WikiExtractResponse {
  query?: { pages?: Record<string, { title?: string; extract?: string }> };
}

interface GitHubReadme {
  content?: string;
  encoding?: string;
}
interface GitHubContentItem {
  name?: string;
  type?: string;
}

/** A repo root → its README + top-level file list; a blob URL → that file's raw text. */
async function fetchGitHub(
  url: string,
  transport: Transport,
  maxChars: number,
  signal: { signal?: AbortSignal },
): Promise<PageText | undefined> {
  const blob = GITHUB_BLOB.exec(url);
  if (blob) {
    const [, owner, repo, ref, path] = blob;
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
    const res = await transport.send({ url: raw, method: "GET", ...signal });
    if (!res.ok) throw new Error(`GitHub file fetch failed with status ${res.status}`);
    return { title: `${owner}/${repo} · ${path}`, text: (await res.text()).slice(0, maxChars) };
  }
  const root = GITHUB_REPO.exec(url);
  if (!root) return undefined;
  const [, owner, repo] = root;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  let readme = "";
  try {
    const r = await transport.send({ url: `${api}/readme`, method: "GET", ...signal });
    if (r.ok) {
      const data = await r.json<GitHubReadme>();
      if (data.content && data.encoding === "base64") {
        readme = new TextDecoder().decode(base64ToBytes(data.content.replace(/\s/g, "")));
      }
    }
  } catch {
    /* no README, or rate-limited — fall through to the file list */
  }
  let files = "";
  try {
    const c = await transport.send({ url: `${api}/contents`, method: "GET", ...signal });
    if (c.ok) {
      const items = await c.json<GitHubContentItem[]>();
      files = (Array.isArray(items) ? items : [])
        .filter((i) => i.name)
        .map((i) => `${i.type === "dir" ? "[dir] " : ""}${i.name}`)
        .join("\n");
    }
  } catch {
    /* ignore — README alone is still useful */
  }
  if (!readme && !files) {
    throw new Error(`Couldn't read the GitHub repo ${owner}/${repo} (private, missing, or rate-limited).`);
  }
  const text = [
    files ? `Repository ${owner}/${repo} — top-level files:\n${files}` : "",
    readme ? `README (${owner}/${repo}):\n${readme}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, maxChars);
  return { title: `${owner}/${repo}`, text };
}

export async function fetchPageText(
  url: string,
  opts: { transport?: Transport; maxChars?: number; signal?: AbortSignal } = {},
): Promise<PageText> {
  const transport = opts.transport ?? new DirectTransport();
  const maxChars = opts.maxChars ?? MAX_PAGE_TEXT_CHARS;
  const signal = opts.signal ? { signal: opts.signal } : {};

  const wiki = WIKIPEDIA_ARTICLE.exec(url);
  if (wiki) {
    const title = decodeURIComponent(wiki[2]!).replace(/_/g, " ");
    const api =
      `https://${wiki[1]}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1` +
      `&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`;
    const res = await transport.send({
      url: api,
      method: "GET",
      headers: { "Api-User-Agent": API_USER_AGENT },
      ...signal,
    });
    if (!res.ok) throw new Error(`Wikipedia fetch failed with status ${res.status}`);
    const data = await res.json<WikiExtractResponse>();
    const page = Object.values(data.query?.pages ?? {})[0];
    if (!page?.extract) throw new Error(`Wikipedia has no readable article at ${url}`);
    return { ...(page.title ? { title: page.title } : {}), text: page.extract.slice(0, maxChars) };
  }

  const github = await fetchGitHub(url, transport, maxChars, signal);
  if (github) return github;

  const res = await transport.send({ url, method: "GET", ...signal });
  if (!res.ok) throw new Error(`Fetching ${url} failed with status ${res.status}`);
  const raw = (await res.text()).slice(0, maxChars * 2); // pre-strip cap (HTML shrinks)
  if (!looksLikeHtml(raw)) return { text: raw.slice(0, maxChars) };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim();
  const text = htmlToText(raw).slice(0, maxChars);
  if (!text) throw new Error(`No readable text found at ${url}`);
  return { ...(title ? { title: decodeEntities(title) } : {}), text };
}

function looksLikeHtml(s: string): boolean {
  const head = s.slice(0, 1000).toLowerCase();
  return head.includes("<html") || head.includes("<!doctype html") || head.includes("<body");
}

/**
 * Regex tag-strip (workers have no DOMParser): drop non-content blocks, turn
 * block-element boundaries into newlines, strip remaining tags, decode the
 * common entities. Good enough for article prose — not a readability engine.
 */
function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|section|article|li|tr|blockquote|h[1-6])>/gi, "\n")
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A numeric character reference → its character, or "" if out of Unicode range
 * (String.fromCodePoint throws on > 0x10FFFF — hostile/garbled HTML must not crash
 * the whole page parse, and in KeylessSearch a throw latches DDG off for good). */
function codePoint(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
}

/** Decode the common HTML entities (shared by the HTML-ish parsers in providers/). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => codePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
