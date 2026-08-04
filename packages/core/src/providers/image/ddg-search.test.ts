import { describe, expect, it } from "vitest";
import type { Transport, TransportRequest } from "../transport/transport.js";
import { DuckDuckGoImageSearch, DuckDuckGoSearch, KeylessSearch, keylessSearchNote, type KeylessSearchState } from "./ddg-search.js";
import { WikiSearch } from "./free-search.js";

function fakeTransport(
  reply: (req: TransportRequest) => { ok?: boolean; status?: number; body: unknown } | Error,
): Transport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      const r = reply(request);
      if (r instanceof Error) throw r;
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        json: async <T>() => r.body as T,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
      };
    },
  };
}

const LITE_HTML = `
<html><body><table>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cnn.com%2F&rut=abc" class='result-link'>CNN — Breaking News, <b>Latest</b> News</a></td></tr>
<tr><td class='result-snippet'>View the latest news and breaking news today &amp; more.</td></tr>
<tr><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_provider=x&u3=https%3A%2F%2Fad.example" class='result-link'>Sponsored thing</a></td></tr>
<tr><td class='result-snippet'>Buy now!</td></tr>
<tr><td><a rel="nofollow" href="https://www.reuters.com/world/" class='result-link'>World News | Reuters</a></td></tr>
<tr><td class='result-snippet'>Reuters provides &quot;trusted&quot; world coverage.</td></tr>
</table></body></html>`;

describe("DuckDuckGoSearch", () => {
  it("parses lite results, decodes uddg redirects, strips markup, skips ads", async () => {
    const transport = fakeTransport(() => ({ body: LITE_HTML }));
    const hits = await new DuckDuckGoSearch({ transport }).searchWeb("news");
    expect(transport.requests[0]!.url).toContain("lite.duckduckgo.com/lite/?q=news");
    expect(hits).toEqual([
      {
        link: "https://www.cnn.com/",
        title: "CNN — Breaking News, Latest News",
        snippet: "View the latest news and breaking news today & more.",
      },
      {
        link: "https://www.reuters.com/world/",
        title: "World News | Reuters",
        snippet: 'Reuters provides "trusted" world coverage.',
      },
    ]);
  });

  it("caps the result count and surfaces HTTP failures", async () => {
    const transport = fakeTransport(() => ({ body: LITE_HTML }));
    const hits = await new DuckDuckGoSearch({ transport }).searchWeb("news", 1);
    expect(hits).toHaveLength(1);
    const blocked = fakeTransport(() => ({ ok: false, status: 429, body: "" }));
    await expect(new DuckDuckGoSearch({ transport: blocked }).searchWeb("x")).rejects.toThrow(
      "status 429",
    );
  });
});

