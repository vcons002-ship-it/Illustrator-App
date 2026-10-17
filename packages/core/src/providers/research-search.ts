import { DirectTransport, type Transport } from "./transport/transport.js";
import type { FigureSearch, ImageSearchHit, RetrievedImage, WebSearchHit, WebSearchOptions } from "./image/image-search.js";

export type WebSearchBackend = "auto" | "brave" | "tavily" | "google" | "keyless";
export type ImageSearchBackend = Exclude<WebSearchBackend, "tavily">;
export interface SearchSettings {
  keys: Record<string, string>;
  searchEngineId?: string;
  webSearchProvider?: WebSearchBackend;
  imageSearchProvider?: ImageSearchBackend;
}

/** Explicit selections never silently downgrade to a different service. */
export function resolveSearchBackends(settings: SearchSettings): {
  web: Exclude<WebSearchBackend, "auto">;
  images: Exclude<ImageSearchBackend, "auto">;
  news: "brave" | "tavily" | undefined;
} {
  const google = !!((settings.keys.search || settings.keys.gemini) && settings.searchEngineId);
  const autoWeb = settings.keys.brave ? "brave" : settings.keys.tavily ? "tavily" : google ? "google" : "keyless";
  const web = settings.webSearchProvider && settings.webSearchProvider !== "auto" ? settings.webSearchProvider : autoWeb;
  const images = settings.imageSearchProvider && settings.imageSearchProvider !== "auto" ? settings.imageSearchProvider
    : settings.keys.brave ? "brave" : google ? "google" : "keyless";
  const news = web === "brave" || web === "tavily" ? web
    : settings.keys.brave ? "brave" : settings.keys.tavily ? "tavily" : undefined;
  return { web, images, news };
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : undefined; } catch { return undefined; }
}
function str(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function obj(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(obj) : []; }
export function searchDomains(options: WebSearchOptions = {}): string[] {
  const domains = options.domains ?? [];
  if (domains.length > 10 || domains.some((d) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d))) {
    throw new Error("Search domains must be up to 10 hostnames, e.g. sec.gov (not URLs or search operators).");
  }
  return [...new Set(domains.map((d) => d.toLowerCase()))];
}
function allowed(link: string, domains: string[]): boolean {
  const host = new URL(link).hostname.toLowerCase();
  return !domains.length || domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Official, keyed APIs. Never silently substitute Wikipedia on errors, quota or missing access. */
export class ResearchSearch implements FigureSearch {
  readonly id: string;
  private readonly transport: Transport;
  constructor(private readonly opts: { provider: "brave" | "tavily"; apiKey: string; transport?: Transport; images?: FigureSearch }) {
    this.id = `${opts.provider}-search`;
    this.transport = opts.transport ?? new DirectTransport();
  }
  searchWeb(query: string, count = 5, options: WebSearchOptions = {}): Promise<WebSearchHit[]> {
    return this.text(query, count, options, false);
  }
  searchNews(query: string, count = 5, options: WebSearchOptions = {}): Promise<WebSearchHit[]> {
    return this.text(query, count, { freshness: "week", ...options }, true);
  }
  private async request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const provider = this.opts.provider;
    if (!this.opts.apiKey.trim()) throw new Error(`Configure a ${provider === "brave" ? "Brave Search" : "Tavily"} API key in Settings → Internet search.`);
    let response;
    try {
      response = await this.transport.send({
        url: provider === "brave" ? `https://api.search.brave.com/res/v1/${path}` : "https://api.tavily.com/search",
        method: provider === "brave" ? "GET" : "POST",
        headers: provider === "brave" ? { "X-Subscription-Token": this.opts.apiKey, accept: "application/json" }
          : { authorization: `Bearer ${this.opts.apiKey}` },
        ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(25_000),
      });
    } catch {
      // Never echo fetch errors: they can contain auth headers, query URLs, or provider response data.
      throw new Error(`${provider} search could not be reached. Check the connection/desktop link and retry. No background sources were substituted.`);
    }
    if (!response.ok) throw new Error(`${provider} search failed (HTTP ${response.status}). Check the API key, product access and quota. No background sources were substituted.`);
    try { return obj(await response.json()); }
    catch { throw new Error(`${provider} returned an unreadable search response. No background sources were substituted.`); }
  }
  private async text(query: string, count: number, options: WebSearchOptions, news: boolean): Promise<WebSearchHit[]> {
    const domains = searchDomains(options);
    const want = Math.min(10, Math.max(1, Math.floor(count)));
    const provider = this.opts.provider;
    let data: Record<string, unknown>;
    if (provider === "brave") {
      const q = domains.length ? `${query} (${domains.map((d) => `site:${d}`).join(" OR ")})` : query;
      const params = new URLSearchParams({ q, count: String(want), safesearch: "strict" });
      if (options.freshness) params.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[options.freshness]);
      data = await this.request(`${news ? "news" : "web"}/search?${params}`);
    } else {
      data = await this.request("", {
        query, topic: news ? "news" : "general", max_results: want, search_depth: "basic",
        include_answer: false, include_published_date: true,
        ...(options.freshness ? { time_range: options.freshness, filter_by_published_date: true } : {}),
        ...(domains.length ? { include_domains: domains } : {}),
      });
    }
    const results = provider === "brave" && !news ? obj(data.web).results : data.results;
    if (!Array.isArray(results)) throw new Error(`${provider} returned an unreadable search response. No background sources were substituted.`);
    const retrievedAt = new Date().toISOString();
    const seen = new Set<string>();
    return rows(results).flatMap((r): WebSearchHit[] => {
      const link = httpUrl(r.url);
      if (!link || !allowed(link, domains) || seen.has(link)) return [];
      if (news && /(^|\.)(wikipedia\.org|wikimedia\.org)$/.test(new URL(link).hostname)) return [];
      seen.add(link);
      const publishedAt = str(r.page_age) ?? str(r.published_date) ?? str(r.age);
      return [{ link, ...(str(r.title) ? { title: str(r.title)! } : {}),
        ...(str(r.description ?? r.content) ? { snippet: str(r.description ?? r.content)!.slice(0, 4_000) } : {}),
        provider, sourceType: news ? "news" : "web", publisher: str(obj(r.profile).name) ?? new URL(link).hostname, retrievedAt,
        ...(publishedAt ? { publishedAt, dateNote: provider === "brave" ? "Provider page/age date, which may reflect publication, update or discovery. Verify original publication on the article." : "Estimated publication/update date; verify on the article." } : {}),
      }];
    }).slice(0, want);
  }
  async search(query: string, count = 5): Promise<ImageSearchHit[]> {
    if (this.opts.provider !== "brave") {
      if (!this.opts.images) throw new Error("Tavily is configured for text/news. Choose Brave, legacy Google, or keyless image search in Settings.");
      return this.opts.images.search(query, count);
    }
    const params = new URLSearchParams({ q: query, count: String(Math.min(20, Math.max(1, Math.floor(count)))), safesearch: "strict" });
    const data = await this.request(`images/search?${params}`);
    if (!Array.isArray(data.results)) throw new Error("Brave returned an unreadable image-search response.");
    return rows(data.results).flatMap((r): ImageSearchHit[] => {
      const properties = obj(r.properties);
      const link = httpUrl(properties.url);
      if (!link) return [];
      const contextLink = httpUrl(r.url);
      const thumbnailLink = httpUrl(obj(r.thumbnail).src);
      return [{ link, ...(contextLink ? { contextLink } : {}), ...(thumbnailLink ? { thumbnailLink } : {}),
        ...(str(r.title) ? { title: str(r.title)! } : {}),
        ...(typeof properties.width === "number" ? { width: properties.width } : {}),
        ...(typeof properties.height === "number" ? { height: properties.height } : {}),
      }];
    }).slice(0, Math.min(20, Math.max(1, count)));
  }
  async retrieve(query: string): Promise<RetrievedImage | undefined> {
    const hit = (await this.search(query, 1))[0];
    return hit ? { sourceUrl: hit.link, ...(hit.contextLink ? { contextLink: hit.contextLink } : {}), ...(hit.title ? { title: hit.title } : {}) } : undefined;
  }
}
