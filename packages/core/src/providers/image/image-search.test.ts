import { describe, it, expect } from "vitest";
import {
  GoogleImageSearch,
  buildFigureQuery,
  formatGroundingContext,
  groundingQuery,
} from "./image-search.js";
import type { Transport, TransportRequest, TransportResponse } from "../transport/transport.js";

interface Scripted {
  ok?: boolean;
  status?: number;
  json?: unknown;
  bytes?: ArrayBuffer;
}

class FakeTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly handler: (req: TransportRequest, index: number) => Scripted) {}
  send(request: TransportRequest): Promise<TransportResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    const s = this.handler(request, index);
    return Promise.resolve({
      ok: s.ok ?? true,
      status: s.status ?? 200,
      json: <T>() => Promise.resolve(s.json as T),
      arrayBuffer: () => Promise.resolve(s.bytes ?? new ArrayBuffer(0)),
      text: () => Promise.resolve(""),
    });
  }
}

const searchJson = {
  items: [
    {
      link: "https://example.org/krebs.png",
      mime: "image/png",
      title: "Krebs cycle",
      image: { contextLink: "https://example.org/article", thumbnailLink: "https://tbn.gstatic.com/k1", width: 1200, height: 900 },
    },
    { link: "https://other.org/cycle.jpg", image: { thumbnailLink: "https://tbn.gstatic.com/k2" } },
  ],
};

describe("GoogleImageSearch.search", () => {
  it("queries the Custom Search image API and maps hits in ranking order", async () => {
    const t = new FakeTransport(() => ({ json: searchJson }));
    const s = new GoogleImageSearch({ apiKey: "K", engineId: "CX", transport: t });
    const hits = await s.search("krebs cycle diagram");

    const url = t.requests[0]!.url;
    expect(url).toContain("key=K");
    expect(url).toContain("cx=CX");
    expect(url).toContain("q=krebs%20cycle%20diagram");
    expect(url).toContain("searchType=image");
    expect(hits[0]).toMatchObject({
      link: "https://example.org/krebs.png",
      thumbnailLink: "https://tbn.gstatic.com/k1",
      contextLink: "https://example.org/article",
    });
  });

  it("throws on a non-OK response (quota exceeded, bad key…)", async () => {
    const t = new FakeTransport(() => ({ ok: false, status: 429 }));
    const s = new GoogleImageSearch({ apiKey: "K", engineId: "CX", transport: t });
    await expect(s.search("x")).rejects.toThrow(/429/);
  });
});

describe("GoogleImageSearch.retrieve", () => {
  const png = new TextEncoder().encode("PNG").buffer;

  it("downloads the top hit's bytes (cacheable like a generated image)", async () => {
    const t = new FakeTransport((req) =>
      req.url.includes("customsearch") ? { json: searchJson } : { bytes: png },
    );
    const s = new GoogleImageSearch({ apiKey: "K", engineId: "CX", transport: t });
    const out = await s.retrieve("krebs cycle diagram");
    expect(out?.bytes?.mimeType).toBe("image/png");
    expect(new TextDecoder().decode(out!.bytes!.bytes)).toBe("PNG");
    expect(out?.contextLink).toBe("https://example.org/article");
  });

  it("falls back to the Google-hosted thumbnail when the origin blocks the download", async () => {
    const t = new FakeTransport((req) => {
      if (req.url.includes("customsearch")) return { json: searchJson };
      if (req.url.includes("example.org")) return { ok: false, status: 403 }; // hotlink-protected
      return { bytes: png }; // thumbnail host serves fine
    });
    const s = new GoogleImageSearch({ apiKey: "K", engineId: "CX", transport: t });
    const out = await s.retrieve("krebs cycle diagram");
    expect(out?.bytes).toBeDefined();
    expect(t.requests.some((r) => r.url.includes("tbn.gstatic.com"))).toBe(true);
  });

  it("returns a URL-only result when no bytes are fetchable (inline <img> display)", async () => {
    const t = new FakeTransport((req) =>
      req.url.includes("customsearch") ? { json: searchJson } : { ok: false, status: 403 },
    );
    const s = new GoogleImageSearch({ apiKey: "K", engineId: "CX", transport: t });
    const out = await s.retrieve("krebs cycle diagram");
    expect(out?.bytes).toBeUndefined();
    expect(out?.sourceUrl).toBe("https://tbn.gstatic.com/k1"); // thumbnail = safest hotlink
  });

  it("returns undefined when the search has no results (caller generates instead)", async () => {
    const t = new FakeTransport(() => ({ json: { items: [] } }));
    const s = new GoogleImageSearch({ apiKey: "K", engineId: "CX", transport: t });
    expect(await s.retrieve("xyzzy")).toBeUndefined();
  });
});

