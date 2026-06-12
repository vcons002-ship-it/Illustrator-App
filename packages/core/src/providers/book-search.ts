import { DirectTransport, type Transport } from "./transport/transport.js";

/**
 * Keyless full-book discovery for the landing-page buddy: Project Gutenberg via
 * the Gutendex API. Chosen for the same reason WikiSearch exists (free-search.ts):
 * it's the rare book source that is free, keyless AND CORS-open — and every hit
 * comes with a direct plain-text URL the buddy can fetch and open as a real
 * `BookSource`. ~75k public-domain titles: the classics an "illustrate it while
 * we chat" feature shines on.
 */

export interface BookSearchHit {
  title: string;
  author?: string;
  /** Direct full-text URL (plain text preferred), fetchable client-side. */
  textUrl: string;
  /** Human catalog page, for attribution links in the chat. */
  pageUrl?: string;
}

interface GutendexResponse {
  results?: {
    id?: number;
    title?: string;
    authors?: { name?: string }[];
    /** mime-type → URL ("text/plain; charset=utf-8", "application/zip", …). */
    formats?: Record<string, string>;
  }[];
}

export interface GutenbergSearchOptions {
  transport?: Transport;
  baseUrl?: string;
}

export class GutenbergSearch {
  readonly id = "gutenberg-search";
  private readonly transport: Transport;
  private readonly baseUrl: string;

  constructor(opts: GutenbergSearchOptions = {}) {
    this.transport = opts.transport ?? new DirectTransport();
    this.baseUrl = opts.baseUrl ?? "https://gutendex.com/books";
  }

  /** Top matches with a usable text URL, in catalog (popularity) order. */
  async search(query: string, count = 5): Promise<BookSearchHit[]> {
    const url = `${this.baseUrl}?search=${encodeURIComponent(query)}`;
    return (await this.fetchHits(url)).slice(0, count);
  }

  /**
   * Random picks for "surprise me / open a random classic": Gutendex lists the
   * catalog in download-count order, so a random page among the first ~30
   * (≈ the thousand most-loved books) is a shuffle of the classics shelf.
   * `rng` is injectable for tests.
   */
  async random(count = 5, rng: () => number = Math.random): Promise<BookSearchHit[]> {
    const page = 1 + Math.floor(rng() * 30);
    const hits = await this.fetchHits(`${this.baseUrl}?page=${page}`);
    // Shuffle (Fisher–Yates) so repeat calls on the same page still vary.
    for (let i = hits.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [hits[i], hits[j]] = [hits[j]!, hits[i]!];
    }
    return hits.slice(0, count);
  }

  private async fetchHits(url: string): Promise<BookSearchHit[]> {
    const res = await this.transport.send({ url, method: "GET" });
    if (!res.ok) throw new Error(`Project Gutenberg search failed with status ${res.status}`);
    const data = await res.json<GutendexResponse>();
    const hits: BookSearchHit[] = [];
    for (const r of data.results ?? []) {
      const textUrl = pickTextUrl(r.formats ?? {});
      if (!r.title || !textUrl) continue;
      const author = r.authors?.[0]?.name;
      hits.push({
        title: r.title,
        ...(author ? { author: flipName(author) } : {}),
        textUrl,
        ...(r.id !== undefined ? { pageUrl: `https://www.gutenberg.org/ebooks/${r.id}` } : {}),
      });
    }
    return hits;
  }
}

/** Best fetchable text format: plain text first, HTML as fallback — never archives. */
function pickTextUrl(formats: Record<string, string>): string | undefined {
  const usable = ([mime, url]: [string, string], wanted: string) =>
    mime.startsWith(wanted) && !/\.zip$/i.test(url) ? url : undefined;
  for (const entry of Object.entries(formats)) {
    const url = usable(entry, "text/plain");
    if (url) return url;
  }
  for (const entry of Object.entries(formats)) {
    const url = usable(entry, "text/html");
    if (url) return url;
  }
  return undefined;
}

/** Gutendex names are catalog-style ("Shelley, Mary") — flip to reading order. */
function flipName(name: string): string {
  const m = /^([^,]+),\s*(.+)$/.exec(name);
  return m ? `${m[2]} ${m[1]}` : name;
}
