import { DirectTransport, type Transport } from "../transport/transport.js";

/**
 * Real-image retrieval for technical books, via Google's Programmable Search Engine
 * (Custom Search JSON API with `searchType=image`). The LLM's visualization plan
 * decides WHAT to look for (the keyEvent's subject/form); this module finds an
 * EXISTING figure for it — an authoritative diagram beats a generated one for
 * labeled scientific content. AI generation remains the fallback when nothing
 * suitable exists or can't be fetched.
 *
 * Requires two credentials (both free-tier friendly):
 *  - an API key with the "Custom Search API" enabled (Google Cloud console),
 *  - a Programmable Search Engine id (`cx`) with image search + full-web search on.
 */

export interface ImageSearchOptions {
  apiKey: string;
  /** Programmable Search Engine id ("cx"). */
  engineId: string;
  baseUrl?: string;
  transport?: Transport;
}

/** One image hit, in the API's ranking order. */
export interface ImageSearchHit {
  /** Direct image URL. */
  link: string;
  mime?: string;
  /** Google-hosted thumbnail (reliably hotlinkable when the origin blocks fetches). */
  thumbnailLink?: string;
  /** Page the image was found on (attribution / click-through). */
  contextLink?: string;
  title?: string;
  width?: number;
  height?: number;
}

interface CustomSearchResponse {
  items?: {
    link?: string;
    title?: string;
    mime?: string;
    image?: {
      contextLink?: string;
      thumbnailLink?: string;
      width?: number;
      height?: number;
    };
  }[];
}

/** A retrieved figure ready for the reader: bytes when fetchable, else a hotlink URL. */
export interface RetrievedImage {
  /** Image bytes (persistable/cacheable). Absent when only hotlinking worked. */
  bytes?: { bytes: ArrayBuffer; mimeType: string };
  /** Direct image URL for <img src> display when bytes couldn't be fetched. */
  sourceUrl?: string;
  /** Page the figure came from, for attribution. */
  contextLink?: string;
  title?: string;
}

export class GoogleImageSearch {
  readonly id = "google-image-search";
  private readonly apiKey: string;
  private readonly engineId: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;

  constructor(opts: ImageSearchOptions) {
    this.apiKey = opts.apiKey;
    this.engineId = opts.engineId;
    this.baseUrl = opts.baseUrl ?? "https://www.googleapis.com/customsearch/v1";
    this.transport = opts.transport ?? new DirectTransport();
  }

  /** Top image hits for a query (API ranking order). Throws on a non-OK response. */
  async search(query: string, count = 5): Promise<ImageSearchHit[]> {
    const url =
      `${this.baseUrl}?key=${encodeURIComponent(this.apiKey)}&cx=${encodeURIComponent(this.engineId)}` +
      `&q=${encodeURIComponent(query)}&searchType=image&num=${Math.min(10, Math.max(1, count))}&safe=active`;
    const res = await this.transport.send({ url, method: "GET" });
    if (!res.ok) throw new Error(`Image search failed with status ${res.status}`);
    const data = await res.json<CustomSearchResponse>();
    return (data.items ?? [])
      .filter((i) => i.link)
      .map((i) => ({
        link: i.link!,
        ...(i.mime ? { mime: i.mime } : {}),
        ...(i.title ? { title: i.title } : {}),
        ...(i.image?.thumbnailLink ? { thumbnailLink: i.image.thumbnailLink } : {}),
        ...(i.image?.contextLink ? { contextLink: i.image.contextLink } : {}),
        ...(typeof i.image?.width === "number" ? { width: i.image.width } : {}),
        ...(typeof i.image?.height === "number" ? { height: i.image.height } : {}),
      }));
  }

  /**
   * Find a usable figure for a query. Tries each hit in ranking order: full image
   * bytes first, then its Google-hosted thumbnail bytes (downloadable + cacheable);
   * if every byte-fetch is blocked (hotlink/CORS), falls back to a URL-only result
   * the UI can still display inline via <img src>. Undefined when the search itself
   * returns nothing usable.
   */
  async retrieve(query: string): Promise<RetrievedImage | undefined> {
    const hits = await this.search(query);
    if (hits.length === 0) return undefined;
    for (const hit of hits.slice(0, 3)) {
      for (const url of [hit.link, hit.thumbnailLink]) {
        if (!url) continue;
        const bytes = await this.fetchImageBytes(url);
        if (bytes) {
          return {
            bytes,
            ...(hit.contextLink ? { contextLink: hit.contextLink } : {}),
            ...(hit.title ? { title: hit.title } : {}),
          };
        }
      }
    }
    // Nothing downloadable — hotlink the best hit (its thumbnail is the safest src).
    const best = hits[0]!;
    return {
      sourceUrl: best.thumbnailLink ?? best.link,
      ...(best.contextLink ? { contextLink: best.contextLink } : {}),
      ...(best.title ? { title: best.title } : {}),
    };
  }

  /** Download an image's bytes; undefined on any failure or a non-image response. */
  private async fetchImageBytes(url: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> {
    try {
      const res = await this.transport.send({ url, method: "GET" });
      if (!res.ok) return undefined;
      const bytes = await res.arrayBuffer();
      if (!bytes || bytes.byteLength === 0) return undefined;
      return { bytes, mimeType: guessMime(url) };
    } catch {
      return undefined;
    }
  }
}

/** Best-effort mime from the URL extension (the transport seam doesn't expose headers). */
function guessMime(url: string): string {
  const m = url.toLowerCase().match(/\.(png|jpe?g|gif|webp|svg)(\?|$)/);
  if (!m) return "image/png";
  const ext = m[1]!;
  return ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}

/**
 * The image-search query for a technical keyEvent's visualization plan: the LLM-chosen
 * subject (the established concept/structure term) plus its visual form. e.g.
 * subject "the Krebs cycle", environment "step-by-step process diagram" →
 * "the Krebs cycle step-by-step process diagram".
 */
export function buildFigureQuery(subject: string | undefined, environment: string | undefined): string {
  const s = (subject ?? "").trim();
  const form = (environment ?? "").trim();
  const base = [s, form].filter(Boolean).join(" ");
  // Ensure the query asks for a FIGURE, not photos of the topic.
  return /diagram|chart|figure|illustration|schematic|graph/i.test(base) ? base : `${base} diagram`.trim();
}
