import { DirectTransport, type Transport } from "../transport/transport.js";

/**
 * Google Programmable Search Engine access for technical books (Custom Search JSON API),
 * in two modes off the SAME credentials:
 *  - **image** (`searchType=image`) → retrieve an EXISTING figure for the LLM's
 *    visualization plan; an authoritative diagram beats a generated one for labeled
 *    scientific content.
 *  - **web** (no `searchType`) → fetch reference snippets + source URLs to GROUND the
 *    analysis. Provider-agnostic: the snippets are injected into whatever LLM is reading
 *    (a local model included), so grounded facts don't require Gemini as the reader.
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
    snippet?: string;
    mime?: string;
    image?: {
      contextLink?: string;
      thumbnailLink?: string;
      width?: number;
      height?: number;
    };
  }[];
}

/** One web-search result, for grounding the analysis. */
export interface WebSearchHit {
  link: string;
  title?: string;
  snippet?: string;
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

/**
 * What the engine, pipeline and chat need from a search backend — satisfied by the
 * keyed GoogleImageSearch and the keyless WikiSearch (free-search.ts), so callers
 * never care which credentials (if any) are behind it.
 */
export interface FigureSearch {
  /** Stable backend id ("google-image-search" / "wiki-search"), for diagnostics. */
  readonly id: string;
  searchWeb(query: string, count?: number): Promise<WebSearchHit[]>;
  search(query: string, count?: number): Promise<ImageSearchHit[]>;
  retrieve(query: string): Promise<RetrievedImage | undefined>;
}

export class GoogleImageSearch implements FigureSearch {
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

  /** Build a Custom Search request URL (web mode, or image mode when `image` is set). */
  private queryUrl(query: string, count: number, image: boolean): string {
    return (
      `${this.baseUrl}?key=${encodeURIComponent(this.apiKey)}&cx=${encodeURIComponent(this.engineId)}` +
      `&q=${encodeURIComponent(query)}&num=${Math.min(10, Math.max(1, count))}&safe=active` +
      (image ? "&searchType=image" : "")
    );
  }

  /** Top WEB results for a query (for grounding). Throws on a non-OK response. */
  async searchWeb(query: string, count = 5): Promise<WebSearchHit[]> {
    const res = await this.transport.send({ url: this.queryUrl(query, count, false), method: "GET" });
    if (!res.ok) throw new Error(`Web search failed with status ${res.status}`);
    const data = await res.json<CustomSearchResponse>();
    return (data.items ?? [])
      .filter((i) => i.link)
      .map((i) => ({
        link: i.link!,
        ...(i.title ? { title: i.title } : {}),
        ...(i.snippet ? { snippet: i.snippet } : {}),
      }));
  }

