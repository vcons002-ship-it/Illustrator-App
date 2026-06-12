import { describe, expect, it } from "vitest";
import type { Transport, TransportRequest } from "../transport/transport.js";
import { DuckDuckGoSearch, KeylessSearch } from "./ddg-search.js";
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

  it("keeps figures on Commons", async () => {
    const wikiTransport = fakeTransport(() => ({
      body: { query: { pages: { "1": { title: "File:Cycle.png", index: 1, imageinfo: [{ url: "https://c.test/cycle.png" }] } } } },
    }));
    const search = new KeylessSearch({
      ddg: new DuckDuckGoSearch({ transport: fakeTransport(() => new Error("must not be called")) }),
      wiki: new WikiSearch({ transport: wikiTransport }),
      state: { ddgUnavailable: false },
    });
    const hits = await search.search("cycle diagram");
    expect(hits[0]!.link).toBe("https://c.test/cycle.png");
  });
});
