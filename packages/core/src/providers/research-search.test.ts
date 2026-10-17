import { describe, expect, it } from "vitest";
import { ResearchSearch, resolveSearchBackends, searchDomains } from "./research-search.js";
import { searchResultSummary } from "./image/image-search.js";
import type { Transport, TransportRequest } from "./transport/transport.js";

function fixture(body: unknown, status = 200) {
  const requests: TransportRequest[] = [];
  const transport: Transport = { async send(request) {
    requests.push(request);
    return { ok: status === 200, status, json: async <T>() => body as T, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) };
  } };
  return { requests, transport };
}
const article = { url: "https://www.sec.gov/news/announcement", title: "Company announcement", description: "Current announcement", page_age: "2026-10-17", profile: { name: "SEC" } };

describe("Brave official search API", () => {
  it("uses the news endpoint, maps freshness, retains date provenance and enforces domain restrictions", async () => {
    const f = fixture({ results: [article, { ...article, url: "https://sec.gov.evil.test/x" }, { ...article, url: "javascript:alert(1)" }, article] });
    const hits = await new ResearchSearch({ provider: "brave", apiKey: "synthetic-key", transport: f.transport })
      .searchNews("ACME catalyst", 5, { freshness: "day", domains: ["sec.gov"] });
    const url = new URL(f.requests[0]!.url);
    expect(url.pathname).toBe("/res/v1/news/search");
    expect(url.searchParams.get("freshness")).toBe("pd");
    expect(url.searchParams.get("q")).toContain("site:sec.gov");
    expect(url.href).not.toContain("synthetic-key");
    expect(f.requests[0]?.headers?.["X-Subscription-Token"]).toBe("synthetic-key");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ link: article.url, publishedAt: article.page_age, publisher: "SEC", provider: "brave", sourceType: "news" });
    expect(hits[0]?.retrievedAt).toMatch(/^\d{4}-/);
    expect(hits[0]?.dateNote).toMatch(/Verify original publication/);
  });
  it("defaults news to a week and rejects Wikipedia even if the news provider supplies it", async () => {
    const f = fixture({ results: [{ ...article, url: "https://en.wikipedia.org/wiki/ACME" }] });
    const hits = await new ResearchSearch({ provider: "brave", apiKey: "k", transport: f.transport }).searchNews("ACME");
    expect(new URL(f.requests[0]!.url).searchParams.get("freshness")).toBe("pw");
    expect(hits).toEqual([]);
  });
  it("uses web.results for general search without inventing a missing article date", async () => {
    const f = fixture({ web: { results: [{ url: "https://example.com/x", title: "Background" }] } });
    const hits = await new ResearchSearch({ provider: "brave", apiKey: "k", transport: f.transport }).searchWeb("topic");
    expect(new URL(f.requests[0]!.url).pathname).toBe("/res/v1/web/search");
    expect(hits[0]?.sourceType).toBe("web");
    expect(hits[0]?.publishedAt).toBeUndefined();
  });
  it("maps image original, thumbnail and source page distinctly for reference adoption", async () => {
    const f = fixture({ results: [{ url: "https://example.com/article", title: "A bird", thumbnail: { src: "https://imgs.example.com/thumb" }, properties: { url: "https://example.com/bird.png", width: 1200, height: 800 } }] });
    const search = new ResearchSearch({ provider: "brave", apiKey: "k", transport: f.transport });
    expect(await search.search("bird")).toEqual([{ link: "https://example.com/bird.png", contextLink: "https://example.com/article", thumbnailLink: "https://imgs.example.com/thumb", title: "A bird", width: 1200, height: 800 }]);
    expect(new URL(f.requests[0]!.url).pathname).toBe("/res/v1/images/search");
    expect((await search.retrieve("bird"))?.sourceUrl).toBe("https://example.com/bird.png");
  });
  it.each([401, 403, 429, 500])("fails visibly on HTTP %s without making a fallback request", async (status) => {
    const f = fixture({ error: "secret-bearing provider details" }, status);
    const search = new ResearchSearch({ provider: "brave", apiKey: "synthetic-secret", transport: f.transport });
    await expect(search.searchNews("stock")).rejects.toThrow(`HTTP ${status}`);
    expect(f.requests).toHaveLength(1);
  });
  it("requires a key before making a network request", async () => {
    const f = fixture({});
    await expect(new ResearchSearch({ provider: "brave", apiKey: "", transport: f.transport }).searchWeb("x")).rejects.toThrow(/Configure a Brave/);
    expect(f.requests).toHaveLength(0);
  });
  it("redacts transport errors that might contain credentials and attaches a timeout", async () => {
    let signal: AbortSignal | undefined;
    const transport: Transport = { async send(request) { signal = request.signal; throw new Error("secret-token-in-network-error"); } };
    await expect(new ResearchSearch({ provider: "brave", apiKey: "k", transport }).searchNews("x")).rejects.toThrow(/could not be reached/);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
  it("distinguishes empty results from a malformed response", async () => {
    const make = (body: unknown) => new ResearchSearch({ provider: "brave" as const, apiKey: "k", transport: fixture(body).transport });
    expect(await make({ results: [] }).searchNews("x")).toEqual([]);
    await expect(make({ unexpected: [] }).searchNews("x")).rejects.toThrow(/unreadable/);
  });
});