describe("GoogleImageSearch.searchWeb (grounding)", () => {
  it("queries the Custom Search API in WEB mode (no searchType=image) and maps snippets", async () => {
    const t = new FakeTransport(() => ({
      json: {
        items: [
          { link: "https://nih.gov/atp", title: "ATP", snippet: "Adenosine triphosphate is the energy currency." },
          { link: "https://x.org/none" }, // no snippet → filtered by formatGroundingContext, kept here
        ],
      },
    }));
    const s = new GoogleImageSearch({ apiKey: "K", engineId: "CX", transport: t });
    const hits = await s.searchWeb("ATP energy");
    expect(t.requests[0]!.url).not.toContain("searchType=image");
    expect(t.requests[0]!.url).toContain("q=ATP%20energy");
    expect(hits[0]).toEqual({
      link: "https://nih.gov/atp",
      title: "ATP",
      snippet: "Adenosine triphosphate is the energy currency.",
    });
  });
});

describe("groundingQuery", () => {
  it("uses a topical chapter heading as the query", () => {
    expect(groundingQuery("The Krebs Cycle", "Some body text.", "Cell Biology")).toBe("The Krebs Cycle");
  });

  it("falls back to the opening sentence for a generic heading", () => {
    const q = groundingQuery("Chapter 3", "Photosynthesis converts light into chemical energy. More text.", "Botany");
    expect(q).toBe("Photosynthesis converts light into chemical energy.");
  });

  it("scopes a very short topic with the book title for precision", () => {
    expect(groundingQuery("ATP", "x", "Cell Biology")).toBe("ATP (Cell Biology)");
  });

  it("returns empty when there's nothing to search", () => {
    expect(groundingQuery("Chapter 1", "   ")).toBe("");
  });
});

describe("formatGroundingContext", () => {
  it("builds an injectable block + de-duplicated sources, ignoring snippet-less hits", () => {
    const { context, sources } = formatGroundingContext([
      { link: "https://a.org", title: "A", snippet: "Fact one." },
      { link: "https://b.org", snippet: "Fact two." },
      { link: "https://a.org", snippet: "Fact one." }, // dup link
      { link: "https://c.org" }, // no snippet → dropped
    ]);
    expect(context).toMatch(/ground definitions, quantities/i);
    expect(context).toContain("[1] A: Fact one.");
    expect(context).toContain("[2] Fact two.");
    expect(sources).toEqual(["https://a.org", "https://b.org"]);
  });

  it("is empty when no hit has a snippet", () => {
    expect(formatGroundingContext([{ link: "https://a.org" }])).toEqual({ context: "", sources: [] });
  });
});

describe("buildFigureQuery", () => {
  it("joins the LLM's subject + visual form", () => {
    expect(buildFigureQuery("the Krebs cycle", "step-by-step process diagram")).toBe(
      "the Krebs cycle step-by-step process diagram",
    );
  });

  it("appends 'diagram' when the plan didn't name a figure-like form", () => {
    expect(buildFigureQuery("mitochondrion", "cutaway view")).toBe("mitochondrion cutaway view diagram");
    expect(buildFigureQuery("transformer architecture", undefined)).toBe("transformer architecture diagram");
  });
});
