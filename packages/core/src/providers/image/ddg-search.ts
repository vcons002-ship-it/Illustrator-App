import { DirectTransport, type Transport } from "../transport/transport.js";
import { decodeEntities } from "../page-text.js";
import { WikiSearch } from "./free-search.js";
import type {
  FigureSearch,
  ImageSearchHit,
  RetrievedImage,
  WebSearchHit,
} from "./image-search.js";

/**
 * Keyless FULL-WEB search via DuckDuckGo's Lite endpoint — the "non-Wikipedia"
 * questions WikiSearch can't answer (news, products, niche sites). This is HTML
 * parsing of a results page, which free-search.ts deliberately avoided as a
 * default; it exists now as an OPT-LESS upgrade with a hard fallback:
 *
 *  - It only ever runs where the transport is CORS-exempt (the extension's
 *    background proxy, a Rust shell, tests). In the plain web app the first
 *    attempt fails CORS, the failure is remembered for the session, and every
 *    search transparently uses Wikipedia — exactly the previous behaviour.
 *  - Markup drift or a bot wall parse to zero hits, which also falls back to
 *    Wikipedia per-call. Nothing new can break search that worked before.
 *
 * Volume stays polite: one GET per explicit search_web tool call (bounded by
 * the chats' tool-round caps), no scraping loops, no result-page paging.
 */

export interface DuckDuckGoSearchOptions {
  transport?: Transport;
  baseUrl?: string;
}

export class DuckDuckGoSearch {
  readonly id = "ddg-search";
  private readonly transport: Transport;
  private readonly baseUrl: string;

  constructor(opts: DuckDuckGoSearchOptions = {}) {
    this.transport = opts.transport ?? new DirectTransport();
    this.baseUrl = opts.baseUrl ?? "https://lite.duckduckgo.com/lite/";
  }

