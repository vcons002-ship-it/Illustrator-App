import { describe, expect, it } from "vitest";
import { decodeEntities } from "./page-text.js";

describe("decodeEntities", () => {
  it("decodes common + numeric entities and survives out-of-range code points", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe('a & b <c> "d"');
    expect(decodeEntities("caf&#233; &#x2014; ok")).toBe("café — ok");
    // > 0x10FFFF would throw String.fromCodePoint — must not crash the parse
    // (each bad entity drops to "", leaving the surrounding spaces).
    expect(decodeEntities("x &#1114112; &#x110000; y")).toBe("x   y");
  });
});
import type { Transport, TransportRequest } from "./transport/transport.js";
import { extractLinks, fetchPageText } from "./page-text.js";

describe("extractLinks", () => {
  const base = "https://ex.com/dir/page.html";
  it("resolves relative + absolute hrefs and tag-strips the label", () => {
    const html = '<a href="/a">A</a> <a href="sub/b">B</a> <a href="https://other.com/c"><b>C</b> link</a>';
    expect(extractLinks(html, base)).toEqual([
      { text: "A", url: "https://ex.com/a" },
      { text: "B", url: "https://ex.com/dir/sub/b" },
      { text: "C link", url: "https://other.com/c" },
    ]);
  });

  it("drops js/mailto/tel/in-page anchors + non-http, and de-dupes", () => {
    const html =
      '<a href="javascript:void(0)">x</a><a href="mailto:a@b.c">m</a><a href="tel:123">t</a>' +
      '<a href="#top">top</a><a href="/dup">one</a><a href="/dup">two</a>';
    expect(extractLinks(html, base)).toEqual([{ text: "one", url: "https://ex.com/dup" }]);
  });

  it("falls back to the URL when the label is empty and caps the count", () => {
    expect(extractLinks('<a href="/x"><img></a>', base)).toEqual([{ text: "https://ex.com/x", url: "https://ex.com/x" }]);
    const many = Array.from({ length: 100 }, (_, i) => `<a href="/p${i}">${i}</a>`).join("");
    expect(extractLinks(many, base).length).toBe(60);
  });
});

function fakeTransport(body: string | unknown, ok = true, status = 200): Transport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      return {
        ok,
        status,
        json: async <T>() => body as T,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      };
    },
  };
}

describe("fetchPageText", () => {
  it("routes Wikipedia article URLs through the plaintext extracts API", async () => {
    const transport = fakeTransport({
      query: { pages: { "123": { title: "Citric acid cycle", extract: "The cycle is…" } } },
    });
    const page = await fetchPageText("https://en.wikipedia.org/wiki/Citric_acid_cycle", { transport });
    expect(page).toEqual({ title: "Citric acid cycle", text: "The cycle is…" });
    const api = transport.requests[0]!.url;
    expect(api).toContain("en.wikipedia.org/w/api.php");
    expect(api).toContain("explaintext=1");
    expect(api).toContain("origin=*");
    expect(api).toContain(encodeURIComponent("Citric acid cycle"));
  });

  it("reads a GitHub repo via the API: README (base64) + top-level file list", async () => {
    const readme = "# Setup\n\nRun `npm install`, then `npm start`.";
    const b64 = Buffer.from(readme, "utf8").toString("base64");
    const requests: TransportRequest[] = [];
    const transport: Transport & { requests: TransportRequest[] } = {
      requests,
      async send(request) {
        requests.push(request);
        const u = request.url;
        const body = u.endsWith("/readme")
          ? { content: b64, encoding: "base64" }
          : u.endsWith("/contents")
            ? [{ name: "package.json", type: "file" }, { name: "src", type: "dir" }]
            : "";
        return {
          ok: true,
          status: 200,
          json: async <T>() => body as T,
          arrayBuffer: async () => new ArrayBuffer(0),
          text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
        };
      },
    };
    const page = await fetchPageText("https://github.com/owner/repo", { transport });
    expect(page.title).toBe("owner/repo");
    expect(page.text).toContain("npm install");
    expect(page.text).toContain("package.json");
    expect(page.text).toContain("[dir] src");
    expect(requests.some((r) => r.url.endsWith("/repos/owner/repo/readme"))).toBe(true);
    expect(requests.some((r) => r.url.endsWith("/repos/owner/repo/contents"))).toBe(true);
  });

  it("reads a GitHub blob URL as raw file text", async () => {
    const transport = fakeTransport("export const x = 1;");
    const page = await fetchPageText("https://github.com/o/r/blob/main/src/index.ts", { transport });
    expect(page.text).toContain("export const x");
    expect(page.title).toContain("src/index.ts");
    expect(transport.requests[0]!.url).toBe("https://raw.githubusercontent.com/o/r/main/src/index.ts");
  });

  it("returns plain-text responses as-is", async () => {
    const transport = fakeTransport("CHAPTER I.\n\nIt was a dark and stormy night.");
    const page = await fetchPageText("https://g.test/84.txt", { transport });
    expect(page.text).toContain("dark and stormy");
    expect(page.title).toBeUndefined();
  });

  it("strips HTML pages down to readable text with the page title", async () => {
    const html = `<!doctype html><html><head><title>The &amp; Article</title>
      <style>p { color: red }</style></head>
      <body><nav>Menu Junk</nav><script>track();</script>
      <h1>The Article</h1><p>First paragraph.</p><p>Second &quot;quoted&quot; one.</p></body></html>`;
    const page = await fetchPageText("https://example.test/article", { transport: fakeTransport(html) });
    expect(page.title).toBe("The & Article");
    expect(page.text).toContain("First paragraph.");
    expect(page.text).toContain('Second "quoted" one.');
    expect(page.text).not.toContain("track()");
    expect(page.text).not.toContain("Menu Junk");
    expect(page.text).not.toContain("color: red");
    // Block boundaries became line breaks.
    expect(page.text.indexOf("First paragraph.")).toBeGreaterThan(page.text.indexOf("The Article"));
  });

  it("surfaces on-page links for an HTML page (absolute), none for plain text", async () => {
    const html = '<!doctype html><html><body><p>hi</p><a href="/next">Next page</a></body></html>';
    const page = await fetchPageText("https://example.test/dir/article", { transport: fakeTransport(html) });
    expect(page.links).toEqual([{ text: "Next page", url: "https://example.test/next" }]);
    const plain = await fetchPageText("https://example.test/raw.txt", { transport: fakeTransport("just text") });
    expect(plain.links).toBeUndefined();
  });

  it("caps the returned text length", async () => {
    const transport = fakeTransport("x".repeat(5000));
    const page = await fetchPageText("https://g.test/big.txt", { transport, maxChars: 1000 });
    expect(page.text).toHaveLength(1000);
  });

  it("surfaces HTTP failures and empty articles", async () => {
    await expect(
      fetchPageText("https://blocked.test/a", { transport: fakeTransport("", false, 403) }),
    ).rejects.toThrow("status 403");
    await expect(
      fetchPageText("https://en.wikipedia.org/wiki/Nope", {
        transport: fakeTransport({ query: { pages: { "-1": {} } } }),
      }),
    ).rejects.toThrow("no readable article");
  });
});