describe("Tavily API", () => {
  it("requests news with strict date filtering, no generated answer, and retained source dates", async () => {
    const f = fixture({ results: [{ url: article.url, title: article.title, content: "News text", published_date: "2026-10-17" }] });
    const hits = await new ResearchSearch({ provider: "tavily", apiKey: "synthetic", transport: f.transport }).searchNews("ACME", 3, { freshness: "day", domains: ["sec.gov"] });
    expect(f.requests[0]).toMatchObject({ url: "https://api.tavily.com/search", method: "POST", body: { topic: "news", time_range: "day", filter_by_published_date: true, include_published_date: true, include_answer: false, include_domains: ["sec.gov"], max_results: 3 } });
    expect(hits[0]).toMatchObject({ provider: "tavily", sourceType: "news", publishedAt: "2026-10-17", snippet: "News text" });
  });
  it("does not claim Tavily has a dedicated image index", async () => {
    await expect(new ResearchSearch({ provider: "tavily", apiKey: "k" }).search("bird")).rejects.toThrow(/Choose Brave/);
  });
});

describe("provider selection and disclosure", () => {
  it("uses Brave for all indexes automatically, or Tavily for text/news with independent images", () => {
    expect(resolveSearchBackends({ keys: { brave: "k", tavily: "t" } })).toEqual({ web: "brave", news: "brave", images: "brave" });
    expect(resolveSearchBackends({ keys: { tavily: "t" } })).toEqual({ web: "tavily", news: "tavily", images: "keyless" });
    expect(resolveSearchBackends({ keys: {} })).toEqual({ web: "keyless", images: "keyless", news: undefined });
  });
  it("preserves explicit choices even when their key is missing (do not silently downgrade)", () => {
    expect(resolveSearchBackends({ keys: {}, webSearchProvider: "brave", imageSearchProvider: "google" })).toEqual({ web: "brave", news: "brave", images: "google" });
  });
  it.each(["https://sec.gov", "sec.gov OR evil.com", "evil.com/path", "*.sec.gov"])("rejects unsafe domain restrictions: %s", (domain) => {
    expect(() => searchDomains({ domains: [domain] })).toThrow(/hostnames/);
  });
  it("shows background fallback warnings in the user-visible result summary", () => {
    expect(searchResultSummary("ACME", [{ link: "https://en.wikipedia.org/wiki/ACME", provider: "wikipedia", sourceType: "background", warning: "Not current news" }])).toMatch(/wikipedia[\s\S]*⚠ Not current news/);
  });
});