  /**
   * Top organic results (ads filtered), in page order.
   *
   * THREE ATTEMPTS, because one wasn't enough in practice. A bare GET with no
   * User-Agent is the shape DuckDuckGo most readily answers with a bot wall — which
   * parses to zero hits, looks exactly like "no results for that query", and sent
   * every search quietly to Wikipedia. So: a browser UA on every request; a POST to
   * the same Lite endpoint (the form the page itself submits, and the more reliable
   * of the two); and the classic HTML host as a second origin in case Lite is the one
   * being blocked.
   *
   * Only a TRANSPORT failure on the first attempt latches DDG off for the session —
   * that's CORS, which is permanent for this realm. A bot wall or a bad status is
   * transient and must not disable anything.
   */
  async searchWeb(query: string, count = 5): Promise<WebSearchHit[]> {
    const want = Math.min(10, Math.max(1, count));
    const q = encodeURIComponent(query);
    let firstError: unknown;
    const attempts: { url: string; method: "GET" | "POST"; body?: string }[] = [
      { url: `${this.baseUrl}?q=${q}&kl=wt-wt`, method: "GET" },
      { url: this.baseUrl, method: "POST", body: `q=${q}&kl=wt-wt` },
      { url: `https://html.duckduckgo.com/html/?q=${q}&kl=wt-wt`, method: "GET" },
    ];
    for (const [i, attempt] of attempts.entries()) {
      let res;
      try {
        res = await this.transport.send({
          url: attempt.url,
          method: attempt.method,
          headers: {
            // Without these DuckDuckGo serves a bot wall that parses to nothing.
            "user-agent": BROWSER_UA,
            "accept-language": "en-US,en;q=0.9",
            ...(attempt.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          },
          ...(attempt.body ? { body: attempt.body } : {}),
        });
      } catch (err) {
        // CORS/offline. Only the FIRST attempt's transport failure is diagnostic —
        // if the realm can't reach one host it can't reach the others either.
        if (i === 0) throw new DdgUnavailableError(err instanceof Error ? err.message : String(err));
        firstError ??= err;
        continue;
      }
      if (!res.ok) {
        firstError ??= new Error(`DuckDuckGo search failed with status ${res.status}`);
        continue;
      }
      const hits = parseLiteResults(await res.text()).slice(0, want);
      if (hits.length > 0) return hits;
    }
    // Every route answered and none of them parsed. A genuinely empty query looks the
    // same as a bot wall from here, so say nothing more than the truth.
    if (firstError instanceof Error) throw firstError;
    return [];
  }
}

/** A real browser's UA. Sent because the alternative is a bot wall that parses to zero
 * hits and reads, from every layer above, as "that query had no results". */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Marks a TRANSPORT-level failure (CORS/offline) — the only thing that should
 * disable DDG for the session. HTTP-status/parse errors are transient. */
export class DdgUnavailableError extends Error {}

/**
 * Parse the Lite results page: each organic result is an anchor with class
 * `result-link` (title row) followed by a `result-snippet` cell. Regex-based —
 * workers have no DOMParser — and tolerant of attribute order/quoting.
 */
function parseLiteResults(html: string): WebSearchHit[] {
  // Collect EVERY result-link first (ads included) so the i-th snippet pairs
  // with the i-th link — filtering ads before pairing would shift the snippets.
  const links: { link?: string; title: string }[] = [];
  const anchorRe = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
  for (let m = anchorRe.exec(html); m; m = anchorRe.exec(html)) {
    const attrs = m[1]!;
    if (!/class\s*=\s*['"][^'"]*result-link/i.test(attrs)) continue;
    const href = /href\s*=\s*['"]([^'"]+)['"]/i.exec(attrs)?.[1];
    const link = href ? resolveResultUrl(href) : undefined;
    links.push({
      // Ad/tracking links (DDG routes ads through duckduckgo.com/y.js) keep
      // their slot but are dropped from the output below.
      ...(link && !/duckduckgo\.com\/y\.js/i.test(link) ? { link } : {}),
      title: plainText(m[2]!),
    });
  }
  const snippets: string[] = [];
  const snippetRe = /class\s*=\s*['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/(?:td|div)>/gi;
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(plainText(m[1]!));
  }
  return links.flatMap((l, i) =>
    l.link
      ? [
          {
            link: l.link,
            ...(l.title ? { title: l.title } : {}),
            ...(snippets[i] ? { snippet: snippets[i]! } : {}),
          },
        ]
      : [],
  );
}

/** Lite hrefs are direct URLs or `//duckduckgo.com/l/?uddg=<encoded>` redirects. */
function resolveResultUrl(href: string): string | undefined {
  const uddg = /[?&]uddg=([^&]+)/.exec(href)?.[1];
  if (uddg) {
    try {
      const direct = decodeURIComponent(uddg);
      return /^https?:\/\//i.test(direct) ? direct : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  return undefined;
}

function plainText(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Session memory: once DDG fails at the transport level (CORS in the plain web
 * app, network policy…) there is no point re-trying it every search. Module
 * scope = per JS realm (page or worker), resettable for tests. */
export interface KeylessSearchState {
  ddgUnavailable: boolean;
  /** Why full-web search was switched off for this session, if it was. */
  ddgReason?: string;
}
const sharedState: KeylessSearchState = { ddgUnavailable: false };

/**
 * WHAT KEYLESS SEARCH ACTUALLY IS, in words, for the reader and the model.
 *
 * Two facts nothing surfaced. Image search without Google credentials is Wikimedia
 * Commons — an archive, not the web — so it feels narrow and nobody could tell whether
 * that was a failure or the design. And full-web text search latches OFF for the whole
 * session on one CORS/offline failure, after which Wikipedia answers everything and the
 * results look fine. Both were invisible; both are the reason to reach for a key. PURE.
 */
export function keylessSearchNote(state: KeylessSearchState = sharedState): string {
  const web = state.ddgUnavailable
    ? `Full-web search (DuckDuckGo) is OFF for this session — ${state.ddgReason ?? "it couldn't be reached"}. ` +
      "Text searches are answering from Wikipedia only, so say when a question needs the wider web."
    : "Full-web text search is on (DuckDuckGo).";
  return (
    `${web} IMAGE search is Wikimedia Commons only — a licensed archive, not the web — so it is strong on ` +
    "diagrams, artworks and public-domain photographs and weak on everything else. For broader pictures the reader " +
    "needs a Google Programmable Search key AND engine id in Settings."
  );
}

/**
 * The keyless composite behind `search_web`/`search_images` when no Google
 * Custom Search credentials are configured: full-web grounding from DuckDuckGo
 * where the environment allows it, Wikipedia as the always-works fallback, and
 * Wikimedia Commons for figures (DDG image search needs a JS token dance and
 * offers no licensing signal — Commons stays the better figure source).
 */
export class KeylessSearch implements FigureSearch {
  readonly id = "keyless-search";
  private readonly ddg: DuckDuckGoSearch;
  private readonly wiki: WikiSearch;
  private readonly state: KeylessSearchState;

  constructor(
    opts: { transport?: Transport; ddg?: DuckDuckGoSearch; wiki?: WikiSearch; state?: KeylessSearchState } = {},
  ) {
    const transport = opts.transport ? { transport: opts.transport } : {};
    this.ddg = opts.ddg ?? new DuckDuckGoSearch(transport);
    this.wiki = opts.wiki ?? new WikiSearch(transport);
    this.state = opts.state ?? sharedState;
  }

  async searchWeb(query: string, count = 5): Promise<WebSearchHit[]> {
    if (!this.state.ddgUnavailable) {
      try {
        const hits = await this.ddg.searchWeb(query, count);
        if (hits.length > 0) return hits;
        // Parsed to nothing (markup drift / bot wall): fall through this call,
        // but keep trying DDG — a niche query can legitimately have no results.
      } catch (err) {
        // Only a CORS/offline failure is permanent for the session; a transient
        // HTTP status or parse error falls through to Wikipedia for THIS call but
        // leaves DDG enabled for the next one.
        if (err instanceof DdgUnavailableError) {
          this.state.ddgUnavailable = true;
          // WHY, kept — a session that silently drops from full-web to Wikipedia
          // still returns results, so nothing about the answers says it happened.
          this.state.ddgReason = err.message;
        }
      }
    }
    return this.wiki.searchWeb(query, count);
  }

  /**
   * Figures come from Wikimedia Commons — licensed, labelled and hotlinkable.
   *
   * NOT DuckDuckGo: its image endpoint needs a per-session token scraped from a
   * results page, which is exactly the brittle thing this file is careful not to
   * depend on. The honest consequence is that keyless IMAGE search is an archive
   * search, not a web one, and it will feel narrow next to Google's — see
   * `keylessSearchNote`, which says so where a reader can read it.
   */
  async search(query: string, count = 5): Promise<ImageSearchHit[]> {
    return this.wiki.search(query, count);
  }

  async retrieve(query: string): Promise<RetrievedImage | undefined> {
    return this.wiki.retrieve(query);
  }
}
