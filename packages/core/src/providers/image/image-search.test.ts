import { describe, it, expect } from "vitest";
import { GoogleImageSearch, buildFigureQuery } from "./image-search.js";
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