  /** Top image hits for a query (API ranking order). Throws on a non-OK response. */
  async search(query: string, count = 5): Promise<ImageSearchHit[]> {
    const res = await this.transport.send({ url: this.queryUrl(query, count, true), method: "GET" });
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
    return retrieveFromHits(this.transport, await this.search(query));
  }
}

/**
 * The bytes-then-thumbnail-then-hotlink ladder over ranked image hits, shared by
 * every search backend: bytes are persistable/cacheable (the goal), the thumbnail
 * host is the most fetch-tolerant fallback, and a URL-only result still displays
 * via <img src> when every byte-fetch is blocked. Undefined when there are no hits.
 */
export async function retrieveFromHits(
  transport: Transport,
  hits: readonly ImageSearchHit[],
): Promise<RetrievedImage | undefined> {
  if (hits.length === 0) return undefined;
  for (const hit of hits.slice(0, 3)) {
    // THUMBNAIL FIRST: it's always a browser-renderable raster (Commons renders a
    // PNG/JPEG thumb even for SVG/TIFF/PDF/DjVu originals — which <img> can NOT
    // display from raw bytes; trying the original first showed alt text instead
    // of the figure). The full link is the fallback when no thumb exists.
    for (const url of [hit.thumbnailLink, hit.link]) {
      if (!url) continue;
      const bytes = await fetchImageBytes(transport, url);
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

/**
 * Cap on each third-party image download. These are arbitrary hosts from search
 * results — the least reliable endpoints we talk to, and some hotlink-blockers
 * blackhole instead of refusing — so without a deadline one dead host would
 * stall the render pipeline indefinitely (fetch has no default timeout).
 */
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/** Formats an <img> can't decode from raw bytes — never download these (Commons
 * originals are often TIFF/PDF/DjVu scans; their THUMBS are fine rasters). */
const UNDISPLAYABLE_EXT = /\.(tiff?|pdf|djvu?|xcf|webm|ogv|ogg|stl)(\?|$)/i;

/** Download an image's bytes; undefined on any failure or a non-image response. */
async function fetchImageBytes(
  transport: Transport,
  url: string,
): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> {
  if (UNDISPLAYABLE_EXT.test(url)) return undefined;
  try {
    const res = await transport.send({ url, method: "GET", signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const bytes = await res.arrayBuffer();
    if (!bytes || bytes.byteLength === 0) return undefined;
    // The bytes decide the type, not the URL. A refusal page is a 200 with a body, and calling it
    // a PNG is what put an HTML document in front of ComfyUI's LoadImage. Rejecting here lets the
    // ladder fall through to the thumbnail host, which is the one that reliably serves images.
    const sniffed = sniffImageMime(bytes);
    if (!sniffed) return undefined;
    return { bytes, mimeType: sniffed };
  } catch {
    return undefined;
  }
}

/** Best-effort mime from the URL extension (the transport seam doesn't expose headers). */
/**
 * WHAT THESE BYTES ACTUALLY ARE, read from the bytes themselves.
 *
 * A hotlink-blocking host answers 200 with an HTML page. Nothing checked: a non-empty body and an
 * `.png` in the URL were enough, so the error page was saved as `vr-ref-….png`, handed to ComfyUI,
 * and surfaced three layers away as `LoadImage: cannot identify image file` — a message that names
 * neither the host that refused nor the fact that a refusal is what happened.
 *
 * Magic numbers, because the URL, the Content-Type header and the truth are three different things
 * here. Returns undefined for anything that isn't a raster an image model can open. PURE.
 */
export function sniffImageMime(bytes: ArrayBuffer): string | undefined {
  const b = new Uint8Array(bytes);
  if (b.length < 12) return undefined;
  const is = (offset: number, ...sig: number[]): boolean => sig.every((v, i) => b[offset + i] === v);
  if (is(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (is(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (is(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (is(0, 0x52, 0x49, 0x46, 0x46) && is(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (is(0, 0x42, 0x4d)) return "image/bmp";
  // SVG is text, and an image MODEL can't rasterise it — treat it like the HTML it resembles.
  return undefined;
}

/**
 * A picture we can PROVE is a picture, in a container the image engine can't open.
 *
 * AVIF and HEIC are ordinary on news and government sites now, and both are ISO-BMFF: the brand
 * sits at offset 8, after the `ftyp` box. Pillow — which is what ComfyUI's LoadImage uses — needs a
 * plugin for either, and won't have one. Naming them separately is the difference between "that
 * host refused us" and "that host served a format we can't use, pick a different result": the first
 * is a dead end, the second tells the reader exactly what to do next. PURE.
 */
export function unsupportedImageFormat(bytes: ArrayBuffer): string | undefined {
  const b = new Uint8Array(bytes);
  if (b.length < 12) return undefined;
  const brand = String.fromCharCode(...b.subarray(8, 12));
  const isFtyp = String.fromCharCode(...b.subarray(4, 8)) === "ftyp";
  if (isFtyp && (brand === "avif" || brand === "avis")) return "AVIF";
  if (isFtyp && (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "mif1")) return "HEIC";
  if (b[0] === 0xff && b[1] === 0x0a) return "JPEG XL";
  if (String.fromCharCode(...b.subarray(0, 5)).toLowerCase().startsWith("<svg") || String.fromCharCode(...b.subarray(0, 5)) === "<?xml") return "SVG";
  return undefined;
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

/** Generic chapter/section headings that don't name a topic to search for. */
const GENERIC_HEADING = /^(chapter|part|section|unit|appendix|introduction|conclusion|abstract|references)\b/i;

/**
 * The web-search query to GROUND a chapter: its heading when that names a real topic
 * (e.g. "The Krebs Cycle", "Backpropagation"), else the opening sentence of the text —
 * optionally scoped by the book title for disambiguation. Empty when there's nothing.
 */
export function groundingQuery(
  chapterTitle: string | undefined,
  chapterText: string,
  bookTitle?: string,
): string {
  const title = (chapterTitle ?? "").trim();
  const useTitle = title && !GENERIC_HEADING.test(title) && title !== (bookTitle ?? "").trim();
  const base = useTitle
    ? title
    : (chapterText.trim().split(/(?<=[.?!])\s/)[0] ?? "").trim().split(/\s+/).slice(0, 14).join(" ");
  if (!base) return "";
  // A very short topic gains precision from the book title (e.g. "ATP" + "Cell Biology");
  // a multi-word heading like "The Krebs Cycle" is already specific enough on its own.
  const bt = (bookTitle ?? "").trim();
  return bt && base.split(/\s+/).length <= 2 && !base.includes(bt) ? `${base} (${bt})` : base;
}

/**
 * Turn web hits into an injectable grounding block + a de-duplicated source list. The
 * block instructs the reader to prefer these real sources over recollection; the sources
 * are folded into the book's glossary as citations. Empty when no hit carries a snippet.
 */
export function formatGroundingContext(hits: readonly WebSearchHit[]): { context: string; sources: string[] } {
  const usable = hits.filter((h) => h.snippet?.trim()).slice(0, 5);
  if (usable.length === 0) return { context: "", sources: [] };
  const lines = usable.map((h, i) => `[${i + 1}] ${h.title ? `${h.title}: ` : ""}${h.snippet!.trim()}`);
  const context =
    "Reference sources from a web search on this chapter's topic — use them to ground " +
    "definitions, quantities, units, and facts, preferring them over recollection:\n" +
    lines.join("\n");
  const sources = usable.map((h) => h.link).filter((u, i, all) => all.indexOf(u) === i);
  return { context, sources };
}