describe("KeylessSearch", () => {
  const wikiBody = { query: { search: [{ title: "CNN", snippet: "American news channel" }] } };

  it("prefers DuckDuckGo and never touches Wikipedia when it works", async () => {
    const ddgTransport = fakeTransport(() => ({ body: LITE_HTML }));
    const wikiTransport = fakeTransport(() => ({ body: wikiBody }));
    const search = new KeylessSearch({
      ddg: new DuckDuckGoSearch({ transport: ddgTransport }),
      wiki: new WikiSearch({ transport: wikiTransport }),
      state: { ddgUnavailable: false },
    });
    const hits = await search.searchWeb("news");
    expect(hits[0]!.link).toBe("https://www.cnn.com/");
    expect(wikiTransport.requests).toHaveLength(0);
  });

  it("falls back to Wikipedia on transport failure and stops retrying DDG", async () => {
    const ddgTransport = fakeTransport(() => new Error("CORS blocked"));
    const wikiTransport = fakeTransport(() => ({ body: wikiBody }));
    const state = { ddgUnavailable: false };
    const search = new KeylessSearch({
      ddg: new DuckDuckGoSearch({ transport: ddgTransport }),
      wiki: new WikiSearch({ transport: wikiTransport }),
      state,
    });
    const first = await search.searchWeb("news");
    expect(first[0]!.title).toBe("CNN");
    expect(state.ddgUnavailable).toBe(true);
    await search.searchWeb("more news");
    // DDG was tried exactly once; the session remembers the block.
    expect(ddgTransport.requests).toHaveLength(1);
    expect(wikiTransport.requests).toHaveLength(2);
  });

  it("does NOT latch on a transient HTTP status — only on transport (CORS) failure", async () => {
    // A 429 is transient: fall back this call but keep DDG enabled for the next.
    const ddg429 = fakeTransport(() => ({ ok: false, status: 429, body: "" }));
    const wiki = fakeTransport(() => ({ body: wikiBody }));
    const state = { ddgUnavailable: false };
    const search = new KeylessSearch({
      ddg: new DuckDuckGoSearch({ transport: ddg429 }),
      wiki: new WikiSearch({ transport: wiki }),
      state,
    });
    await search.searchWeb("news");
    expect(state.ddgUnavailable).toBe(false); // NOT latched on a status error
    await search.searchWeb("more news");
    // Three routes per call now (GET, POST, the html host), and the SECOND call tried again —
    // which is the point: a status error is transient and must not latch DDG off.
    expect(ddg429.requests).toHaveLength(6);
  });

  it("falls through (without blacklisting) when DDG parses to zero hits", async () => {
    const ddgTransport = fakeTransport(() => ({ body: "<html>bot wall</html>" }));
    const wikiTransport = fakeTransport(() => ({ body: wikiBody }));
    const state = { ddgUnavailable: false };
    const search = new KeylessSearch({
      ddg: new DuckDuckGoSearch({ transport: ddgTransport }),
      wiki: new WikiSearch({ transport: wikiTransport }),
      state,
    });
    const hits = await search.searchWeb("news");
    expect(hits[0]!.title).toBe("CNN");
    expect(state.ddgUnavailable).toBe(false);
  });

  it("falls back to Commons for figures when the web image feed is down", async () => {
    // Web-wide images come from DuckDuckGo now; Commons is the floor beneath it, and this is
    // that floor — the state says the web feed is already off for the session.
    const wikiTransport = fakeTransport(() => ({
      body: { query: { pages: { "1": { title: "File:Cycle.png", index: 1, imageinfo: [{ url: "https://c.test/cycle.png" }] } } } },
    }));
    const search = new KeylessSearch({
      ddg: new DuckDuckGoSearch({ transport: fakeTransport(() => new Error("must not be called")) }),
      ddgImages: new DuckDuckGoImageSearch({ transport: fakeTransport(() => new Error("must not be called")) }),
      wiki: new WikiSearch({ transport: wikiTransport }),
      state: { ddgUnavailable: false, ddgImagesUnavailable: true },
    });
    const hits = await search.search("cycle diagram");
    expect(hits[0]!.link).toBe("https://c.test/cycle.png");
  });
});

describe("DuckDuckGo survives a bot wall", () => {
  class Recorder implements Transport {
    readonly requests: TransportRequest[] = [];
    constructor(private readonly pages: string[]) {}
    async send(req: TransportRequest) {
      this.requests.push(req);
      const body = this.pages[this.requests.length - 1] ?? "";
      return {
        ok: true,
        status: 200,
        json: async <T,>(): Promise<T> => ({}) as T,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => body,
      };
    }
  }
  const page = (title: string) =>
    `<a class="result-link" href="https://e.com/1">${title}</a><td class="result-snippet">snip</td>`;

  it("sends a real User-Agent — without one the answer is a bot wall that parses to nothing", () => {
    const t = new Recorder([page("hit")]);
    return new DuckDuckGoSearch({ transport: t }).searchWeb("q").then(() => {
      expect(t.requests[0]!.headers?.["user-agent"]).toMatch(/Mozilla/);
    });
  });

  it("retries as a POST, then the html host, when a page parses to zero hits", async () => {
    // A bot wall is a 200 with no results — indistinguishable from "no such query" unless
    // something else is tried.
    const t = new Recorder(["<html>are you a robot</html>", "", page("found at last")]);
    const hits = await new DuckDuckGoSearch({ transport: t }).searchWeb("q");
    expect(hits).toHaveLength(1);
    expect(t.requests).toHaveLength(3);
    expect(t.requests[1]!.method).toBe("POST");
    expect(t.requests[2]!.url).toContain("html.duckduckgo.com");
  });

  it("stops at the first route that actually returns something", async () => {
    const t = new Recorder([page("hit")]);
    await new DuckDuckGoSearch({ transport: t }).searchWeb("q");
    expect(t.requests).toHaveLength(1);
  });
});

