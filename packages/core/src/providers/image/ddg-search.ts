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

  /** Top organic results (ads filtered), in page order. */
  async searchWeb(query: string, count = 5): Promise<WebSearchHit[]> {
    const url = `${this.baseUrl}?q=${encodeURIComponent(query)}&kl=wt-wt`;
    const res = await this.transport.send({ url, method: "GET" });
    if (!res.ok) throw new Error(`DuckDuckGo search failed with status ${res.status}`);
    return parseLiteResults(await res.text()).slice(0, Math.min(10, Math.max(1, count)));
  }
}

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
}
const sharedState: KeylessSearchState = { ddgUnavailable: false };

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
      } catch {
        this.state.ddgUnavailable = true;
      }
    }
    return this.wiki.searchWeb(query, count);
  }

  /** Figures stay on Commons (licensed, labeled, hotlinkable). */
  async search(query: string, count = 5): Promise<ImageSearchHit[]> {
    return this.wiki.search(query, count);
  }

  async retrieve(query: string): Promise<RetrievedImage | undefined> {
    return this.wiki.retrieve(query);
  }
}
