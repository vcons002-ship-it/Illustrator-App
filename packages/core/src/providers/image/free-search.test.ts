import { describe, expect, it } from "vitest";
import { WikiSearch } from "./free-search.js";
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

const webJson = {
  query: {
    search: [
      {
        title: "Citric acid cycle",
        snippet:
          'The citric acid <span class="searchmatch">cycle</span> &amp; friends &quot;quoted&quot;',
      },
      { title: "Hans Krebs (biochemist)", snippet: "discoverer of the cycle" },
      { snippet: "no title — dropped" },
    ],
  },
};

// `pages` is an unordered keyed map; `index` carries the search rank (here reversed
// on purpose so the order assertion means something).
const commonsJson = {
  query: {
    pages: {
      "2": {
        title: "File:Krebs cycle.png",
        index: 2,
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/krebs.png",
            thumburl: "https://upload.wikimedia.org/thumb/krebs.png",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Krebs_cycle.png",
            mime: "image/png",
            width: 2880,
            height: 2811,
          },
        ],
      },
      "1": {
        title: "File:Citric acid cycle.svg",
        index: 1,
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/citric.svg",
            thumburl: "https://upload.wikimedia.org/thumb/citric.png",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Citric_acid_cycle.svg",
            mime: "image/svg+xml",
          },
        ],
      },
      "3": { title: "File:No info.png", index: 3 },
    },
  },
};

describe("WikiSearch.searchWeb", () => {
  it("maps articles to web hits with page URLs and plain-text snippets", async () => {
    const t = new FakeTransport(() => ({ json: webJson }));
    const s = new WikiSearch({ transport: t });
    const hits = await s.searchWeb("Krebs cycle", 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      link: "https://en.wikipedia.org/wiki/Citric_acid_cycle",
      title: "Citric acid cycle",
      snippet: 'The citric acid cycle & friends "quoted"',
    });
    expect(hits[1]!.link).toBe("https://en.wikipedia.org/wiki/Hans_Krebs_(biochemist)");
    const url = t.requests[0]!.url;
    expect(url).toContain("list=search");
    expect(url).toContain("origin=*");
    expect(url).toContain("srlimit=5");
    expect(t.requests[0]!.headers?.["Api-User-Agent"]).toContain("VisualReader");
  });

  it("throws on a non-OK response", async () => {
    const t = new FakeTransport(() => ({ ok: false, status: 429 }));
    const s = new WikiSearch({ transport: t });
    await expect(s.searchWeb("q")).rejects.toThrow(/429/);
  });
});

describe("WikiSearch.search", () => {
  it("maps Commons pages to image hits in search-rank order", async () => {
    const t = new FakeTransport(() => ({ json: commonsJson }));
    const s = new WikiSearch({ transport: t });
    const hits = await s.search("Krebs cycle diagram");
    expect(hits.map((h) => h.title)).toEqual(["Citric acid cycle.svg", "Krebs cycle.png"]);
    expect(hits[0]).toMatchObject({
      link: "https://upload.wikimedia.org/citric.svg",
      mime: "image/svg+xml",
      thumbnailLink: "https://upload.wikimedia.org/thumb/citric.png",
      contextLink: "https://commons.wikimedia.org/wiki/File:Citric_acid_cycle.svg",
    });
    expect(hits[1]).toMatchObject({ width: 2880, height: 2811 });
    const url = t.requests[0]!.url;
    expect(url).toContain("gsrnamespace=6");
    expect(url).toContain("generator=search");
  });

  it("returns empty for a response with no pages", async () => {
    const t = new FakeTransport(() => ({ json: { query: {} } }));
    const s = new WikiSearch({ transport: t });
    expect(await s.search("nothing")).toEqual([]);
  });
});

describe("WikiSearch.retrieve", () => {
  it("downloads the top hit's bytes (shared retrieval ladder)", async () => {
    const png = new TextEncoder().encode("png-bytes").buffer as ArrayBuffer;
    const t = new FakeTransport((req) =>
      req.url.includes("api.php") ? { json: commonsJson } : { bytes: png },
    );
    const s = new WikiSearch({ transport: t });
    const got = await s.retrieve("Krebs cycle diagram");
    expect(got?.bytes?.bytes.byteLength).toBe(png.byteLength);
    expect(got?.contextLink).toContain("Citric_acid_cycle.svg");
  });

  it("falls back to a hotlink URL when every byte-fetch fails", async () => {
    const t = new FakeTransport((req) =>
      req.url.includes("api.php") ? { json: commonsJson } : { ok: false, status: 403 },
    );
    const s = new WikiSearch({ transport: t });
    const got = await s.retrieve("Krebs cycle diagram");
    expect(got?.bytes).toBeUndefined();
    expect(got?.sourceUrl).toBe("https://upload.wikimedia.org/thumb/citric.png");
  });
});