describe("keylessSearchNote — saying what keyless search actually is", () => {
  it("says both feeds are on, and that a key alone isn't enough", () => {
    // A Programmable Search key does nothing without an engine id — the trap that costs an
    // afternoon in a console that never mentions it.
    const note = keylessSearchNote({ ddgUnavailable: false });
    expect(note).toMatch(/Full-web text search is on/);
    expect(note).toMatch(/Web-wide image search is on/);
    expect(note).toMatch(/key AND an engine id/i);
  });

  it("says when full-web TEXT search has been switched off, and why", () => {
    // It latches for the WHOLE session on one CORS failure, after which Wikipedia answers
    // everything and the results look perfectly fine.
    const note = keylessSearchNote({ ddgUnavailable: true, ddgReason: "blocked by CORS" });
    expect(note).toMatch(/TEXT search \(DuckDuckGo\) is OFF/);
    expect(note).toMatch(/blocked by CORS/);
    expect(note).toMatch(/Wikipedia only/);
  });

  it("says when pictures have dropped back to the archive, and that it's the feed not the query", () => {
    // Commons alone reads as broken even when it's working exactly as built: it has no
    // products, no people, nothing recent.
    const note = keylessSearchNote({ ddgUnavailable: false, ddgImagesUnavailable: true, ddgImagesReason: "no vqd token" });
    expect(note).toMatch(/IMAGE search is OFF/);
    expect(note).toMatch(/no vqd token/);
    expect(note).toMatch(/it is the feed, not the query/);
  });
});

describe("DuckDuckGo image search", () => {
  const jsonTransport = (pages: { body: string; ok?: boolean; status?: number }[]) => {
    const requests: TransportRequest[] = [];
    return {
      requests,
      transport: {
        async send(req: TransportRequest) {
          requests.push(req);
          const page = pages[requests.length - 1] ?? { body: "" };
          return {
            ok: page.ok ?? true,
            status: page.status ?? 200,
            json: async <T,>(): Promise<T> => JSON.parse(page.body) as T,
            arrayBuffer: async () => new ArrayBuffer(0),
            text: async () => page.body,
          };
        },
      } as Transport,
    };
  };

  it("mints the vqd token, then maps the results", async () => {
    const { transport, requests } = jsonTransport([
      { body: '<script>vqd="4-123abc"</script>' },
      { body: JSON.stringify({ results: [{ image: "https://e.com/a.jpg", thumbnail: "https://ddg/t.jpg", title: "A", url: "https://e.com/p", width: 800, height: 600 }] }) },
    ]);
    const hits = await new DuckDuckGoImageSearch({ transport }).search("otter");
    expect(hits).toEqual([
      { link: "https://e.com/a.jpg", thumbnailLink: "https://ddg/t.jpg", contextLink: "https://e.com/p", title: "A", width: 800, height: 600 },
    ]);
    expect(requests[1]!.url).toContain("vqd=4-123abc");
  });

  it("fails LOUDLY when the token is gone, naming which half broke", async () => {
    // An empty list would read as "no pictures of that". The token vanishing is markup drift,
    // and it has to be sayable or the archive fallback pretends to be a web search.
    const { transport } = jsonTransport([{ body: "<html>no token here</html>" }]);
    await expect(new DuckDuckGoImageSearch({ transport }).search("otter")).rejects.toThrow(/no vqd token/i);
  });

  it("falls back to Commons and REMEMBERS why", async () => {
    const { transport } = jsonTransport([{ body: "<html>nope</html>" }]);
    const state: KeylessSearchState = { ddgUnavailable: false };
    const wikiBody = JSON.stringify({ query: { pages: {} } });
    const search = new KeylessSearch({
      ddgImages: new DuckDuckGoImageSearch({ transport }),
      wiki: new WikiSearch({ transport: fakeTransport(() => ({ body: wikiBody })) }),
      state,
    });
    await search.search("otter");
    expect(state.ddgImagesUnavailable).toBe(true);
    expect(state.ddgImagesReason).toMatch(/vqd/i);
  });
});
