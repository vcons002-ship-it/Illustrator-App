import { DirectTransport, type Transport } from "../transport/transport.js";
import {
  retrieveFromHits,
  type FigureSearch,
  type ImageSearchHit,
  type RetrievedImage,
  type WebSearchHit,
} from "./image-search.js";

/**
 * Keyless search backend: Wikipedia for grounding snippets, Wikimedia Commons for
 * figure retrieval. Exists because the app is a browser app — CORS blocks scraping
 * search-engine result pages client-side, and the MediaWiki APIs are the rare
 * search source that is free, keyless AND CORS-open (`origin=*`). Narrower than
 * whole-web Custom Search, but for TECHNICAL material (the only place search is
 * used) an encyclopedia is a strong source, and Commons is full of exactly the
 * labeled diagrams figure retrieval wants.
 *
 * Deliberately NOT here: scraping DuckDuckGo/Google result pages through a
 * CORS-exempt context (the desktop Rust shell / the extension background worker).
 * Possible, but fragile (markup drift), rate-limited and ToS-gray — revisit only
 * if Wikipedia coverage proves too narrow in practice.
 */

export interface WikiSearchOptions {
  transport?: Transport;
  /** Wikipedia Action API endpoint (web/grounding mode). */
  webApiUrl?: string;
  /** Wikimedia Commons Action API endpoint (figure mode). */
  imageApiUrl?: string;
}

interface WikiWebResponse {
  query?: { search?: { title?: string; snippet?: string }[] };
}

interface CommonsImageResponse {
  query?: {
    pages?: Record<
      string,
      {
        title?: string;
        /** Search rank — `pages` is an unordered map, this restores the order. */
        index?: number;
        imageinfo?: {
          url?: string;
          thumburl?: string;
          descriptionurl?: string;
          mime?: string;
          width?: number;
          height?: number;
        }[];
      }
    >;
  };
}

/**
 * Wikimedia asks API clients to identify themselves; browsers can't set User-Agent
 * from JS, so `Api-User-Agent` is their sanctioned (and CORS-allowed) alternative —
 * without it, cloud/datacenter IPs get aggressively throttled.
 */
const API_USER_AGENT = "VisualReader/1.0 (https://github.com/vcons002-ship-it/illustrator-app)";

export class WikiSearch implements FigureSearch {
  readonly id = "wiki-search";
  private readonly transport: Transport;
  private readonly webApiUrl: string;
  private readonly imageApiUrl: string;

  constructor(opts: WikiSearchOptions = {}) {
    this.transport = opts.transport ?? new DirectTransport();
    this.webApiUrl = opts.webApiUrl ?? "https://en.wikipedia.org/w/api.php";
    this.imageApiUrl = opts.imageApiUrl ?? "https://commons.wikimedia.org/w/api.php";
  }

  /** Top Wikipedia articles for a query, shaped like web hits (for grounding). */
  async searchWeb(query: string, count = 5): Promise<WebSearchHit[]> {
    const n = Math.min(10, Math.max(1, count));
    const url =
      `${this.webApiUrl}?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
      `&srlimit=${n}&format=json&origin=*`;
    const res = await this.transport.send({
      url,
      method: "GET",
      headers: { "Api-User-Agent": API_USER_AGENT },
    });
    if (!res.ok) throw new Error(`Wikipedia search failed with status ${res.status}`);
    const data = await res.json<WikiWebResponse>();
    return (data.query?.search ?? [])
      .filter((s) => s.title)
      .map((s) => ({
        link: pageUrl(s.title!),
        title: s.title!,
        ...(s.snippet ? { snippet: stripHtml(s.snippet) } : {}),
      }));
  }

  /** Top Commons images for a query, in search-rank order. */
  async search(query: string, count = 5): Promise<ImageSearchHit[]> {
    const n = Math.min(10, Math.max(1, count));
    const url =
      `${this.imageApiUrl}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}` +
      `&gsrnamespace=6&gsrlimit=${n}&prop=imageinfo&iiprop=url%7Cmime%7Csize&iiurlwidth=640` +
      `&format=json&origin=*`;
    const res = await this.transport.send({
      url,
      method: "GET",
      headers: { "Api-User-Agent": API_USER_AGENT },
    });
    if (!res.ok) throw new Error(`Commons image search failed with status ${res.status}`);
    const data = await res.json<CommonsImageResponse>();
    return Object.values(data.query?.pages ?? {})
      .map((p) => ({ p, info: p.imageinfo?.[0] }))
      .filter(({ info }) => info?.url)
      .sort((a, b) => (a.p.index ?? 99) - (b.p.index ?? 99))
      .map(({ p, info }) => ({
        link: info!.url!,
        ...(info!.mime ? { mime: info!.mime } : {}),
        ...(p.title ? { title: p.title.replace(/^File:/, "") } : {}),
        ...(info!.thumburl ? { thumbnailLink: info!.thumburl } : {}),
        ...(info!.descriptionurl ? { contextLink: info!.descriptionurl } : {}),
        ...(typeof info!.width === "number" ? { width: info!.width } : {}),
        ...(typeof info!.height === "number" ? { height: info!.height } : {}),
      }));
  }

  /** Find a usable figure (same bytes → thumbnail → hotlink ladder as Custom Search). */
  async retrieve(query: string): Promise<RetrievedImage | undefined> {
    return retrieveFromHits(this.transport, await this.search(query));
  }
}

/** Canonical article URL from a title ("Citric acid cycle" → …/wiki/Citric_acid_cycle). */
function pageUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** Snippets arrive as HTML with <span class="searchmatch"> highlights — plain-text them. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
